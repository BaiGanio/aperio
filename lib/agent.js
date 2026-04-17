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
 *
 * ─── Reasoning / thinking support ────────────────────────────────────────────
 * Model-specific reasoning extraction is fully delegated to reasoningAdapters.js.
 * To add a new thinking model, add one entry there — zero changes needed here.
 */

import { Client }               from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic                from "@anthropic-ai/sdk";
import { readFileSync }         from "fs";
import { resolve }              from "path";
import os                       from "os";
import { loadSkillIndex, matchSkill, executeSkill } from "./skills.js";
import { resolveReasoningAdapter } from "./reasoning.js";

const DEBUG = false;
const dbg = (...args) => DEBUG && console.log('dbg:', ...args);
let streamUsage = { input_tokens: 0, output_tokens: 0 };

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
      importance: Number.parseInt(importanceMatch?.[1] || "3"),
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

  // ── Resolve per-model reasoning adapter ────────────────────────────────────
  // The adapter knows how to extract/strip reasoning for this specific model.
  // All thinking-related logic lives in reasoningAdapters.js — nothing here
  // needs to change when adding a new model.
  const reasoningAdapter = resolveReasoningAdapter(provider.model);

  // Derived flags kept for backward-compat with runAgentLoop callers.
  // An adapter opts INTO thinking by setting thinks: true explicitly.
  // This avoids subtle bugs from match-exclusion lists.
  const OLLAMA_THINKS   = reasoningAdapter.thinks === true;
  const OLLAMA_NO_TOOLS = reasoningAdapter.noTools === true;

  console.log(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${OLLAMA_THINKS} noTools=${OLLAMA_NO_TOOLS}`);

  // ── Agent Identity and Skills ─────────────────────────────────────────────
  const FILES = ["whoami.md"];
  const CACHED_PROMPT = FILES.map(f => {
    try { return readFileSync(resolve(root, "prompts", f), "utf-8"); }
    catch { return ""; }
  }).join("\n\n");
  const skillIndex = loadSkillIndex(resolve(root, "skills"));

  const providerTag = `---\nYou are running as: ${
    provider.name === "ollama"
      ? `Ollama (${provider.model})`
      : `Anthropic Claude (${provider.model})`
  }\nIf asked which model or AI you are, answer accurately using the above.`;

  // Called once per agent loop iteration with the latest user message.
  // Appends the matching skill (if any) between the base prompt and provider tag.
  const getSystemPrompt = (userMessage = "") => {
    const skill = matchSkill(userMessage, skillIndex);
    if (skill) {
      console.log(`🎯 Skill matched: ${skill.name}`);
      return `${CACHED_PROMPT}\n\n---\n\n${skill.content}\n\n${providerTag}`;
    }
    return `${CACHED_PROMPT}\n\n${providerTag}`;
  };

  // ── MCP ───────────────────────────────────────────────────────────────────
  const transport = new StdioClientTransport({
    command: "node",
    args:    [resolve(root, "mcp/index.js")],
    env:     { ...process.env },
  });
  const mcp = new Client({ name: clientName, version });
  await mcp.connect(transport);

  const { tools: mcpTools } = await mcp.listTools();
  const mcpToolNames   = new Set(mcpTools.map(t => t.name));
  const anthropicTools = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const ollamaTools    = mcpTools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: simplifySchema(t.name, mcpTools) },
  }));

  const MAX_HISTORY = 20;

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

      const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
      const lastUserText = typeof lastUserMsg?.content === "string"
        ? lastUserMsg.content
        : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";

      const stream = provider.client.messages.stream({
        model: provider.model, max_tokens: 8192,
        system: getSystemPrompt(lastUserText), tools: anthropicTools, messages: trimmed,
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
        if (event.type === "message_delta") {
          stopReason = event.delta.stop_reason;
          if (event.usage) {                          // ← add this
            streamUsage = {
              input_tokens: event.usage.input_tokens ?? 0,
              output_tokens: event.usage.output_tokens ?? 0,
            };
          }
        }
      }

      emit(emitter, { type: "stream_end", text: fullText, usage: streamUsage });
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
        emit(emitter, { type: "stream_end", text: "", usage: streamUsage });
        return "";
      }

      const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
      const lastUserText = typeof lastUserMsg?.content === "string"
        ? lastUserMsg.content
        : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";

      const openaiMessages = [
        { role: "system", content: getSystemPrompt(lastUserText) },
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
        emit(emitter, { type: "stream_end", text: msg, usage: streamUsage });
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
            stream_options: { include_usage: true },
            ...(OLLAMA_NO_TOOLS || opts.noTools ? {} : { tools: ollamaTools }),
            stream: true,
          }),
          signal: controller.signal,
        });
      } catch (e) {
        emit(emitter, { type: "stream_start" });
        emit(emitter, { type: "token", text: "⚠️ " + e.message });
        emit(emitter, { type: "stream_end", text: e.message, usage: streamUsage });
        return e.message;
      }

      if (!response.ok) {
        const err = await response.text();
        emit(emitter, { type: "stream_start" });
        emit(emitter, { type: "token", text: "⚠️ Ollama error: " + err });
        emit(emitter, { type: "stream_end", text: err, usage: streamUsage });
        return err;
      }

      // ── Stream read ───────────────────────────────────────────────────────
      // Create a fresh adapter state for this request.
      const adapterState = reasoningAdapter.createState();
      const adapterEmit  = (obj) => emit(emitter, obj);

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "", toolCalls = [];
      let tokenBuffer = "", mightBeToolCall = false;

      emit(emitter, { type: "stream_start" });

      // ── Stream read loop ──────────────────────────────────────────────────
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }

          // Capture usage from final chunk (stream_options: { include_usage: true })
          if (parsed.usage) {
            streamUsage = {
              input_tokens: parsed.usage.prompt_tokens ?? 0,
              output_tokens: parsed.usage.completion_tokens ?? 0,
            };
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!toolCalls[i]) toolCalls[i] = { id: "", name: "", args: "" };
              if (tc.id) toolCalls[i].id = tc.id;
              if (tc.function?.name) toolCalls[i].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
            }
            mightBeToolCall = true;
            continue;
          }

          // Text / reasoning via adapter
          const { contentToken } = reasoningAdapter.processDelta(delta, adapterState, adapterEmit);
          if (contentToken) {
            fullText += contentToken;
            if (mightBeToolCall) tokenBuffer += contentToken;
            else emit(emitter, { type: "token", text: contentToken });
          }
        }
      }

      // ── Flush adapter state after stream ends ─────────────────────────────
      // Some adapters (e.g. Gemma's tag splitter) may hold a trailing buffer.
      if (typeof reasoningAdapter.flushState === "function") {
        const flushed = reasoningAdapter.flushState(adapterState);
        if (flushed) {
          fullText += flushed;
          if (OLLAMA_THINKS) emit(emitter, { type: "token", text: flushed });
          else if (mightBeToolCall) tokenBuffer += flushed;
          else emit(emitter, { type: "token", text: flushed });
        }
      }

      // Strip any residual reasoning markup from the complete text.
      // (Adapters that never embed reasoning in content return the text unchanged.)
      const cleanText = reasoningAdapter.stripReasoning(fullText);

      dbg(`post-stream | cleanText: ${cleanText.substring(0, 80)} | toolCalls: ${
          toolCalls.map(t => `${t.name}(${t.args.substring(0, 60)})`).join(", ") || "none"
        }`);

      // ── Post-stream: thinking models ─────────────────────────────────────
      if (OLLAMA_THINKS) {
        const intercepted = cleanText.trim() ? extractTextToolCall(cleanText) : null;

        if (intercepted) {
          emit(emitter, { type: "reasoning_done" });
          emit(emitter, { type: "stream_start" });
          emit(emitter, { type: "stream_end", text: fixUnclosedFence(cleanText), usage: streamUsage });
          const result = await callTool(intercepted.name, intercepted.input);
          const id = `intercept_${Date.now()}`;
          messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: intercepted.name, input: intercepted.input }] });
          messages.push({ role: "user",      content: [{ type: "tool_result", tool_use_id: id, content: result }] });
          if (intercepted.trailing) {
            emit(emitter, { type: "stream_start" });
            emit(emitter, { type: "stream_end", text: intercepted.trailing, usage: streamUsage});
            messages.push({ role: "assistant", content: [{ type: "text", text: intercepted.trailing }] });
            return intercepted.trailing;
          }
          continue;
        }

        if (toolCalls.length > 0) {
          emit(emitter, { type: "reasoning_done" });
          const am = { role: "assistant", content: [] };
          if (cleanText) am.content.push({ type: "text", text: cleanText });
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

        dbg(`THINKING normal response`);
        emit(emitter, { type: "reasoning_done" });
        emit(emitter, { type: "stream_end", text: "", usage: streamUsage });
        messages.push({ role: "assistant", content: [{ type: "text", text: cleanText }] });
        return cleanText;
      }

      // ── Post-stream: non-thinking models ─────────────────────────────────
      if (toolCalls.length > 0) {
        const am = { role: "assistant", content: [] };
        if (cleanText) am.content.push({ type: "text", text: cleanText });
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

      if (cleanText.trim()) {
        const intercepted = extractTextToolCall(cleanText);
        dbg(`intercept: ${intercepted ? intercepted.name : "null"} | len: ${cleanText.length}`);
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
            emit(emitter, { type: "stream_end", text: intercepted.trailing, usage: streamUsage });
            messages.push({ role: "assistant", content: [{ type: "text", text: intercepted.trailing }] });
            return intercepted.trailing;
          }
          continue;
        }
      }

      dbg(`non-thinking normal response`);
      if (tokenBuffer) {
        emit(emitter, { type: "stream_start" });
        emit(emitter, { type: "token", text: tokenBuffer });
        tokenBuffer = "";
      }
      emit(emitter, { type: "stream_end", text: "", usage: streamUsage });
      messages.push({ role: "assistant", content: [{ type: "text", text: cleanText }] });
      return cleanText;
    }
  }

  // ── Public surface ─────────────────────────────────────────────────────────
  return {
    provider,
    mcpTools,
    OLLAMA_THINKS,
    OLLAMA_NO_TOOLS,
    reasoningAdapter,   // exposed for testing / introspection

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