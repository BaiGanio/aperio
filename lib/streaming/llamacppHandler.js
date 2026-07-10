const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

// Generic OpenAI-compatible SSE stream reader — shared by any provider speaking
// the /v1/chat/completions protocol (originally written for Ollama; llama.cpp's
// llama-server exposes the same wire format, plus a `timings` block on the
// final chunk that Ollama doesn't send).
export class LlamaCppStreamHandler {
  constructor(response, emitter, reasoningAdapter, callTool, provider, suppressThinking = false) {
    this.response = response; this.emitter = emitter; this.adapter = reasoningAdapter;
    this.callTool = callTool; this.provider = provider;
    this.fullText = ""; this.reasoningContent = ""; this.toolCalls = [];
    this.tokenBuffer = ""; this.mightBeToolCall = false;
    // A streamed error object. llama-server returns HTTP 200 for a streaming
    // request, then emits `data: {"error":{…}}` if inference fails mid-stream
    // (e.g. "Compute error." on an OOM Metal alloc). Captured here so the caller
    // surfaces the real failure instead of treating the empty token stream as a
    // degenerate "no response" completion and burning a pointless retry.
    this.streamError = null;
    this.adapterState = reasoningAdapter.createState(suppressThinking); this.detectedThinking = false;
    this.streamUsage = zeroUsage();
    // llama-server's final SSE chunk carries a `timings` block (prompt_ms,
    // predicted_ms, prompt_per_second, predicted_per_second, cache_n) — not
    // part of the OpenAI schema, so it's captured separately from streamUsage.
    this.timings = null;
    // Carries an incomplete trailing SSE line between network chunks. A single
    // `data: {…}` line is routinely split across two reader.read() reads; without
    // this buffer both halves fail the `data:`/JSON checks and the token is
    // silently dropped — corrupting long outputs (e.g. a streamed HTML page)
    // with scattered missing characters.
    this.sseBuffer = "";
  }
  async process() {
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    this.emitter.send({ type: "stream_start" });
    while (true) { const { done, value } = await reader.read(); if (done) break; if (this.processChunk(decoder.decode(value, { stream: true }))) break; }
    // Process any final line that arrived without a trailing newline.
    if (this.sseBuffer) { const last = this.sseBuffer; this.sseBuffer = ""; this.processLine(last); }
    this.flushAdapter();
    return { text: this.fullText, toolCalls: this.toolCalls, cleanText: this.adapter.stripReasoning(this.fullText), reasoningContent: this.reasoningContent || null };
  }
  processChunk(chunk) {
    this.sseBuffer += chunk;
    let nlIdx;
    // Only consume up to the last newline; keep the (possibly partial) remainder
    // buffered until the next chunk completes it.
    while ((nlIdx = this.sseBuffer.indexOf("\n")) !== -1) {
      const line = this.sseBuffer.slice(0, nlIdx);
      this.sseBuffer = this.sseBuffer.slice(nlIdx + 1);
      if (this.processLine(line)) return true;
    }
    return false;
  }
  processLine(line) {
    if (!line.startsWith("data: ")) return false;
    const data = line.slice(6).trim();
    if (data === "[DONE]") return true;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return false; }
    // A mid-stream error object carries no `choices`/`delta`, so the token path
    // below would silently drop it. Capture the message and end the stream so
    // the caller can report it verbatim.
    if (parsed.error) { this.streamError = parsed.error?.message || parsed.error?.type || "unknown streaming error"; return true; }
    if (parsed.usage) this.streamUsage = { input_tokens: parsed.usage.prompt_tokens ?? 0, output_tokens: parsed.usage.completion_tokens ?? 0, thinking_tokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0 };
    if (parsed.timings) this.timings = parsed.timings;
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return false;
    this.processDelta(delta);
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
    if (delta.reasoning) this.reasoningContent += delta.reasoning;
    if (!this.adapter.thinks && (delta.reasoning || delta.reasoning_content)) this.detectedThinking = true;
    const { contentToken } = this.adapter.processDelta(delta, this.adapterState, (o) => this.emitter.send(o));
    if (contentToken) { this.fullText += contentToken; if (this.mightBeToolCall) this.tokenBuffer += contentToken; else this.emitter.send({ type: "token", text: contentToken }); }
  }
  flushAdapter() { if (typeof this.adapter.flushState === "function") { const flushed = this.adapter.flushState(this.adapterState); if (flushed) { this.fullText += flushed; if (this.mightBeToolCall) this.tokenBuffer += flushed; else this.emitter.send({ type: "token", text: flushed }); } } }
  flushRemainingTokenBuffer() { if (this.tokenBuffer) { this.emitter.send({ type: "stream_start" }); this.emitter.send({ type: "token", text: this.tokenBuffer }); this.tokenBuffer = ""; } }
}
