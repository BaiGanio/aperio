import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

// ─── Setup ────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const systemPrompt = readFileSync(resolve(__dirname, "prompts/system_prompt.md"), "utf-8");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Model config ─────────────────────────────────────────────────────────────
// Switch models here. Haiku = fast + cheap. Sonnet = smarter. Opus = best.
//
// const MODEL = "claude-opus-4-6";          // Most capable — higher cost
// const MODEL = "claude-sonnet-4-6";        // Balanced — recommended for power users
const MODEL = "claude-haiku-4-5-20251001";   // Fast + cheap — default for daily use

// ─── MCP Client ───────────────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: "node",
  args: [resolve(__dirname, "mcp/index.js")],
});
const mcp = new Client({ name: "aperio-server", version: "1.0.0" });
await mcp.connect(transport);
console.log("✅ MCP server connected");

const { tools: mcpTools } = await mcp.listTools();
const tools = mcpTools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

async function callTool(name, input) {
  const result = await mcp.callTool({ name, arguments: input });
  return result.content?.[0]?.text ?? "No result";
}

// ─── Streaming agentic loop ───────────────────────────────────────────────────
const MAX_HISTORY = 20;

async function runAgentLoop(messages, ws) {
  while (true) {
    const trimmed = messages.length > MAX_HISTORY
      ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
      : messages;

    // ── Streaming request ──────────────────────────────────────
    let fullText = "";
    let toolUses = [];
    let currentToolUse = null;
    let inputJson = "";
    let stopReason = null;
    let contentBlocks = [];

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages: trimmed,
    });

    // Signal start of streaming message
    ws.send(JSON.stringify({ type: "stream_start" }));

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") {
          contentBlocks.push({ type: "text", text: "" });
        } else if (event.content_block.type === "tool_use") {
          currentToolUse = {
            type: "tool_use",
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          };
          inputJson = "";
          contentBlocks.push(currentToolUse);
          // Notify UI which tool is being called
          ws.send(JSON.stringify({ type: "tool", name: event.content_block.name }));
        }
      }

      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          const token = event.delta.text;
          fullText += token;
          // Stream token to client
          ws.send(JSON.stringify({ type: "token", text: token }));
          // Update content block
          const last = contentBlocks[contentBlocks.length - 1];
          if (last?.type === "text") last.text += token;
        } else if (event.delta.type === "input_json_delta") {
          inputJson += event.delta.partial_json;
        }
      }

      if (event.type === "content_block_stop" && currentToolUse) {
        try { currentToolUse.input = JSON.parse(inputJson || "{}"); } catch {}
        toolUses.push({ ...currentToolUse });
        currentToolUse = null;
        inputJson = "";
      }

      if (event.type === "message_delta") {
        stopReason = event.delta.stop_reason;
      }
    }

    // Signal end of streaming
    ws.send(JSON.stringify({ type: "stream_end", text: fullText }));

    // Push assistant message to history
    messages.push({ role: "assistant", content: contentBlocks });

    // ── Tool use ───────────────────────────────────────────────
    if (stopReason === "tool_use" && toolUses.length > 0) {
      const toolResults = [];
      for (const tool of toolUses) {
        const result = await callTool(tool.name, tool.input);
        toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: result });
      }
      messages.push({ role: "user", content: toolResults });
      continue; // loop back for Claude to process tool results
    }

    return fullText;
  }
}

// ─── Express + WebSocket ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, "public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const messages = [];
  let initialized = false;

  ws.send(JSON.stringify({ type: "status", text: "connected" }));

  async function init() {
    messages.push({
      role: "user",
      content: "Load my core memories silently, then greet me in one short sentence. Do not repeat or summarize the memories back to me.",
    });
    ws.send(JSON.stringify({ type: "thinking" }));
    await runAgentLoop(messages, ws);
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
        await runAgentLoop(messages, ws);
        await sendMemories(ws);
      }

      if (data.type === "get_memories") {
        await sendMemories(ws);
      }

      if (data.type === "delete_memory") {
        try {
          await callTool("forget", { id: data.id });
          ws.send(JSON.stringify({ type: "deleted", id: data.id }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", text: `Delete failed: ${err.message}` }));
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", text: err.message }));
    }
  });
});

// ─── Fetch memories ───────────────────────────────────────────────────────────
async function sendMemories(ws) {
  try {
    const result = await callTool("recall", { limit: 50 });
    ws.send(JSON.stringify({ type: "memories", raw: result }));
  } catch (err) {
    console.error("Failed to fetch memories:", err.message);
  }
}

// ─── Memory deduplication job ─────────────────────────────────────────────────
// Runs every 10 minutes — finds near-duplicate memories using pgvector
// and logs them for review (safe mode: logs only, doesn't auto-delete)
const DEDUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEDUP_THRESHOLD   = 0.97;            // cosine similarity — 97% = near-identical

async function runDedup() {
  try {
    const result = await callTool("dedup_memories", { threshold: DEDUP_THRESHOLD, dry_run: true });
    const lines = result.split("\n").filter(l => l.trim());
    if (lines.length > 1) {
      console.log(`\n🧹 Dedup report:\n${result}`);
    }
  } catch (err) {
    // Silently skip if dedup tool not available
  }
}

// Run once on startup (after 30s), then every 10 minutes
setTimeout(() => {
  runDedup();
  setInterval(runDedup, DEDUP_INTERVAL_MS);
}, 30_000);

// ─── REST ─────────────────────────────────────────────────────────────────────
app.get("/api/memories", async (req, res) => {
  try {
    const result = await callTool("recall", { limit: 50 });
    res.json({ raw: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🧠 Aperio UI running at http://localhost:${PORT}\n`);
});
