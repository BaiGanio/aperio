/**
 * lib/agent.js — Aperio shared agent core (REFACTORED)
 * 
 * Changes:
 * - Extracted OllamaStreamHandler class for stream processing
 * - Extracted ToolExecutor class for tool call handling
 * - Removed duplicate simplifySchema (using zodToJsonSchema)
 * - Replaced console.error with logger
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { resolve } from "path";
import os from "os";
import { loadSkillIndex, matchSkill } from "./workers/skills.js";
import { resolveReasoningAdapter } from "./workers/reasoning.js";
import logger from "./helpers/logger.js";

const DEBUG = false;
const dbg = (...args) => DEBUG && logger.debug('dbg:', ...args);
let streamUsage = { input_tokens: 0, output_tokens: 0 };

// ─── Model selection ──────────────────────────────────────────────────────────
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
    if (process.env.CHECK_RAM === "true") {
      selectedModel = getRecommendedModel();
      logger.info(`CHECK_RAM enabled. Auto-selected: ${selectedModel}`);
    } else {
      selectedModel = "llama3.1";
    }
  }

  if (PROVIDER === "ollama") {
    return {
      name: "ollama",
      model: selectedModel,
      baseURL: `${OLLAMA_BASE_URL}/v1`,
      ollamaBaseURL: OLLAMA_BASE_URL,
    };
  }

  if (PROVIDER === "deepseek") {
    return {
      name: "deepseek",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY,
      ollamaBaseURL: null,
      vision: false,
    };
  }

  return {
    name: "anthropic",
    model: ANTHROPIC_MODEL,
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    ollamaBaseURL: OLLAMA_BASE_URL,
  };
}

// ─── JSON Schema conversion ─────────────────────────
function inferZodType(zodField) {
  const def = zodField._def;
  if (def.typeName === "ZodString") return "string";
  if (def.typeName === "ZodNumber") return "number";
  if (def.typeName === "ZodBoolean") return "boolean";
  if (def.typeName === "ZodArray") return "array";
  if (def.typeName === "ZodEnum") return "string";
  return "string";
}

export function zodToJsonSchema(zodSchema) {
  if (!zodSchema?._def?.shape) {
    return { type: "object", properties: {}, required: [] };
  }
  
  const shape = zodSchema._def.shape();
  const properties = {};
  const required = [];
  
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = { type: inferZodType(value) };
    if (value.isOptional && !value.isOptional()) {
      required.push(key);
    }
  }
  return { type: "object", properties, required };
}

// ─── Utility ──────────────────────────────────────────────────────────────────
export function fixUnclosedFence(text) {
  const fences = text.match(/```/g) || [];
  if (fences.length % 2 === 0) return text;
  // If the text already ends with ```, it's a dangling closer — leave it
  if (text.trimEnd().endsWith("```")) return text;
  return text + "\n```";
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
    return {
      type: typeMatch?.[1]?.toLowerCase() || "fact",
      title: titleMatch?.[1] || "Untitled",
      content: contentLine,
      tags: tags[0] === "none" ? [] : tags,
      importance: Number.parseInt(importanceMatch?.[1] || "3"),
      id,
      createdAt,
    };
  });
}

// ─── OllamaStreamHandler ──────────────────────────────────────────────────────
class OllamaStreamHandler {
  constructor(response, emitter, reasoningAdapter, callTool, provider) {
    this.response = response;
    this.emitter = emitter;
    this.adapter = reasoningAdapter;
    this.callTool = callTool;
    this.provider = provider;
    
    this.fullText = "";
    this.toolCalls = [];
    this.tokenBuffer = "";
    this.mightBeToolCall = false;
    this.adapterState = reasoningAdapter.createState();
    this.detectedThinking = false;
  }
  
  async process() {
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    
    this.emitter.send({ type: "stream_start" });
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const shouldStop = this.processChunk(chunk);
      if (shouldStop) break;
    }
    
    this.flushAdapter();
    return {
      text: this.fullText,
      toolCalls: this.toolCalls,
      cleanText: this.adapter.stripReasoning(this.fullText),
    };
  }
  
  processChunk(chunk) {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return true;
      
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      
      if (parsed.usage) {
        streamUsage = {
          input_tokens: parsed.usage.prompt_tokens ?? 0,
          output_tokens: parsed.usage.completion_tokens ?? 0,
        };
      }
      
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      
      this.processDelta(delta);
    }
    return false;
  }
  
  processDelta(delta) {
    // Handle tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!this.toolCalls[i]) this.toolCalls[i] = { id: "", name: "", args: "" };
        if (tc.id) this.toolCalls[i].id = tc.id;
        if (tc.function?.name) this.toolCalls[i].name = tc.function.name;
        if (tc.function?.arguments) this.toolCalls[i].args += tc.function.arguments;
      }
      this.mightBeToolCall = true;
      return;
    }
    
    // Probe: detect reasoning fields on models not yet in the adapter registry
    if (!this.adapter.thinks && (delta.reasoning || delta.reasoning_content)) {
      this.detectedThinking = true;
    }

    // Handle text/reasoning via adapter
    const adapterEmit = (obj) => this.emitter.send(obj);
    const { contentToken } = this.adapter.processDelta(delta, this.adapterState, adapterEmit);
    
    if (contentToken) {
      this.fullText += contentToken;
      if (this.mightBeToolCall) {
        this.tokenBuffer += contentToken;
      } else {
        this.emitter.send({ type: "token", text: contentToken });
      }
    }
  }
  
  flushAdapter() {
    if (typeof this.adapter.flushState === "function") {
      const flushed = this.adapter.flushState(this.adapterState);
      if (flushed) {
        this.fullText += flushed;
        if (this.mightBeToolCall) {
          this.tokenBuffer += flushed;
        } else {
          this.emitter.send({ type: "token", text: flushed });
        }
      }
    }
  }
  
  flushRemainingTokenBuffer() {
    if (this.tokenBuffer) {
      this.emitter.send({ type: "stream_start" });
      this.emitter.send({ type: "token", text: this.tokenBuffer });
      this.tokenBuffer = "";
    }
  }
}

// ─── ToolExecutor ─────────────────────────────────────────────────────────────
class ToolExecutor {
  constructor(callTool, emitter, messages) {
    this.callTool = callTool;
    this.emitter = emitter;
    this.messages = messages;
  }
  
  async executeToolCalls(toolCalls, cleanText = "") {
    if (!toolCalls?.length) return false;
    
    const assistantMsg = { role: "assistant", content: [] };
    if (cleanText) assistantMsg.content.push({ type: "text", text: cleanText });
    
    for (const tc of toolCalls) {
      assistantMsg.content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: this.parseArgs(tc.args),
      });
    }
    
    this.messages.push(assistantMsg);
    
    const results = [];
    for (const tc of toolCalls) {
      const input = this.parseArgs(tc.args);
      const result = await this.callTool(tc.name, input);
      results.push({ type: "tool_result", tool_use_id: tc.id, content: result });
    }
    
    this.messages.push({ role: "user", content: results });
    return true;
  }
  
  async executeInterceptedToolCall(intercepted) {
    if (!intercepted) return false;
    
    this.emitter.send({ type: "retract" });
    this.emitter.send({ type: "tool", name: intercepted.name });
    
    const result = await this.callTool(intercepted.name, intercepted.input);
    const id = `intercept_${Date.now()}`;
    
    this.messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id, name: intercepted.name, input: intercepted.input }]
    });
    this.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: result }]
    });
    
    if (intercepted.trailing) {
      this.emitter.send({ type: "stream_start" });
      this.emitter.send({ type: "stream_end", text: intercepted.trailing, usage: streamUsage });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: intercepted.trailing }] });
      return intercepted.trailing;
    }
    
    return null;
  }
  
  parseArgs(argsStr) {
    try {
      return JSON.parse(argsStr || "{}");
    } catch {
      return {};
    }
  }
  
  async executeThinkingResponse(cleanText, toolCalls, streamHandler, isThinkingModel) {
    const intercepted = cleanText.trim() ? extractTextToolCall(cleanText, this.messages) : null;
    
    if (intercepted) {
      this.emitter.send({ type: "reasoning_done" });
      this.emitter.send({ type: "stream_start" });
      this.emitter.send({ type: "stream_end", text: fixUnclosedFence(cleanText), usage: streamUsage });
      return await this.executeInterceptedToolCall(intercepted);
    }
    
    if (toolCalls.length > 0) {
      this.emitter.send({ type: "reasoning_done" });
      await this.executeToolCalls(toolCalls, cleanText);
      return null; // Continue loop
    }
    
    this.emitter.send({ type: "reasoning_done" });
    this.emitter.send({ type: "stream_end", text: "", usage: streamUsage });
    this.messages.push({ role: "assistant", content: [{ type: "text", text: cleanText }] });
    return cleanText;
  }
  
  async executeNonThinkingResponse(cleanText, toolCalls, streamHandler) {
    if (toolCalls.length > 0) {
      await this.executeToolCalls(toolCalls, cleanText);
      return null; // Continue loop
    }
    
    if (cleanText.trim()) {
      const intercepted = extractTextToolCall(cleanText, this.messages);
      if (intercepted) {
        streamHandler.tokenBuffer = "";
        return await this.executeInterceptedToolCall(intercepted);
      }
    }
    
    streamHandler.flushRemainingTokenBuffer();
    this.emitter.send({ type: "stream_end", text: "", usage: streamUsage });
    this.messages.push({ role: "assistant", content: [{ type: "text", text: cleanText }] });
    return cleanText;
  }
}

// ─── Helper: extract text tool call ─────────────────────────────────────────
function extractTextToolCall(text, messages) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const searchIn = fenceMatch ? fenceMatch[1].trim() : text;
  const match = searchIn.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (!match) return null;
  
  try {
    const parsed = JSON.parse(match[0]);
    const params = parsed.parameters ?? parsed.input ?? parsed.arguments ?? {};
    const cleaned = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v != null && v !== "" && v !== "None" && v !== "null")
    );
    let trailing = fenceMatch
      ? text.slice(text.indexOf(fenceMatch[0]) + fenceMatch[0].length).trim()
      : text.slice(text.indexOf(match[0]) + match[0].length).trim();
    trailing = trailing.replace(/^[-–—\s]*(?:Response|Result|Answer|Output)\s*:\s*/i, "").trim();
    return { name: match[1], input: cleaned, trailing };
  } catch {
    return null;
  }
}

