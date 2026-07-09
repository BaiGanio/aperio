import express from "express";
import helmet from "helmet";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve, sep as pathSep } from "path";
import { createRequire } from "module";
import { execFile, execFileSync } from "child_process";
import dotenv from "dotenv";

import { ensurePort } from "./lib/helpers/ensurePort.js";
import { createNetGuard, buildAllowedHosts } from "./lib/helpers/netGuard.js";
import { createAuthGuard, isAuthorized } from "./lib/helpers/authGuard.js";
import { makeRateLimiter } from "./lib/helpers/rateLimit.js";
import { createStaticGuard, STATIC_COOKIE } from "./lib/helpers/staticAuth.js";
import { createAppServer } from "./lib/helpers/tlsServer.js";
import { createCrashBreaker } from "./lib/helpers/crashBreaker.js";
import { shouldEnableRoundtable } from "./lib/helpers/roundtableBudget.js";
import { buildRoundtableAgentSpec } from "./lib/agent/job-spec.js";
import { randomBytes } from "crypto";
import logger from "./lib/helpers/logger.js";
import { BROWSERS, browserArgsFor } from "./lib/helpers/browserLauncher.js";
import { runBootstrap, bootstrapEvents, stepState, STEPS } from "./bootstrap.js";

// ─── Global error guards ──────────────────────────────────────────────────────
// Prevent a per-connection exception from crashing the whole server.
// uncaughtException covers sync throws inside EventEmitter callbacks (e.g. the
// ws "connection" handler); unhandledRejection covers async leaks (e.g. an
// await inside a ws "message" callback whose rejection escaped the try/catch).
//
// PROC-01: a single blowup is logged and absorbed, but repeated fatal errors in
// a short window mean the process is wedged — trip the breaker and exit so the
// supervisor restarts cleanly instead of serving errors forever.
const crashBreaker = createCrashBreaker({ threshold: 5, windowMs: 60_000 });
// Flipped true once gracefulShutdown begins. Late rejections during teardown
// (aborted fetches, "write after end" once the logger is closing) are expected
// noise — route them to the console so we never write to an ended logger.
let isShuttingDown = false;
function handleFatal(label, err) {
  if (isShuttingDown) {
    console.error(`${label} (during shutdown):`, err);
    return;
  }
  logger.error(`${label}:`, err);
  if (crashBreaker.record()) {
    logger.error("PROC-01: too many fatal errors in a short window — exiting for a clean restart.");
    process.exit(1);
  }
}
process.on("uncaughtException", (err) => handleFatal("Uncaught exception", err));
process.on("unhandledRejection", (err) => handleFatal("Unhandled rejection", err));

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const require   = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Only load a real .env. .env.example holds placeholder/default secrets
// (e.g. POSTGRES_PASSWORD=aperio_secret) and must never be treated as live
// config — before setup we rely on process env + in-code defaults instead.
const envPath = resolve(__dirname, ".env");
if (existsSync(envPath)) dotenv.config({ path: envPath });

const { version } = require("./package.json");
logger.info(`🚀 Starting Aperio server (version ${version})...`);

const PORT      = Number(process.env.PORT ?? 3000);
const HOST      = process.env.HOST ?? "127.0.0.1";
const LOCK_FILE = resolve(__dirname, "var/bootstrap.lock");

const isBootstrapped  = () => existsSync(LOCK_FILE);
const getBootstrapMeta = () => {
  try { return JSON.parse(readFileSync(LOCK_FILE, "utf8")); }
  catch { return null; }
};

// Flipped once the wizard posts a config and bootstrap begins. Lets a
// mid-bootstrap page refresh skip the wizard and resume the progress view.
let bootstrapStarted = false;

// Flipped true at the very end of bootApp() — the WebSocket + agent are live and
// the app can actually serve the SPA. The setup page polls /api/bootstrap/state
// for this so its "Open Aperio" button doesn't hand the user a frozen shell
// while bootApp (embeddings → Ollama → agent → WebSocket) is still warming up.
let appReady = false;
let bootAppPromise = null;

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

// ─── Port: free it before we try to bind ─────────────────────────────────────
await ensurePort(PORT, { wait: !!process.env.APERIO_RESTART });

// ─── Express (always starts immediately — serves setup UI right away) ─────────
const app = express();
// Security headers (X-Content-Type-Options, frameguard, Referrer-Policy, …).
// CSP is disabled for now: the UI relies on inline scripts/handlers/styles and
// CDN assets, so a strict policy needs those reworked first (tracked in the plan).
app.use(helmet({ contentSecurityPolicy: false }));

