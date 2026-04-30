import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { createRequire } from "module";
import { execFile } from "child_process";
import dotenv from "dotenv";

import { getStore } from "./db/index.js";
import { createAgent } from "./lib/agent.js";
import { ensureOllama } from "./lib/helpers/startOllama.js";
import { ensurePort } from "./lib/helpers/ensurePort.js";
import { createWatchdog } from "./lib/helpers/shutdownGuard.js";
import { deduplicateMemories } from "./lib/workers/deduplicate.js";
import { makeWsHandler } from "./lib/emitters/handlers/wsHandler.js";
import { apiRouter } from "./lib/routes/api.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const require   = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = existsSync(resolve(__dirname, ".env"))
  ? resolve(__dirname, ".env")
  : resolve(__dirname, ".env.example");
dotenv.config({ path: envPath });

const { version } = require("./package.json");
console.log(`🚀 Starting Aperio server (version ${version})...`);

// ─── DB ───────────────────────────────────────────────────────────────────────
const store = await getStore();

// ─── Agent ────────────────────────────────────────────────────────────────────
const agent = await createAgent({ root: __dirname, version, clientName: "aperio-server" });
const { provider, callTool, runAgentLoop } = agent;

// ─── Port: free it before we try to bind ─────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3000);
await ensurePort(PORT);

// ─── Ollama: ensure running silently before serving ───────────────────────────
if (provider.name === "ollama") await ensureOllama();

// ─── Ollama watchdog: stop Ollama and shut down the server X seconds after closing the browser ───────────
const ownedModels = [process.env.OLLAMA_EMBEDDING_MODEL, process.env.OLLAMA_MODEL];
const watchdog = createWatchdog({ enabled: provider.name === "ollama", models: [provider.model, ...ownedModels], timeoutMs: Number(process.env.IDLE_TIMEOUT_SECONDS)*1000});

const providerLabel = provider.name === "anthropic"
  ? `Anthropic (${provider.model})`
  : `Ollama (${provider.model})${agent.reasoningAdapter.match !== "__noop__" ? ` · thinking via ${agent.reasoningAdapter.match}` : ""}`;

console.log(`🤖 Provider: ${providerLabel}`);
console.log("✅ MCP server connected");

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());                                    // must come first
app.use(express.static(resolve(__dirname, "public")));
app.use("/api", apiRouter({ agent: { ...agent, version }, store, watchdog }));

// ─── WebSocket ────────────────────────────────────────────────────────────────
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", makeWsHandler({ agent, store, __dirname }));

// ─── Background jobs ─────────────────────────────────────────────────────────
deduplicateMemories(callTool);

// ─── Graceful shutdown: disarm watchdog so we don't race with SIGTERM ─────────
process.on("SIGTERM", () => { watchdog.stop(); process.exit(0); });
process.on("SIGINT",  () => { watchdog.stop(); process.exit(0); });

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("✅ Server root:", process.cwd());
console.log("✅ Static files:", resolve(__dirname, "public"));

httpServer.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n✨ Aperio running at ${url}\n`);

  const [cmd, ...args] =
    process.platform === "darwin" ? ["open",    url]
    : process.platform === "win32"  ? ["cmd", "/c", "start", url]
    : ["xdg-open", url];
  execFile(cmd, args, (err) => {
    if (err) console.error("⚠️  Could not open browser:", err.message);
  });
});