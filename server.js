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

// ─── Provider config ──────────────────────────────────────────────────────────
//
// Switch AI provider by setting AI_PROVIDER in your .env:
//
//   AI_PROVIDER=anthropic   → Claude via Anthropic API (default)
//   AI_PROVIDER=ollama      → Local model via Ollama (free, no API key)
//
// Anthropic models (reasoning supported on sonnet + opus):
//   claude-haiku-4-5-20251001   fast + cheap (default, no reasoning)
//   claude-sonnet-4-6           balanced (reasoning supported)
//   claude-opus-4-6             most capable (reasoning supported)
//
// Ollama models:
//   llama3.1        recommended — best tool use support
//   mistral         good alternative
//   qwen2.5         fast and capable
//   deepseek-r1     native <think> reasoning
//   qwen3           native think: true reasoning
//
const PROVIDER        = process.env.AI_PROVIDER?.toLowerCase() || "anthropic";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || "llama3.1";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

// ─── Reasoning capability detection ──────────────────────────────────────────
//
// Three reasoning paths:
//
//   1. Claude sonnet/opus  → Anthropic extended thinking API (thinking content blocks)
//   2. DeepSeek R1         → Native <think>...</think> tags in text stream
//   3. Qwen3 / other think → Ollama `think: true` param → delta.thinking field
//
const IS_DEEPSEEK_R1 = OLLAMA_MODEL.toLowerCase().includes("deepseek-r1") 
                    || OLLAMA_MODEL.toLowerCase().includes("qwen3");
const IS_QWEN3        = OLLAMA_MODEL.toLowerCase().includes("qwen3");
const OLLAMA_THINKS   = IS_DEEPSEEK_R1 || IS_QWEN3; // Ollama models with native reasoning

// Claude models that support extended thinking (haiku does not)
const CLAUDE_THINKS   = PROVIDER === "anthropic" &&
  ["claude-sonnet-4-6", "claude-opus-4-6"].some(m => ANTHROPIC_MODEL.includes(m));

// ─── System prompt ────────────────────────────────────────────────────────────
const systemPromptBase = readFileSync(resolve(__dirname, "prompts/system_prompt.md"), "utf-8");

const getSystemPrompt = () => `${systemPromptBase}

---
You are running as: ${PROVIDER === "ollama" ? `Ollama (${OLLAMA_MODEL})` : `Anthropic Claude (${ANTHROPIC_MODEL})`}
If asked which model or AI you are, answer accurately using the above.
${PROVIDER === "ollama" ? (IS_DEEPSEEK_R1 ? `
You are DeepSeek R1 — a reasoning model. Your <think> blocks are shown as collapsible reasoning in the UI.
You do NOT have access to a tool_calls API. Instead, call tools by outputting ONLY a raw JSON object:
{"name": "tool_name", "parameters": {...}}

Available tools:
- recall:        {"name": "recall", "parameters": {"limit": 50}}
- recall search: {"name": "recall", "parameters": {"query": "search term", "limit": 10}}
- remember:      {"name": "remember", "parameters": {"type": "fact|preference|project|decision|solution|source|person", "title": "...", "content": "...", "importance": 1-5, "tags": ["..."]}}
- forget:        {"name": "forget", "parameters": {"id": "uuid"}}
- update_memory: {"name": "update_memory", "parameters": {"id": "uuid", "content": "new content"}}
- read_file:     {"name": "read_file", "parameters": {"path": "/absolute/path"}}
- write_file:    {"name": "write_file", "parameters": {"path": "/absolute/path", "content": "..."}}
- scan_project:  {"name": "scan_project", "parameters": {"path": "/absolute/path"}}
- fetch_url:     {"name": "fetch_url", "parameters": {"url": "https://..."}}

