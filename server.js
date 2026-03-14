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

// Models that stream reasoning in delta.reasoning
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

const anthropicTools = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

const simplifySchema = (name) => {
  if (name === "recall") return { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } };
  if (name === "remember") return { type: "object", required: ["type","title","content"], properties: { type: { type: "string", enum: ["fact","preference","project","decision","solution","source","person"] }, title: { type: "string" }, content: { type: "string" }, importance: { type: "number" }, tags: { type: "array", items: { type: "string" } } } };
  return mcpTools.find(t => t.name === name)?.inputSchema ?? {};
};

const ollamaTools = mcpTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: simplifySchema(t.name) } }));

async function callTool(name, input) {
  const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
  const result = await mcp.callTool({ name, arguments: args });
  return result.content?.[0]?.text ?? "No result";
}

function extractTextToolCall(text) {
  // Match a JSON block (with or without fences) that looks like a tool call
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();
  const match = jsonStr.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (!match) return null;
  if (!mcpToolNames.has(match[1])) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const params = parsed.parameters ?? parsed.input ?? parsed.arguments ?? {};
    const cleaned = Object.fromEntries(Object.entries(params).filter(([,v]) => v != null && v !== "" && v !== "None" && v !== "null"));
    // Extract any text after the JSON block / fences as a trailing response
    let trailing = "";
    if (fenceMatch) {
      trailing = text.slice(text.indexOf(fenceMatch[0]) + fenceMatch[0].length).trim();
    } else {
      trailing = text.slice(text.indexOf(match[0]) + match[0].length).trim();
    }
    // Strip common model artifacts like "Response: " prefix
    trailing = trailing.replace(/^[-–—\s]*(?:Response|Result|Answer|Output)\s*:\s*/i, "").trim();
    return { name: match[1], input: cleaned, trailing };
  } catch { return null; }
}

const MAX_HISTORY = 20;

// ─── Anthropic loop ───────────────────────────────────────────────────────────
async function runAnthropicLoop(messages, ws) {
  while (true) {
    const trimmed = messages.length > MAX_HISTORY ? [messages[0], ...messages.slice(-(MAX_HISTORY-1))] : messages;
    let fullText = "", toolUses = [], currentToolUse = null, inputJson = "", stopReason = null, contentBlocks = [];

    const stream = provider.client.messages.stream({ model: provider.model, max_tokens: 4096, system: getSystemPrompt(), tools: anthropicTools, messages: trimmed });
    ws.send(JSON.stringify({ type: "stream_start" }));

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") contentBlocks.push({ type: "text", text: "" });
        else if (event.content_block.type === "tool_use") {
          currentToolUse = { type: "tool_use", id: event.content_block.id, name: event.content_block.name, input: {} };
          inputJson = ""; contentBlocks.push(currentToolUse);
          ws.send(JSON.stringify({ type: "tool", name: event.content_block.name }));
        }
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          fullText += event.delta.text;
          ws.send(JSON.stringify({ type: "token", text: event.delta.text }));
          const last = contentBlocks[contentBlocks.length-1];
          if (last?.type === "text") last.text += event.delta.text;
        } else if (event.delta.type === "input_json_delta") inputJson += event.delta.partial_json;
      }
      if (event.type === "content_block_stop" && currentToolUse) {
        try { currentToolUse.input = JSON.parse(inputJson || "{}"); } catch {}
        toolUses.push({ ...currentToolUse }); currentToolUse = null; inputJson = "";
      }
      if (event.type === "message_delta") stopReason = event.delta.stop_reason;
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

