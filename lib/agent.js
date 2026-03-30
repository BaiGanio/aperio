/**
 * lib/agent.js — Aperio shared agent core
 *
 * Owns everything that is the same whether you're serving a browser
 * or running a terminal session:
 *   • provider / model selection
 *   • MCP boot + tool helpers
 *   • system-prompt builder
 *   • runAnthropicLoop / runOllamaLoop / runAgentLoop
 *   • handleRememberIntent
 *   • parseMemoriesRaw
 *
 * Both server.js and scripts/chat.js import createAgent() and get back
 * a ready-to-use agent object. Neither file duplicates loop logic anymore.
 *
 * The loops communicate with the caller through a tiny "emitter" interface:
 *
 *   emitter.send(msgObject)   ← agent pushes events (token, tool, stream_end …)
 *   emitter.abort()           ← caller signals abort (optional)
 *
 * server.js wraps a real WebSocket:
 *   const emitter = makeWsEmitter(ws);
 *
 * chat.js wraps stdout:
 *   const emitter = makeCliEmitter(onTurnDone);
 *
 * Helper factories for both are exported at the bottom of this file.
 */

import { Client }               from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic                from "@anthropic-ai/sdk";
import { readFileSync }         from "fs";
import { resolve }              from "path";
import os                       from "os";

// ─── Model selection ──────────────────────────────────────────────────────────
export function getRecommendedModel() {
  const gb = os.totalmem() / 1024 ** 3;
  if (gb >= 60) return "deepseek-r1:32";
  if (gb >= 30) return "qwen3:14b";
  if (gb >= 14) return "llama3.1:8b";
  if (gb >= 8)  return "qwen2.5:3b";
  return "qwen3:8b";
}

export function resolveProvider() {
  const PROVIDER        = process.env.AI_PROVIDER?.toLowerCase() || "anthropic";
  const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

  let selectedModel = process.env.OLLAMA_MODEL;
  if (!selectedModel) {
    if (process.env.CHECK_RAM === "true") {
      selectedModel = getRecommendedModel();
      console.log(`[System] CHECK_RAM is true. Auto-selected: ${selectedModel}`);
    } else {
      selectedModel = "llama3.1";
    }
  }

  if (PROVIDER === "ollama") {
    return {
      name:    "ollama",
      model:   selectedModel,
      baseURL: `${OLLAMA_BASE_URL}/v1`,
      ollamaBaseURL: OLLAMA_BASE_URL,
    };
  }

  return {
    name:          "anthropic",
    model:         ANTHROPIC_MODEL,
    client:        new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    ollamaBaseURL: OLLAMA_BASE_URL,
  };
}

// ─── Schema helpers ───────────────────────────────────────────────────────────
function simplifySchema(name, mcpTools) {
  if (name === "recall")
    return { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } };
  if (name === "remember")
    return {
      type: "object",
      required: ["type", "title", "content"],
      properties: {
        type:       { type: "string", enum: ["fact","preference","project","decision","solution","source","person"] },
        title:      { type: "string", description: "Short title" },
        content:    { type: "string", description: "Full memory content" },
        importance: { type: "integer", description: "1 to 5, use 3 as default" },
        tags:       { type: "array", items: { type: "string" }, description: "Optional list of tags, use empty array [] if none" },
      },
    };
  return mcpTools.find(t => t.name === name)?.inputSchema ?? {};
}

