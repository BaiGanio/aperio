/**
 * lib/agent.js — Aperio shared agent core (REFACTORED)
 * Wired validateOutputSafe into every output path.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { resolve } from "path";
import os from "os";
import { loadSkillIndex, matchSkill, getAlwaysOnSkills } from "./workers/skills.js";
import { resolveReasoningAdapter } from "./workers/reasoning.js";
import { validateOutputSafe } from "./helpers/validateOutput.js";
import logger from "./helpers/logger.js";
import { encode } from "gpt-tokenizer";

const DEBUG = false;
const dbg = (...args) => DEBUG && logger.debug('dbg:', ...args);
let streamUsage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };

export function getRecommendedModel() {
  const gb = os.totalmem() / 1024 ** 3;
  if (gb >= 60) return "deepseek-r1:32";
  if (gb >= 30) return "qwen3:14b";
  if (gb >= 14) return "llama3.1:8b";
  if (gb >= 8) return "qwen2.5:3b";
  return "qwen3:8b";
}

export function resolveProvider() {
  const PROVIDER = process.env.AI_PROVIDER?.toLowerCase() || "anthropic";
  const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  let selectedModel = process.env.OLLAMA_MODEL;
  if (!selectedModel) {
    if (process.env.CHECK_RAM === "true") { selectedModel = getRecommendedModel(); logger.info(`CHECK_RAM enabled. Auto-selected: ${selectedModel}`); }
    else { selectedModel = "llama3.1"; }
  }
  if (PROVIDER === "ollama") return { name: "ollama", model: selectedModel, baseURL: `${OLLAMA_BASE_URL}/v1`, ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: parseInt(process.env.OLLAMA_NUM_CTX || "32768", 10) };
  if (PROVIDER === "deepseek") return { name: "deepseek", model: process.env.DEEPSEEK_MODEL, baseURL: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY, ollamaBaseURL: null, vision: false, contextWindow: 128000 };
  return { name: "anthropic", model: ANTHROPIC_MODEL, client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: 200000 };
}

function inferZodType(zf) {
  const d = zf._def;
  if (d.type) {
    if (d.type === "optional") return inferZodType(d.innerType);
    if (d.type === "enum") return "string";
    if (d.type === "array") return "array";
    return d.type;
  }
  if (d.typeName === "ZodString") return "string";
  if (d.typeName === "ZodNumber") return "number";
  if (d.typeName === "ZodBoolean") return "boolean";
  if (d.typeName === "ZodArray") return "array";
  if (d.typeName === "ZodEnum") return "string";
  return "string";
}

export function zodToJsonSchema(zs) {
  if (!zs?._def?.shape) return { type: "object", properties: {}, required: [] };
  const shape = typeof zs._def.shape === "function" ? zs._def.shape() : zs._def.shape;
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(shape)) { properties[k] = { type: inferZodType(v) }; if (v.isOptional && !v.isOptional()) required.push(k); }
  return { type: "object", properties, required };
}

const CTX_WARN_TARGET = 0.60;
const CTX_TRIM_TARGET = 0.75;
const CTX_MIN_MESSAGES = 4;

function trimByTokens(msgs, inputTokens, contextWindow) {
  if (inputTokens < contextWindow * CTX_TRIM_TARGET) return { messages: msgs, dropped: 0 };
  const pressure = (inputTokens - contextWindow * CTX_TRIM_TARGET) / (contextWindow * (1 - CTX_TRIM_TARGET));
  const dropFraction = Math.min(0.5, pressure * 0.5);
  const toDrop = Math.floor((msgs.length - 1) * dropFraction);
  if (toDrop <= 0) return { messages: msgs, dropped: 0 };
  const kept = Math.max(CTX_MIN_MESSAGES, msgs.length - toDrop);
  return { messages: [msgs[0], ...msgs.slice(-(kept - 1))], dropped: toDrop };
}

function dropOrphanedToolResults(msgs) {
  let i = 1;
  while (i < msgs.length) { const m = msgs[i]; if (m.role !== "tool" && !(Array.isArray(m.content) && m.content[0]?.type === "tool_result")) break; i++; }
  return i === 1 ? msgs : [msgs[0], ...msgs.slice(i)];
}

export function parseMemoriesRaw(raw) {
  if (!raw || raw.trim() === "No memories found." || raw.trim() === "No result") return [];
  return raw.split("---").filter(b => b.trim()).map(block => {
    const lines = block.trim().split("\n");
    const header = lines[0] || "";
    const typeMatch = header.match(/\[(\w+)\]/);
    const titleMatch = header.match(/\] (.+?) \(importance:/) || header.match(/\] (.+)/);
    const importanceMatch = header.match(/importance: (\d)/);
    const contentLine = lines[1] || "";
    const tagsLine = lines.find(l => l.startsWith("Tags:")) || "";
    const tags = tagsLine.replace("Tags:", "").trim().split(",").map(t => t.trim()).filter(Boolean);
    const idLine = lines.find(l => l.startsWith("ID:")) || "";
    const id = idLine.replace("ID:", "").trim() || null;
    const dateLine = lines.find(l => l.startsWith("Created:") || l.startsWith("Saved:")) || "";
    const createdAt = dateLine.split(":").slice(1).join(":").trim() || null;
    const type = typeMatch?.[1]?.toLowerCase() || "fact";
    const title = titleMatch?.[1] || "Untitled";
    return { type, title, content: contentLine, tags: tags[0] === "none" ? [] : tags, importance: Number.parseInt(importanceMatch?.[1] || "3"), id, createdAt };
  });
}

class OllamaStreamHandler {
  constructor(response, emitter, reasoningAdapter, callTool, provider) {
    this.response = response; this.emitter = emitter; this.adapter = reasoningAdapter;
    this.callTool = callTool; this.provider = provider;
    this.fullText = ""; this.reasoningContent = ""; this.toolCalls = [];
    this.tokenBuffer = ""; this.mightBeToolCall = false;
    this.adapterState = reasoningAdapter.createState(); this.detectedThinking = false;
  }
  async process() {
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    this.emitter.send({ type: "stream_start" });
    while (true) { const { done, value } = await reader.read(); if (done) break; if (this.processChunk(decoder.decode(value, { stream: true }))) break; }
    this.flushAdapter();
    return { text: this.fullText, toolCalls: this.toolCalls, cleanText: this.adapter.stripReasoning(this.fullText), reasoningContent: this.reasoningContent || null };
  }
  processChunk(chunk) {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return true;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.usage) streamUsage = { input_tokens: parsed.usage.prompt_tokens ?? 0, output_tokens: parsed.usage.completion_tokens ?? 0, thinking_tokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0 };
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      this.processDelta(delta);
    }
    return false;
  }
  processDelta(delta) {
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!this.toolCalls[i]) this.toolCalls[i] = { id: "", name: "", args: "" };
        if (tc.id) this.toolCalls[i].id = tc.id;
        if (tc.function?.name) this.toolCalls[i].name = tc.function.name;
        if (tc.function?.arguments) this.toolCalls[i].args += tc.function.arguments;
      }
      this.mightBeToolCall = true; return;
    }
    if (delta.reasoning_content) this.reasoningContent += delta.reasoning_content;
    if (!this.adapter.thinks && (delta.reasoning || delta.reasoning_content)) this.detectedThinking = true;
    const { contentToken } = this.adapter.processDelta(delta, this.adapterState, (o) => this.emitter.send(o));
    if (contentToken) { this.fullText += contentToken; if (this.mightBeToolCall) this.tokenBuffer += contentToken; else this.emitter.send({ type: "token", text: contentToken }); }
  }
  flushAdapter() { if (typeof this.adapter.flushState === "function") { const flushed = this.adapter.flushState(this.adapterState); if (flushed) { this.fullText += flushed; if (this.mightBeToolCall) this.tokenBuffer += flushed; else this.emitter.send({ type: "token", text: flushed }); } } }
  flushRemainingTokenBuffer() { if (this.tokenBuffer) { this.emitter.send({ type: "stream_start" }); this.emitter.send({ type: "token", text: this.tokenBuffer }); this.tokenBuffer = ""; } }
}

class ToolExecutor {
  constructor(callTool, emitter, messages) { this.callTool = callTool; this.emitter = emitter; this.messages = messages; }
  async executeToolCalls(toolCalls, cleanText = "", reasoningContent = null) {
    if (!toolCalls?.length) return false;
    const validatedText = validateOutputSafe(cleanText, "tool-preamble");
    const msg = { role: "assistant", content: [] };
    if (validatedText) msg.content.push({ type: "text", text: validatedText });
    if (reasoningContent) msg.reasoning_content = reasoningContent;
    for (const tc of toolCalls) msg.content.push({ type: "tool_use", id: tc.id, name: tc.name, input: this.parseArgs(tc.args) });
    this.messages.push(msg);
    const results = [];
    for (const tc of toolCalls) results.push({ type: "tool_result", tool_use_id: tc.id, content: await this.callTool(tc.name, this.parseArgs(tc.args)) });
    this.messages.push({ role: "tool", content: results }); return true;
  }
  async executeInterceptedToolCall(intercepted, reasoningContent = null) {
    if (!intercepted) return false;
    this.emitter.send({ type: "retract" }); this.emitter.send({ type: "tool", name: intercepted.name });
    const result = await this.callTool(intercepted.name, intercepted.input);
    const id = `intercept_${Date.now()}`;
    this.messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: intercepted.name, input: intercepted.input }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    this.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] });
    if (intercepted.trailing) {
      const validated = validateOutputSafe(intercepted.trailing, "intercept-trailing");
      this.emitter.send({ type: "stream_start" }); this.emitter.send({ type: "stream_end", text: validated, usage: streamUsage });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }] }); return validated;
    }
    return null;
  }
  parseArgs(argsStr) { try { return JSON.parse(argsStr || "{}"); } catch { return {}; } }
  async executeThinkingResponse(cleanText, toolCalls, streamHandler, isThinkingModel, reasoningContent = null) {
    const intercepted = cleanText.trim() ? extractTextToolCall(cleanText, this.messages) : null;
    if (intercepted) {
      const validated = validateOutputSafe(cleanText, "thinking-intercept");
      this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_start" });
      this.emitter.send({ type: "stream_end", text: validated, usage: streamUsage });
      return await this.executeInterceptedToolCall(intercepted, reasoningContent);
    }
    if (toolCalls.length > 0) { this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_end", text: "", usage: streamUsage }); await this.executeToolCalls(toolCalls, cleanText, reasoningContent); return null; }
    const validated = validateOutputSafe(cleanText, "thinking-final");
    this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_end", text: validated, usage: streamUsage });
    this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    return validated;
  }
  async executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent = null) {
    if (toolCalls.length > 0) { this.emitter.send({ type: "stream_end", text: "", usage: streamUsage }); await this.executeToolCalls(toolCalls, cleanText, reasoningContent); return null; }
    if (cleanText.trim()) { const intercepted = extractTextToolCall(cleanText, this.messages); if (intercepted) { streamHandler.tokenBuffer = ""; return await this.executeInterceptedToolCall(intercepted, reasoningContent); } }
    streamHandler.flushRemainingTokenBuffer();
    this.emitter.send({ type: "stream_end", text: "", usage: streamUsage });
    const validated = validateOutputSafe(cleanText, "non-thinking-final");
    this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    return validated;
  }
}

function extractTextToolCall(text, messages) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const searchIn = fenceMatch ? fenceMatch[1].trim() : text;
  const match = searchIn.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const params = parsed.parameters ?? parsed.input ?? parsed.arguments ?? {};
    const cleaned = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== "" && v !== "None" && v !== "null"));
    let trailing = fenceMatch ? text.slice(text.indexOf(fenceMatch[0]) + fenceMatch[0].length).trim() : text.slice(text.indexOf(match[0]) + match[0].length).trim();
    trailing = trailing.replace(/^[-–—\s]*(?:Response|Result|Answer|Output)\s*:\s*/i, "").trim();
    return { name: match[1], input: cleaned, trailing };
  } catch { return null; }
}