// ─── Ollama loop ──────────────────────────────────────────────────────────────
async function runOllamaLoop(messages, ws) {
  while (true) {
    const trimmed = messages.length > MAX_HISTORY ? [messages[0], ...messages.slice(-(MAX_HISTORY-1))] : messages;

    const openaiMessages = [
      { role: "system", content: getSystemPrompt() },
      ...trimmed.map(m => {
        if (Array.isArray(m.content) && m.content[0]?.type === "tool_result")
          return { role: "tool", tool_call_id: m.content[0].tool_use_id, content: m.content[0].content };
        if (Array.isArray(m.content)) {
          const text = m.content.filter(b => b.type === "text").map(b => b.text).join("");
          const tcs = m.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
          return { role: m.role, content: text || null, ...(tcs.length ? { tool_calls: tcs } : {}) };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    // Health check
    try {
      const h = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!h.ok) throw new Error();
    } catch {
      const msg = `Ollama is not running. Fix:\n1. ollama serve\n2. ollama pull ${OLLAMA_MODEL}`;
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: "⚠️ " + msg }));
      ws.send(JSON.stringify({ type: "stream_end", text: msg }));
      return msg;
    }

    let response;
    try {
      response = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: provider.model, messages: openaiMessages, ...(OLLAMA_THINKS ? {} : { tools: ollamaTools }), stream: true }),
      });
    } catch (e) {
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: "⚠️ " + e.message }));
      ws.send(JSON.stringify({ type: "stream_end", text: e.message }));
      return e.message;
    }

    if (!response.ok) {
      const err = await response.text();
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: "⚠️ Ollama error: " + err }));
      ws.send(JSON.stringify({ type: "stream_end", text: err }));
      return err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "", reasoningText = "", toolCalls = [], sentReasoningStart = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]");
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

        // Content — always stream live; client decides whether to show or discard
        if (delta.content) {
          fullText += delta.content;
          ws.send(JSON.stringify({ type: "token", text: delta.content }));
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) { toolCalls[tc.index] = { id: tc.id || `call_${tc.index}`, name: "", args: "" }; ws.send(JSON.stringify({ type: "tool", name: tc.function?.name || "…" })); }
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
            }
          }
        }
      }
    }

    console.log("🔍 thinking post-stream | fullText:", fullText.substring(0,80), "| toolCalls:", toolCalls.length);
    // ── Thinking model post-stream ─────────────────────────────
    if (OLLAMA_THINKS) {
      const intercepted = fullText.trim() ? extractTextToolCall(fullText) : null;

      if (intercepted) {
        // Text-mode tool call (Qwen3 ignores tools API)
        if (sentReasoningStart) ws.send(JSON.stringify({ type: "reasoning_done" }));
        ws.send(JSON.stringify({ type: "tool", name: intercepted.name }));
       //ws.send(JSON.stringify({ type: "stream_end", text: "" }));
        const result = await callTool(intercepted.name, intercepted.input);
        const id = `intercept_${Date.now()}`;
        messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: intercepted.name, input: intercepted.input }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] });
        sentReasoningStart = false;
        // If model already provided a response after the tool call, use it directly
        if (intercepted.trailing) {
          ws.send(JSON.stringify({ type: "stream_start" }));
          ws.send(JSON.stringify({ type: "stream_end", text: intercepted.trailing }));
          messages.push({ role: "assistant", content: [{ type: "text", text: intercepted.trailing }] });
          return intercepted.trailing;
        }
        continue;
      }

      if (toolCalls.length > 0) {
        if (sentReasoningStart) ws.send(JSON.stringify({ type: "reasoning_done" }));
        const am = { role: "assistant", content: [] };
        if (fullText) am.content.push({ type: "text", text: fullText });
        toolCalls.forEach(tc => am.content.push({ type: "tool_use", id: tc.id, name: tc.name, input: (() => { try { return JSON.parse(tc.args||"{}"); } catch { return {}; } })() }));
        messages.push(am);
        const results = [];
        for (const tc of toolCalls) { let inp = {}; try { inp = JSON.parse(tc.args||"{}"); } catch {} results.push({ type: "tool_result", tool_use_id: tc.id, content: await callTool(tc.name, inp) }); }
        messages.push({ role: "user", content: results });
        sentReasoningStart = false;
        continue;
      }
      console.log("🟢 THINKING normal response");
      // Normal response — signal reasoning done, send full text instantly
      if (sentReasoningStart) ws.send(JSON.stringify({ type: "reasoning_done" }));
      ws.send(JSON.stringify({ type: "stream_start" }));
      for (const word of fullText.split(" ")) {
      ws.send(JSON.stringify({ type: "token", text: word + " " }));
      await new Promise(r => setTimeout(r, 28));
      }
    
      ws.send(JSON.stringify({ type: "stream_end", text: fullText }));
      messages.push({ role: "assistant", content: [{ type: "text", text: fullText }] });
      return fullText;
    }

    console.log("🔍 post-stream | fullText:", fullText.substring(0,80), "| toolCalls:", toolCalls.length);
    // ── Non-thinking model post-stream ─────────────────────────

    // API tool calls — execute silently and loop
    if (toolCalls.length > 0) {
      const am = { role: "assistant", content: [] };
      if (fullText) am.content.push({ type: "text", text: fullText });
      toolCalls.forEach(tc => am.content.push({ type: "tool_use", id: tc.id, name: tc.name, input: (() => { try { return JSON.parse(tc.args||"{}"); } catch { return {}; } })() }));
      messages.push(am);
      const results = [];
      for (const tc of toolCalls) {
        let inp = {}; try { inp = JSON.parse(tc.args||"{}"); } catch {}
        results.push({ type: "tool_result", tool_use_id: tc.id, content: await callTool(tc.name, inp) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    // Text-mode tool call (model output JSON instead of using tools API)
    if (fullText.trim()) {
      const intercepted = extractTextToolCall(fullText);
      if (intercepted) {
        ws.send(JSON.stringify({ type: "retract" })); // remove any streamed JSON from UI
        ws.send(JSON.stringify({ type: "tool", name: intercepted.name }));
        const result = await callTool(intercepted.name, intercepted.input);
        const id = `intercept_${Date.now()}`;
        messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: intercepted.name, input: intercepted.input }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] });
        // If model already provided a response after the tool call, use it directly
        if (intercepted.trailing) {
          ws.send(JSON.stringify({ type: "stream_start" }));
          ws.send(JSON.stringify({ type: "stream_end", text: intercepted.trailing }));
          messages.push({ role: "assistant", content: [{ type: "text", text: intercepted.trailing }] });
          return intercepted.trailing;
        }
        continue;
      }
    }
    console.log("🟡 NON-THINKING normal response");
    // Normal response — stream to UI
    ws.send(JSON.stringify({ type: "stream_start" }));
    ws.send(JSON.stringify({ type: "stream_end", text: fullText }));
    messages.push({ role: "assistant", content: [{ type: "text", text: fullText }] });
    return fullText;
  }
}

