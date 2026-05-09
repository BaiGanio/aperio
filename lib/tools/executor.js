import { validateOutputSafe } from "../helpers/validateOutput.js";

const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

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
      this.emitter.send({ type: "stream_start" }); this.emitter.send({ type: "stream_end", text: validated, usage: this.streamUsage });
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