export async function createAgent({ root, version, clientName = "Aperio-agent" }) {
  const provider = resolveProvider();
  const reasoningAdapter = resolveReasoningAdapter(provider.model);
  let OLLAMA_THINKS = reasoningAdapter.thinks === true;
  const OLLAMA_NO_TOOLS = reasoningAdapter.noTools === true;
  logger.info(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${OLLAMA_THINKS} noTools=${OLLAMA_NO_TOOLS}`);

  const FILES = ["whoami.md"];
  const CACHED_PROMPT = FILES.map(f => { try { return readFileSync(resolve(root, "prompts", f), "utf-8"); } catch { return ""; } }).join("\n\n");
  const skillIndex = loadSkillIndex(resolve(root, "skills"));
  const alwaysOnContent = getAlwaysOnSkills(skillIndex).map(s => s.content).join("\n\n---\n\n");
  const providerTag = `---\nYou are running as: ${provider.name === "ollama" ? `Ollama (${provider.model})` : provider.name === "deepseek" ? `DeepSeek (${provider.model})` : `Anthropic Claude (${provider.model})`}\nIf asked which model or AI you are, answer accurately using the above.`;

  const getSystemPrompt = (userMessage = "") => {
    const parts = [CACHED_PROMPT];
    if (alwaysOnContent) parts.push(alwaysOnContent);
    const onDemand = matchSkill(userMessage, skillIndex);
    if (onDemand) { logger.info(`🎯 Skill matched: ${onDemand.name}`); parts.push(onDemand.content); }
    parts.push(providerTag);
    return parts.join("\n\n---\n\n");
  };

  const transport = new StdioClientTransport({ command: "node", args: [resolve(root, "mcp/index.js")], env: { ...process.env } });
  const mcp = new Client({ name: clientName, version });
  await mcp.connect(transport);
  const { tools: mcpTools } = await mcp.listTools();
  const anthropicTools = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const ollamaTools = mcpTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.inputSchema) } }));

  const MAX_HISTORY = 20;
  const HEALTH_CHECK_TIMEOUT = parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || "3000", 10);
  const FETCH_TIMEOUT = parseInt(process.env.OLLAMA_FETCH_TIMEOUT_MS || "120000", 10);

  async function callTool(name, input) {
    const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
    const result = await mcp.callTool({ name, arguments: args });
    // Handle multimodal results — image blocks from read_image
    const text = result.content?.find(c => c.type === "text")?.text ?? "";
    const image = result.content?.find(c => c.type === "image");
    if (image) {
      return `[Image data: ${image.data ? `base64 (${Math.round(image.data.length * 0.75 / 1024)}KB)` : "no data"}] ${text}`;
    }
    return text || "No result";
  }

  async function runAnthropicLoop(messages, emitter) {
    while (true) {
      streamUsage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
      const trimmed = messages.length > MAX_HISTORY ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))] : messages;
      let fullText = "", toolUses = [], currentToolUse = null, inputJson = "", stopReason = null, contentBlocks = [];
      const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
      const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
      const stream = provider.client.messages.stream({ model: provider.model, max_tokens: 8192, system: getSystemPrompt(lastUserText), tools: anthropicTools, messages: trimmed });
      emitter.send({ type: "stream_start" });
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "text") contentBlocks.push({ type: "text", text: "" });
          else if (event.content_block.type === "tool_use") {
            currentToolUse = { type: "tool_use", id: event.content_block.id, name: event.content_block.name, input: {} };
            inputJson = ""; contentBlocks.push(currentToolUse); emitter.send({ type: "tool", name: event.content_block.name });
          }
        }
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") { fullText += event.delta.text; emitter.send({ type: "token", text: event.delta.text }); const last = contentBlocks[contentBlocks.length - 1]; if (last?.type === "text") last.text += event.delta.text; }
          else if (event.delta.type === "input_json_delta") inputJson += event.delta.partial_json;
        }
        if (event.type === "content_block_stop" && currentToolUse) { try { currentToolUse.input = JSON.parse(inputJson || "{}"); } catch {} toolUses.push({ ...currentToolUse }); currentToolUse = null; inputJson = ""; }
        if (event.type === "message_start") streamUsage = { input_tokens: event.message.usage.input_tokens ?? 0, output_tokens: event.message.usage.output_tokens ?? 0, thinking_tokens: 0 };
        if (event.type === "message_delta") { stopReason = event.delta.stop_reason; if (event.usage) streamUsage.output_tokens = event.usage.output_tokens ?? streamUsage.output_tokens; }
      }
      const validatedText = validateOutputSafe(fullText, "anthropic");
      streamUsage.thinking_tokens = Math.max(0, streamUsage.output_tokens - encode(validatedText).length);
      emitter.send({ type: "stream_end", text: validatedText, usage: streamUsage });
      const textBlock = contentBlocks.find(b => b.type === "text");
      if (textBlock) textBlock.text = validatedText;
      messages.push({ role: "assistant", content: contentBlocks });
      if (stopReason === "tool_use" && toolUses.length > 0) {
        const toolResults = [];
        for (const tool of toolUses) toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: await callTool(tool.name, tool.input) });
        messages.push({ role: "user", content: toolResults }); continue;
      }
      return validatedText;
    }
  }

  async function checkOllamaHealth(emitter, setAbort) {
    if (provider.name !== "ollama") return true;
    try {
      const c = new AbortController(); setAbort(c);
      const h = await fetch(`${provider.ollamaBaseURL}/api/tags`, { signal: AbortSignal.any([c.signal, AbortSignal.timeout(HEALTH_CHECK_TIMEOUT)]) });
      if (!h.ok) throw new Error(); return true;
    } catch {
      const msg = `Ollama is not running. Fix:\n1. ollama serve\n2. ollama pull ${provider.model}`;
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + msg }); emitter.send({ type: "stream_end", text: msg, usage: streamUsage }); return false;
    }
  }

  async function makeOllamaRequest(messages, openaiMessages, opts, setAbort) {
    const controller = new AbortController(); setAbort(controller);
    const timeoutController = new AbortController(); const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
        body: JSON.stringify({ model: provider.model, messages: openaiMessages, stream_options: { include_usage: true }, ...(OLLAMA_NO_TOOLS || opts.noTools ? {} : { tools: ollamaTools }), stream: true }),
        signal: AbortSignal.any([controller.signal, timeoutController.signal]),
      });
      clearTimeout(timeoutId); return response;
    } catch (e) { clearTimeout(timeoutId); throw e; }
  }

  function toOpenAIMessages(messages, systemPrompt) {
    return [{ role: "system", content: systemPrompt }, ...messages.flatMap(m => {
      if (Array.isArray(m.content) && m.content[0]?.type === "tool_result") return m.content.map(tr => ({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content }));
      if (Array.isArray(m.content)) {
        const text = m.content.filter(b => b.type === "text").map(b => b.text).join("");
        const images = provider.vision === false ? [] : m.content.filter(b => b.type === "image").map(b => ({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }));
        const content = images.length > 0 ? [{ type: "text", text: text || "" }, ...images] : (text || null);
        const tcs = m.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
        return [{ role: m.role, content, ...(tcs.length ? { tool_calls: tcs } : {}), ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
      }
      return [{ role: m.role, content: m.content, ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
    })];
  }

  async function runOllamaLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
    while (true) {
      const prevInputTokens = streamUsage.input_tokens;
      streamUsage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
      if (getAbort()?.signal?.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const pct = prevInputTokens > 0 ? Math.round((prevInputTokens / provider.contextWindow) * 100) : 0;
      if (pct >= Math.round(CTX_WARN_TARGET * 100) && pct < Math.round(CTX_TRIM_TARGET * 100)) emitter.send({ type: "context_warning", pct });
      const { messages: rawMessages, dropped } = prevInputTokens > 0 ? trimByTokens(messages, prevInputTokens, provider.contextWindow) : { messages: messages.length > MAX_HISTORY ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))] : messages, dropped: 0 };
      if (dropped > 0) { logger.info(`[agent] context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
      const trimmed = dropOrphanedToolResults(rawMessages);
      const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
      const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
      const systemPrompt = getSystemPrompt(lastUserText);
      const openaiMessages = toOpenAIMessages(trimmed, systemPrompt);
      const healthy = await checkOllamaHealth(emitter, setAbort);
      if (!healthy) return "Ollama is not running";
      let response;
      try { response = await makeOllamaRequest(messages, openaiMessages, opts, setAbort); }
      catch (e) {
        const errorMsg = e.name === "AbortError" ? "Request timeout" : e.message;
        emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + errorMsg }); emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage }); return errorMsg;
      }
      if (!response.ok) {
        const err = await response.text();
        emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ Ollama error: " + err }); emitter.send({ type: "stream_end", text: err, usage: streamUsage }); return err;
      }
      const streamHandler = new OllamaStreamHandler(response, emitter, reasoningAdapter, callTool, provider);
      const { cleanText, toolCalls, reasoningContent } = await streamHandler.process();
      if (streamHandler.detectedThinking && !OLLAMA_THINKS) { OLLAMA_THINKS = true; logger.info(`[agent] thinking auto-detected for model="${provider.model}"`); }
      dbg(`post-stream | cleanText: ${cleanText.substring(0, 80)} | toolCalls: ${toolCalls.length}`);
      const toolExecutor = new ToolExecutor(callTool, emitter, messages);
      if (OLLAMA_THINKS) { const r = await toolExecutor.executeThinkingResponse(cleanText, toolCalls, streamHandler, true, reasoningContent); if (r !== null) return r; }
      else { const r = await toolExecutor.executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent); if (r !== null) return r; }
      continue;
    }
  }

  return {
    provider, mcpTools,
    get OLLAMA_THINKS() { return OLLAMA_THINKS; },
    OLLAMA_NO_TOOLS, reasoningAdapter, callTool,
    async runAgentLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
      return provider.name === "anthropic" ? runAnthropicLoop(messages, emitter) : runOllamaLoop(messages, emitter, opts, getAbort, setAbort);
    },
    async handleRememberIntent(text, emitter) {
      try { const content = text.replace(/^remember\s+that\s*/i, "").trim(); await callTool("remember", { type: "preference", title: content.substring(0, 60), content }); emitter.send({ type: "tool", name: "remember" }); }
      catch (err) { logger.error("handleRememberIntent failed:", err.message); }
    },
    async fetchMemories() { const raw = await callTool("recall", { limit: 50 }); return { raw, parsed: parseMemoriesRaw(raw) }; },
    async buildGreeting() {
      let ctx = "";
      try { const raw = await callTool("recall", { limit: 50 }); if (raw && raw.trim() && !raw.includes("No memories")) ctx = `\n\nHere is what you know about the user:\n${raw}`; } catch {}
      return `Greet me in one short friendly sentence. Do not use any tools.${ctx}`;
    },
  };
}