CRITICAL RULES:
- When calling a tool, output ONLY the JSON object — nothing before or after it.
- Do NOT wrap in backticks or markdown.
- Do NOT explain what you are about to do before calling a tool.
- After a tool result, respond ONLY based on what the tool actually returned.
- NEVER hallucinate memories. If recall returned nothing — say so honestly.` : `
CRITICAL — OLLAMA RULES (non-negotiable):
- NEVER write text before calling a tool. Call the tool first, silently.
- NEVER narrate what you are about to do. Just do it.
- NEVER explain your reasoning before a tool call.
- NEVER print JSON tool call syntax as text. Use the tool_calls API only.
- Your FIRST action in every response that needs a tool must be the tool call itself.`) : ""}`;

// ─── Provider boot ────────────────────────────────────────────────────────────
let provider;

if (PROVIDER === "ollama") {
  provider = {
    name: "ollama",
    model: OLLAMA_MODEL,
    baseURL: `${OLLAMA_BASE_URL}/v1`,
  };
  console.log(`🤖 Provider: Ollama (${OLLAMA_MODEL}) @ ${OLLAMA_BASE_URL}`);
  if (IS_DEEPSEEK_R1) console.log("🧠 Reasoning: DeepSeek R1 <think> tags");
  else if (IS_QWEN3)  console.log("🧠 Reasoning: Qwen3 think parameter");
} else {
  provider = {
    name: "anthropic",
    model: ANTHROPIC_MODEL,
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  };
  console.log(`🤖 Provider: Anthropic (${ANTHROPIC_MODEL})`);
  if (CLAUDE_THINKS) console.log("🧠 Reasoning: Claude extended thinking enabled");
}

// ─── MCP Client ───────────────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: "node",
  args: [resolve(__dirname, "mcp/index.js")],
});
const mcp = new Client({ name: "aperio-server", version: "1.0.0" });
await mcp.connect(transport);
console.log("✅ MCP server connected");

const { tools: mcpTools } = await mcp.listTools();
const mcpToolNames = new Set(mcpTools.map(t => t.name));

// Anthropic tool format
const anthropicTools = mcpTools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

// OpenAI-compatible tool format (for Ollama) — simplified schemas
const simplifySchema = (name) => {
  if (name === "recall") return {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query. OMIT entirely to load all memories. Do NOT pass null or empty string." },
      limit: { type: "integer", description: "Max results. Default 10, max 50." },
    },
  };
  if (name === "remember") return {
    type: "object",
    required: ["type", "title", "content"],
    properties: {
      type:       { type: "string", enum: ["fact","preference","project","decision","solution","source","person"] },
      title:      { type: "string", description: "Short title" },
      content:    { type: "string", description: "Full memory content in plain English" },
      importance: { type: "number", description: "1-5 (default 3)" },
      tags:       { type: "array", items: { type: "string" } },
    },
  };
  return { type: "object", properties: {} };
};

const ollamaTools = mcpTools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: simplifySchema(t.name) },
}));

// ─── Tool caller ──────────────────────────────────────────────────────────────
async function callTool(name, input) {
  const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
  console.log(`[callTool] ${name}`, JSON.stringify(args));
  const result = await mcp.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "No result";
  console.log(`[callTool] ${name} → ${text.slice(0, 120).replace(/\n/g, " ")}`);
  return text;
}

// ─── Text tool-call interceptor ───────────────────────────────────────────────
// Some local models (and DeepSeek R1) output tool calls as raw JSON text
// instead of using the tool_calls API. This detects and reroutes them.
function extractTextToolCall(text) {
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  const match = stripped.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (!match) return null;
  const toolName = match[1];
  if (!mcpToolNames.has(toolName)) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const params = parsed.parameters ?? parsed.input ?? parsed.arguments ?? {};
    const cleaned = Object.fromEntries(
      Object.entries(params).filter(([_, v]) =>
        v !== "None" && v !== "null" && v !== null && v !== undefined && v !== ""
      )
    );
    return { name: toolName, input: cleaned };
  } catch {
    return null;
  }
}

// ─── Streaming agent loop — Anthropic ─────────────────────────────────────────
const MAX_HISTORY = 20;

