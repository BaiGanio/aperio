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
import { createRequire } from 'module';
import { getStore } from './db/index.js';
const require = createRequire(import.meta.url);
const { version } = require('./package.json');

const app = express();

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const store = await getStore(); 

const systemPromptBase = readFileSync(resolve(__dirname, "prompts/system_prompt.md"), "utf-8");
const getSystemPrompt = () => `${systemPromptBase}

---
You are running as: ${PROVIDER === "ollama" ? `Ollama (${OLLAMA_MODEL})` : `Anthropic Claude (${ANTHROPIC_MODEL})`}
If asked which model or AI you are, answer accurately using the above.`;

// Aperio-lite needs to check the available RAM, so it can propose solutions that fit within the user's limits.
// 1. Function to determine the best Qwen model based on RAM
function getRecommendedModel() {
    const totalRamGB = os.totalmem() / (1024 ** 3);
    
    // Tier 5: Flagship (64GB+)
    if (totalRamGB >= 60) return "qwen2.5:72b-instruct-q4_K_M"; 
    
    // Tier 4: High-End / MoE (32GB - 64GB)
    if (totalRamGB >= 30) return "qwen3.5:35b-instruct-q4_K_M"; 
    
    // Tier 3: Advanced Reasoning (16GB - 32GB)
    if (totalRamGB >= 14) return "qwen2.5:14b-instruct-q8_0"; 
    
    // Tier 2: Mainstream (8GB - 16GB)
    if (totalRamGB >= 8)  return "qwen3.5:7b-instruct-q4_K_M"; 
    
    // Tier 1: Lite (Under 8GB)
    return "qwen3.5:3b-instruct-q4_0" || "deepseek-r1:1.5b" || "qwen2.5-coder:3b";
}

// 2. Logic to choose the model
let selectedModel = process.env.OLLAMA_MODEL;

if (!selectedModel) {
    if (process.env.CHECK_RAM === "true") {
        selectedModel = getRecommendedModel();
        console.log(`[System] CHECK_RAM is true. Auto-selected: ${selectedModel}`);
    } else {
        selectedModel = "llama3.1"; // Your original default fallback
    }
}
const PROVIDER = process.env.AI_PROVIDER?.toLowerCase() || "anthropic";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const OLLAMA_MODEL = selectedModel;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

// Models that stream reasoning in delta.reasoning
const OLLAMA_THINKS = ["deepseek-r1", "qwen3"].some(m => OLLAMA_MODEL.toLowerCase().includes(m));
const OLLAMA_NO_TOOLS = ["deepseek-r1"].some(m => OLLAMA_MODEL.toLowerCase().includes(m));

let provider;
if (PROVIDER === "ollama") {
  provider = { name: "ollama", model: OLLAMA_MODEL, baseURL: `${OLLAMA_BASE_URL}/v1` };
  console.log(`🤖 Provider: Ollama (${OLLAMA_MODEL}) @ ${OLLAMA_BASE_URL}`);
} else {
  provider = { name: "anthropic", model: ANTHROPIC_MODEL, client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) };
  console.log(`🤖 Provider: Anthropic (${ANTHROPIC_MODEL})`);
}

const transport = new StdioClientTransport({ command: "node", args: [resolve(__dirname, "mcp/index.js")], env: { ...process.env } });
const mcp = new Client({ name: "aperio-server", version: version });
await mcp.connect(transport);
console.log("✅ MCP server connected");

const { tools: mcpTools } = await mcp.listTools();
const mcpToolNames = new Set(mcpTools.map(t => t.name));

const anthropicTools = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

const simplifySchema = (name) => {
  if (name === "recall") return { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } };
  if (name === "remember") return { type: "object", required: ["type","title","content"], properties: { type: { type: "string", enum: ["fact","preference","project","decision","solution","source","person"] }, title: { type: "string", description: "Short title" }, content: { type: "string", description: "Full memory content" }, importance: { type: "integer", description: "1 to 5, use 3 as default" }, tags: { type: "array", items: { type: "string" }, description: "Optional list of tags, use empty array [] if none" } } };
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
  const searchIn = fenceMatch ? fenceMatch[1].trim() : text;
  const match = searchIn.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/);
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

    const stream = provider.client.messages.stream({ model: provider.model, max_tokens: 8192, system: getSystemPrompt(), tools: anthropicTools, messages: trimmed });
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

