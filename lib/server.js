// lib/server.js — Callable Aperio server composition root
//
// Encapsulates Express + HTTP + WebSocket + lifecycle setup that used to live
// at the top level of server.js.  Extracted so that tests can import and compose
// the real application without going through a script entrypoint.
//
// server.js remains the thin production entrypoint that loads .env, installs
// global error handlers, delegates to createApp(), and hooks signals.
//
// Usage (production):
//   import { createApp } from "./lib/server.js";
//   const app = await createApp({ root: __dirname, version });
//   app.listen();  // or httpServer.listen() already called if autoListen

import express from "express";
import helmet from "helmet";
import {
  existsSync, readFileSync, mkdirSync, statSync, chmodSync, writeFileSync,
} from "fs";
import { resolve } from "path";
import { createRequire } from "module";
import { randomBytes } from "crypto";

import { ensurePort } from "./helpers/ensurePort.js";
import { createNetGuard, buildAllowedHosts } from "./helpers/netGuard.js";
import { createAuthGuard } from "./helpers/authGuard.js";
import { makeRateLimiter } from "./helpers/rateLimit.js";
import { createStaticGuard, STATIC_COOKIE } from "./helpers/staticAuth.js";
import { createAppServer } from "./helpers/tlsServer.js";
import logger from "./helpers/logger.js";
import { runBootstrap, bootstrapEvents, stepState, STEPS, killActivePriming } from "../bootstrap.js";
import { ensurePricingCache } from "./pricing.js";
import { openBrowser } from "./server/browser.js";
import { createWsServer } from "./server/ws.js";
import { createGracefulShutdown } from "./server/shutdown.js";

/**
 * Prefer the full teardown when shutdown races with an in-progress app boot.
 * If boot fails before installing it, fall back to the pre-boot cleanup.
 *
 * @param {object} options
 * @param {Promise<unknown> | null} options.bootAppPromise
 * @param {() => (() => Promise<void>) | null} options.getFullShutdown
 * @param {() => Promise<void>} options.earlyShutdown
 */
export async function finishBootBeforeShutdown({
  bootAppPromise,
  getFullShutdown,
  earlyShutdown,
}) {
  let teardown = getFullShutdown();
  if (teardown) return teardown();

  if (bootAppPromise) {
    try { await bootAppPromise; } catch { /* boot failure uses early cleanup */ }
    teardown = getFullShutdown();
    if (teardown) return teardown();
  }

  return earlyShutdown();
}

/**
 * Create the Aperio Express + HTTP + WebSocket server, fully composed.
 *
 * @param {object}        options
 * @param {string}        options.root       Repository root directory (__dirname of the entrypoint)
 * @param {string}        options.version    Package version string
 * @param {number=}       options.port       Listening port (default: env PORT or 3000)
 * @param {string=}       options.host       Listening host (default: env HOST or "127.0.0.1")
 * @param {boolean=}      options.skipBoot   When true, do NOT call bootApp (for lightweight tests)
 * @param {boolean=}      options.skipBrowser When true, do NOT open a browser
 * @param {boolean=}      options.autoListen  When true, start listening immediately (default: true)
 * @param {object=}       options.injectAgent Test agent override (optional)
 * @returns {Promise<{app: import("express").Express, httpServer: import("http").Server,
 *   gracefulShutdown: (() => Promise<void>), listen: (() => void)}>}
 */
