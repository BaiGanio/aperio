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

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const systemPromptBase = readFileSync(resolve(__dirname, "prompts/system_prompt.md"), "utf-8");
const getSystemPrompt = () => `${systemPromptBase}

---
You are running as: ${PROVIDER === "ollama" ? `Ollama (${OLLAMA_MODEL})` : `Anthropic Claude (${ANTHROPIC_MODEL})`}
If asked which model or AI you are, answer accurately using the above.`;

const PROVIDER        = process.env.AI_PROVIDER?.toLowerCase() || "anthropic";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || "llama3.1";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

// Models that emit reasoning tokens in delta.reasoning
const OLLAMA_THINKS = ["deepseek-r1", "qwen3"].some(m => OLLAMA_MODEL.toLowerCase().includes(m));

let provider;
if (PROVIDER === "ollama") {
  provider = { name: "ollama", model: OLLAMA_MODEL, baseURL: `${OLLAMA_BASE_URL}/v1` };
  console.log(`🤖 Provider: Ollama (${OLLAMA_MODEL}) @ ${OLLAMA_BASE_URL}`);
} else {
  provider = { name: "anthropic", model: ANTHROPIC_MODEL, client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) };
  console.log(`🤖 Provider: Anthropic (${ANTHROPIC_MODEL})`);
}

const transport = new StdioClientTransport({ command: "node", args: [resolve(__dirname, "mcp/index.js")] });
const mcp = new Client({ name: "aperio-server", version: "1.0.0" });
await mcp.connect(transport);
console.log("✅ MCP server connected");

const { tools: mcpTools } = await mcp.listTools();
const mcpToolNames = new Set(mcpTools.map(t => t.name));

const anthropicTools = mcpTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

const simplifySchema = (name, schema) => {
  if (name === "recall") return { type: "object", properties: { query: { type: "string", description: "What to search for (optional)" }, limit: { type: "number", description: "Max results (default 10, max 50)" } } };
  if (name === "remember") return { type: "object", required: ["type", "title", "content"], properties: { type: { type: "string", enum: ["fact","preference","project","decision","solution","source","person"] }, title: { type: "string" }, content: { type: "string" }, importance: { type: "number" }, tags: { type: "array", items: { type: "string" } } } };
  return schema;
};

const ollamaTools = mcpTools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: simplifySchema(t.name, t.inputSchema) } }));

async function callTool(name, input) {
  const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
  const result = await mcp.callTool({ name, arguments: args });
  return result.content?.[0]?.text ?? "No result";
}

function extractTextToolCall(text) {
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  const match = stripped.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (!match) return null;
  const toolName = match[1];
  if (!mcpToolNames.has(toolName)) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const params = parsed.parameters ?? parsed.input ?? parsed.arguments ?? {};
    const cleaned = Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== "None" && v !== "null" && v !== null && v !== undefined && v !== ""));
    return { name: toolName, input: cleaned };
  } catch { return null; }
}

const MAX_HISTORY = 20;

async function runAnthropicLoop(messages, ws) {
  while (true) {
    const trimmed = messages.length > MAX_HISTORY ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))] : messages;
    let fullText = "", toolUses = [], currentToolUse = null, inputJson = "", stopReason = null, contentBlocks = [];

    const stream = provider.client.messages.stream({ model: provider.model, max_tokens: 4096, system: getSystemPrompt(), tools: anthropicTools, messages: trimmed });
    ws.send(JSON.stringify({ type: "stream_start" }));

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") { contentBlocks.push({ type: "text", text: "" }); }
        else if (event.content_block.type === "tool_use") { currentToolUse = { type: "tool_use", id: event.content_block.id, name: event.content_block.name, input: {} }; inputJson = ""; contentBlocks.push(currentToolUse); ws.send(JSON.stringify({ type: "tool", name: event.content_block.name })); }
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") { const token = event.delta.text; fullText += token; ws.send(JSON.stringify({ type: "token", text: token })); const last = contentBlocks[contentBlocks.length - 1]; if (last?.type === "text") last.text += token; }
        else if (event.delta.type === "input_json_delta") { inputJson += event.delta.partial_json; }
      }
      if (event.type === "content_block_stop" && currentToolUse) { try { currentToolUse.input = JSON.parse(inputJson || "{}"); } catch {} toolUses.push({ ...currentToolUse }); currentToolUse = null; inputJson = ""; }
      if (event.type === "message_delta") { stopReason = event.delta.stop_reason; }
    }

    ws.send(JSON.stringify({ type: "stream_end", text: fullText }));
    messages.push({ role: "assistant", content: contentBlocks });

    if (stopReason === "tool_use" && toolUses.length > 0) {
      const toolResults = [];
      for (const tool of toolUses) { const result = await callTool(tool.name, tool.input); toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: result }); }
      messages.push({ role: "user", content: toolResults });
      continue;
    }
    return fullText;
  }
}