// ─── Utility ──────────────────────────────────────────────────────────────────
export function fixUnclosedFence(text) {
  const fences = text.match(/```/g) || [];
  return fences.length % 2 !== 0 ? text + "\n```" : text;
}

export function parseMemoriesRaw(raw) {
  if (!raw || raw.trim() === "No memories found." || raw.trim() === "No result") return [];
  return raw.split("---").filter(b => b.trim()).map(block => {
    const lines           = block.trim().split("\n");
    const header          = lines[0] || "";
    const typeMatch       = header.match(/\[(\w+)\]/);
    const titleMatch      = header.match(/\] (.+?) \(importance:/);
    const importanceMatch = header.match(/importance: (\d)/);
    const contentLine     = lines[1] || "";
    const tagsLine        = lines.find(l => l.startsWith("Tags:")) || "";
    const tags            = tagsLine.replace("Tags:", "").trim().split(",").map(t => t.trim()).filter(Boolean);
    const idLine          = lines.find(l => l.startsWith("ID:")) || "";
    const id              = idLine.replace("ID:", "").trim() || null;
    const dateLine        = lines.find(l => l.startsWith("Created:") || l.startsWith("Saved:")) || "";
    const createdAt       = dateLine.split(":").slice(1).join(":").trim() || null;
    return {
      type:       typeMatch?.[1]?.toLowerCase() || "fact",
      title:      titleMatch?.[1] || "Untitled",
      content:    contentLine,
      tags:       tags[0] === "none" ? [] : tags,
      importance: parseInt(importanceMatch?.[1] || "3"),
      id,
      createdAt,
    };
  });
}

// ─── createAgent ─────────────────────────────────────────────────────────────
/**
 * Boot the agent: connect MCP, build tool lists, wire up the system prompt.
 *
 * @param {object} opts
 * @param {string} opts.root          - Absolute path to project root
 * @param {string} opts.version       - Package version string
 * @param {string} [opts.clientName]  - MCP client name (default "aperio-agent")
 * @returns {Promise<Agent>}
 */
export async function createAgent({ root, version, clientName = "aperio-agent" }) {
  const provider = resolveProvider();

  // ── System prompt ──────────────────────────────────────────────────────────
  let systemPromptBase = "You are Aperio, a helpful AI assistant.";
  try { systemPromptBase = readFileSync(resolve(root, "prompts/system_prompt.md"), "utf-8"); } catch {}

  const getSystemPrompt = () =>
    `${systemPromptBase}\n\n---\nYou are running as: ${
      provider.name === "ollama"
        ? `Ollama (${provider.model})`
        : `Anthropic Claude (${provider.model})`
    }\nIf asked which model or AI you are, answer accurately using the above.`;

  // ── MCP ───────────────────────────────────────────────────────────────────
  const transport = new StdioClientTransport({
    command: "node",
    args:    [resolve(root, "mcp/index.js")],
    env:     { ...process.env },
  });
  const mcp = new Client({ name: clientName, version });
  await mcp.connect(transport);

  const { tools: mcpTools } = await mcp.listTools();
  const mcpToolNames  = new Set(mcpTools.map(t => t.name));
  const anthropicTools = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const ollamaTools    = mcpTools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: simplifySchema(t.name, mcpTools) },
  }));

  // Thinking / no-tools flags
  const OLLAMA_THINKS   = ["deepseek-r1", "qwen3"].some(m => provider.model.toLowerCase().includes(m));
  const OLLAMA_NO_TOOLS = ["deepseek-r1"].some(m => provider.model.toLowerCase().includes(m));
  const MAX_HISTORY     = 20;

  // ── Internal helpers ───────────────────────────────────────────────────────
  async function callTool(name, input) {
    const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
    const result = await mcp.callTool({ name, arguments: args });
    return result.content?.[0]?.text ?? "No result";
  }

  function extractTextToolCall(text) {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const searchIn   = fenceMatch ? fenceMatch[1].trim() : text;
    const match      = searchIn.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/);
    if (!match || !mcpToolNames.has(match[1])) return null;
    try {
      const parsed  = JSON.parse(match[0]);
      const params  = parsed.parameters ?? parsed.input ?? parsed.arguments ?? {};
      const cleaned = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v != null && v !== "" && v !== "None" && v !== "null")
      );
      let trailing = fenceMatch
        ? text.slice(text.indexOf(fenceMatch[0]) + fenceMatch[0].length).trim()
        : text.slice(text.indexOf(match[0]) + match[0].length).trim();
      trailing = trailing.replace(/^[-–—\s]*(?:Response|Result|Answer|Output)\s*:\s*/i, "").trim();
      return { name: match[1], input: cleaned, trailing };
    } catch { return null; }
  }

  // ── emit helpers (keep emitter calls DRY) ─────────────────────────────────
  const emit = (em, obj) => em.send(obj);

  // ── Anthropic loop ─────────────────────────────────────────────────────────
  async function runAnthropicLoop(messages, emitter) {
    while (true) {
      const trimmed = messages.length > MAX_HISTORY
        ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
        : messages;

      let fullText = "", toolUses = [], currentToolUse = null, inputJson = "",
          stopReason = null, contentBlocks = [];

      const stream = provider.client.messages.stream({
        model: provider.model, max_tokens: 8192,
        system: getSystemPrompt(), tools: anthropicTools, messages: trimmed,
      });
      emit(emitter, { type: "stream_start" });

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "text")
            contentBlocks.push({ type: "text", text: "" });
          else if (event.content_block.type === "tool_use") {
            currentToolUse = { type: "tool_use", id: event.content_block.id, name: event.content_block.name, input: {} };
            inputJson = "";
            contentBlocks.push(currentToolUse);
            emit(emitter, { type: "tool", name: event.content_block.name });
          }
        }
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            fullText += event.delta.text;
            emit(emitter, { type: "token", text: event.delta.text });
            const last = contentBlocks[contentBlocks.length - 1];
            if (last?.type === "text") last.text += event.delta.text;
          } else if (event.delta.type === "input_json_delta") {
            inputJson += event.delta.partial_json;
          }
        }
        if (event.type === "content_block_stop" && currentToolUse) {
          try { currentToolUse.input = JSON.parse(inputJson || "{}"); } catch {}
          toolUses.push({ ...currentToolUse });
          currentToolUse = null; inputJson = "";
        }
        if (event.type === "message_delta") stopReason = event.delta.stop_reason;
      }

      emit(emitter, { type: "stream_end", text: fullText });
      messages.push({ role: "assistant", content: contentBlocks });

      if (stopReason === "tool_use" && toolUses.length > 0) {
        const toolResults = [];
        for (const tool of toolUses) {
          const result = await callTool(tool.name, tool.input);
          toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: result });
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }
      return fullText;
    }
  }

  // ── Ollama loop ────────────────────────────────────────────────────────────
  async function runOllamaLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
    while (true) {
      const trimmed = messages.length > MAX_HISTORY
        ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
        : messages;

      if (getAbort()?.signal?.aborted) {
        emit(emitter, { type: "stream_end", text: "" });
        return "";
      }

      const openaiMessages = [
        { role: "system", content: getSystemPrompt() },
        ...trimmed.map(m => {
          if (Array.isArray(m.content) && m.content[0]?.type === "tool_result")
            return { role: "tool", tool_call_id: m.content[0].tool_use_id, content: m.content[0].content };
          if (Array.isArray(m.content)) {
            const text = m.content.filter(b => b.type === "text").map(b => b.text).join("");
            const tcs  = m.content.filter(b => b.type === "tool_use").map(b => ({
              id: b.id, type: "function",
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            }));
            return { role: m.role, content: text || null, ...(tcs.length ? { tool_calls: tcs } : {}) };
          }
          return { role: m.role, content: m.content };
        }),
      ];

      // ── Ollama health check ──────────────────────────────────────────────
      try {
        const controller = new AbortController();
        setAbort(controller);
        const h = await fetch(`${provider.ollamaBaseURL}/api/tags`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        });
        if (!h.ok) throw new Error();
      } catch {
        const msg = `Ollama is not running. Fix:\n1. ollama serve\n2. ollama pull ${provider.model}`;
        emit(emitter, { type: "stream_start" });
        emit(emitter, { type: "token", text: "⚠️ " + msg });
        emit(emitter, { type: "stream_end", text: msg });
        return msg;
      }

      // ── Request ──────────────────────────────────────────────────────────
      let response;
      try {
        const controller = new AbortController();
        setAbort(controller);
        response = await fetch(`${provider.baseURL}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: provider.model,
            messages: openaiMessages,
            ...(OLLAMA_NO_TOOLS || opts.noTools ? {} : { tools: ollamaTools }),
            stream: true,
          }),
          signal: controller.signal,
        });
      } catch (e) {
        emit(emitter, { type: "stream_start" });
        emit(emitter, { type: "token", text: "⚠️ " + e.message });
        emit(emitter, { type: "stream_end", text: e.message });
        return e.message;
      }

      if (!response.ok) {
        const err = await response.text();
        emit(emitter, { type: "stream_start" });
        emit(emitter, { type: "token", text: "⚠️ Ollama error: " + err });
        emit(emitter, { type: "stream_end", text: err });
        return err;
      }

      // ── Stream read ───────────────────────────────────────────────────────
      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "", toolCalls = [], sentReasoningStart = false;
      let tokenBuffer = "", mightBeToolCall = false;

      outer: while (true) {
        let done, value;
        try { ({ done, value } = await reader.read()); }
        catch (e) {
          if (e.name === "AbortError") { emit(emitter, { type: "stream_end", text: "" }); return ""; }
          throw e;
        }
        if (done) break;

        const lines = decoder.decode(value)
          .split("\n")
          .filter(l => l.startsWith("data: ") && l !== "data: [DONE]");

        for (const line of lines) {
          let data; try { data = JSON.parse(line.slice(6)); } catch { continue; }
          const delta = data.choices?.[0]?.delta;
          if (!delta) continue;

          // Reasoning tokens
          if (OLLAMA_THINKS && delta.reasoning) {
            if (!sentReasoningStart) {
              sentReasoningStart = true;
              process.stderr.write("dbg: reasoning_start\n");
              emit(emitter, { type: "reasoning_start" });
            }
            emit(emitter, { type: "reasoning_token", text: delta.reasoning });
          }

          // Content tokens
          if (delta.content) {
            fullText += delta.content;
            if (sentReasoningStart) {
              emit(emitter, { type: "reasoning_done" });
              sentReasoningStart = false;
            }
            if (OLLAMA_THINKS) {
              emit(emitter, { type: "token", text: delta.content });
            } else {
              const t = fullText.trimStart();
              if (!mightBeToolCall && (t.startsWith("{") || t.startsWith("```"))) mightBeToolCall = true;
              if (mightBeToolCall) tokenBuffer += delta.content;
              else emit(emitter, { type: "token", text: delta.content });
            }
          }

          // API tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id || `call_${tc.index}`, name: "", args: "" };
                  emit(emitter, { type: "tool", name: tc.function?.name || "…" });
                }
                if (tc.function?.name)      toolCalls[tc.index].name = tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
              }
            }
          }
        }
      }

      process.stderr.write(
        `dbg post-stream | fullText: ${fullText.substring(0, 80)} | toolCalls: ${
          toolCalls.map(t => `${t.name}(${t.args.substring(0, 60)})`).join(", ") || "none"
        }\n`
      );

      // ── Post-stream: thinking models ─────────────────────────────────────
      if (OLLAMA_THINKS) {
        const intercepted = fullText.trim() ? extractTextToolCall(fullText) : null;

        if (intercepted) {
          if (sentReasoningStart) emit(emitter, { type: "reasoning_done" });
          emit(emitter, { type: "stream_start" });
          emit(emitter, { type: "stream_end", text: fixUnclosedFence(fullText) });
          const result = await callTool(intercepted.name, intercepted.input);
          const id = `intercept_${Date.now()}`;
          messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: intercepted.name, input: intercepted.input }] });
          messages.push({ role: "user",      content: [{ type: "tool_result", tool_use_id: id, content: result }] });
          sentReasoningStart = false;
          if (intercepted.trailing) {
            emit(emitter, { type: "stream_start" });
            emit(emitter, { type: "stream_end", text: intercepted.trailing });
            messages.push({ role: "assistant", content: [{ type: "text", text: intercepted.trailing }] });
            return intercepted.trailing;
          }
          continue;
        }

        if (toolCalls.length > 0) {
          if (sentReasoningStart) emit(emitter, { type: "reasoning_done" });
          const am = { role: "assistant", content: [] };
          if (fullText) am.content.push({ type: "text", text: fullText });
          toolCalls.forEach(tc => am.content.push({
            type: "tool_use", id: tc.id, name: tc.name,
            input: (() => { try { return JSON.parse(tc.args || "{}"); } catch { return {}; } })(),
          }));
          messages.push(am);
          const results = [];
          for (const tc of toolCalls) {
            let inp = {}; try { inp = JSON.parse(tc.args || "{}"); } catch {}
            results.push({ type: "tool_result", tool_use_id: tc.id, content: await callTool(tc.name, inp) });
          }
          messages.push({ role: "user", content: results });
          sentReasoningStart = false;
          continue;
        }

        process.stderr.write("dbg: THINKING normal response\n");
        if (sentReasoningStart) emit(emitter, { type: "reasoning_done" });
        emit(emitter, { type: "stream_end", text: "" });
        messages.push({ role: "assistant", content: [{ type: "text", text: fullText }] });
        return fullText;
      }

      // ── Post-stream: non-thinking models ─────────────────────────────────
      if (toolCalls.length > 0) {
        const am = { role: "assistant", content: [] };
        if (fullText) am.content.push({ type: "text", text: fullText });
        toolCalls.forEach(tc => am.content.push({
          type: "tool_use", id: tc.id, name: tc.name,
          input: (() => { try { return JSON.parse(tc.args || "{}"); } catch { return {}; } })(),
        }));
        messages.push(am);
        const results = [];
        for (const tc of toolCalls) {
          let inp = {}; try { inp = JSON.parse(tc.args || "{}"); } catch {}
          results.push({ type: "tool_result", tool_use_id: tc.id, content: await callTool(tc.name, inp) });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      if (fullText.trim()) {
        const intercepted = extractTextToolCall(fullText);
        process.stderr.write(`dbg intercept: ${intercepted ? intercepted.name : "null"} | len: ${fullText.length}\n`);
        if (intercepted) {
          tokenBuffer = "";
          emit(emitter, { type: "retract" });
          emit(emitter, { type: "tool", name: intercepted.name });
          const result = await callTool(intercepted.name, intercepted.input);
          const id = `intercept_${Date.now()}`;
          messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: intercepted.name, input: intercepted.input }] });
          messages.push({ role: "user",      content: [{ type: "tool_result", tool_use_id: id, content: result }] });
          if (intercepted.trailing) {
            emit(emitter, { type: "stream_start" });
            emit(emitter, { type: "stream_end", text: intercepted.trailing });
            messages.push({ role: "assistant", content: [{ type: "text", text: intercepted.trailing }] });
            return intercepted.trailing;
          }
          continue;
        }
      }

      process.stderr.write("dbg: non-thinking normal response\n");
      if (tokenBuffer) {
        emit(emitter, { type: "stream_start" });
        emit(emitter, { type: "token", text: tokenBuffer });
        tokenBuffer = "";
      }
      emit(emitter, { type: "stream_end", text: "" });
      messages.push({ role: "assistant", content: [{ type: "text", text: fullText }] });
      return fullText;
    }
  }

  // ── Public surface ─────────────────────────────────────────────────────────
  return {
    provider,
    mcpTools,
    OLLAMA_THINKS,
    OLLAMA_NO_TOOLS,

    callTool,

    /** Run the correct loop based on provider. */
    async runAgentLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
      return provider.name === "ollama"
        ? runOllamaLoop(messages, emitter, opts, getAbort, setAbort)
        : runAnthropicLoop(messages, emitter);
    },

    /** Intercept "remember that …" for no-tools models. */
    async handleRememberIntent(text, emitter) {
      try {
        const content = text.replace(/^remember\s+that\s*/i, "").trim();
        await callTool("remember", { type: "preference", title: content.substring(0, 60), content });
        emit(emitter, { type: "tool", name: "remember" });
      } catch (err) {
        console.error("handleRememberIntent failed:", err.message);
      }
    },

    /** Fetch and parse memories via MCP tool. */
    async fetchMemories() {
      const raw = await callTool("recall", { limit: 50 });
      return { raw, parsed: parseMemoriesRaw(raw) };
    },

    /** Build the greeting message with optional memory injection. */
    async buildGreeting() {
      let ctx = "";
      try {
        const raw = await callTool("recall", { limit: 50 });
        if (raw && raw.trim() && !raw.includes("No memories"))
          ctx = `\n\nHere is what you know about the user:\n${raw}`;
      } catch {}
      return `Greet me in one short friendly sentence. Do not use any tools.${ctx}`;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Emitter factories
//  These are thin adapters so neither server.js nor chat.js knows about the
//  other's output mechanism.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * WebSocket emitter — used by server.js.
 * Serialises every message object to JSON and calls ws.send().
 */
export function makeWsEmitter(ws) {
  return {
    send(obj) { ws.send(JSON.stringify(obj)); },
  };
}

/**
 * CLI emitter — used by scripts/chat.js.
 *
 * Design goals:
 *   • Answer is the star — printed as "A: <text>" with no preamble clutter
 *   • Tool use is a single dim line, not a banner
 *   • Reasoning is optional and gated by showReasoning flag
 *   • Spinner stops cleanly before any text lands on screen
 *   • All debug noise stays on stderr, never touches stdout
 *
 * @param {function} onTurnDone    - Called when stream_end arrives
 * @param {object}   hooks         - { stopSpinner, startSpinner }
 * @param {object}   options       - { showReasoning: bool }
 */
export function makeCliEmitter(onTurnDone, hooks = {}, options = {}) {
  const { stopSpinner = () => {}, startSpinner = () => {} } = hooks;
  const { showReasoning = false } = options;

  // ── ANSI palette ────────────────────────────────────────────────────────────
  const R       = "\x1b[0m";
  const BOLD    = "\x1b[1m";
  const DIM     = "\x1b[2m";
  const ITALIC  = "\x1b[3m";
  const CYAN    = "\x1b[36m";
  const GRAY    = "\x1b[90m";
  const GREEN   = "\x1b[32m";
  const RED     = "\x1b[31m";
  const YELLOW  = "\x1b[33m";
  const MAGENTA = "\x1b[35m";
  const BLUE    = "\x1b[34m";
  const BG_CODE = "\x1b[48;5;236m"; // dark bg for inline code

  // ── Markdown → ANSI renderer ────────────────────────────────────────────────
  // Called once on the complete answer buffer at stream_end.
  function renderMarkdown(text) {
    const lines  = text.split("\n");
    const out    = [];
    let inFence  = false;
    let lang     = "";

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // ── fenced code blocks ─────────────────────────────────────────────
      const fenceMatch = line.match(/^(`{3,})([\w+-]*)/);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          lang    = fenceMatch[2] || "";
          const badge = lang ? ` ${DIM}${lang}${R}` : "";
          out.push(`${GRAY}┌─${badge}`);
        } else {
          inFence = false;
          out.push(`${GRAY}└─${R}`);
        }
        continue;
      }

      if (inFence) {
        out.push(`${GRAY}│${R} ${CYAN}${line}${R}`);
        continue;
      }

      // ── headings ───────────────────────────────────────────────────────
      const h3 = line.match(/^### (.+)/);
      const h2 = line.match(/^## (.+)/);
      const h1 = line.match(/^# (.+)/);
      if (h1) { out.push(`\n${BOLD}${CYAN}${h1[1]}${R}`); continue; }
      if (h2) { out.push(`\n${BOLD}${h2[1]}${R}`); continue; }
      if (h3) { out.push(`${BOLD}${DIM}${h3[1]}${R}`); continue; }

      // ── horizontal rule ────────────────────────────────────────────────
      if (/^[-*_]{3,}$/.test(line.trim())) {
        out.push(`${GRAY}${"─".repeat(48)}${R}`);
        continue;
      }

      // ── bullet / numbered list ─────────────────────────────────────────
      line = line.replace(/^(\s*)([-*+]) /, (_, sp, bullet) => `${sp}${CYAN}•${R} `);
      line = line.replace(/^(\s*)(\d+)\. /,  (_, sp, n)     => `${sp}${DIM}${n}.${R} `);

      // ── inline styles ──────────────────────────────────────────────────
      // Bold+italic  ***text***
      line = line.replace(/\*{3}(.+?)\*{3}/g, `${BOLD}${ITALIC}$1${R}`);
      // Bold         **text**
      line = line.replace(/\*{2}(.+?)\*{2}/g, `${BOLD}$1${R}`);
      // Italic       *text* or _text_
      line = line.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${ITALIC}$1${R}`);
      line = line.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,       `${ITALIC}$1${R}`);
      // Strikethrough ~~text~~
      line = line.replace(/~~(.+?)~~/g, `${DIM}$1${R}`);
      // Inline code  `code`
      line = line.replace(/`([^`]+)`/g, `${BG_CODE}${YELLOW} $1 ${R}`);

      out.push(line);
    }

    // close any unclosed fence gracefully
    if (inFence) out.push(`${GRAY}└─${R}`);

    return out.join("\n");
  }

  // ── Tool badge ──────────────────────────────────────────────────────────────
  const TOOL_META = {
    recall:              { icon: "⟳", label: "recalling memory",    color: BLUE    },
    remember:            { icon: "✦", label: "saving memory",        color: GREEN   },
    backfill_embeddings: { icon: "⟳", label: "backfilling embeddings", color: GRAY  },
    dedup_memories:      { icon: "⟳", label: "deduplicating",        color: GRAY   },
    forget:              { icon: "✕", label: "forgetting memory",    color: RED     },
  };

  function toolBadge(name) {
    const meta  = TOOL_META[name] || { icon: "◆", label: name, color: MAGENTA };
    return `${meta.color}${meta.icon} ${meta.label}${GRAY}…${R}`;
  }

  // ── State ───────────────────────────────────────────────────────────────────
  let inReasoning   = false;
  let answerStarted = false;
  let answerBuffer  = "";   // accumulate full answer for markdown render

  return {
    send(msg) {
      switch (msg.type) {

        // ── stream_start: swallow silently — do NOT print the blank ↳ line ──
        case "stream_start":
          stopSpinner();
          break;

        // ── tool use: one clear dim badge, then spinner while waiting ────────
        case "tool":
          stopSpinner();
          process.stdout.write(`\n  ${toolBadge(msg.name)}\n`);
          startSpinner("working");
          break;

        // ── reasoning block ──────────────────────────────────────────────────
        case "reasoning_start":
          stopSpinner();
          if (showReasoning) {
            process.stdout.write(`\n${GRAY}╭─ thinking ${"─".repeat(34)}╮${R}\n`);
            inReasoning = true;
          }
          break;

        case "reasoning_token":
          if (showReasoning && inReasoning)
            process.stdout.write(`${GRAY}${msg.text}${R}`);
          break;

        case "reasoning_done":
          if (inReasoning) {
            if (showReasoning) process.stdout.write(`\n${GRAY}╰${"─".repeat(46)}╯${R}\n`);
            inReasoning = false;
          }
          break;

        // ── answer tokens: buffer silently, render on stream_end ─────────────
        case "token":
          stopSpinner();
          if (!answerStarted) {
            answerStarted = true;
          }
          answerBuffer += msg.text;
          break;

        case "retract":
          // nothing to erase in terminal — buffer handles it
          break;

        // ── turn complete: NOW render the buffered answer ─────────────────────
        case "stream_end":
          stopSpinner();
          if (answerStarted && answerBuffer.trim()) {
            const rendered = renderMarkdown(answerBuffer.trimEnd());
            process.stdout.write(`\n${CYAN}${BOLD}A:${R}\n${rendered}\n`);
          }
          process.stdout.write("\n");
          answerStarted = false;
          answerBuffer  = "";
          inReasoning   = false;
          onTurnDone();
          break;

        case "thinking":
          startSpinner("thinking");
          break;

        case "error":
          stopSpinner();
          process.stdout.write(`\n${RED}✖ error: ${msg.text}${R}\n\n`);
          answerStarted = false;
          answerBuffer  = "";
          onTurnDone();
          break;

        // silently swallow browser-only events
        case "status":
        case "provider":
        case "memories":
        case "deleted":
          break;
      }
    },
  };
}