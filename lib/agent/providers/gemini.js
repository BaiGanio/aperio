import { trimByTokens, estimateMsgTokens, dropOrphanedToolResults } from "../../context/trim.js";
import logger from "../../helpers/logger.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
const GEMINI_THINKING_BUDGET = parseInt(process.env.GEMINI_THINKING_BUDGET ?? "0", 10);

function contentToParts(content, toolNames = {}) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  return content.flatMap(b => {
    if (b.type === "text" && b.text) return [{ text: b.text }];
    if (b.type === "tool_use") return [{ functionCall: { name: b.name, args: b.input } }];
    if (b.type === "tool_result") {
      const toolName = toolNames[b.tool_use_id] || b.tool_use_id;
      if (Array.isArray(b.content)) {
        const textPart = b.content.find(c => c.type === "text")?.text ?? "";
        const imgParts = b.content.filter(c => c.type === "image").map(c => ({ inlineData: { mimeType: c.source.media_type, data: c.source.data } }));
        return [{ functionResponse: { name: toolName, response: { result: textPart || "Image provided" } } }, ...imgParts];
      }
      return [{ functionResponse: { name: toolName, response: { result: b.content } } }];
    }
    if (b.type === "image") return [{ inlineData: { mimeType: b.source.media_type, data: b.source.data } }];
    return [];
  });
}

function toGeminiHistory(messages) {
  const toolNames = {};
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) { if (b.type === "tool_use") toolNames[b.id] = b.name; }
    }
  }
  return messages.map(m => {
    const parts = contentToParts(m.content, toolNames);
    const hasFunctionResponse = parts.some(p => "functionResponse" in p);
    const role = m.role === "assistant" ? "model" : hasFunctionResponse ? "function" : "user";
    return { role, parts };
  });
}

export async function runGeminiLoop(messages, emitter, opts = {}, ctx) {
  const { provider, callTool, getSystemPrompt, getGeminiTools } = ctx;
  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  while (true) {
    tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
    streamUsage = zeroUsage();
    const hwm = tokenHWM > 0 ? tokenHWM : messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
    const { messages: raw, dropped } = trimByTokens(messages, hwm, provider.contextWindow);
    if (dropped > 0) logger.info(`[agent] gemini context trimmed: dropped ${dropped} messages`);
    const safe = dropped === 0 && raw.length > MAX_HISTORY ? [raw[0], ...raw.slice(-(MAX_HISTORY - 1))] : raw;
    const trimmed = dropOrphanedToolResults(safe);

    const lastMsg = trimmed[trimmed.length - 1];
    const lastUserText = typeof lastMsg?.content === "string" ? lastMsg.content : lastMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
    const systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, messages);
    const geminiTools = getGeminiTools(lastUserText, messages);

    const history = toGeminiHistory(trimmed.slice(0, -1));
    const currentParts = contentToParts(lastMsg?.content ?? "", buildToolNameMap(trimmed));

    const geminiModel = provider.client.getGenerativeModel({
      model: provider.model,
      systemInstruction: systemPrompt,
      generationConfig: GEMINI_THINKING_BUDGET > 0 ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } } : {},
      ...(opts.noTools ? {} : { tools: geminiTools }),
    });

    const lastMsgIsToolResult = Array.isArray(lastMsg?.content) && lastMsg.content.some(b => b.type === "tool_result");
    const currentRole = lastMsgIsToolResult ? "function" : "user";
    const allContents = [...history, { role: currentRole, parts: currentParts }];

    let result;
    try {
      result = await geminiModel.generateContentStream({ contents: allContents });
    } catch (e) {
      const msg = e.message ?? String(e);
      logger.error(`[gemini] generateContentStream failed: ${msg}`, { model: provider.model });
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ Gemini error: " + msg }); emitter.send({ type: "stream_end", text: msg, usage: streamUsage });
      return msg;
    }

    emitter.send({ type: "stream_start" });
    let fullText = "";
    for await (const chunk of result.stream) {
      const textParts = chunk.candidates?.[0]?.content?.parts?.filter(p => "text" in p) ?? [];
      const text = textParts.map(p => p.text).join("");
      if (text) { fullText += text; emitter.send({ type: "token", text }); }
    }

    let response;
    try { response = await result.response; } catch (e) {
      const msg = e.message ?? String(e);
      logger.error(`[gemini] result.response failed: ${msg}`, { model: provider.model });
      emitter.send({ type: "stream_end", text: fullText || msg, usage: streamUsage }); return msg;
    }

    streamUsage = {
      input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      thinking_tokens: response.usageMetadata?.thoughtsTokenCount ?? 0,
    };
    emitter.send({ type: "stream_end", text: fullText, usage: streamUsage });

    const functionCalls = response.functionCalls() ?? [];
    if (functionCalls.length > 0) {
      messages.push({ role: "assistant", content: functionCalls.map(fc => ({ type: "tool_use", id: fc.name, name: fc.name, input: fc.args })) });
      const toolResults = [];
      for (const fc of functionCalls) {
        emitter.send({ type: "tool", name: fc.name });
        const toolResult = await callTool(fc.name, fc.args);
        toolResults.push({ type: "tool_result", tool_use_id: fc.name, content: toolResult });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    messages.push({ role: "assistant", content: fullText });
    return fullText;
  }
}

function buildToolNameMap(messages) {
  const map = {};
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) { if (b.type === "tool_use") map[b.id] = b.name; }
    }
  }
  return map;
}
