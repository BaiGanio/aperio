const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

export class OllamaStreamHandler {
  constructor(response, emitter, reasoningAdapter, callTool, provider) {
    this.response = response; this.emitter = emitter; this.adapter = reasoningAdapter;
    this.callTool = callTool; this.provider = provider;
    this.fullText = ""; this.reasoningContent = ""; this.toolCalls = [];
    this.tokenBuffer = ""; this.mightBeToolCall = false;
    this.adapterState = reasoningAdapter.createState(); this.detectedThinking = false;
    this.streamUsage = zeroUsage();
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
      if (parsed.usage) this.streamUsage = { input_tokens: parsed.usage.prompt_tokens ?? 0, output_tokens: parsed.usage.completion_tokens ?? 0, thinking_tokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0 };
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
