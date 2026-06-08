import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { createRequire } from "module";
import { execFile } from "child_process";
import dotenv from "dotenv";

import { ensurePort } from "./lib/helpers/ensurePort.js";
import logger from "./lib/helpers/logger.js";
import { runBootstrap, bootstrapEvents, stepState, STEPS } from "./bootstrap.js";

// ─── Global error guards ──────────────────────────────────────────────────────
// Prevent a per-connection exception from crashing the whole server.
// uncaughtException covers sync throws inside EventEmitter callbacks (e.g. the
// ws "connection" handler); unhandledRejection covers async leaks (e.g. an
// await inside a ws "message" callback whose rejection escaped the try/catch).
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  logger.error("Unhandled rejection:", err);
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const require   = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = existsSync(resolve(__dirname, ".env"))
  ? resolve(__dirname, ".env")
  : resolve(__dirname, ".env.example");
dotenv.config({ path: envPath });

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

// ─── Port: free it before we try to bind ─────────────────────────────────────
await ensurePort(PORT);

// ─── Express (always starts immediately — serves setup UI right away) ─────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// ─── Locale detection (Accept-Language + cookie) ──────────────────────────────
// Supported EU locales — must mirror public/scripts/i18n.js.
const SUPPORTED_LOCALES = new Set([
  "en", "bg", "de", "fr", "es", "it", "pt", "nl", "pl", "ro",
  "el", "sv", "da", "fi", "cs", "sk", "sl", "hr", "hu", "et",
  "lv", "lt", "mt", "ga",
]);
const I18N_COOKIE = "aperio_lang";

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
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderHtmlWithLocale("index.html", lang));
});

app.use(express.static(resolve(__dirname, "public"), { index: false }));
app.use("/uploads", express.static(resolve(__dirname, "var/uploads")));
app.use("/scratch", express.static(resolve(__dirname, "var/scratch")));

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
    meta:  getBootstrapMeta(),
    steps: STEPS.map(s => ({ ...s, status: stepState[s.id] })),
  });
});

// ─── Setup wizard: machine specs + model recommendation ──────────────────────
app.get("/api/setup/specs", async (_req, res) => {
  try {
    const { getSpecs } = await import("./lib/helpers/specs.js");
    res.json(getSpecs());
  } catch (err) {
    logger.error("specs failed:", err);
    res.status(500).json({ error: "specs_failed" });
  }
});