// REBIND-01: reject unknown Host headers (DNS-rebinding) and cross-site
// state-changing /api calls (Origin + X-Aperio-Client). Runs before any route,
// including the early bootstrap/setup endpoints. Extend via APERIO_ALLOWED_HOSTS.
const allowedHosts = buildAllowedHosts(HOST);
app.use(createNetGuard({ allowedHosts }));

// AUTH-01: opt-in shared-secret gate on /api/* (no-op unless APERIO_AUTH_TOKEN set).
app.use(createAuthGuard());

// Stash the raw body so the GitHub webhook can verify its HMAC signature
// (express.json otherwise consumes the stream before any route sees the bytes).
app.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ─── Locale detection (Accept-Language + cookie) ──────────────────────────────
// Supported EU locales — must mirror public/scripts/i18n.js.
const SUPPORTED_LOCALES = new Set([
  "en", "bg", "de", "fr", "es", "it", "pt", "nl", "pl", "ro",
  "el", "sv", "da", "fi", "cs", "sk", "sl", "hr", "hu", "et",
  "lv", "lt", "mt", "ga",
]);
const I18N_COOKIE = "aperio_lang";

// PATH-02: per-process secret handed to the browser as an httpOnly cookie when
// the app shell loads; required to read /uploads and /scratch (see staticAuth.js).
const STATIC_TOKEN = randomBytes(32).toString("hex");
function setStaticCookie(res) {
  res.cookie?.(STATIC_COOKIE, STATIC_TOKEN, {
    path: "/", httpOnly: true, sameSite: "Lax", maxAge: 30 * 24 * 3600 * 1000,
  });
}

function readCookieFromHeader(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

// Parses an Accept-Language header and picks the highest-quality supported tag.
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
  return pickLocaleFromHeader(req.headers["accept-language"]) || "en";
}

// Inject `window.__APERIO_LANG__ = "<lang>"` into HTML responses so the i18n
// engine has a server-detected default before localStorage/navigator kick in.
// Cached on first read so repeated requests don't hit disk.
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
  const html = readHtml(file);
  const inject =
    `<script>window.__APERIO_LANG__=${JSON.stringify(lang)};</script>`;
  // Inject right before the i18n script tag so it sees the value.
  return html.replace(
    /(<script[^>]+src="scripts\/i18n\.js"><\/script>)/,
    `${inject}\n  $1`
  );
}

// `/` and `/setup` need locale injection. Everything else (CSS, JS, assets)
// is served by express.static below.
app.get(["/", "/index.html"], (req, res) => {
  if (!isBootstrapped()) return res.redirect("/setup");
  const lang = detectLocale(req);
  res.cookie?.(I18N_COOKIE, lang, { path: "/", maxAge: 365 * 24 * 3600 * 1000, sameSite: "Lax" });
  setStaticCookie(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderHtmlWithLocale("index.html", lang));
});

app.use(express.static(resolve(__dirname, "public"), { index: false }));
// PATH-02: gate the generated/uploaded-file mounts behind the static cookie.
const staticGuard = createStaticGuard(STATIC_TOKEN);
app.use("/uploads", staticGuard, express.static(resolve(__dirname, "var/uploads")));
app.use("/scratch", staticGuard, express.static(resolve(__dirname, "var/scratch")));
app.use("/roundtables", staticGuard, express.static(resolve(__dirname, "var/roundtables")));

// ─── Bootstrap guard middleware ───────────────────────────────────────────────
// Until .bootstrap.lock exists every request redirects to /setup,
// except the setup page itself and the bootstrap API endpoints.
app.use((req, res, next) => {
  if (isBootstrapped()) return next();

  const bypass =
    req.path.startsWith("/setup") ||
    req.path.startsWith("/api/bootstrap") ||
    req.path.startsWith("/api/setup") ||
    req.path === "/favicon.ico";

  if (bypass) return next();

  // Return a JSON 503 for API calls so in-flight XHR/fetch don't get HTML
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({ error: "setup_required" });
  }

  res.redirect("/setup");
});

// ─── Setup page ───────────────────────────────────────────────────────────────
app.get("/setup", (req, res) => {
  if (isBootstrapped()) return res.redirect("/");
  const lang = detectLocale(req);
  res.cookie?.(I18N_COOKIE, lang, { path: "/", maxAge: 365 * 24 * 3600 * 1000, sameSite: "Lax" });
  setStaticCookie(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderHtmlWithLocale("setup.html", lang));
});