// ─── This counts backtick fences — if odd number, the last one is unclosed, so it appends the closing fence. ────────
function fixUnclosedFence(text) {
  const fences = text.match(/```/g) || [];
  if (fences.length % 2 !== 0) return text + "\n```";
  return text;
}

// ─── Ollama loop ──────────────────────────────────────────────────────────────
async function runOllamaLoop(messages, ws, opts = {}, getAbort = () => null, setAbort = () => {}) {
  while (true) {
    const trimmed = messages.length > MAX_HISTORY ? [messages[0], ...messages.slice(-(MAX_HISTORY-1))] : messages;

    if (getAbort()?.signal?.aborted) {
      ws.send(JSON.stringify({ type: "stream_end", text: "" }));
      return "";
    }
    
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
      const controller = new AbortController();
      setAbort(controller);
      const h = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
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
      const controller = new AbortController();
      setAbort(controller);
       response = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: provider.model, messages: openaiMessages, ...(OLLAMA_NO_TOOLS || opts.noTools ? {} : { tools: ollamaTools }), stream: true }),
        signal: controller.signal,
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
    // For non-thinking models only: buffer tokens that look like a JSON tool call
    // Thinking models (Qwen3) never output raw JSON tool calls, so skip buffering for them
    let tokenBuffer = "", mightBeToolCall = false;

    while (true) {
      let done, value;
      try {
        ({ done, value } = await reader.read());
      } catch (e) {
        if (e.name === "AbortError") {
          ws.send(JSON.stringify({ type: "stream_end", text: "" }));
          return "";
        }
        throw e;
      }
      if (done) break;
      const lines = decoder.decode(value).split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]");
      for (const line of lines) {
        let data; try { data = JSON.parse(line.slice(6)); } catch { continue; }
        const delta = data.choices?.[0]?.delta;
        if (!delta) continue;

        // Reasoning tokens
        if (OLLAMA_THINKS && delta.reasoning) {
          reasoningText += delta.reasoning;
          if (!sentReasoningStart) { sentReasoningStart = true; console.log("🧠 sending reasoning_start"); ws.send(JSON.stringify({ type: "reasoning_start" })); }
          ws.send(JSON.stringify({ type: "reasoning_token", text: delta.reasoning }));
        }

        // Content tokens
        if (delta.content) {
          fullText += delta.content;
          if (sentReasoningStart) {
            ws.send(JSON.stringify({ type: "reasoning_done" }));
            sentReasoningStart = false;
          }
          if (OLLAMA_THINKS) {
            // Thinking models: always stream live, they don't output raw JSON tool calls
            ws.send(JSON.stringify({ type: "token", text: delta.content }));
          } else {
            // Non-thinking models: buffer if response looks like a JSON tool call
            const trimmed = fullText.trimStart();
            if (!mightBeToolCall && (trimmed.startsWith("{") || trimmed.startsWith("```"))) {
              mightBeToolCall = true;
            }
            if (mightBeToolCall) {
              tokenBuffer += delta.content;
            } else {
              ws.send(JSON.stringify({ type: "token", text: delta.content }));
            }
          }
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

    console.log("🧠 thinking post-stream | fullText:", fullText.substring(0,80), "| toolCalls:", toolCalls.map(t => `${t.name}(${t.args.substring(0,60)})`).join(", ") || "none");
    // ── Thinking model post-stream ─────────────────────────────
    if (OLLAMA_THINKS) {
      const intercepted = fullText.trim() ? extractTextToolCall(fullText) : null;

      if (intercepted) {
        // Text-mode tool call (Qwen3 ignores tools API)
        if (sentReasoningStart) ws.send(JSON.stringify({ type: "reasoning_done" }));
        ws.send(JSON.stringify({ type: "stream_start" }));
        ws.send(JSON.stringify({ type: "stream_end", text: fixUnclosedFence(fullText) }));
        //ws.send(JSON.stringify({ type: "tool", name: intercepted.name }));
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
      // Tokens already streamed live — just close reasoning if open and signal completion
      if (sentReasoningStart) ws.send(JSON.stringify({ type: "reasoning_done" }));
      ws.send(JSON.stringify({ type: "stream_end", text: "" }));
      messages.push({ role: "assistant", content: [{ type: "text", text: fullText }] });
      return fullText;
    }

    console.log("🔍 post-stream | fullText:", fullText.substring(0,80), "| toolCalls:", toolCalls.map(t => `${t.name}(${t.args.substring(0,60)})`).join(", ") || "none");
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
      console.log("🔍 intercept result:", intercepted ? intercepted.name : "null", "| fullText len:", fullText.length);
      if (intercepted) {
        tokenBuffer = ""; // discard buffered JSON — confirmed tool call, never show it
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
    // If content was buffered (looked like JSON but wasn't a tool call), flush it now
    if (tokenBuffer) {
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: tokenBuffer }));
      tokenBuffer = "";
    }
    // Tokens already streamed live — just signal completion
    ws.send(JSON.stringify({ type: "stream_end", text: "" }));
    messages.push({ role: "assistant", content: [{ type: "text", text: fullText }] });
    return fullText;
  }
}

async function handleRememberIntent(text, ws) {
  try {
    const content = text.replace(/^remember\s+that\s*/i, "").trim();
    await callTool("remember", { type: "preference", title: content.substring(0, 60), content });
    ws.send(JSON.stringify({ type: "tool", name: "remember" }));
  } catch (err) {
    console.error("handleRememberIntent failed:", err.message);
  }
}

async function runAgentLoop(messages, ws, getAbort, setAbort) {
  return provider.name === "ollama" ? runOllamaLoop(messages, ws, {}, getAbort, setAbort) : runAnthropicLoop(messages, ws);
}