async function runAnthropicLoop(messages, ws) {
  while (true) {
    const trimmed = messages.length > MAX_HISTORY
      ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
      : messages;

    let fullText    = "";
    let thinkingText = "";
    let toolUses    = [];
    let currentToolUse = null;
    let inputJson   = "";
    let stopReason  = null;
    let contentBlocks = [];

    const streamParams = {
      model:   provider.model,
      // thinking requires max_tokens > budget_tokens — use 16k, else 4k
      max_tokens: CLAUDE_THINKS ? 16000 : 4096,
      system:  getSystemPrompt(),
      tools:   anthropicTools,
      messages: trimmed,
      // Extended thinking — only on sonnet/opus, not haiku
      ...(CLAUDE_THINKS ? { thinking: { type: "enabled", budget_tokens: 8000 } } : {}),
    };

    const stream = provider.client.messages.stream(streamParams);

    ws.send(JSON.stringify({ type: "stream_start" }));

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "thinking") {
          // Claude thinking block — collect silently, don't stream to UI yet
          contentBlocks.push({ type: "thinking", thinking: "" });
        } else if (event.content_block.type === "text") {
          contentBlocks.push({ type: "text", text: "" });
        } else if (event.content_block.type === "tool_use") {
          currentToolUse = {
            type: "tool_use",
            id:   event.content_block.id,
            name: event.content_block.name,
            input: {},
          };
          inputJson = "";
          contentBlocks.push(currentToolUse);
          ws.send(JSON.stringify({ type: "tool", name: event.content_block.name }));
        }
      }

      if (event.type === "content_block_delta") {
        if (event.delta.type === "thinking_delta") {
          // Accumulate thinking — send to UI as retract after stream ends
          thinkingText += event.delta.thinking;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last?.type === "thinking") last.thinking += event.delta.thinking;

        } else if (event.delta.type === "text_delta") {
          const token = event.delta.text;
          fullText += token;
          ws.send(JSON.stringify({ type: "token", text: token }));
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

    // Send reasoning to UI — same retract pattern as R1, UI handles it identically
    if (thinkingText) {
      ws.send(JSON.stringify({ type: "retract", reasoning: thinkingText }));
      ws.send(JSON.stringify({ type: "stream_start" }));
      // Re-stream the actual response text after retracting
      for (let i = 0; i < fullText.length; i += 8) {
        ws.send(JSON.stringify({ type: "token", text: fullText.slice(i, i + 8) }));
      }
    }

    ws.send(JSON.stringify({ type: "stream_end", text: fullText }));
    messages.push({ role: "assistant", content: contentBlocks });

    if (stopReason === "tool_use" && toolUses.length > 0) {
      const toolResults = [];
      for (const tool of toolUses) {
        ws.send(JSON.stringify({ type: "tool", name: tool.name }));
        const result = await callTool(tool.name, tool.input);
        toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: result });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    return fullText;
  }
}