export async function createApp({
  root = process.cwd(),
  version = "0.0.0",
  port: PORT = Number(process.env.PORT ?? 3000),
  host: HOST = process.env.HOST ?? "127.0.0.1",
  skipBoot = false,
  skipBrowser = process.env.APERIO_BENCHMARK_RUN === "1",
  autoListen = true,
  injectAgent = null,
} = {}) {
  // Replicate __dirname semantics for code that was moved out of server.js
  const __dirname = root;
  const require = createRequire(resolve(root, "package.json"));

  // ─── State flags ──────────────────────────────────────────────────────────
  const LOCK_FILE = resolve(__dirname, "var/bootstrap.lock");
  const isBootstrapped  = () => existsSync(LOCK_FILE);
  const getBootstrapMeta = () => {
    try { return JSON.parse(readFileSync(LOCK_FILE, "utf8")); }
    catch { return null; }
  };
  let bootstrapStarted = false;
  let appReady = false;
  let bootAppPromise = null;
  let isShuttingDown = false;
  let fullShutdown = null; // set by bootApp() once the full app has booted

  function bootAppOnce() {
    if (appReady) return Promise.resolve();
    if (!bootAppPromise) {
      bootAppPromise = bootApp().catch((err) => {
        logger.error("Aperio app boot failed:", err);
        throw err;
      });
    }
    return bootAppPromise;
  }

  // ─── Port: free it before we try to bind ──────────────────────────────────
  await ensurePort(PORT, { wait: !!process.env.APERIO_RESTART });

  // ─── Express ──────────────────────────────────────────────────────────────
  const app = express();
  // Create the listener before installing security middleware so HSTS can be
  // restricted to actual HTTPS deployments. Sending Strict-Transport-Security
  // from the default HTTP listener makes browsers permanently upgrade this
  // local origin to HTTPS, where the plain HTTP server cannot answer.
  const { server: httpServer, secure } = createAppServer(app);

  // ─── Signal handling: registered before boot, not after ───────────────────
  // bootApp()'s own gracefulShutdown (below) used to be the only SIGINT/SIGTERM
  // handler, and it's only wired up once the wizard finishes and the full app
  // boots. A kill/crash during the wizard phase — while primeLlamaCppModel's
  // scratch llama-server is mid-download — hit Node's default no-handler exit
  // instead, orphaning that scratch server (reparented to init, still holding
  // its ephemeral port). Registering here, unconditionally, covers both phases:
  // before boot it just reaps any in-flight priming child; once bootApp sets
  // `fullShutdown`, this delegates to the complete teardown.
  let earlyShuttingDown = false;
  async function shutdown() {
    if (fullShutdown) return fullShutdown();
    if (earlyShuttingDown) return process.exit(130);
    earlyShuttingDown = true;
    return finishBootBeforeShutdown({
      bootAppPromise,
      getFullShutdown: () => fullShutdown,
      earlyShutdown: async () => {
        killActivePriming();
        try { httpServer.closeAllConnections?.(); } catch { /* not listening yet */ }
        await new Promise(resolvePromise => httpServer.close(() => resolvePromise()));
        process.exit(0);
      },
    });
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);

  const cspMode = String(process.env.APERIO_CSP || "on").trim().toLowerCase();
  const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'", "ws:", "wss:"],
    // Helmet's defaults (merged with the list above) include
    // upgrade-insecure-requests. On the plain-HTTP listener Safari applies it
    // to loopback subresources and fetches https://127.0.0.1:… — which this
    // server cannot answer — so every script fails with a TLS error.
    // Chrome/Firefox skip upgrading trustworthy loopback origins, which is why
    // only Safari broke. Emit the directive only when actually serving HTTPS.
    upgradeInsecureRequests: secure ? [] : null,
  };
  if (cspMode === "off") {
    logger.warn("CSP is disabled via APERIO_CSP=off");
    app.use(helmet({ contentSecurityPolicy: false, strictTransportSecurity: secure }));
  } else {
    app.use(helmet({
      strictTransportSecurity: secure,
      contentSecurityPolicy: {
        directives: cspDirectives,
        reportOnly: cspMode === "report",
      },
    }));
  }

  // REBIND-01: reject unknown Host headers (DNS-rebinding) and cross-site
  // state-changing /api calls (Origin + X-Aperio-Client). Runs before any route,
  // including the early bootstrap/setup endpoints. Extend via APERIO_ALLOWED_HOSTS.
  const allowedHosts = buildAllowedHosts(HOST);
  app.use(createNetGuard({ allowedHosts }));

  // AUTH-01: opt-in shared-secret gate on /api/* (no-op unless APERIO_AUTH_TOKEN set).
  app.use(createAuthGuard());

  // Stash the raw body so the GitHub webhook can verify its HMAC signature
  app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // ─── Locale detection ─────────────────────────────────────────────────────
  const SUPPORTED_LOCALES = new Set([
    "en", "bg", "de", "fr", "es", "it", "pt", "nl", "pl", "ro",
    "el", "sv", "da", "fi", "cs", "sk", "sl", "hr", "hu", "et",
    "lv", "lt", "mt", "ga", "zh", "ja",
  ]);
  const I18N_COOKIE = "aperio_lang";

  // PATH-02: per-process secret handed to the browser as an httpOnly cookie
  const STATIC_TOKEN = randomBytes(32).toString("hex");

  function readCookieFromHeader(header, name) {
    if (!header) return null;
    const match = header.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function pickLocaleFromHeader(header) {
    if (!header) return null;
    const candidates = header.split(",").map(part => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find(p => p.trim().startsWith("q="));
      const quality = q ? parseFloat(q.split("=")[1]) : 1;
      return { tag: tag.toLowerCase(), q: Number.isFinite(quality) ? quality : 1 };
    }).sort((a, b) => b.q - a.q);
    for (const { tag } of candidates) {
      const base = tag.split("-")[0];
      if (SUPPORTED_LOCALES.has(base)) return base;
    }
    return null;
  }

  function detectLocale(req) {
    const fromCookie = readCookieFromHeader(req.headers.cookie, I18N_COOKIE);
    if (fromCookie && SUPPORTED_LOCALES.has(fromCookie)) return fromCookie;
    return pickLocaleFromHeader(req.headers["accept-language"]) || process.env.DEFAULT_LOCALE || "en";
  }

  let _indexHtmlCache = null;
  let _setupHtmlCache = null;
  function readHtml(file) {
    if (file === "index.html") {
      if (_indexHtmlCache == null) _indexHtmlCache = readFileSync(resolve(__dirname, "public", file), "utf8");
      return _indexHtmlCache;
    }
    if (file === "setup.html") {
      if (_setupHtmlCache == null) _setupHtmlCache = readFileSync(resolve(__dirname, "public", file), "utf8");
      return _setupHtmlCache;
    }
    return readFileSync(resolve(__dirname, "public", file), "utf8");
  }

  function renderHtmlWithLocale(file, lang) {
    // Stamp the server-detected locale as an attribute, not an inline
    // <script>: the CSP script-src has no 'unsafe-inline'/nonce, so an inline
    // stamp is refused by the browser and the detection silently degrades.
    const html = readHtml(file);
    return html.replace(/<html\b/, `<html data-aperio-lang="${lang}"`);
  }

  function setStaticCookie(res) {
    res.cookie?.(STATIC_COOKIE, STATIC_TOKEN, {
      path: "/", httpOnly: true, sameSite: "Lax", maxAge: 30 * 24 * 3600 * 1000,
    });
  }

  // ─── Routes ───────────────────────────────────────────────────────────────
  app.get(["/", "/index.html"], (req, res) => {
    if (!isBootstrapped()) return res.redirect("/setup");
    const lang = detectLocale(req);
    res.cookie?.(I18N_COOKIE, lang, { path: "/", maxAge: 365 * 24 * 3600 * 1000, sameSite: "Lax" });
    setStaticCookie(res);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderHtmlWithLocale("index.html", lang));
  });

  app.use(express.static(resolve(__dirname, "public"), { index: false }));
  const staticGuard = createStaticGuard(STATIC_TOKEN);
  const sandboxStatic = (_req, res, next) => {
    res.setHeader("Content-Security-Policy", "sandbox");
    next();
  };
  // Runtime var/ data anchors to process.cwd(), not the install dir — matching
  // the writers (wsHandler sessions/scratch, workers/roundtable.js, file tools),
  // the SQLite default, and the path-guard floor. Identical in normal launches
  // (cwd == repo root); sandboxed runs (cwd elsewhere) stay self-contained (#282).
  app.use("/uploads", staticGuard, sandboxStatic, express.static(resolve(process.cwd(), "var/uploads")));
  app.use("/scratch", staticGuard, sandboxStatic, express.static(resolve(process.cwd(), "var/scratch")));
  app.use("/roundtables", staticGuard, express.static(resolve(process.cwd(), "var/roundtables")));

  // ─── Bootstrap guard middleware ────────────────────────────────────────────
  app.use((req, res, next) => {
    if (isBootstrapped()) return next();
    const bypass =
      req.path.startsWith("/setup") ||
      req.path.startsWith("/api/bootstrap") ||
      req.path.startsWith("/api/setup") ||
      req.path === "/favicon.ico";
    if (bypass) return next();
    if (req.path.startsWith("/api/")) {
      return res.status(503).json({ error: "setup_required" });
    }
    res.redirect("/setup");
  });

  // ─── Setup page ───────────────────────────────────────────────────────────
  app.get("/setup", (req, res) => {
    if (isBootstrapped()) return res.redirect("/");
    const lang = detectLocale(req);
    res.cookie?.(I18N_COOKIE, lang, { path: "/", maxAge: 365 * 24 * 3600 * 1000, sameSite: "Lax" });
    setStaticCookie(res);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderHtmlWithLocale("setup.html", lang));
  });

  app.get("/api/locale", (req, res) => {
    res.json({ lang: detectLocale(req), supported: [...SUPPORTED_LOCALES] });
  });

  app.get("/api/bootstrap/state", (_req, res) => {
    res.json({
      bootstrapped: isBootstrapped(),
      started: bootstrapStarted,
      ready: appReady,
      meta:  getBootstrapMeta(),
      steps: STEPS.map(s => ({ ...s, status: stepState[s.id] })),
    });
  });

  const setupLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, name: "setup" });

  app.get("/api/setup/specs", setupLimiter, async (_req, res) => {
    try {
      const { getSpecs } = await import("./helpers/specs.js");
      res.json(getSpecs());
    } catch (err) {
      logger.error("specs failed:", err);
      res.status(500).json({ error: "specs_failed" });
    }
  });

  app.post("/api/setup/config", setupLimiter, async (req, res) => {
    if (isBootstrapped() || bootstrapStarted) {
      return res.status(409).json({ error: "already_started" });
    }
    try {
      const { provider, apiKey, model, pullModel } = req.body ?? {};
      const { writeEnvFromWizard } = await import("./helpers/envFile.js");
      writeEnvFromWizard({ provider, apiKey, model, port: PORT });

      // Reload .env so bootApp + providers see the new values
      const dotenv = await import("dotenv");
      dotenv.config({ path: resolve(__dirname, ".env"), override: true });

      // Tier-1 choices (provider, key, model) go to DB settings, not .env
      // (#252): apply to process.env for this boot and stash for bootApp to
      // flush into the store the moment it opens.
      const { stashWizardConfig } = await import("./helpers/setupPending.js");
      stashWizardConfig({ provider, apiKey, model });

      bootstrapStarted = true;
      bootstrapEvents.once("complete", () => {
        logger.info("Bootstrap done — initialising app…");
        void bootAppOnce().catch(() => {});
      });
      bootstrapEvents.once("error", () => { bootstrapStarted = false; });
      runBootstrap({
        model: model || process.env.LLAMACPP_MODEL,
        engine: provider && provider.toLowerCase() === "llamacpp" ? provider.toLowerCase() : null,
        pullModel: !!pullModel,
      });

      res.json({ ok: true });
    } catch (err) {
      logger.warn("setup config rejected:", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Bootstrap SSE stream ─────────────────────────────────────────────────
  app.get("/api/bootstrap/stream", (req, res) => {
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send("snapshot", { steps: STEPS.map(s => ({ ...s, status: stepState[s.id] })) });

    if (isBootstrapped()) {
      send("complete", { ready: true });
      return res.end();
    }

    const onProgress = d  => send("progress", d);
    const onStep     = d  => send("step", d);
    const onComplete = () => { send("complete", { ready: true }); res.end(); };
    const onError    = d  => { send("error", d); res.end(); };

    bootstrapEvents.on("progress", onProgress);
    bootstrapEvents.on("step",     onStep);
    bootstrapEvents.on("complete", onComplete);
    bootstrapEvents.on("error",    onError);

    const hb = setInterval(() => res.write(": ping\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(hb);
      bootstrapEvents.off("progress", onProgress);
      bootstrapEvents.off("step",     onStep);
      bootstrapEvents.off("complete", onComplete);
      bootstrapEvents.off("error",    onError);
    });
  });

  // ─── HTTP server creation ─────────────────────────────────────────────────
  const scheme = secure ? "https" : "http";

  // ─── Listen ───────────────────────────────────────────────────────────────
  if (autoListen) {
    httpServer.listen(PORT, HOST, async () => {
      // Use address().port for accurate URL in case PORT=0 (OS-assigned)
      const actualPort = httpServer.address().port;
      const url = `${scheme}://${HOST}:${actualPort}`;
      logger.warn(`\n✨ Aperio running at ${url}\n`);

      // Machine-readable readiness line for test harness
      if (process.env.APERIO_REPORT_PORT) {
        process.stdout.write(JSON.stringify({ type: "ready", port: actualPort, pid: process.pid }) + "\n");
      }

      if (HOST !== "127.0.0.1" && HOST !== "::1" && HOST !== "localhost") {
        logger.warn("⚠️  Server is bound to a non-loopback address. Do not expose to untrusted networks.");
      }

      if (skipBoot) return;

      const launchBrowser = (browserUrl) => openBrowser(browserUrl, { root: __dirname });

      if (isBootstrapped()) {
        logger.info("✓ Already bootstrapped — starting app.");
        try { await bootAppOnce(); } catch { return; }
        // Use the actual loopback address for the automatic launch. Some
        // browsers/managed profiles upgrade localhost to HTTPS, while the
        // default local Aperio listener is plain HTTP. Relative assets then
        // inherit that wrong scheme and all fail with TLS errors.
        const browserHost = HOST === "localhost" ? "127.0.0.1" : HOST;
        if (!skipBrowser) launchBrowser(`${scheme}://${browserHost}:${actualPort}`);
      } else if (existsSync(resolve(__dirname, ".env"))) {
        logger.info("First run with existing .env — bootstrapping.");
        bootstrapStarted = true;
        bootstrapEvents.once("complete", () => { void bootAppOnce().catch(() => {}); });
        bootstrapEvents.once("error", () => { bootstrapStarted = false; });
        const envProvider = (process.env.AI_PROVIDER ?? "").toLowerCase();
        runBootstrap({
          model: process.env.LLAMACPP_MODEL,
          engine: envProvider === "llamacpp" ? envProvider : null,
        });
        const browserHost = HOST === "localhost" ? "127.0.0.1" : HOST;
        if (!skipBrowser) launchBrowser(`${scheme}://${browserHost}:${actualPort}/setup`);
      } else {
        logger.info("First run — opening setup wizard.");
        const browserHost = HOST === "localhost" ? "127.0.0.1" : HOST;
        if (!skipBrowser) launchBrowser(`${scheme}://${browserHost}:${actualPort}/setup`);
      }
    });
  }

  // ─── bootApp (full app init) ──────────────────────────────────────────────
  async function bootApp() {
    const { getStore }                      = await import("../db/index.js");
    const { applyLiteDefaults }             = await import("./config.js");
    applyLiteDefaults(0);
    const store = await getStore();
    const { flushWizardConfig }             = await import("./helpers/setupPending.js");
    await flushWizardConfig(store);
    const { applyConfigToEnv }              = await import("./config-resolver.js");
    await applyConfigToEnv(store);
    const liteApplied = applyLiteDefaults(1);
    if (liteApplied.length) logger.info(`[config] lite defaults applied: ${liteApplied.join(", ")}`);

    const { createAgent }                   = await import("./agent.js");
    const { isLocalProvider }               = await import("./providers/index.js");
    const { ensureLlamaCpp, getLlamaCppPid, stopLlamaCpp } = await import("./helpers/startLlamaCpp.js");
    const { createWatchdog }                = await import("./helpers/shutdownGuard.js");
    const { deduplicateMemories }           = await import("./workers/deduplicate.js");
    const { inferMemories }                 = await import("./workers/infer.js");
    const { createSessionPruner }           = await import("./workers/session-prune.js");
    const { createAgentRunPruner }          = await import("./workers/agent-run-prune.js");
    const { createLlamaLogPruner }          = await import("./workers/llamacpp-log-prune.js");
    const { createArtifactStore }           = await import("./context/artifactStore.js");
    const { createAgentScheduler }          = await import("./workers/agent-scheduler.js");
    const { makeWsHandler }                 = await import("./emitters/handlers/wsHandler.js");
    const { apiRouter }                     = await import("./routes/api.js");
    const { generateEmbedding, initEmbeddings, disposeEmbeddings, checkEmbeddingProvider } = await import("./helpers/embeddings.js");

    // Hydrate allowed-folders
    const { loadAllowlist, getAllowlist, setAllowlist } = await import("./routes/paths.js");
    await loadAllowlist(store);
    try {
      const { pickBackend } = await import("./codegraph/indexer.js");
      const backend = pickBackend(store);
      if (backend) {
        const { repos: listRepos } = backend.mod;
        const { repos: indexed } = await listRepos(store);
        const current = getAllowlist();
        const toAdd = (indexed || []).map(r => r.root_path).filter(p => !current.some(a => p === a || p.startsWith(a + "/")));
        if (toAdd.length) {
          await setAllowlist([...current, ...toAdd]);
          logger.info(`[allowlist] synced ${toAdd.length} indexed repo(s): ${toAdd.join(", ")}`);
        }
      }
    } catch (err) {
      logger.warn(`[allowlist] repo sync skipped: ${err.message}`);
    }

    await checkEmbeddingProvider(store);
    const { shutdown: shutdownEmbeddings } = await initEmbeddings(store, generateEmbedding);

    const { EventEmitter } = await import("events");
    const watcherEvents = new EventEmitter();
    const { createWatcherRegistry } = await import("./helpers/watcher-registry.js");
    const watcherRegistry = createWatcherRegistry();
    const { createFolderIndexingService } = await import("./services/folder-indexing.js");
    const folderIndexer = createFolderIndexingService({ store, watcherEvents, watcherRegistry });

    // Code graph watcher
    let codegraphBoot = null;
    if (process.env.APERIO_CODEGRAPH === "on") {
      const { isCodegraphAvailable } = await import("./codegraph/indexer.js");
      if (!isCodegraphAvailable(store)) {
        logger.warn(`[codegraph] APERIO_CODEGRAPH=on but backend has no graph store. Switch DB_BACKEND=sqlite or postgres.`);
      } else {
        const { markEnabled } = await import("./codegraph/status.js");
        const roots = getAllowlist();
        const dedupedRoots = roots.filter(r =>
          !roots.some(other => other !== r && r.startsWith(other + "/"))
        );
        markEnabled(dedupedRoots);
        codegraphBoot = (async () => {
          try {
            const { startAllWatchers } = await import("./codegraph/watcher.js");
            const { handles } = await startAllWatchers(store, roots, watcherEvents);
            for (const h of handles) await watcherRegistry.register("codegraph", h.root, h);
          } catch (err) {
            const { logError } = await import("./helpers/logger.js");
            logError(`[codegraph] watcher boot failed`, err);
          }
        })();
      }
    }

    // Doc graph watcher
    let docgraphBoot = null;
    if (process.env.APERIO_DOCGRAPH === "on") {
      const { isDocgraphAvailable } = await import("./docgraph/indexer.js");
      if (!isDocgraphAvailable(store)) {
        logger.warn(`[docgraph] APERIO_DOCGRAPH=on but backend has no document store. Switch DB_BACKEND=sqlite or postgres.`);
      } else {
        const { markEnabled } = await import("./docgraph/status.js");
        const roots = getAllowlist();
        const dedupedRoots = roots.filter(r =>
          !roots.some(other => other !== r && r.startsWith(other + "/"))
        );
        markEnabled(dedupedRoots);
        docgraphBoot = (async () => {
          try {
            const { startAllWatchers } = await import("./docgraph/watcher.js");
            const { handles } = await startAllWatchers(store, roots, watcherEvents);
            for (const h of handles) await watcherRegistry.register("docgraph", h.root, h);
          } catch (err) {
            const { logError } = await import("./helpers/logger.js");
            logError(`[docgraph] watcher boot failed`, err);
          }
        })();
      }
    }

    // API router
    const boot = { agent: null, scheduler: null, watchdog: null };
    const { createErrorHandler } = await import("./helpers/errorHandler.js");
    app.use("/api", apiRouter({
      store, version, watcherEvents, watcherRegistry,
      generateEmbedding, folderIndexer,
      getAgent:     () => boot.agent,
      getScheduler: () => boot.scheduler,
      getWatchdog:  () => boot.watchdog,
    }));
    app.use(createErrorHandler());

    // Agent (or injected test agent)
    const bootProvider = (process.env.AI_PROVIDER || "").toLowerCase();
    if (bootProvider === "llamacpp") {
      const llamaReady = await ensureLlamaCpp();
      if (llamaReady === false) {
        throw new Error("Aperio cannot start because the existing llama-server is unmanaged or uses a stale preset. Stop it manually and restart Aperio.");
      }
    }

    const agent = injectAgent ?? await (async () => {
      const { createIndexFolderTool } = await import("./agent/host-tools/index-folder.js");
      return createAgent({
        root: __dirname,
        version,
        clientName: "aperio-server",
        hostTools: [createIndexFolderTool(folderIndexer)],
      });
    })();
    const { provider, callTool } = agent;
    boot.agent = agent;

    // Boot-time model preload: the router loads models lazily, so without this
    // a cold cache (or a model switch) made the user's FIRST MESSAGE pay the
    // whole download+load while the greeting sat there looking ready. Trigger
    // the load now — via the forced warm-up, so the prompt cache is primed by
    // the same request — and publish progress on the app-wide model_status bus
    // that wsHandler feeds to every connected browser. Fire-and-forget: boot
    // must not block for a multi-GB download; sessions opened meanwhile show
    // the download banner instead of a false idle.
    if (bootProvider === "llamacpp" && !injectAgent) {
      const { preloadMainModel } = await import("./helpers/modelPreload.js");
      preloadMainModel({
        model: provider.model,
        routerModelId: provider.requestModel || provider.model,
        baseURL: provider.llamacppBaseURL,
        warm: () => agent.warmCache("en", () => null, () => {}, { force: true }),
      }).catch(err => logger.warn(`[modelPreload] boot preload failed: ${err.message}`));
    }

    // Roundtable agents
    const { shouldEnableRoundtable } = await import("./helpers/roundtableBudget.js");
    const { buildRoundtableAgentSpec } = await import("./agent/job-spec.js");
    const roundtableAgents = parseRoundtableAgents(process.env.ROUNDTABLE_AGENTS);
    const primaryRtConfig  = roundtableAgents[0] ?? null;
    const verifierConfig   = roundtableAgents[1] ?? null;
    const roundtableCharacters = (process.env.ROUNDTABLE_CHARACTERS || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    let primaryRoundtable = null;
    let verifier = null;
    let roundtableUnavailableReason = null;
    const roundtableGate = shouldEnableRoundtable({
      mainProvider: provider,
      primaryConfig: primaryRtConfig,
      verifierConfig,
      env: process.env,
    });
    if (!roundtableGate.enabled) {
      roundtableUnavailableReason = roundtableGate.reason;
      logger.warn(`[roundtable] Discuss unavailable for this session: ${roundtableGate.reason}`);
    } else if (primaryRtConfig && verifierConfig) {
      try {
        primaryRoundtable = await createAgent({
          root: __dirname,
          version,
          clientName: "aperio-server-rt-primary",
          spec: buildRoundtableAgentSpec({
            id: "primary",
            description: "Round-table primary answerer",
            providerConfig: primaryRtConfig,
            persona: "primary",
            character: roundtableCharacters[0] ?? null,
          }),
        });
        verifier = await createAgent({
          root: __dirname,
          version,
          clientName: "aperio-server-rt-verifier",
          spec: buildRoundtableAgentSpec({
            id: "verifier",
            description: "Round-table verifier reviewer",
            providerConfig: verifierConfig,
            persona: "verifier",
            character: roundtableCharacters[1] ?? null,
          }),
        });
        logger.info(`🤝 Round-table: primary = ${primaryRoundtable.provider.name} (${primaryRoundtable.provider.model}), verifier = ${verifier.provider.name} (${verifier.provider.model})`);
      } catch (err) {
        logger.error(`⚠️  Could not boot round-table agents — Discuss toggle disabled:`, err.message);
        roundtableUnavailableReason = err.message;
        primaryRoundtable = null;
        verifier = null;
      }
    } else if (primaryRtConfig || verifierConfig) {
      logger.warn(`[roundtable] ROUNDTABLE_AGENTS needs TWO "provider:model" pairs — Discuss disabled.`);
    }
    const roundtableAvailable = Boolean(primaryRoundtable && verifier);

    // Watchdog
    const idleMode = (process.env.IDLE_SHUTDOWN || "auto").toLowerCase();
    const watchdog = createWatchdog({
      enabled:   idleMode === "on" ? true : idleMode === "off" ? false : isLocalProvider(provider.name),
      getPid:    getLlamaCppPid,
      _stopLlama: stopLlamaCpp,
      timeoutMs: (Number(process.env.IDLE_TIMEOUT_SECONDS) || 180) * 1000,
      _markShuttingDown: () => { isShuttingDown = true; },
    });
    boot.watchdog = watchdog;

    // Provider label log
    const thinkingSuffix = agent.reasoningAdapter.match !== "__noop__"
      ? ` · thinking via ${agent.reasoningAdapter.match}` : "";
    const providerLabel = provider.name === "anthropic"
      ? `Anthropic (${provider.model})`
      : provider.name === "deepseek"
        ? `DeepSeek (${provider.model})`
        : provider.name === "llamacpp"
          ? `llama.cpp (${provider.model})${thinkingSuffix}`
          : `${provider.name} (${provider.model})`;
    logger.info(`🤖 Provider: ${providerLabel}`);
    if (provider.name === "llamacpp") {
      const { machineCapacityPct } = await import("./providers/index.js");
      const fmt = (n) => Number(n).toLocaleString("en-US");
      const serverWin = process.env.LLAMACPP_SERVE_CTX;
      const capPct = machineCapacityPct(provider.model);
      const detail = [
        serverWin ? `server KV cache ${fmt(serverWin)}` : null,
        typeof capPct === "number" ? `${capPct}% of RAM capacity` : null,
      ].filter(Boolean).join(" · ");
      logger.info(
        `🧮 Context window: ${fmt(provider.contextWindow)} tokens` + (detail ? ` (${detail})` : ""),
      );
    }
    logger.info("✅ MCP server connected");

    // Background-agent scheduler
    const agentJobs = await store.listAgentJobs?.().catch(err => {
      logger.warn(`[agent-scheduler] could not load jobs from DB: ${err.message}`);
      return [];
    }) ?? [];
    let broadcastToClients = () => {};
    const scheduler = createAgentScheduler({
      callTool, createAgent, root: __dirname, version, watcherEvents,
      jobs: agentJobs,
      recordRun: (run) => store.recordAgentRun(run),
      notify: (payload) => broadcastToClients({ type: "agent_job_done", ...payload }),
    });
    boot.scheduler = scheduler;

    // WebSocket
    const { wss, broadcastToClients: sendToClients } = createWsServer({
      httpServer, allowedHosts, makeWsHandler,
      agent, primaryRoundtable, verifier,
      roundtableAvailable, roundtableUnavailableReason,
      store, isShuttingDown: () => isShuttingDown,
    });
    broadcastToClients = sendToClients;

    appReady = true;
    // Write bootstrap lock so the guard middleware (which checks
    // isBootstrapped()) passes API requests through.  In the normal flow
    // runBootstrap() creates this file, but when bootAppOnce() is called
    // directly (e.g. by the E2E test fixture, or the "already bootstrapped"
    // fast path in createApp's listen callback), it must be created here.
    try {
      mkdirSync(resolve(__dirname, "var"), { recursive: true });
      writeFileSync(resolve(__dirname, "var/bootstrap.lock"), JSON.stringify({
        completedAt: new Date().toISOString(),
        model: agent?.provider?.model ?? null,
        engine: agent?.provider?.name ?? null,
      }));
    } catch { /* non-fatal */ }
    logger.warn("✅ Aperio is ready.");

    // Fire-and-forget: warm pricing cache from OpenRouter (or load from file)
    ensurePricingCache();

    // Background workers
    const memoryWorkersEnabled =
      isLocalProvider(provider.name) || process.env.APERIO_CLOUD_MEMORY_WORKERS === "1";
    if (!memoryWorkersEnabled) {
      logger.info(`[privacy] memory inference/dedup workers disabled on cloud provider "${provider.name}" (set APERIO_CLOUD_MEMORY_WORKERS=1 to override)`);
    }
    const noopWorker = { stop() {} };
    const dedup     = memoryWorkersEnabled ? deduplicateMemories(callTool) : noopWorker;
    const infer     = memoryWorkersEnabled ? inferMemories(callTool)       : noopWorker;
    const pruner    = createSessionPruner();
    const logPruner = createLlamaLogPruner();
    const runPruner = createAgentRunPruner({
      store,
      artifactStore: createArtifactStore({ rootDir: resolve(__dirname, "var", "agent-artifacts") }),
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────
    const gracefulShutdown = createGracefulShutdown({
      markShuttingDown: () => { isShuttingDown = true; },
      watchdog, dedup, infer, pruner, logPruner, runPruner, scheduler,
      codegraphBoot, docgraphBoot, watcherRegistry, shutdownEmbeddings,
      wss, httpServer, stopLlamaCpp, disposeEmbeddings, store,
    });

    // The pre-boot `shutdown()` handler (registered right after httpServer was
    // created) is already listening for SIGTERM/SIGINT — hand it the full
    // teardown now that this app instance actually has one, instead of adding
    // a second pair of listeners.
    fullShutdown = gracefulShutdown;

    return { gracefulShutdown, wss, store, agent, scheduler, watchdog };
  }

  return {
    app,
    httpServer,
    bootApp,
    bootAppOnce,
    get isReady() { return appReady; },
    isShuttingDown: () => isShuttingDown,
  };
}

// ─── Standalone helper: roundtable agent config ──────────────────────────────
function parseRoundtableAgents(raw) {
  if (!raw || typeof raw !== "string") return [];
  const SUPPORTED = new Set(["anthropic", "deepseek", "gemini", "claude-code", "codex"]);
  return raw.split(",").map(pair => {
    const trimmed = pair.trim();
    if (!trimmed) return null;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) {
      logger.warn(`[roundtable] ignoring malformed agent spec "${trimmed}" — expected "provider:model"`);
      return null;
    }
    const name = trimmed.slice(0, idx).toLowerCase();
    const model = trimmed.slice(idx + 1).trim();
    if (!SUPPORTED.has(name)) {
      logger.warn(`[roundtable] ignoring unsupported provider "${name}" — supported: ${[...SUPPORTED].join(", ")}`);
      return null;
    }
    if (!model) {
      logger.warn(`[roundtable] ignoring "${trimmed}" — model is empty`);
      return null;
    }
    return { name, model };
  }).filter(Boolean);
}