// ─── Express + WebSocket ──────────────────────────────────────────────────────
app.get('/api/version', (req, res) => {
  res.json({ version: require('./package.json').version });
});
app.get("/api/provider", (_, res) => res.json({ provider: provider.name, model: provider.model }));
app.get("/api/config", (req, res) => {
    // This tells the frontend which database we are actually using
    res.json({ 
        backend: process.env.DB_BACKEND || 'lancedb' 
    });
});

app.get("/api/memories", async (req, res) => {
    try {
        const records = await store.table.query().limit(500).toArray();
        return res.json({ raw: records }); 
    } catch (e) {
      console.error("Server Error:", e);
      // Check if we already sent headers to avoid the crash
      if (!res.headersSent) {
        return res.status(500).json({ error: e.message });
      }
    }
});

app.use(express.json());
app.use(express.static(resolve(__dirname, "public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const messages = [];
  let initialized = false;
  let abortController = null;

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

    // For ollama: call without tools for init greeting
    const getAbort = () => abortController;
    const setAbort = (c) => { abortController = c; };
    if (provider.name === "ollama") {
      await runOllamaLoop(messages, ws, { noTools: true }, getAbort, setAbort);
    } else {
      await runAgentLoop(messages, ws, getAbort, setAbort);
    }
    await sendMemories(ws);
  }

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "init" && !initialized) { initialized = true; await init(); return; }
      if (data.type === "chat") {
        messages.push({ role: "user", content: data.text });
        ws.send(JSON.stringify({ type: "thinking" }));
        // For no-tools models, intercept "remember that..." server-side
        if (OLLAMA_NO_TOOLS && /^remember\s+that\b/i.test(data.text.trim())) {
          console.log("🧠 remember intent | OLLAMA_NO_TOOLS:", OLLAMA_NO_TOOLS, "| text:", data.text.substring(0,40));
          await handleRememberIntent(data.text, ws);
        }
        const getAbort = () => abortController;
        const setAbort = (c) => { abortController = c; };
        await runAgentLoop(messages, ws, getAbort, setAbort);
        await sendMemories(ws);
      }
      if (data.type === "stop") {
        if (abortController) { abortController.abort(); abortController = null; }
        ws.send(JSON.stringify({ type: "stream_end", text: "" }));
        return;
      }
      if (data.type === "get_memories") await sendMemories(ws);
      if (data.type === "delete_memory") {
        try { await callTool("forget", { id: data.id }); ws.send(JSON.stringify({ type: "deleted", id: data.id })); }
        catch (err) { ws.send(JSON.stringify({ type: "error", text: `Delete failed: ${err.message}` })); }
      }
    } catch (err) { ws.send(JSON.stringify({ type: "error", text: err.message })); }
  });
});

function parseMemoriesRaw(raw) {
  if (!raw || raw.trim() === "No memories found." || raw.trim() === "No result") return [];
  return raw.split("---").filter(b => b.trim()).map(block => {
    const lines = block.trim().split("\n");
    const header = lines[0] || "";
    const typeMatch = header.match(/\[(\w+)\]/);
    const titleMatch = header.match(/\] (.+?) \(importance:/);
    const importanceMatch = header.match(/importance: (\d)/);
    const contentLine = lines[1] || "";
    const tagsLine = lines.find(l => l.startsWith("Tags:")) || "";
    const tags = tagsLine.replace("Tags:", "").trim().split(",").map(t => t.trim()).filter(Boolean);
    const idLine = lines.find(l => l.startsWith("ID:")) || "";
    const id = idLine.replace("ID:", "").trim() || null;
    const dateLine = lines.find(l => l.startsWith("Created:") || l.startsWith("Saved:")) || "";
    const createdAt = dateLine.split(":").slice(1).join(":").trim() || null;
    return {
      type: typeMatch?.[1]?.toLowerCase() || "fact",
      title: titleMatch?.[1] || "Untitled",
      content: contentLine,
      tags: tags[0] === "none" ? [] : tags,
      importance: parseInt(importanceMatch?.[1] || "3"),
      id,
      createdAt,
    };
  });
}

async function sendMemories(ws) {
  try {
    const raw = await callTool("recall", { limit: 50 });
    ws.send(JSON.stringify({ type: "memories", memories: parseMemoriesRaw(raw) }));
  } catch (err) { console.error("Failed to fetch memories:", err.message); }
}

const DEDUP_INTERVAL_MS = 10 * 60 * 1000;
async function runDedup() {
  try { const r = await callTool("dedup_memories", { threshold: 0.97, dry_run: true }); if (r.split("\n").filter(l=>l.trim()).length > 1) console.log(`🧹 Dedup:\n${r}`); } catch {}
}
setTimeout(() => { runDedup(); setInterval(runDedup, DEDUP_INTERVAL_MS); }, 30_000);

console.error("✅ Server is running from:", process.cwd());
console.error("✅ UI static file path:", resolve(__dirname, "public"));
const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => console.log(`\n✨ Aperio running at http://localhost:${PORT}\n`));