// ─── Streaming agent loop — Ollama ────────────────────────────────────────────
async function runOllamaLoop(messages, ws) {
  let loopCount = 0;
  const MAX_LOOPS = 6;

  while (true) {
    if (++loopCount > MAX_LOOPS) {
      const msg = "⚠️ Agent loop limit reached — the model may be stuck. Try rephrasing your request.";
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: msg }));
      ws.send(JSON.stringify({ type: "stream_end", text: msg }));
      return msg;
    }

    const trimmed = messages.length > MAX_HISTORY
      ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
      : messages;

    // Convert Anthropic-style message history to OpenAI format for Ollama
    const openaiMessages = [
      { role: "system", content: getSystemPrompt() },
      ...trimmed.map(m => {
        if (Array.isArray(m.content) && m.content[0]?.type === "tool_result") {
          return { role: "tool", tool_call_id: m.content[0].tool_use_id, content: m.content[0].content };
        }
        if (Array.isArray(m.content)) {
          const text = m.content.filter(b => b.type === "text").map(b => b.text).join("");
          const toolCalls = m.content
            .filter(b => b.type === "tool_use")
            .map(b => ({
              id: b.id, type: "function",
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            }));
          return { role: m.role, content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    // ── Health check ──────────────────────────────────────────────────────────
    try {
      const health = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!health.ok) throw new Error("Ollama not ready");
    } catch {
      const msg = `Ollama is not running at ${OLLAMA_BASE_URL}.\n\nFix:\n1. Install Ollama: https://ollama.ai\n2. Run: ollama serve\n3. Pull model: ollama pull ${OLLAMA_MODEL}\n4. Restart Aperio`;
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: "⚠️ **Ollama not reachable**\n\n" + msg }));
      ws.send(JSON.stringify({ type: "stream_end", text: msg }));
      return msg;
    }

    // ── Request ───────────────────────────────────────────────────────────────
    let response;
    try {
      response = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model:    provider.model,
          messages: openaiMessages,
          // DeepSeek R1 doesn't support the tools API — omit, use text interceptor
          ...(IS_DEEPSEEK_R1 ? {} : { tools: ollamaTools }),
          // Qwen3 and other think-capable models — enable reasoning
          ...(OLLAMA_THINKS ? { think: true } : {}),
          stream: true,
        }),
      });
    } catch (fetchErr) {
      const msg = `Could not connect to Ollama: ${fetchErr.message}\n\nMake sure Ollama is running: ollama serve`;
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: "⚠️ " + msg }));
      ws.send(JSON.stringify({ type: "stream_end", text: msg }));
      return msg;
    }

    if (!response.ok) {
      const errText = await response.text();
      const msg = `Ollama error ${response.status}: ${errText}\n\nIs the model pulled? Run: ollama pull ${OLLAMA_MODEL}`;
      ws.send(JSON.stringify({ type: "stream_start" }));
      ws.send(JSON.stringify({ type: "token", text: "⚠️ " + msg }));
      ws.send(JSON.stringify({ type: "stream_end", text: msg }));
      return msg;
    }

    // ── Stream ────────────────────────────────────────────────────────────────
    let fullText     = "";
    let thinkingText = "";
    let toolCalls    = [];
    let suppressTokens = false; // set true when we detect an incoming text tool call

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();

    ws.send(JSON.stringify({ type: "stream_start" }));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]");

      for (const line of lines) {
        try {
          const data  = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (!delta) continue;

          // ── Reasoning delta (Qwen3 / Ollama think: true) ──────────────────
          // Ollama returns delta.thinking for think-capable models.
          // Collect silently — send to UI as retract after stream ends.
          if (delta.thinking) {
            thinkingText += delta.thinking;
          }

          // ── Text delta ────────────────────────────────────────────────────
          if (delta.content) {
            fullText += delta.content;

            if (IS_DEEPSEEK_R1) {
              // R1 embeds <think>...</think> inline in content —
              // suppress thinking tokens and tool call JSON tokens from the UI
              const openThinks  = fullText.split("<think>").length - 1;
              const closeThinks = fullText.split("</think>").length - 1;
              const inThink     = openThinks > closeThinks;
              const isTag       = delta.content.includes("<think>") || delta.content.includes("</think>");
              const afterThink  = fullText.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
              const isToolCall  = afterThink.length > 0 && extractTextToolCall(afterThink) !== null;

              if (!inThink && !isTag && !isToolCall) {
                ws.send(JSON.stringify({ type: "token", text: delta.content }));
              }
            } else {
              // Non-R1: suppress once a text-mode tool call pattern is detected mid-stream
              if (!suppressTokens && extractTextToolCall(fullText)) {
                suppressTokens = true;
              }
              if (!suppressTokens) {
                ws.send(JSON.stringify({ type: "token", text: delta.content }));
              }
            }
          }

          // ── Tool call delta (OpenAI-format tool_calls) ────────────────────
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id || `call_${tc.index}`, name: "", args: "" };
                  ws.send(JSON.stringify({ type: "tool", name: tc.function?.name || "thinking…" }));
                }
                if (tc.function?.name)      toolCalls[tc.index].name  = tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
              }
            }
          }
        } catch {}
      }
    }

    // ── DeepSeek R1 — extract <think> block and route ─────────────────────────
    // R1 puts chain-of-thought inside <think>...</think> before its actual output.
    // Strip it, then either intercept a tool call or re-stream the clean response.
    if (IS_DEEPSEEK_R1 && toolCalls.length === 0 && fullText.includes("<think>")) {
      const thinkMatch = fullText.match(/<think>([\s\S]*?)<\/think>/);
      if (thinkMatch) {
        const reasoning  = thinkMatch[1].trim();
        const cleanText  = fullText.replace(/<think>[\s\S]*?<\/think>\s*/, "").trim();
        const intercepted = cleanText ? extractTextToolCall(cleanText) : null;

        // Case A: tool call hidden after <think>
        if (intercepted) {
          console.log(`[r1] intercepted tool call after <think>: ${intercepted.name}`);
          ws.send(JSON.stringify({ type: "retract", reasoning }));
          ws.send(JSON.stringify({ type: "stream_start" }));
          ws.send(JSON.stringify({ type: "tool", name: intercepted.name }));
          ws.send(JSON.stringify({ type: "stream_end", text: "" }));
          const result = await callTool(intercepted.name, intercepted.input);
          messages.push({ role: "assistant", content: JSON.stringify({ name: intercepted.name, parameters: intercepted.input }) });
          messages.push({ role: "user", content: `TOOL_RESULT[${intercepted.name}]: ${result}\n\nIMPORTANT: Use ONLY this data. Do NOT call recall again.` });
          continue;
        }

        // Case B: real response — retract raw stream, re-stream clean text
        if (reasoning && cleanText) {
          ws.send(JSON.stringify({ type: "retract", reasoning }));
          ws.send(JSON.stringify({ type: "stream_start" }));
          for (let i = 0; i < cleanText.length; i += 8) {
            ws.send(JSON.stringify({ type: "token", text: cleanText.slice(i, i + 8) }));
          }
          ws.send(JSON.stringify({ type: "stream_end", text: cleanText }));
          if (messages.at(-1)?.role === "assistant") {
            messages[messages.length - 1] = { role: "assistant", content: [{ type: "text", text: cleanText }] };
          } else {
            messages.push({ role: "assistant", content: [{ type: "text", text: cleanText }] });
          }
          return cleanText;
        }
      }
    }

    // ── Qwen3 / think: true — retract and re-stream ───────────────────────────
    // Ollama separates reasoning into delta.thinking, so fullText is already clean.
    // Just retract with the accumulated thinking and re-stream the text response.
    if (OLLAMA_THINKS && !IS_DEEPSEEK_R1 && thinkingText && fullText && toolCalls.length === 0) {
      ws.send(JSON.stringify({ type: "retract", reasoning: thinkingText }));
      ws.send(JSON.stringify({ type: "stream_start" }));
      for (let i = 0; i < fullText.length; i += 8) {
        ws.send(JSON.stringify({ type: "token", text: fullText.slice(i, i + 8) }));
      }
      ws.send(JSON.stringify({ type: "stream_end", text: fullText }));
      messages.push({ role: "assistant", content: [{ type: "text", text: fullText }] });
      return fullText;
    }

    // ── Text tool-call interception (non-R1 models that ignore the tools API) ──
    // Model narrated a tool call as text instead of using tool_calls.
    if (toolCalls.length === 0 && fullText.trim()) {
      const intercepted = extractTextToolCall(fullText);
      if (intercepted) {
        console.log(`[ollama] intercepted text tool call: ${intercepted.name}`);
        const jsonStart   = fullText.search(/[`{]/);
        const reasoningText = jsonStart > 0 ? fullText.slice(0, jsonStart).trim() : "";
        ws.send(JSON.stringify({ type: "retract", reasoning: reasoningText }));
        ws.send(JSON.stringify({ type: "stream_start" }));
        ws.send(JSON.stringify({ type: "tool", name: intercepted.name }));
        ws.send(JSON.stringify({ type: "stream_end", text: "" }));
        const result  = await callTool(intercepted.name, intercepted.input);
        const fakeId  = `intercept_${Date.now()}`;
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: fakeId, name: intercepted.name, input: intercepted.input }] });
        messages.push({ role: "user",      content: [{ type: "tool_result", tool_use_id: fakeId, content: result }] });
        continue;
      }
    }

    ws.send(JSON.stringify({ type: "stream_end", text: fullText }));

    // ── Build assistant history entry ─────────────────────────────────────────
    const assistantMsg = { role: "assistant", content: [] };
    if (fullText) assistantMsg.content.push({ type: "text", text: fullText });
    toolCalls.forEach(tc => assistantMsg.content.push({
      type: "tool_use", id: tc.id, name: tc.name,
      input: (() => { try { return JSON.parse(tc.args || "{}"); } catch { return {}; } })(),
    }));
    messages.push(assistantMsg);

    // ── Execute real tool_calls (OpenAI-format) ───────────────────────────────
    if (toolCalls.length > 0) {
      ws.send(JSON.stringify({ type: "stream_start" }));
      const toolResults = [];
      for (const tc of toolCalls) {
        ws.send(JSON.stringify({ type: "tool", name: tc.name }));
        let input = {};
        try { input = JSON.parse(tc.args || "{}"); } catch {}
        const result = await callTool(tc.name, input);
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
      }
      ws.send(JSON.stringify({ type: "stream_end", text: "" }));
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    return fullText;
  }
}

// ─── Unified agent loop ───────────────────────────────────────────────────────
async function runAgentLoop(messages, ws) {
  return provider.name === "ollama"
    ? runOllamaLoop(messages, ws)
    : runAnthropicLoop(messages, ws);
}

// ─── Express + WebSocket ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, "public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const messages  = [];
  let initialized = false;

  ws.send(JSON.stringify({ type: "status", text: "connected" }));
  ws.send(JSON.stringify({
    type: "provider",
    name: provider.name,
    model: provider.model,
    // Tell the UI whether this session has reasoning — drives the reasoning toggle
    reasoning: CLAUDE_THINKS || OLLAMA_THINKS,
  }));

  async function init() {
    messages.push({
      role: "user",
      content: IS_DEEPSEEK_R1
        ? "Call recall with limit 50 to load my memories. After you get the result, greet me by name if you found it. One short sentence only. Do not list or summarize memories."
        : "Load my core memories silently, then greet me in one short sentence. Do not repeat or summarize the memories back to me.",
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function sendMemories(ws) {
  try {
    const result = await callTool("recall", { limit: 50 });
    ws.send(JSON.stringify({ type: "memories", raw: result }));
  } catch (err) {
    console.error("Failed to fetch memories:", err.message);
  }
}

// ─── Memory dedup job ─────────────────────────────────────────────────────────
const DEDUP_INTERVAL_MS = 10 * 60 * 1000;
const DEDUP_THRESHOLD   = 0.97;

async function runDedup() {
  try {
    const result = await callTool("dedup_memories", { threshold: DEDUP_THRESHOLD, dry_run: true });
    const lines  = result.split("\n").filter(l => l.trim());
    if (lines.length > 1) console.log(`\n🧹 Dedup report:\n${result}`);
  } catch {}
}

setTimeout(() => { runDedup(); setInterval(runDedup, DEDUP_INTERVAL_MS); }, 30_000);

// ─── REST ─────────────────────────────────────────────────────────────────────
app.get("/api/provider", (req, res) => {
  res.json({ provider: provider.name, model: provider.model, reasoning: CLAUDE_THINKS || OLLAMA_THINKS });
});

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
  console.log(`\n✦ Aperio running at http://localhost:${PORT}\n`);
});