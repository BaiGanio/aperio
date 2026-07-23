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

import { ensurePort } from "./helpers/ensurePort.js";
import { createNetGuard, buildAllowedHosts } from "./helpers/netGuard.js";
import { createAuthGuard } from "./helpers/authGuard.js";
import { createAppServer } from "./helpers/tlsServer.js";
import logger from "./helpers/logger.js";
import { runBootstrap, bootstrapEvents, stepState, STEPS, killActivePriming } from "../bootstrap.js";
import { ensurePricingCache } from "./pricing.js";
import { openBrowser } from "./server/browser.js";
import { createWsServer } from "./server/ws.js";
import { createGracefulShutdown } from "./server/shutdown.js";
import { registerSetupRoutes } from "./server/setupRoutes.js";
import { hydrateRuntime } from "./server/hydrateRuntime.js";
import { bootGraphWatcher } from "./server/graphWatchers.js";
import { bootRoundtable } from "./server/roundtable.js";
import { createBackgroundWorkers } from "./server/backgroundWorkers.js";

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
 * @param {string=}       options.runtimeRoot Mutable runtime state directory (defaults to root)
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
  runtimeRoot = root,
} = {}) {
  // Replicate __dirname semantics for code that was moved out of server.js
  const __dirname = root;
  const require = createRequire(resolve(root, "package.json"));

  // ─── State flags ──────────────────────────────────────────────────────────
  const RUNTIME_ROOT = resolve(runtimeRoot);
  const LOCK_FILE = resolve(RUNTIME_ROOT, "var/bootstrap.lock");
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

  // ─── Setup/bootstrap HTTP application ─────────────────────────────────────
  registerSetupRoutes({
    app,
    root: __dirname,
    PORT,
    isBootstrapped,
    getBootstrapMeta,
    getBootstrapStarted: () => bootstrapStarted,
    setBootstrapStarted: (v) => { bootstrapStarted = v; },
    getAppReady: () => appReady,
    bootAppOnce,
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
    const {
      store, generateEmbedding, disposeEmbeddings, shutdownEmbeddings,
      getAllowlist, watcherEvents, watcherRegistry, folderIndexer,
    } = await hydrateRuntime();

    const { createAgent }                   = await import("./agent.js");
    const { isLocalProvider }               = await import("./providers/index.js");
    const { ensureLlamaCpp, getLlamaCppPid, stopLlamaCpp } = await import("./helpers/startLlamaCpp.js");
    const { createWatchdog }                = await import("./helpers/shutdownGuard.js");
    const { createAgentScheduler }          = await import("./workers/agent-scheduler.js");
    const { makeWsHandler }                 = await import("./emitters/handlers/wsHandler.js");
    const { apiRouter }                     = await import("./routes/api.js");

    // Code graph watcher — bootGraphWatcher only awaits its cheap gate check
    // (env flag / availability / markEnabled); the returned bootPromise is the
    // full initial index, kicked off in the background and never awaited here.
    const { bootPromise: codegraphBoot } = await bootGraphWatcher({
      kind: "codegraph", envFlag: "APERIO_CODEGRAPH",
      store, roots: getAllowlist(), watcherEvents, watcherRegistry,
    });

    // Doc graph watcher
    const { bootPromise: docgraphBoot } = await bootGraphWatcher({
      kind: "docgraph", envFlag: "APERIO_DOCGRAPH",
      store, roots: getAllowlist(), watcherEvents, watcherRegistry,
    });

    // API router
    const boot = { agent: null, scheduler: null, watchdog: null };
    const { createErrorHandler } = await import("./helpers/errorHandler.js");
    const apiRoutes = apiRouter({
      store, version, watcherEvents, watcherRegistry,
      generateEmbedding, folderIndexer,
      getAgent:     () => boot.agent,
      getScheduler: () => boot.scheduler,
      getWatchdog:  () => boot.watchdog,
    });
    app.use("/api", apiRoutes);
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
    const { primaryRoundtable, verifier, roundtableAvailable, roundtableUnavailableReason } =
      await bootRoundtable({ root: __dirname, version, provider, createAgent });

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
      mkdirSync(resolve(RUNTIME_ROOT, "var"), { recursive: true });
      writeFileSync(resolve(RUNTIME_ROOT, "var/bootstrap.lock"), JSON.stringify({
        completedAt: new Date().toISOString(),
        model: agent?.provider?.model ?? null,
        engine: agent?.provider?.name ?? null,
      }));
    } catch { /* non-fatal */ }
    logger.warn("✅ Aperio is ready.");

    // Fire-and-forget: warm pricing cache from OpenRouter (or load from file)
    ensurePricingCache();

    // Background workers
    const { dedup, infer, pruner, logPruner, runPruner } = await createBackgroundWorkers({
      providerName: provider.name, callTool, store, runtimeRoot: RUNTIME_ROOT,
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────
    const gracefulShutdown = createGracefulShutdown({
      markShuttingDown: () => { isShuttingDown = true; },
      watchdog, dedup, infer, pruner, logPruner, runPruner, scheduler, apiRoutes,
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
