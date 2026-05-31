import { validateOutputSafe } from "../helpers/validateOutput.js";
import logger from "../helpers/logger.js";

const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

// Tools that touch disk, memory, or external state. For these, we refuse to
// "repair" malformed JSON args — the regex repair below can succeed in
// producing parseable JSON while silently shifting string boundaries, which
// for edit_file/write_file means a corrupted file lands on disk. Better to
// hand the model a parse error and let it retry with valid JSON.
const DESTRUCTIVE_TOOLS = new Set([
  "write_file", "edit_file", "append_file", "generate_xlsx", "run_node_script",
  "run_shell", "wiki_write", "remember", "update_memory", "forget",
  "backfill_embeddings", "deduplicate_memories",
]);

export function extractTextToolCall(text, messages) {
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

export class ToolExecutor {
  constructor(callTool, emitter, messages) { this.callTool = callTool; this.emitter = emitter; this.messages = messages; this.streamUsage = zeroUsage(); }
  async executeToolCalls(toolCalls, cleanText = "", reasoningContent = null) {
    if (!toolCalls?.length) return false;
    const validatedText = validateOutputSafe(cleanText, "tool-preamble");
    const msg = { role: "assistant", content: [] };
    if (validatedText) msg.content.push({ type: "text", text: validatedText });
    if (reasoningContent) msg.reasoning_content = reasoningContent;
    const parsedByTc = new Map();
    for (const tc of toolCalls) {
      const parsed = this.parseArgs(tc.args, tc.name);
      parsedByTc.set(tc.id, parsed);
      msg.content.push({ type: "tool_use", id: tc.id, name: tc.name, input: parsed });
    }
    this.messages.push(msg);
    const results = [];
    for (const tc of toolCalls) {
      // Surface each tool call to the UI so the user sees what the agent is
      // doing during the otherwise-silent execution window (e.g. write_file →
      // run_node_script → verify on a pptx build). Without this the frontend
      // falls back to an idle "connected" state and looks frozen. Anthropic
      // emits this from its own stream; deepseek/ollama route through here.
      this.emitter.send({ type: "tool", name: tc.name });
      results.push({ type: "tool_result", tool_use_id: tc.id, content: await this.callTool(tc.name, parsedByTc.get(tc.id)) });
    }
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
      this.emitter.send({ type: "stream_start" }); this.emitter.send({ type: "stream_end", text: validated, usage: this.streamUsage });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }] }); return validated;
    }
    return null;
  }
  parseArgs(argsStr, toolName = "") {
    if (!argsStr || argsStr.trim() === "") return {};
    try { return JSON.parse(argsStr); } catch (err) {
      // For destructive tools, do not attempt regex repair — a "successful"
      // repair can shift string boundaries by one quote and silently corrupt
      // file contents. Hand the model a parse error and let it retry.
      if (DESTRUCTIVE_TOOLS.has(toolName)) {
        logger.error(
          `[executor] parseArgs REFUSED to repair "${toolName}" args (destructive tool): ${err.message}\n` +
          `  raw: ${argsStr.slice(0, 400)}`
        );
        return { __parse_error__:
          `Tool "${toolName}" requires strictly valid JSON arguments. JSON.parse error: ${err.message}. ` +
          `Retry with correctly escaped JSON (every string must be double-quoted, every key must be followed by a colon, every internal quote must be escaped as \\").`
        };
      }
      const repaired = argsStr
        .replace(/"([^"\\]*)"\s*(?=")/g, '"$1":')              // missing colon: {"key""val"} → {"key":"val"}
        .replace(/(?<=[{,]\s*)"([^"{}:,\n\r]+):/g, '"$1":')    // unclosed key quote: "key: val → "key": val
        .replace(/([^"\\])\s*}\s*$/, '$1"}');                   // missing closing quote at end
      try {
        const result = JSON.parse(repaired);
        logger.warn(
          `[executor] parseArgs repaired malformed JSON from model (${toolName || "unknown"})\n` +
          `  raw:      ${argsStr.slice(0, 400)}\n` +
          `  repaired: ${repaired.slice(0, 400)}`
        );
        return result;
      } catch { /* fall through to error */ }
      logger.error(
        `[executor] parseArgs failed (${toolName || "unknown"}): ${err.message}\n` +
        `  raw: ${argsStr.slice(0, 400)}`
      );
      return { __parse_error__: `Tool arguments were not valid JSON: ${err.message}. Please retry with correct JSON.` };
    }
  }
  async executeThinkingResponse(cleanText, toolCalls, streamHandler, isThinkingModel, reasoningContent = null) {
    const intercepted = cleanText.trim() ? extractTextToolCall(cleanText, this.messages) : null;
    if (intercepted) {
      const validated = validateOutputSafe(cleanText, "thinking-intercept");
      this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_start" });
      this.emitter.send({ type: "stream_end", text: validated, usage: this.streamUsage });
      return await this.executeInterceptedToolCall(intercepted, reasoningContent);
    }
    if (toolCalls.length > 0) { this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_end", text: "", usage: this.streamUsage }); await this.executeToolCalls(toolCalls, cleanText, reasoningContent); return null; }
    const validated = validateOutputSafe(cleanText, "thinking-final");
    this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_end", text: validated, usage: this.streamUsage });
    this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    return validated;
  }
  async executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent = null) {
    if (toolCalls.length > 0) { this.emitter.send({ type: "stream_end", text: "", usage: this.streamUsage }); await this.executeToolCalls(toolCalls, cleanText, reasoningContent); return null; }
    if (cleanText.trim()) { const intercepted = extractTextToolCall(cleanText, this.messages); if (intercepted) { streamHandler.tokenBuffer = ""; return await this.executeInterceptedToolCall(intercepted, reasoningContent); } }
    streamHandler.flushRemainingTokenBuffer();
    this.emitter.send({ type: "stream_end", text: "", usage: this.streamUsage });
    const validated = validateOutputSafe(cleanText, "non-thinking-final");
    this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    return validated;
  }
}