// ─── createAgent ─────────────────────────────────────────────────────────────
export async function createAgent({ root, version, clientName = "Aperio-agent" }) {
  const provider = resolveProvider();
  const reasoningAdapter = resolveReasoningAdapter(provider.model);
  let OLLAMA_THINKS = reasoningAdapter.thinks === true;
  const OLLAMA_NO_TOOLS = reasoningAdapter.noTools === true;

  logger.info(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${OLLAMA_THINKS} noTools=${OLLAMA_NO_TOOLS}`);

  // ─── Agent Identity and Skills ─────────────────────────────────────────────
  const FILES = ["whoami.md"];
  const CACHED_PROMPT = FILES.map(f => {
    try { return readFileSync(resolve(root, "prompts", f), "utf-8"); }
    catch { return ""; }
  }).join("\n\n");
  const skillIndex = loadSkillIndex(resolve(root, "skills"));

  const providerTag = `---\nYou are running as: ${
    provider.name === "ollama"
      ? `Ollama (${provider.model})`
      : provider.name === "deepseek"
        ? `DeepSeek (${provider.model})`
        : `Anthropic Claude (${provider.model})`
  }\nIf asked which model or AI you are, answer accurately using the above.`;

  const getSystemPrompt = (userMessage = "") => {
    const skill = matchSkill(userMessage, skillIndex);
    if (skill) {
      logger.info(`🎯 Skill matched: ${skill.name}`);
      return `${CACHED_PROMPT}\n\n---\n\n${skill.content}\n\n${providerTag}`;
    }
    return `${CACHED_PROMPT}\n\n${providerTag}`;
  };

  // ─── MCP ───────────────────────────────────────────────────────────────────
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(root, "mcp/index.js")],
    env: { ...process.env },
  });
  const mcp = new Client({ name: clientName, version });
  await mcp.connect(transport);

  const { tools: mcpTools } = await mcp.listTools();
  const mcpToolNames = new Set(mcpTools.map(t => t.name));
  const anthropicTools = mcpTools.map(t => ({ 
    name: t.name, 
    description: t.description, 
    input_schema: t.inputSchema 
  }));
  const ollamaTools = mcpTools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.inputSchema),
    },
  }));

  const MAX_HISTORY = 20;
  const HEALTH_CHECK_TIMEOUT = parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || "3000", 10);
  const FETCH_TIMEOUT = parseInt(process.env.OLLAMA_FETCH_TIMEOUT_MS || "10000", 10);

  // ─── Internal helpers ───────────────────────────────────────────────────────
  async function callTool(name, input) {
    const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
    const result = await mcp.callTool({ name, arguments: args });
    return result.content?.[0]?.text ?? "No result";
  }

  // ─── Anthropic loop ─────────────────────────────────────────────────────────
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
      emitter.send({ type: "stream_start" });

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            contentBlocks.push({ type: "text", text: "" });
          } else if (event.content_block.type === "tool_use") {
            currentToolUse = { type: "tool_use", id: event.content_block.id, name: event.content_block.name, input: {} };
            inputJson = "";
            contentBlocks.push(currentToolUse);
            emitter.send({ type: "tool", name: event.content_block.name });
          }
        }
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            fullText += event.delta.text;
            emitter.send({ type: "token", text: event.delta.text });
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
          if (event.usage) {
            streamUsage = {
              input_tokens: event.usage.input_tokens ?? 0,
              output_tokens: event.usage.output_tokens ?? 0,
            };
          }
        }
      }

      emitter.send({ type: "stream_end", text: fullText, usage: streamUsage });
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

  // ─── Ollama health check ────────────────────────────────────────────────────
  async function checkOllamaHealth(emitter, setAbort) {
    if (provider.name !== "ollama") return true;
    try {
      const controller = new AbortController();
      setAbort(controller);
      const h = await fetch(`${provider.ollamaBaseURL}/api/tags`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(HEALTH_CHECK_TIMEOUT)]),
      });
      if (!h.ok) throw new Error();
      return true;
    } catch {
      const msg = `Ollama is not running. Fix:\n1. ollama serve\n2. ollama pull ${provider.model}`;
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "token", text: "⚠️ " + msg });
      emitter.send({ type: "stream_end", text: msg, usage: streamUsage });
      return false;
    }
  }

  // ─── Ollama request ─────────────────────────────────────────────────────────
  async function makeOllamaRequest(messages, openaiMessages, opts, setAbort) {
    const controller = new AbortController();
    setAbort(controller);
    
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT);
    
    try {
      const response = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          messages: openaiMessages,
          stream_options: { include_usage: true },
          ...(OLLAMA_NO_TOOLS || opts.noTools ? {} : { tools: ollamaTools }),
          stream: true,
        }),
        signal: AbortSignal.any([controller.signal, timeoutController.signal]),
      });
      clearTimeout(timeoutId);
      return response;
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  // ─── Convert messages to OpenAI format ──────────────────────────────────────
  function toOpenAIMessages(messages, systemPrompt) {
    return [
      { role: "system", content: systemPrompt },
      ...messages.map(m => {
        if (Array.isArray(m.content) && m.content[0]?.type === "tool_result") {
          return { role: "tool", tool_call_id: m.content[0].tool_use_id, content: m.content[0].content };
        }
        if (Array.isArray(m.content)) {
          const text = m.content.filter(b => b.type === "text").map(b => b.text).join("");
          const images = provider.vision === false ? [] : m.content
            .filter(b => b.type === "image")
            .map(b => ({
              type: "image_url",
              image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` }
            }));
          const content = images.length > 0
            ? [{ type: "text", text: text || "" }, ...images]
            : (text || null);
          const tcs = m.content.filter(b => b.type === "tool_use").map(b => ({
            id: b.id, type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
          return { role: m.role, content, ...(tcs.length ? { tool_calls: tcs } : {}) };
        }
        return { role: m.role, content: m.content };
      }),
    ];
  }

  // ─── Ollama loop (refactored) ───────────────────────────────────────────────
  async function runOllamaLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
    while (true) {
      if (getAbort()?.signal?.aborted) {
        emitter.send({ type: "stream_end", text: "", usage: streamUsage });
        return "";
      }

      const trimmed = messages.length > MAX_HISTORY
        ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
        : messages;

      const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
      const lastUserText = typeof lastUserMsg?.content === "string"
        ? lastUserMsg.content
        : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";

      const systemPrompt = getSystemPrompt(lastUserText);
      const openaiMessages = toOpenAIMessages(trimmed, systemPrompt);

      // Health check
      const healthy = await checkOllamaHealth(emitter, setAbort);
      if (!healthy) return "Ollama is not running";

      // Make request
      let response;
      try {
        response = await makeOllamaRequest(messages, openaiMessages, opts, setAbort);
      } catch (e) {
        const errorMsg = e.name === "AbortError" ? "Request timeout" : e.message;
        emitter.send({ type: "stream_start" });
        emitter.send({ type: "token", text: "⚠️ " + errorMsg });
        emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage });
        return errorMsg;
      }

      if (!response.ok) {
        const err = await response.text();
        emitter.send({ type: "stream_start" });
        emitter.send({ type: "token", text: "⚠️ Ollama error: " + err });
        emitter.send({ type: "stream_end", text: err, usage: streamUsage });
        return err;
      }

      // Process stream
      const streamHandler = new OllamaStreamHandler(response, emitter, reasoningAdapter, callTool, provider);
      const { cleanText, toolCalls } = await streamHandler.process();

      if (streamHandler.detectedThinking && !OLLAMA_THINKS) {
        OLLAMA_THINKS = true;
        logger.info(`[agent] thinking auto-detected for model="${provider.model}"`);
      }

      dbg(`post-stream | cleanText: ${cleanText.substring(0, 80)} | toolCalls: ${toolCalls.length}`);

      // Execute tools based on model type
      const toolExecutor = new ToolExecutor(callTool, emitter, messages);
      
      if (OLLAMA_THINKS) {
        const result = await toolExecutor.executeThinkingResponse(cleanText, toolCalls, streamHandler, true);
        if (result !== null) return result;
      } else {
        const result = await toolExecutor.executeNonThinkingResponse(cleanText, toolCalls, streamHandler);
        if (result !== null) return result;
      }
      
      // Continue loop if we executed tools
      continue;
    }
  }

  // ─── Public surface ─────────────────────────────────────────────────────────
  return {
    provider,
    mcpTools,
    get OLLAMA_THINKS() { return OLLAMA_THINKS; },
    OLLAMA_NO_TOOLS,
    reasoningAdapter,
    callTool,

    async runAgentLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
      return provider.name === "anthropic"
        ? runAnthropicLoop(messages, emitter)
        : runOllamaLoop(messages, emitter, opts, getAbort, setAbort);
    },

    async handleRememberIntent(text, emitter) {
      try {
        const content = text.replace(/^remember\s+that\s*/i, "").trim();
        await callTool("remember", { type: "preference", title: content.substring(0, 60), content });
        emitter.send({ type: "tool", name: "remember" });
      } catch (err) {
        logger.error("handleRememberIntent failed:", err.message);
      }
    },

    async fetchMemories() {
      const raw = await callTool("recall", { limit: 50 });
      return { raw, parsed: parseMemoriesRaw(raw) };
    },

    async buildGreeting() {
      let ctx = "";
      try {
        const raw = await callTool("recall", { limit: 50 });
        if (raw && raw.trim() && !raw.includes("No memories"))
          ctx = `\n\nHere is what you know about the user:\n${raw}`;
      } catch {
        // Silently fail — greeting still works without memories
      }
      return `Greet me in one short friendly sentence. Do not use any tools.${ctx}`;
    },
  };
}