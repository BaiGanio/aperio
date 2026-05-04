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
const LOCK_FILE = resolve(__dirname, ".bootstrap.lock");

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
app.use(express.static(resolve(__dirname, "public")));

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
  res.sendFile(resolve(__dirname, "public", "setup.html"));
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

httpServer.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  logger.warn(`\n✨ Aperio running at ${url}\n`);

  if (isBootstrapped()) {
    // Already set up: skip straight to full app init
    logger.info("✓ Already bootstrapped — starting app.");
    await bootApp();
    openBrowser(url);
  } else {
    // First run: open the setup page, run bootstrap in the background
    logger.info("First run — opening setup UI.");
    openBrowser(`${url}/setup`);
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
  const { makeWsHandler }                 = await import("./lib/emitters/handlers/wsHandler.js");
  const { apiRouter }                     = await import("./lib/routes/api.js");
  const { generateEmbedding, initEmbeddings } = await import("./lib/helpers/embeddings.js");

  // DB
  const store = await getStore();
  await initEmbeddings(store, generateEmbedding);

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

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", makeWsHandler({ agent, store, __dirname }));

  // Background jobs
  deduplicateMemories(callTool);

  // Graceful shutdown
  process.on("SIGTERM", () => { watchdog.stop(); process.exit(0); });
  process.on("SIGINT",  () => { watchdog.stop(); process.exit(0); });
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