async function runAgentLoop(messages, ws) {
  return provider.name === "ollama" ? runOllamaLoop(messages, ws) : runAnthropicLoop(messages, ws);
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
  ws.send(JSON.stringify({ type: "provider", name: provider.name, model: provider.model }));

  async function init() {
    await sendMemories(ws); // load sidebar immediately

    // Load memories server-side and inject directly — no tool calls needed on init
    let memoriesContext = "";
    try {
      const raw = await callTool("recall", { limit: 50 });
      if (raw && raw.trim() && !raw.includes("No memories")) {
        memoriesContext = `\n\nHere is what you know about the user:\n${raw}`;
      }
    } catch {}

    messages.push({
      role: "user",
      content: `Greet me in one short friendly sentence. Do not use any tools.${memoriesContext}`
    });

    ws.send(JSON.stringify({ type: "thinking" }));
    await runAgentLoop(messages, ws);
    await sendMemories(ws);
  }

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "init" && !initialized) { initialized = true; await init(); return; }
      if (data.type === "chat") { messages.push({ role: "user", content: data.text }); ws.send(JSON.stringify({ type: "thinking" })); await runAgentLoop(messages, ws); await sendMemories(ws); }
      if (data.type === "get_memories") await sendMemories(ws);
      if (data.type === "delete_memory") {
        try { await callTool("forget", { id: data.id }); ws.send(JSON.stringify({ type: "deleted", id: data.id })); }
        catch (err) { ws.send(JSON.stringify({ type: "error", text: `Delete failed: ${err.message}` })); }
      }
    } catch (err) { ws.send(JSON.stringify({ type: "error", text: err.message })); }
  });
});

async function sendMemories(ws) {
  try { ws.send(JSON.stringify({ type: "memories", raw: await callTool("recall", { limit: 50 }) })); }
  catch (err) { console.error("Failed to fetch memories:", err.message); }
}

const DEDUP_INTERVAL_MS = 10 * 60 * 1000;
async function runDedup() {
  try { const r = await callTool("dedup_memories", { threshold: 0.97, dry_run: true }); if (r.split("\n").filter(l=>l.trim()).length > 1) console.log(`🧹 Dedup:\n${r}`); } catch {}
}
setTimeout(() => { runDedup(); setInterval(runDedup, DEDUP_INTERVAL_MS); }, 30_000);

app.get("/api/provider", (_, res) => res.json({ provider: provider.name, model: provider.model }));
app.get("/api/memories", async (_, res) => { try { res.json({ raw: await callTool("recall", { limit: 50 }) }); } catch (e) { res.status(500).json({ error: e.message }); } });

const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => console.log(`\n✦ Aperio running at http://localhost:${PORT}\n`));