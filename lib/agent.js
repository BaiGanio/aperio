import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { encode } from "gpt-tokenizer";
import { loadSkillIndex, matchSkill } from "./workers/skills.js";
import { resolveReasoningAdapter } from "./workers/reasoning.js";
import { validateOutputSafe } from "./helpers/validateOutput.js";
import logger from "./helpers/logger.js";
import { resolveProvider, getRecommendedModel } from "./providers/index.js";
import { zodToJsonSchema } from "./providers/schema.js";
import { CTX_WARN_TARGET, estimateMsgTokens, trimByTokens, dropOrphanedToolResults } from "./context/trim.js";
import { OllamaStreamHandler } from "./streaming/ollamaHandler.js";
import { ToolExecutor } from "./tools/executor.js";

export { getRecommendedModel, resolveProvider, zodToJsonSchema };

const DEBUG = false;
const dbg = (...args) => DEBUG && logger.debug('dbg:', ...args);
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

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

export async function createAgent({ root, version, clientName = "Aperio-agent" }) {
  const provider = resolveProvider();
  const reasoningAdapter = resolveReasoningAdapter(provider.model);
  let OLLAMA_THINKS = reasoningAdapter.thinks === true;
  const OLLAMA_NO_TOOLS = reasoningAdapter.noTools === true;
  logger.info(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${OLLAMA_THINKS} noTools=${OLLAMA_NO_TOOLS}`);

  const FILES = ["whoami.md"];
  const CACHED_PROMPT = FILES.map(f => { try { return readFileSync(resolve(root, "id", f), "utf-8"); } catch { return ""; } }).join("\n\n");
  const skillIndex = loadSkillIndex(resolve(root, "skills"));
  const providerTag = `---\nYou are running as: ${provider.name === "ollama" ? `Ollama (${provider.model})` : provider.name === "deepseek" ? `DeepSeek (${provider.model})` : `Anthropic Claude (${provider.model})`}\nIf asked which model or AI you are, answer accurately using the above.`;

  const LANG_NAMES = {
    en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
    it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", ro: "Romanian",
    el: "Greek", sv: "Swedish", da: "Danish", fi: "Finnish", cs: "Czech",
    sk: "Slovak", sl: "Slovenian", hr: "Croatian", hu: "Hungarian", et: "Estonian",
    lv: "Latvian", lt: "Lithuanian", mt: "Maltese", ga: "Irish",
  };
  function buildLanguageDirective(lang) {
    const name = LANG_NAMES[lang];
    if (!name || lang === "en") return null;
    return `LANGUAGE DIRECTIVE — highest priority, overrides all other instructions:\n` +
      `The user's interface language is ${name} (${lang}). ` +
      `You MUST think and reason in ${name}. Do NOT use English in your reasoning chain — think in ${name} from the first token. ` +
      `Respond to the user in ${name} using natural, native phrasing. ` +
      `Exception: if the user explicitly writes in a different language, mirror that language for both thinking and response. ` +
      `Keep code, identifiers, file paths, CLI snippets, and proper names in their original form.`;
  }

  const getSystemPrompt = (userMessage = "", lang = "en", extraSystem = "") => {
    const langDirective = buildLanguageDirective(lang);
    const parts = langDirective ? [langDirective, CACHED_PROMPT] : [CACHED_PROMPT];
    const onDemand = matchSkill(userMessage, skillIndex);
    if (onDemand) { logger.info(`🎯 Skill matched: ${onDemand.name}`); parts.push(onDemand.content); }
    parts.push(providerTag);
    if (extraSystem) parts.push(extraSystem);
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
    const text = result.content?.find(c => c.type === "text")?.text ?? "";
    const image = result.content?.find(c => c.type === "image");
    if (image) {
      return `[Image data: ${image.data ? `base64 (${Math.round(image.data.length * 0.75 / 1024)}KB)` : "no data"}] ${text}`;
    }
    return text || "No result";
  }

  async function runAnthropicLoop(messages, emitter, opts = {}) {
    let tokenHWM = 0;
    let streamUsage = zeroUsage();
    while (true) {
      tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
      streamUsage = zeroUsage();
      const hwm = tokenHWM > 0 ? tokenHWM : messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
      const { messages: raw, dropped } = trimByTokens(messages, hwm, provider.contextWindow);
      if (dropped > 0) logger.info(`[agent] anthropic context trimmed: dropped ${dropped} messages at ${Math.round((hwm / provider.contextWindow) * 100)}% pressure`);
      const trimmed = dropped === 0 && raw.length > MAX_HISTORY ? [raw[0], ...raw.slice(-(MAX_HISTORY - 1))] : raw;
      let fullText = "", toolUses = [], currentToolUse = null, inputJson = "", stopReason = null, contentBlocks = [];
      const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
      const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
      const stream = provider.client.messages.stream({ model: provider.model, max_tokens: 8192, system: getSystemPrompt(lastUserText, opts.lang, opts.extraSystem), tools: anthropicTools, messages: trimmed });
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
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + msg }); emitter.send({ type: "stream_end", text: msg, usage: zeroUsage() }); return false;
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
    let tokenHWM = 0;
    let streamUsage = zeroUsage();
    while (true) {
      tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
      streamUsage = zeroUsage();
      if (getAbort()?.signal?.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const hwm = tokenHWM > 0 ? tokenHWM : messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
      const pct = Math.round((hwm / provider.contextWindow) * 100);
      if (pct >= Math.round(CTX_WARN_TARGET * 100) && pct < Math.round(0.75 * 100)) emitter.send({ type: "context_warning", pct });
      const { messages: rawMessages, dropped } = trimByTokens(messages, hwm, provider.contextWindow);
      const safeRaw = dropped === 0 && rawMessages.length > MAX_HISTORY ? [rawMessages[0], ...rawMessages.slice(-(MAX_HISTORY - 1))] : rawMessages;
      if (dropped > 0) { logger.info(`[agent] context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
      const trimmed = dropOrphanedToolResults(safeRaw);
      const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
      const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
      const systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem);
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
      streamUsage = streamHandler.streamUsage;
      if (streamUsage.thinking_tokens === 0 && reasoningContent) streamUsage.thinking_tokens = Math.max(1, Math.ceil(reasoningContent.length / 4));
      if (streamHandler.detectedThinking && !OLLAMA_THINKS) { OLLAMA_THINKS = true; logger.info(`[agent] thinking auto-detected for model="${provider.model}"`); }
      dbg(`post-stream | cleanText: ${cleanText.substring(0, 80)} | toolCalls: ${toolCalls.length}`);
      const toolExecutor = new ToolExecutor(callTool, emitter, messages);
      toolExecutor.streamUsage = streamUsage;
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
      return provider.name === "anthropic" ? runAnthropicLoop(messages, emitter, opts) : runOllamaLoop(messages, emitter, opts, getAbort, setAbort);
    },
    async handleRememberIntent(text, emitter) {
      try { const content = text.replace(/^remember\s+that\s*/i, "").trim(); await callTool("remember", { type: "preference", title: content.substring(0, 60), content }); emitter.send({ type: "tool", name: "remember" }); }
      catch (err) { logger.error("handleRememberIntent failed:", err.message); }
    },
    async fetchMemories() { const raw = await callTool("recall", { limit: 50 }); return { raw, parsed: parseMemoriesRaw(raw) }; },
    async buildGreeting(lang = "en") {
      let ctx = "";
      try { const raw = await callTool("recall", { limit: 50 }); if (raw && raw.trim() && !raw.includes("No memories")) ctx = `\n\nHere is what you know about the user:\n${raw}`; } catch {}
      let greetingPrompt = "Greet me in one short friendly sentence. Do not use any tools.";
      try {
        const localeFile = resolve(root, "public/locales", `${lang}.json`);
        const locale = JSON.parse(readFileSync(localeFile, "utf-8"));
        if (locale.agent_greeting) greetingPrompt = locale.agent_greeting;
      } catch { /* fall back to English */ }
      return `${greetingPrompt}${ctx}`;
    },
  };
}
