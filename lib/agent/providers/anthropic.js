import { encode } from "gpt-tokenizer";
import { validateOutputSafe } from "../../helpers/validateOutput.js";
import { estimateMsgTokens, trimByTokens, makeContextSignals, ctxPct } from "../../context/trim.js";
import logger from "../../helpers/logger.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

export async function runAnthropicLoop(messages, emitter, opts = {}, ctx) {
  const { provider, callTool, getSystemPrompt, getAnthropicTools } = ctx;
  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  const ctxSignals = makeContextSignals();
  while (true) {
    tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
    streamUsage = zeroUsage();
    const hwm = tokenHWM > 0 ? tokenHWM : messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
    const pct = ctxPct(hwm, provider.contextWindow);
    ctxSignals.emit(emitter, hwm, provider.contextWindow);
    const { messages: raw, dropped } = trimByTokens(messages, hwm, provider.contextWindow);
    if (dropped > 0) { logger.info(`[agent] anthropic context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
    const trimmed = dropped === 0 && raw.length > MAX_HISTORY ? [raw[0], ...raw.slice(-(MAX_HISTORY - 1))] : raw;
    let fullText = "", toolUses = [], currentToolUse = null, inputJson = "", stopReason = null, contentBlocks = [];
    const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
    const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
    const tools = getAnthropicTools(lastUserText, messages);
    let stream;
    try {
      stream = provider.client.messages.stream({ model: provider.model, max_tokens: 8192, system: getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, messages), tools, messages: trimmed });
    } catch (e) {
      logger.error("[anthropic] failed to open stream:", e);
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "stream_end", text: "", usage: streamUsage });
      throw e;
    }
    emitter.send({ type: "stream_start" });
    try {
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
    } catch (e) {
      logger.error("[anthropic] stream error:", e);
      emitter.send({ type: "stream_end", text: fullText || "", usage: streamUsage });
      throw e;
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