// ─── Setup wizard: persist choice → write .env → start bootstrap ─────────────
app.post("/api/setup/config", async (req, res) => {
  if (isBootstrapped() || bootstrapStarted) {
    return res.status(409).json({ error: "already_started" });
  }
  try {
    const { provider, apiKey, model } = req.body ?? {};
    const { writeEnvFromWizard } = await import("./lib/helpers/envFile.js");
    writeEnvFromWizard({ provider, apiKey, model, port: PORT });

    // Reload the freshly-written .env so bootApp + providers see the new values
    // without a server restart.
    dotenv.config({ path: resolve(__dirname, ".env"), override: true });

    bootstrapStarted = true;
    bootstrapEvents.once("complete", async () => {
      logger.info("Bootstrap done — initialising app…");
      await bootApp();
    });
    runBootstrap({
      model: model || process.env.OLLAMA_MODEL || "qwen3:4b",
      skipOllama: String(provider).toLowerCase() !== "ollama",
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
const httpServer = createServer(app);

httpServer.listen(PORT, HOST, async () => {
  const url = `http://${HOST}:${PORT}`;
  logger.warn(`\n✨ Aperio running at ${url}\n`);
  if (HOST !== "127.0.0.1" && HOST !== "::1" && HOST !== "localhost") {
    logger.warn("⚠️  Server is bound to a non-loopback address. Do not expose to untrusted networks.");
  }

  if (isBootstrapped()) {
    // Already set up: skip straight to full app init
    logger.info("✓ Already bootstrapped — starting app.");
    await bootApp();
    openBrowser(`http://localhost:${PORT}`);
  } else if (existsSync(resolve(__dirname, ".env"))) {
    // First run, but a .env already exists (user configured by hand) — preserve
    // the old auto-bootstrap behaviour; the setup page shows progress directly.
    logger.info("First run with existing .env — bootstrapping.");
    bootstrapStarted = true;
    bootstrapEvents.once("complete", async () => { await bootApp(); });
    runBootstrap({
      model: process.env.OLLAMA_MODEL ?? "qwen3:4b",
      skipOllama: (process.env.AI_PROVIDER ?? "").toLowerCase() !== "ollama",
    });
    openBrowser(`http://localhost:${PORT}/setup`);
  } else {
    // First run, no .env: open the wizard. Bootstrap kicks off only after the
    // user picks a provider via POST /api/setup/config.
    logger.info("First run — opening setup wizard.");
    openBrowser(`http://localhost:${PORT}/setup`);
  }
});

// ─── Full app init ────────────────────────────────────────────────────────────
// All heavy imports are dynamic so they don't run until we know deps exist.
async function bootApp() {
  const { getStore }                      = await import("./db/index.js");
  const { createAgent }                   = await import("./lib/agent.js");
  const { ensureOllama }                  = await import("./lib/helpers/startOllama.js");
  const { createWatchdog }                = await import("./lib/helpers/shutdownGuard.js");
  const { deduplicateMemories }           = await import("./lib/workers/deduplicate.js");
  const { inferMemories }                 = await import("./lib/workers/infer.js");
  const { createSessionPruner }           = await import("./lib/workers/session-prune.js");
  const { makeWsHandler }                 = await import("./lib/emitters/handlers/wsHandler.js");
  const { apiRouter }                     = await import("./lib/routes/api.js");
  const { generateEmbedding, initEmbeddings, disposeEmbeddings } = await import("./lib/helpers/embeddings.js");

  // DB
  const store = await getStore();
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
  const { shutdown: shutdownEmbeddings } = await initEmbeddings(store, generateEmbedding);

  // ── Code graph live watcher (opt-in) ──────────────────────────────────────
  // APERIO_CODEGRAPH=on starts a chokidar watcher per APERIO_ALLOWED_PATHS_TO_READ
  // root. Initial repo index can take 20-60s on a fresh boot; run it in the
  // background so the API + WebSocket come up immediately. The /api/codegraph/status
  // endpoint surfaces progress to the Code panel.
  let stopCodegraph = null;
  if (process.env.APERIO_CODEGRAPH === 'on') {
    const { isCodegraphAvailable } = await import("./lib/codegraph/indexer.js");
    if (!isCodegraphAvailable(store)) {
      logger.warn(`[codegraph] APERIO_CODEGRAPH=on but backend has no graph store. Switch DB_BACKEND=sqlite or postgres.`);
    } else {
      const { getAllowlist } = await import("./lib/routes/paths.js");
      const { markEnabled } = await import("./lib/codegraph/status.js");
      markEnabled(getAllowlist());
      // Fire-and-forget: don't block bootApp on the initial index.
      const handlePromise = (async () => {
        try {
          const { startAllWatchers } = await import("./lib/codegraph/watcher.js");
          return await startAllWatchers(store, getAllowlist());
        } catch (err) {
          const { logError } = await import("./lib/helpers/logger.js");
          logError(`[codegraph] watcher boot failed`, err);
          return null;
        }
      })();
      stopCodegraph = async () => {
        const handle = await handlePromise;
        if (handle?.stop) await handle.stop();
      };
    }
  }

  // ── Agents ───────────────────────────────────────────────────────────────
  // The main chat agent always boots from AI_PROVIDER / provider env vars.
  // Round-table mode (two-agent cross-review) is opt-in via ROUNDTABLE_AGENTS
  // and boots TWO ADDITIONAL agents independent of the chat agent.
  // Format: "provider:model,provider:model" — first pair = round-table primary
  // (answerer), second pair = verifier (reviewer). Both entries required;
  // otherwise the Discuss toggle stays disabled.
  const agent = await createAgent({
    root: __dirname,
    version,
    clientName: "aperio-server",
  });
  const { provider, callTool } = agent;

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
  if (primaryRtConfig && verifierConfig) {
    try {
      primaryRoundtable = await createAgent({
        root: __dirname,
        version,
        clientName: "aperio-server-rt-primary",
        providerConfig: primaryRtConfig,
        persona: "primary",
        character: roundtableCharacters[0] ?? null,
      });
      verifier = await createAgent({
        root: __dirname,
        version,
        clientName: "aperio-server-rt-verifier",
        providerConfig: verifierConfig,
        persona: "verifier",
        character: roundtableCharacters[1] ?? null,
      });
      const charTag = (a) => a.character ? ` as "${a.character}"` : "";
      logger.info(`🤝 Round-table: primary = ${primaryRoundtable.provider.name} (${primaryRoundtable.provider.model})${charTag(primaryRoundtable)}, verifier = ${verifier.provider.name} (${verifier.provider.model})${charTag(verifier)}`);
    } catch (err) {
      logger.error(`⚠️  Could not boot round-table agents — Discuss toggle disabled:`, err.message);
      primaryRoundtable = null;
      verifier = null;
    }
  } else if (primaryRtConfig || verifierConfig) {
    logger.warn(`[roundtable] ROUNDTABLE_AGENTS needs TWO "provider:model" pairs — Discuss disabled.`);
  }
  const roundtableAvailable = Boolean(primaryRoundtable && verifier);

  // Ollama
  if (provider.name === "ollama") await ensureOllama();

  // Watchdog
  const watchdog = createWatchdog({
    enabled:   provider.name === "ollama",
    models:    [provider.model, process.env.OLLAMA_MODEL],
    timeoutMs: (Number(process.env.IDLE_TIMEOUT_SECONDS) || 180) * 1000,
  });

  const providerLabel = provider.name === "anthropic"
    ? `Anthropic (${provider.model})`
    : provider.name === "deepseek"
      ? `DeepSeek (${provider.model})`
      : `Ollama (${provider.model})${
          agent.reasoningAdapter.match !== "__noop__"
            ? ` · thinking via ${agent.reasoningAdapter.match}` : ""}`;

  logger.info(`🤖 Provider: ${providerLabel}`);
  logger.info("✅ MCP server connected");

  // Mount API routes and WebSocket *after* everything is ready
  app.use("/api", apiRouter({ agent: { ...agent, version }, store, watchdog }));

  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", HOST]);
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ origin }, cb) => {
      if (!origin) return cb(true); // non-browser clients (curl, native WS libs)
      try {
        const { hostname } = new URL(origin);
        cb(allowedHosts.has(hostname), 403, "Forbidden");
      } catch {
        cb(false, 400, "Bad Request");
      }
    },
  });
  wss.on("connection", makeWsHandler({ agent, primaryRoundtable, verifier, roundtableAvailable, store, __dirname }));

  // Background jobs
  const dedup   = deduplicateMemories(callTool);
  const infer   = inferMemories(callTool);
  const pruner  = createSessionPruner();

  // Graceful shutdown
  // Order matters: the ONNX native runtime must be torn down via its own API
  // before process.exit() runs global C++ destructors. Calling exit() while it
  // has live threads causes "mutex lock failed: Invalid argument".
  let shuttingDown = false;
  async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    // 1. Stop timers so the event loop can drain
    watchdog.stop();
    dedup.stop();
    infer.stop();
    pruner.stop();
    if (stopCodegraph) await stopCodegraph().catch(() => {});

    // 2. Let the current ONNX inference finish, then stop the backfill loop
    await shutdownEmbeddings();

    // 3. Terminate WebSocket clients and close the WS server
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));

    // 4. Stop accepting requests and drain existing connections
    httpServer.closeAllConnections?.();
    await new Promise(resolve => httpServer.close(resolve));

    // 5. Dispose the ONNX inference session — releases its thread pool so the
    //    global destructor sequence won't try to lock already-destroyed mutexes.
    await disposeEmbeddings();
    // Give the ONNX thread pool a tick to finish its own cleanup before the
    // C++ global destructors run. Without this yield the mutex is still locked
    // when process.exit() tears down native memory → "mutex lock failed".
    await new Promise(r => setTimeout(r, 150));

    // 6. Close the DB connection.
    await store.close?.();

    process.exit(0);
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
  const SUPPORTED = new Set(["anthropic", "ollama", "deepseek", "gemini"]);
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
  execFile(cmd, args, err => {
    if (err) logger.error("⚠️  Could not open browser:", err.message);
  });
}