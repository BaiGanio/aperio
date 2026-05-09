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

// ─── Port: free it before we try to bind ─────────────────────────────────────
await ensurePort(PORT);

// ─── Express (always starts immediately — serves setup UI right away) ─────────
const app = express();
app.use(express.json());

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

// ─── Bootstrap guard middleware ───────────────────────────────────────────────
// Until .bootstrap.lock exists every request redirects to /setup,
// except the setup page itself and the bootstrap API endpoints.
app.use((req, res, next) => {
  if (isBootstrapped()) return next();

  const bypass =
    req.path.startsWith("/setup") ||
    req.path.startsWith("/api/bootstrap") ||
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
    meta:  getBootstrapMeta(),
    steps: STEPS.map(s => ({ ...s, status: stepState[s.id] })),
  });
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
  } else {
    // First run: open the setup page, run bootstrap in the background
    logger.info("First run — opening setup UI.");
    openBrowser(`http://localhost:${PORT}/setup`);
    runBootstrap({ model: process.env.OLLAMA_MODEL ?? "gemma3:4b" });

    // Wire the full app once bootstrap finishes (no restart needed)
    bootstrapEvents.once("complete", async () => {
      logger.info("Bootstrap done — initialising app…");
      await bootApp();
    });
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
  const { makeWsHandler }                 = await import("./lib/emitters/handlers/wsHandler.js");
  const { apiRouter }                     = await import("./lib/routes/api.js");
  const { generateEmbedding, initEmbeddings } = await import("./lib/helpers/embeddings.js");

  // DB
  const store = await getStore();
  const { shutdown: shutdownEmbeddings } = await initEmbeddings(store, generateEmbedding);

  // Agent
  const agent = await createAgent({ root: __dirname, version, clientName: "aperio-server" });
  const { provider, callTool } = agent;

  // Ollama
  if (provider.name === "ollama") await ensureOllama();

  // Watchdog
  const watchdog = createWatchdog({
    enabled:   provider.name === "ollama",
    models:    [provider.model, process.env.OLLAMA_MODEL],
    timeoutMs: Number(process.env.IDLE_TIMEOUT_SECONDS) * 1000,
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
  wss.on("connection", makeWsHandler({ agent, store, __dirname }));

  // Background jobs
  const dedup  = deduplicateMemories(callTool);
  const infer  = inferMemories(callTool);

  // Graceful shutdown
  // We intentionally avoid process.exit() — calling it while LanceDB's Tokio
  // runtime or ONNX Runtime threads are active destroys their mutexes mid-use,
  // causing the "mutex lock failed: Invalid argument" abort. Instead we close
  // every open handle so Node drains the event loop and exits cleanly on its own.
  let shuttingDown = false;
  async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    // 1. Stop timers so the event loop can drain
    watchdog.stop();
    dedup.stop();
    infer.stop();

    // 2. Let the current ONNX inference finish, then stop the backfill loop
    await shutdownEmbeddings();

    // 3. Terminate WebSocket clients and close the WS server
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));

    // 4. Stop accepting requests and drain existing connections
    httpServer.closeAllConnections?.();
    await new Promise(resolve => httpServer.close(resolve));

    // 5. Release the DB connection pool (Postgres only; LanceDB is embedded)
    await store.close?.();

    // ONNX/LanceDB native threads outlive the JS event loop — Node won't drain
    // on its own. By this point shutdownEmbeddings() has already waited for any
    // in-flight ONNX call to finish, so calling exit here is safe.
    process.exit(0);
  }
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT",  gracefulShutdown);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function openBrowser(url) {
  const [cmd, ...args] =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", url]
    : ["xdg-open", url];
  execFile(cmd, args, err => {
    if (err) logger.error("⚠️  Could not open browser:", err.message);
  });
}