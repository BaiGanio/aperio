import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";
import { createRequire } from "module";
import { getStore, isDockerAvailable } from "./db/index.js";
import { exec } from "child_process";
import { createAgent, makeWsEmitter, parseMemoriesRaw } from "./lib/agent.js";

const require   = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = existsSync(resolve(__dirname, ".env")) 
  ? resolve(__dirname, ".env") 
  : resolve(__dirname, ".env.example");
dotenv.config({ path: envPath });

const { version } = require("./package.json");

// ─── DB ───────────────────────────────────────────────────────────────────────
const store = await getStore();

// ─── Agent ────────────────────────────────────────────────────────────────────
const agent = await createAgent({ root: __dirname, version, clientName: "aperio-server" });
const { provider, callTool, runAgentLoop, handleRememberIntent, fetchMemories, buildGreeting, OLLAMA_NO_TOOLS } = agent;

console.log(
  provider.name === "ollama"
    ? `🤖 Provider: Ollama (${provider.model})`
    : `🤖 Provider: Anthropic (${provider.model})`
);
console.log("✅ MCP server connected");

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();

app.get("/api/version",  (_, res) => res.json({ version }));
app.get("/api/provider", (_, res) => res.json({ provider: provider.name, model: provider.model }));
app.get("/api/config",   (_, res) => res.json({ backend: process.env.DB_BACKEND || "lancedb" }));

app.get("/api/memories", async (req, res) => {
  try {
    const records = await store.table.query().limit(500).toArray();
    return res.json({ raw: records });
  } catch (e) {
    console.error("Server Error:", e);
    if (!res.headersSent) return res.status(500).json({ error: e.message });
  }
});

app.use(express.json());
app.use(express.static(resolve(__dirname, "public")));

// ─── WebSocket ────────────────────────────────────────────────────────────────
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const messages        = [];
  let   initialized     = false;
  let   abortController = null;

  const emitter = makeWsEmitter(ws);

  ws.send(JSON.stringify({ type: "status",   text: "connected" }));
  ws.send(JSON.stringify({
    type: "provider", 
    name: provider.name, 
    model: provider.model, 
    db: isDockerAvailable() ? "postgres" : "lancedb",
  }));

  async function init() {
    // Push memories to sidebar immediately
    await sendMemories(ws);

    messages.push({ role: "user", content: await buildGreeting() });

    const getAbort = () => abortController;
    const setAbort = (c) => { abortController = c; };

    await runAgentLoop(
      messages, emitter,
      provider.name === "ollama" ? { noTools: true } : {},
      getAbort, setAbort
    );
    await sendMemories(ws);
  }

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "init" && !initialized) {
        initialized = true;
        await init();
        return;
      }

      if (data.type === "chat") {
        messages.push({ role: "user", content: data.text });
        ws.send(JSON.stringify({ type: "thinking" }));

        if (OLLAMA_NO_TOOLS && /^remember\s+that\b/i.test(data.text.trim())) {
          console.log("🧠 remember intent | text:", data.text.substring(0, 40));
          await handleRememberIntent(data.text, emitter);
        }

        const getAbort = () => abortController;
        const setAbort = (c) => { abortController = c; };
        await runAgentLoop(messages, emitter, {}, getAbort, setAbort);
        await sendMemories(ws);
        return;
      }

      if (data.type === "stop") {
        if (abortController) { abortController.abort(); abortController = null; }
        ws.send(JSON.stringify({ type: "stream_end", text: "" }));
        return;
      }

      if (data.type === "get_memories") { await sendMemories(ws); return; }

      if (data.type === "delete_memory") {
        try {
          await callTool("forget", { id: data.id });
          ws.send(JSON.stringify({ type: "deleted", id: data.id }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", text: `Delete failed: ${err.message}` }));
        }
        return;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", text: err.message }));
    }
  });
});

// ─── Memory helpers ───────────────────────────────────────────────────────────
async function sendMemories(ws) {
  try {
    const { parsed } = await fetchMemories();
    ws.send(JSON.stringify({ type: "memories", memories: parsed }));
  } catch (err) { console.error("Failed to fetch memories:", err.message); }
}

// ─── Background dedup ─────────────────────────────────────────────────────────
const DEDUP_INTERVAL_MS = 10 * 60 * 1000;
async function runDedup() {
  try {
    const r = await callTool("dedup_memories", { threshold: 0.97, dry_run: true });
    if (r.split("\n").filter(l => l.trim()).length > 1) console.log(`🧹 Dedup:\n${r}`);
  } catch {}
}
setTimeout(() => { runDedup(); setInterval(runDedup, DEDUP_INTERVAL_MS); }, 30_000);

// ─── Start ────────────────────────────────────────────────────────────────────
console.error("✅ Server is running from:", process.cwd());
console.error("✅ UI static file path:", resolve(__dirname, "public"));

const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n✨ Aperio running at ${url}\n`);
  // Auto-open browser — works whether launched via shell script or npm directly
  const cmd = process.platform === "darwin" ? `open "${url}"`
             : process.platform === "win32"  ? `start "${url}"`
             : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.error("⚠️  Could not open browser:", err.message); });
});