async function runOllamaLoop(messages, ws) {
  while (true) {
    const trimmed = messages.length > MAX_HISTORY ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))] : messages;

    const openaiMessages = [
      { role: "system", content: getSystemPrompt() },
      ...trimmed.map(m => {
        if (Array.isArray(m.content) && m.content[0]?.type === "tool_result") return { role: "tool", tool_call_id: m.content[0].tool_use_id, content: m.content[0].content };
        if (Array.isArray(m.content)) {
          const text = m.content.filter(b => b.type === "text").map(b => b.text).join("");
          const toolCalls = m.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
          return { role: m.role, content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    try {
      const health = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!health.ok) throw new Error("Ollama not ready");
    } catch {
      const msg = `Ollama is not running at ${OLLAMA_BASE_URL}.\n\nFix:\n1. Install Ollama at https://ollama.ai\n2. Run: ollama serve\n3. Pull a model: ollama pull ${OLLAMA_MODEL}\n4. Restart Aperio`;
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: "⚠️ **Ollama not reachable**\n\n" + msg }));
      ws.send(JSON.stringify({ type: "stream_end", text: msg }));
      return msg;
    }

    let response;
    try {
      response = await fetch(`${provider.baseURL}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: provider.model, messages: openaiMessages, tools: ollamaTools, stream: true }) });
    } catch (fetchErr) {
      const msg = `Could not connect to Ollama: ${fetchErr.message}`;
      ws.send(JSON.stringify({ type: "stream_start" })); ws.send(JSON.stringify({ type: "token", text: "⚠️ " + msg })); ws.send(JSON.stringify({ type: "stream_end", text: msg }));
      return msg;
    }

    if (!response.ok) {
      const errText = await response.text();
      const msg = `Ollama error ${response.status}: ${errText}`;
      ws.send(JSON.stringify({ type: "stream_start" })); ws.send(JSON.stringify({ type: "token", text: "⚠️ " + msg })); ws.send(JSON.stringify({ type: "stream_end", text: msg }));
      return msg;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "", reasoningText = "", toolCalls = [], sentReasoningStart = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]");

      for (const line of lines) {
        let data; try { data = JSON.parse(line.slice(6)); } catch { continue; }
        const delta = data.choices?.[0]?.delta;
        if (!delta) continue;

        // Reasoning tokens
        if (OLLAMA_THINKS && delta.reasoning) {
          reasoningText += delta.reasoning;
          if (!sentReasoningStart) { sentReasoningStart = true; ws.send(JSON.stringify({ type: "reasoning_start" })); }
          ws.send(JSON.stringify({ type: "reasoning_token", text: delta.reasoning }));
        }

        // Content tokens — NEVER stream live for thinking models (always buffer)
        if (delta.content) {
          fullText += delta.content;
          if (!OLLAMA_THINKS) {
            ws.send(JSON.stringify({ type: "token", text: delta.content }));
          }
        }

        // Tool call deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) { toolCalls[tc.index] = { id: tc.id || `call_${tc.index}`, name: "", args: "" }; ws.send(JSON.stringify({ type: "tool", name: tc.function?.name || "thinking…" })); }
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
            }
          }
        }
      }
    }

    // ── THINKING MODEL post-stream ─────────────────────────────
    if (OLLAMA_THINKS) {
      const intercepted = fullText.trim() ? extractTextToolCall(fullText) : null;

      if (intercepted) {
        // Tool call hidden in content (Qwen3 text-mode tool call)
        if (sentReasoningStart) ws.send(JSON.stringify({ type: "retract_done" }));
        ws.send(JSON.stringify({ type: "tool", name: intercepted.name }));
        ws.send(JSON.stringify({ type: "stream_end", text: "" }));
        const result = await callTool(intercepted.name, intercepted.input);
        const fakeId = `intercept_${Date.now()}`;
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: fakeId, name: intercepted.name, input: intercepted.input }] });
        messages.push({ role: "user",      content: [{ type: "tool_result", tool_use_id: fakeId, content: result }] });
        sentReasoningStart = false;
        continue;
      }

      if (toolCalls.length > 0) {
        // Real API tool calls
        if (sentReasoningStart) ws.send(JSON.stringify({ type: "retract_done" }));
        const assistantMsg = { role: "assistant", content: [] };
        if (fullText) assistantMsg.content.push({ type: "text", text: fullText });
        toolCalls.forEach(tc => assistantMsg.content.push({ type: "tool_use", id: tc.id, name: tc.name, input: (() => { try { return JSON.parse(tc.args || "{}"); } catch { return {}; } })() }));
        messages.push(assistantMsg);
        const toolResults = [];
        for (const tc of toolCalls) { let input = {}; try { input = JSON.parse(tc.args || "{}"); } catch {} const result = await callTool(tc.name, input); toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result }); }
        messages.push({ role: "user", content: toolResults });
        sentReasoningStart = false;
        continue;
      }

      // Normal text response — close reasoning, stream content fresh
      if (sentReasoningStart) ws.send(JSON.stringify({ type: "retract_done" }));
      ws.send(JSON.stringify({ type: "stream_start" }));
      for (let i = 0; i < fullText.length; i += 8) ws.send(JSON.stringify({ type: "token", text: fullText.slice(i, i + 8) }));
      ws.send(JSON.stringify({ type: "stream_end", text: fullText }));
      messages.push({ role: "assistant", content: [{ type: "text", text: fullText }] });
      return fullText;
    }

    // ── NON-THINKING MODEL post-stream ─────────────────────────
    if (toolCalls.length === 0 && fullText.trim()) {
      const intercepted = extractTextToolCall(fullText);
      if (intercepted) {
        ws.send(JSON.stringify({ type: "retract", reasoning: "" }));
        ws.send(JSON.stringify({ type: "tool", name: intercepted.name }));
        ws.send(JSON.stringify({ type: "stream_end", text: "" }));
        const result = await callTool(intercepted.name, intercepted.input);
        const fakeId = `intercept_${Date.now()}`;
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: fakeId, name: intercepted.name, input: intercepted.input }] });
        messages.push({ role: "user",      content: [{ type: "tool_result", tool_use_id: fakeId, content: result }] });
        continue;
      }
    }

    ws.send(JSON.stringify({ type: "stream_end", text: fullText }));

    const assistantMsg = { role: "assistant", content: [] };
    if (fullText) assistantMsg.content.push({ type: "text", text: fullText });
    toolCalls.forEach(tc => assistantMsg.content.push({ type: "tool_use", id: tc.id, name: tc.name, input: (() => { try { return JSON.parse(tc.args || "{}"); } catch { return {}; } })() }));
    messages.push(assistantMsg);

    if (toolCalls.length > 0) {
      const toolResults = [];
      for (const tc of toolCalls) { let input = {}; try { input = JSON.parse(tc.args || "{}"); } catch {} const result = await callTool(tc.name, input); toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result }); }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    return fullText;
  }
}

async function runAgentLoop(messages, ws) {
  if (provider.name === "ollama") return runOllamaLoop(messages, ws);
  return runAnthropicLoop(messages, ws);
}

const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, "public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const messages = [];
  let initialized = false;

  ws.send(JSON.stringify({ type: "status", text: "connected" }));
  ws.send(JSON.stringify({ type: "provider", name: provider.name, model: provider.model }));

  async function init() {
    messages.push({ role: "user", content: "Load my core memories silently, then greet me in one short sentence. Do not repeat or summarize the memories back to me." });
    ws.send(JSON.stringify({ type: "thinking" }));
    await runAgentLoop(messages, ws);
    await sendMemories(ws);
  }

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "init" && !initialized) { initialized = true; await init(); return; }
      if (data.type === "chat") { messages.push({ role: "user", content: data.text }); ws.send(JSON.stringify({ type: "thinking" })); await runAgentLoop(messages, ws); await sendMemories(ws); }
      if (data.type === "get_memories") { await sendMemories(ws); }
      if (data.type === "delete_memory") { try { await callTool("forget", { id: data.id }); ws.send(JSON.stringify({ type: "deleted", id: data.id })); } catch (err) { ws.send(JSON.stringify({ type: "error", text: `Delete failed: ${err.message}` })); } }
    } catch (err) { ws.send(JSON.stringify({ type: "error", text: err.message })); }
  });
});

async function sendMemories(ws) {
  try { const result = await callTool("recall", { limit: 50 }); ws.send(JSON.stringify({ type: "memories", raw: result })); }
  catch (err) { console.error("Failed to fetch memories:", err.message); }
}

const DEDUP_INTERVAL_MS = 10 * 60 * 1000;
const DEDUP_THRESHOLD   = 0.97;
async function runDedup() { try { const result = await callTool("dedup_memories", { threshold: DEDUP_THRESHOLD, dry_run: true }); const lines = result.split("\n").filter(l => l.trim()); if (lines.length > 1) console.log(`\n🧹 Dedup report:\n${result}`); } catch {} }
setTimeout(() => { runDedup(); setInterval(runDedup, DEDUP_INTERVAL_MS); }, 30_000);

app.get("/api/provider", (req, res) => res.json({ provider: provider.name, model: provider.model }));
app.get("/api/memories", async (req, res) => { try { const result = await callTool("recall", { limit: 50 }); res.json({ raw: result }); } catch (err) { res.status(500).json({ error: err.message }); } });

const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => { console.log(`\n✦ Aperio running at http://localhost:${PORT}\n`); });