// Tiny info endpoint so clients can read the server-detected default.
app.get("/api/locale", (req, res) => {
  res.json({ lang: detectLocale(req), supported: [...SUPPORTED_LOCALES] });
});

// ─── Bootstrap state snapshot (handles page-refresh mid-run) ─────────────────
app.get("/api/bootstrap/state", (_req, res) => {
  res.json({
    bootstrapped: isBootstrapped(),
    started: bootstrapStarted,
    ready: appReady,
    meta:  getBootstrapMeta(),
    steps: STEPS.map(s => ({ ...s, status: stepState[s.id] })),
  });
});

// NET-03: throttle the setup endpoints (specs runs system profiling; config
// writes .env + kicks off bootstrap).
const setupLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, name: "setup" });

function listInstalledOllamaModels() {
  try {
    const out = execFileSync("ollama", ["list"], { encoding: "utf8", timeout: 3000 });
    return out
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map(line => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Setup wizard: machine specs + model recommendation ──────────────────────
app.get("/api/setup/specs", setupLimiter, async (_req, res) => {
  try {
    const { getSpecs } = await import("./lib/helpers/specs.js");
    res.json({ ...getSpecs(), ollamaModels: listInstalledOllamaModels() });
  } catch (err) {
    logger.error("specs failed:", err);
    res.status(500).json({ error: "specs_failed" });
  }
});

// ─── Setup wizard: persist choice → write .env → start bootstrap ─────────────
app.post("/api/setup/config", setupLimiter, async (req, res) => {
  if (isBootstrapped() || bootstrapStarted) {
    return res.status(409).json({ error: "already_started" });
  }
  try {
    const { provider, apiKey, model, pullModel } = req.body ?? {};
    const { writeEnvFromWizard } = await import("./lib/helpers/envFile.js");
    writeEnvFromWizard({ provider, apiKey, model, port: PORT });

    // Reload the freshly-written .env so bootApp + providers see the new values
    // without a server restart.
    dotenv.config({ path: resolve(__dirname, ".env"), override: true });
    if (String(provider).toLowerCase() === "ollama" && model?.trim()) {
      process.env.AI_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = model.trim();
    }

    bootstrapStarted = true;
    bootstrapEvents.once("complete", () => {
      logger.info("Bootstrap done — initialising app…");
      void bootAppOnce().catch(() => {});
    });
    bootstrapEvents.once("error", () => { bootstrapStarted = false; });
    runBootstrap({
      model: model || process.env.OLLAMA_MODEL || "qwen2.5:3b",
      skipOllama: String(provider).toLowerCase() !== "ollama",
      pullModel: String(provider).toLowerCase() === "ollama" && pullModel === true,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.warn("setup config rejected:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── Bootstrap SSE stream ─────────────────────────────────────────────────────
app.get("/api/bootstrap/stream", (req, res) => {
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");         // disable nginx buffering if present
  res.flushHeaders();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Immediately replay current state so late-joining clients (page refresh) catch up
  send("snapshot", { steps: STEPS.map(s => ({ ...s, status: stepState[s.id] })) });

  // If bootstrap already finished (e.g. everything was pre-installed, so it
  // completed before this client connected), replay completion so the client
  // shows the "done" state + launch button instead of hanging on the progress view.
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

  // Heartbeat — keeps the connection alive through proxies / load balancers
  const hb = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(hb);
    bootstrapEvents.off("progress", onProgress);
    bootstrapEvents.off("step",     onStep);
    bootstrapEvents.off("complete", onComplete);
    bootstrapEvents.off("error",    onError);
  });
});

// ─── HTTP server starts immediately — setup UI is reachable before bootApp() ──
// NET-01: HTTPS when APERIO_TLS_CERT/APERIO_TLS_KEY are set, else plain HTTP.
const { server: httpServer, secure } = createAppServer(app);
const scheme = secure ? "https" : "http";

httpServer.listen(PORT, HOST, async () => {
  const url = `${scheme}://${HOST}:${PORT}`;
  logger.warn(`\n✨ Aperio running at ${url}\n`);
  if (HOST !== "127.0.0.1" && HOST !== "::1" && HOST !== "localhost") {
    logger.warn("⚠️  Server is bound to a non-loopback address. Do not expose to untrusted networks.");
  }

  if (isBootstrapped()) {
    // Already set up: skip straight to full app init
    logger.info("✓ Already bootstrapped — starting app.");
    try {
      await bootAppOnce();
    } catch {
      return;
    }
    openBrowser(`${scheme}://localhost:${PORT}`);
  } else if (existsSync(resolve(__dirname, ".env"))) {
    // First run, but a .env already exists (user configured by hand) — preserve
    // the old auto-bootstrap behaviour; the setup page shows progress directly.
    logger.info("First run with existing .env — bootstrapping.");
    bootstrapStarted = true;
    bootstrapEvents.once("complete", () => { void bootAppOnce().catch(() => {}); });
    bootstrapEvents.once("error", () => { bootstrapStarted = false; });
    runBootstrap({
      model: process.env.OLLAMA_MODEL ?? "qwen2.5:3b",
      skipOllama: (process.env.AI_PROVIDER ?? "").toLowerCase() !== "ollama",
    });
    openBrowser(`${scheme}://localhost:${PORT}/setup`);
  } else {
    // First run, no .env: open the wizard. Bootstrap kicks off only after the
    // user picks a provider via POST /api/setup/config.
    logger.info("First run — opening setup wizard.");
    openBrowser(`${scheme}://localhost:${PORT}/setup`);
  }
});

// ─── Full app init ────────────────────────────────────────────────────────────
// All heavy imports are dynamic so they don't run until we know deps exist.
async function bootApp() {
  // Resolve DB-stored configuration into process.env BEFORE any consumer module
  // is imported, so even values read at module-load time pick up the user's
  // saved settings (DB > env > default; issue #167). getStore needs only Tier-0
  // vars (DB_BACKEND / paths), which stay in .env.
  const { getStore }                      = await import("./db/index.js");
  const { applyLiteDefaults }             = await import("./lib/config.js");
  applyLiteDefaults(0);                   // lite: pin DB_BACKEND before the store auto-detects
  const store = await getStore();
  const { applyConfigToEnv }              = await import("./lib/config-resolver.js");
  await applyConfigToEnv(store);
  // Lite last-resort defaults (AI_PROVIDER, APERIO_DOCGRAPH, …) — applied only
  // for vars still unset after .env + DB resolution, so saved settings win.
  const liteApplied = applyLiteDefaults(1);
  if (liteApplied.length) logger.info(`[config] lite defaults applied: ${liteApplied.join(", ")}`);

  const { createAgent }                   = await import("./lib/agent.js");
  const { ensureOllama }                  = await import("./lib/helpers/startOllama.js");
  const { getLlamaCppPid }                = await import("./lib/helpers/startLlamaCpp.js");
  const { createWatchdog }                = await import("./lib/helpers/shutdownGuard.js");
  const { deduplicateMemories }           = await import("./lib/workers/deduplicate.js");
  const { inferMemories }                 = await import("./lib/workers/infer.js");
  const { createSessionPruner }           = await import("./lib/workers/session-prune.js");
  const { createAgentRunPruner }          = await import("./lib/workers/agent-run-prune.js");
  const { createArtifactStore }           = await import("./lib/context/artifactStore.js");
  const { createAgentScheduler }          = await import("./lib/workers/agent-scheduler.js");
  const { makeWsHandler }                 = await import("./lib/emitters/handlers/wsHandler.js");
  const { apiRouter }                     = await import("./lib/routes/api.js");
  const { generateEmbedding, initEmbeddings, disposeEmbeddings, checkEmbeddingProvider } = await import("./lib/helpers/embeddings.js");

  // Hydrate the app-wide allowed-folders list from the DB (seeds it from env on
  // first run). Must run before codegraph/watchers read getAllowlist().
  const { loadAllowlist, getAllowlist, setAllowlist } = await import("./lib/routes/paths.js");
  await loadAllowlist(store);
  // Sync indexed repo root paths into the allowlist so they can be read by file
  // tools. Repos indexed before the auto-allowlist feature existed aren't in the
  // DB setting yet — this one-shot merge makes them readable without manual steps.
  try {
    const { pickBackend } = await import("./lib/codegraph/indexer.js");
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

  // Shared bus for codegraph/docgraph live file-change events. Watcher-kind
  // background-agent jobs subscribe to this via the scheduler (Phase 3). Created
  // up front so it can be threaded into both watchers and the scheduler below;
  // harmless (no listeners) when the agent-jobs feature is off.
  const { EventEmitter } = await import("events");
  const watcherEvents = new EventEmitter();

  // Registry of live watcher handles keyed by (kind, root). Both the boot pass
  // and the runtime "add a folder" route register here, so DELETE can stop the
  // matching watcher (otherwise it keeps watching a removed folder) and shutdown
  // can stop every watcher in one sweep.
  const { createWatcherRegistry } = await import("./lib/helpers/watcher-registry.js");
  const watcherRegistry = createWatcherRegistry();

  // ── Code graph live watcher (opt-in) ──────────────────────────────────────
  // APERIO_CODEGRAPH=on starts a chokidar watcher per APERIO_ALLOWED_PATHS_TO_READ
  // root. Initial repo index can take 20-60s on a fresh boot; run it in the
  // background so the API + WebSocket come up immediately. The /api/codegraph/status
  // endpoint surfaces progress to the Code panel.
  let codegraphBoot = null;
  if (process.env.APERIO_CODEGRAPH === 'on') {
    const { isCodegraphAvailable } = await import("./lib/codegraph/indexer.js");
    if (!isCodegraphAvailable(store)) {
      logger.warn(`[codegraph] APERIO_CODEGRAPH=on but backend has no graph store. Switch DB_BACKEND=sqlite or postgres.`);
    } else {
      const { getAllowlist } = await import("./lib/routes/paths.js");
      const { markEnabled } = await import("./lib/codegraph/status.js");

      // Dedupe roots before marking enabled so the status only shows roots that
      // will actually be indexed (filtering out nested dirs like var/scratch).
      const roots = getAllowlist();
      const dedupedRoots = roots.filter(r =>
        !roots.some(other => other !== r && r.startsWith(other + pathSep))
      );
      markEnabled(dedupedRoots);
      // Fire-and-forget: don't block bootApp on the initial index. Each per-root
      // handle is registered so DELETE / shutdown can stop it individually.
      codegraphBoot = (async () => {
        try {
          const { startAllWatchers } = await import("./lib/codegraph/watcher.js");
          const { handles } = await startAllWatchers(store, roots, watcherEvents);
          for (const h of handles) await watcherRegistry.register('codegraph', h.root, h);
        } catch (err) {
          const { logError } = await import("./lib/helpers/logger.js");
          logError(`[codegraph] watcher boot failed`, err);
        }
      })();
    }
  }

  // APERIO_DOCGRAPH=on starts a chokidar watcher per allowed folder for the
  // document graph (notes/PDF/DOCX/XLSX/PPTX/EML). Same fire-and-forget pattern
  // as codegraph so the initial index doesn't block boot.
  let docgraphBoot = null;
  if (process.env.APERIO_DOCGRAPH === 'on') {
    const { isDocgraphAvailable } = await import("./lib/docgraph/indexer.js");
    if (!isDocgraphAvailable(store)) {
      logger.warn(`[docgraph] APERIO_DOCGRAPH=on but backend has no document store. Switch DB_BACKEND=sqlite or postgres.`);
    } else {
      const { getAllowlist } = await import("./lib/routes/paths.js");
      const { markEnabled } = await import("./lib/docgraph/status.js");

      // Dedupe roots before marking enabled so the status only shows roots that
      // will actually be indexed (filtering out nested dirs like var/scratch).
      const roots = getAllowlist();
      const dedupedRoots = roots.filter(r =>
        !roots.some(other => other !== r && r.startsWith(other + pathSep))
      );
      markEnabled(dedupedRoots);
      docgraphBoot = (async () => {
        try {
          const { startAllWatchers } = await import("./lib/docgraph/watcher.js");
          const { handles } = await startAllWatchers(store, roots, watcherEvents);
          for (const h of handles) await watcherRegistry.register('docgraph', h.root, h);
        } catch (err) {
          const { logError } = await import("./lib/helpers/logger.js");
          logError(`[docgraph] watcher boot failed`, err);
        }
      })();
    }
  }

  // ── Serve the API immediately ──────────────────────────────────────────────
  // Mount the REST API now, *before* the multi-second agent/MCP/Ollama warmup
  // below. app.use is synchronous and the awaits that follow yield to the event
  // loop, so every non-agent endpoint (memories, code/doc graph, settings, files,
  // …) is live within ~1s instead of waiting for the whole boot to finish. The
  // agent/scheduler/watchdog are filled into `boot` as they come up; routes read
  // them through lazy getters (chat/agent routes return 503 "warming up" until
  // ready; the browser's WebSocket auto-reconnects).
  const boot = { agent: null, scheduler: null, watchdog: null };
  const { createErrorHandler } = await import("./lib/helpers/errorHandler.js");
  app.use("/api", apiRouter({
    store, version, watcherEvents, watcherRegistry,
    getAgent:     () => boot.agent,
    getScheduler: () => boot.scheduler,
    getWatchdog:  () => boot.watchdog,
  }));
  // Terminal error handler — registered after the API router and before the
  // (still-warming) routes append nothing else, so it stays last in the chain.
  app.use(createErrorHandler());

  // ── Agents ───────────────────────────────────────────────────────────────
  // The main chat agent always boots from AI_PROVIDER / provider env vars.
  // Round-table mode (two-agent cross-review) is opt-in via ROUNDTABLE_AGENTS
  // and boots TWO ADDITIONAL agents independent of the chat agent.
  // Format: "provider:model,provider:model" — first pair = round-table primary
  // (answerer), second pair = verifier (reviewer). Both entries required;
  // otherwise the Discuss toggle stays disabled.
  // Ollama must be sized + started BEFORE the agent is built. ensureOllama()
  // finalizes OLLAMA_NUM_CTX / OLLAMA_CONTEXT_LENGTH in the env, and createAgent
  // snapshots provider.contextWindow from them. Run it afterwards and the window
  // freezes at the 32768 default even though the server serves a larger one.
  if ((process.env.AI_PROVIDER || "").toLowerCase() === "ollama") await ensureOllama();

  const agent = await createAgent({
    root: __dirname,
    version,
    clientName: "aperio-server",
  });
  const { provider, callTool } = agent;
  boot.agent = agent; // chat/agent routes become live

  const roundtableAgents = parseRoundtableAgents(process.env.ROUNDTABLE_AGENTS);
  const primaryRtConfig  = roundtableAgents[0] ?? null;
  const verifierConfig   = roundtableAgents[1] ?? null;
  // Optional domain-character overlays, e.g. ROUNDTABLE_CHARACTERS="space-engineer,doctor".
  // Maps positionally onto the two agents; missing entries leave that agent
  // character-less (protocol role only). Slugs resolve to id/characters/<slug>.md.
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
      const charTag = (a) => a.character ? ` as "${a.character}"` : "";
      logger.info(`🤝 Round-table: primary = ${primaryRoundtable.provider.name} (${primaryRoundtable.provider.model})${charTag(primaryRoundtable)}, verifier = ${verifier.provider.name} (${verifier.provider.model})${charTag(verifier)}`);
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

  // Watchdog. IDLE_SHUTDOWN: "auto" (default) = local Ollama only; "on" = always
  // (the lite desktop/hidden launchers set this so a windowless server still
  // self-stops after the tab closes, even on a cloud provider); "off" = never.
  // getPid is llama-server-only (shutdownGuard now stops by PID, not Ollama's
  // /api/ps check) and stays null until Phase 2 wires ensureLlamaCpp() into the
  // provider boot below — until then this watchdog only closes the HTTP/WS
  // servers and exits on idle, it does not stop Ollama.
  const idleMode = (process.env.IDLE_SHUTDOWN || "auto").toLowerCase();
  const watchdog = createWatchdog({
    enabled:   idleMode === "on" ? true : idleMode === "off" ? false : provider.name === "ollama",
    getPid:    getLlamaCppPid,
    timeoutMs: (Number(process.env.IDLE_TIMEOUT_SECONDS) || 180) * 1000,
  });
  boot.watchdog = watchdog; // /heartbeat starts feeding the idle guard

  const providerLabel = provider.name === "anthropic"
    ? `Anthropic (${provider.model})`
    : provider.name === "deepseek"
      ? `DeepSeek (${provider.model})`
      : `Ollama (${provider.model})${
          agent.reasoningAdapter.match !== "__noop__"
            ? ` · thinking via ${agent.reasoningAdapter.match}` : ""}`;

  logger.info(`🤖 Provider: ${providerLabel}`);
  if (provider.name === "ollama") {
    const { machineCapacityPct } = await import("./lib/providers/index.js");
    const fmt = (n) => Number(n).toLocaleString("en-US");
    const serverWin = process.env.OLLAMA_CONTEXT_LENGTH;
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

  // Background-agent scheduler — created before the API mount so the
  // /api/agents/:id/run route can drive runJob() (interval auto-run is gated by
  // APERIO_AGENT_JOBS=on; manual run-now goes through the same scheduler).
  // Phase 4: job defs come from the DB (store.listAgentJobs), and every run is
  // recorded via store.recordAgentRun so the run-history panel has data.
  const agentJobs = await store.listAgentJobs?.().catch(err => {
    logger.warn(`[agent-scheduler] could not load jobs from DB: ${err.message}`);
    return [];
  }) ?? [];
  // Broadcast to every connected browser. Reassigned once `wss` exists below;
  // until then it's a no-op so the scheduler can be created first.
  let broadcastToClients = () => {};
  const scheduler = createAgentScheduler({
    callTool, createAgent, root: __dirname, version, watcherEvents,
    jobs: agentJobs,
    recordRun: (run) => store.recordAgentRun(run),
    notify: (payload) => broadcastToClients({ type: "agent_job_done", ...payload }),
  });
  boot.scheduler = scheduler; // background-agent routes (run-now, enable) go live

  // API routes + error handler are already mounted above (early). The WebSocket
  // is attached here, once the agent is ready, since makeWsHandler needs it; the
  // browser client auto-reconnects, so chat connects as soon as this is up.
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ origin, req }, cb) => {
      // REBIND-01: browsers send Origin; reject cross-site handshakes.
      if (origin) {
        try {
          const { hostname } = new URL(origin);
          if (!allowedHosts.has(hostname.toLowerCase())) return cb(false, 403, "Forbidden");
        } catch {
          return cb(false, 400, "Bad Request");
        }
      }
      // AUTH-01: opt-in token (no-op unless APERIO_AUTH_TOKEN is set).
      if (!isAuthorized(req)) return cb(false, 401, "Unauthorized");
      cb(true);
    },
  });
  wss.on("connection", makeWsHandler({ agent, primaryRoundtable, verifier, roundtableAvailable, roundtableUnavailableReason, store, __dirname }));

  // Fan a server-side message out to every open browser tab. Used by the
  // background-agent scheduler to surface a "job finished" banner.
  broadcastToClients = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(data); } catch { /* dead socket — ignore */ }
      }
    }
  };

  // The WebSocket is attached and the agent is live — the SPA can now connect.
  // Surface this to the setup page so it only offers "Open Aperio" once clicking
  // it lands on a working app instead of a shell with nothing to talk to.
  appReady = true;
  logger.warn("✅ Aperio is ready.");

  // Background jobs
  // PRIVACY-01: the infer/dedup workers feed stored personal memories to the
  // configured model. On a cloud provider that is third-party egress, so they
  // only run on a local (Ollama) provider unless explicitly opted in.
  const memoryWorkersEnabled =
    provider.name === "ollama" || process.env.APERIO_CLOUD_MEMORY_WORKERS === "1";
  if (!memoryWorkersEnabled) {
    logger.info(`[privacy] memory inference/dedup workers disabled on cloud provider "${provider.name}" (set APERIO_CLOUD_MEMORY_WORKERS=1 to override)`);
  }
  const noopWorker = { stop() {} };
  const dedup     = memoryWorkersEnabled ? deduplicateMemories(callTool) : noopWorker;
  const infer     = memoryWorkersEnabled ? inferMemories(callTool)       : noopWorker;
  const pruner    = createSessionPruner();
  const runPruner = createAgentRunPruner({
    store,
    artifactStore: createArtifactStore({ rootDir: resolve(__dirname, "var", "agent-artifacts") }),
  });

  // Graceful shutdown
  // Order matters: the ONNX native runtime must be torn down via its own API
  // before process.exit() runs global C++ destructors. Calling exit() while it
  // has live threads causes "mutex lock failed: Invalid argument".
  let shuttingDown = false;
  async function gracefulShutdown() {
    // A second Ctrl+C while the graceful teardown is in flight means the user
    // wants out now — escalate to an immediate exit instead of swallowing it.
    // A second Ctrl+C means the user wants out now — exit immediately, quietly.
    if (shuttingDown) process.exit(130); // 128 + SIGINT
    shuttingDown = true;
    isShuttingDown = true; // route any late fatal errors away from the closing logger

    // 1. Stop timers so the event loop can drain
    watchdog.stop();
    dedup.stop();
    infer.stop();
    pruner.stop();
    runPruner.stop();
    scheduler.stop();
    // Give any in-flight boot index a brief window to register its handles, then
    // stop every watcher (boot + runtime-added) via the registry. Don't block the
    // whole teardown on a full initial index (20-60s on a cold repo): stopAll()
    // closes the registry, so a boot pass that finishes registering *after* this
    // point stops its watchers on arrival (see watcher-registry.register) instead
    // of leaking them.
    await Promise.race([
      Promise.allSettled([codegraphBoot, docgraphBoot].filter(Boolean)),
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);
    await watcherRegistry.stopAll().catch(() => {});

    // 2. Let the current ONNX inference finish, then stop the backfill loop.
    //    Cap the wait so a single Ctrl+C doesn't hang on an in-flight embed.
    await shutdownEmbeddings(1500);

    // 3. Terminate WebSocket clients and close the WS server
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));

    // 4. Stop accepting requests and drain existing connections
    httpServer.closeAllConnections?.();
    await new Promise(resolve => httpServer.close(resolve));

    // 5. Dispose the ONNX inference session — releases its thread pool so the
    //    global destructor sequence won't try to lock already-destroyed mutexes.
    await disposeEmbeddings();

    // 6. Close the DB connection.
    await store.close?.();

    // 7. Flush and close the winston logger. Its DailyRotateFile transport holds
    //    a rotation timer that would otherwise keep the event loop alive.
    await new Promise(resolve => logger.end(resolve));

    // Instead of calling process.exit(), let Node exit by draining the event
    // loop. This lets each native addon (ONNX, better-sqlite3, sqlite-vec,
    // sharp) run its own AtExit hook in a controlled order before the C++
    // static destructors fire — avoiding the "mutex lock failed: Invalid
    // argument" crash that process.exit() causes when destructors race.
    //
    // Safety net: if the process is still alive after 750 ms (something is
    // holding the loop), force-exit. By this point every teardown step above has
    // awaited, so a clean drain happens almost immediately — the timer only
    // exists to cap a stuck handle, so it doesn't need to be generous. The timer
    // is unref()'d so it doesn't itself keep the loop alive.
    const forceExit = setTimeout(() => {
      process.exitCode = 0;
      process.exit(0);
    }, 750);
    forceExit.unref();
  }
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT",  gracefulShutdown);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Parse ROUNDTABLE_AGENTS="provider:model,provider:model" into a list of
// `{ name, model }` configs. Tolerates whitespace and extra entries beyond two
// (only the first two are consumed by round-table; rest reserved for future).
function parseRoundtableAgents(raw) {
  if (!raw || typeof raw !== "string") return [];
  const SUPPORTED = new Set(["anthropic", "ollama", "deepseek", "gemini", "claude-code", "codex"]);
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

function openBrowser(url) {
  const [cmd, ...args] =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", url]
    : ["xdg-open", url];
  const openDefault = () => execFile(cmd, args, err => {
    if (err) logger.error("⚠️  Could not open browser:", err.message);
  });

  // APERIO_BROWSER=default (or system) skips the private window and uses the
  // OS default. An unknown value also falls back to the default opener.
  const pref = (process.env.APERIO_BROWSER || "firefox").toLowerCase();
  const b = BROWSERS[pref];
  if (!b) {
    openDefault();
    return;
  }

  // APERIO_BROWSER_ISOLATED gives the browser a dedicated profile under var/,
  // so Aperio's cookies/storage/extensions stay separate from everyday
  // browsing. Not supported for `app`-family privacy browsers.
  const isolated = ["1", "true", "on", "yes"].includes(
    (process.env.APERIO_BROWSER_ISOLATED || "").toLowerCase());
  let profileDir = null;
  if (isolated && b.family !== "app") {
    profileDir = resolve(__dirname, "var/browser-profiles", pref);
    try {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logger.error("⚠️  Could not create browser profile dir:", err.message);
      profileDir = null;
    }
  } else if (isolated) {
    logger.warn(`⚠️  APERIO_BROWSER_ISOLATED ignored: ${pref} has no isolated-profile support.`);
  }

  // Open a private/incognito window in the chosen browser; fall back to the
  // default browser when it isn't installed (ENOENT / non-zero exit).
  const bArgs = browserArgsFor(b, url, profileDir);
  const [browserCmd, ...browserArgs] =
    process.platform === "darwin"
      ? ["open", "-na", b.mac, "--args", ...bArgs]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", b.win, ...bArgs]
      : [b.bin, ...bArgs];
  execFile(browserCmd, browserArgs, err => {
    if (err) openDefault();
  });
}
