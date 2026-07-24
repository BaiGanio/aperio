// tests/harness/mock-provider.js
//
// Scripted "model" for the deterministic agent-loop regression harness
// (agent-harness-epic WS0). Matches the abortable-provider signature every
// real provider loop uses (see lib/agent/providers/anthropic.js) so it drives
// the REAL runAgentLoop, middleware stack, and tool hooks — the only thing
// that's fake is the model turn itself.
//
// ctx.provider.script is a flat array of turns, each either:
//   { tool: "read_file", args: { path: "x" } }   — one scripted tool call
//   { text: "final answer" }                     — ends the script, returns text
//   { plan: "APERIO_PLAN:{...}" }                — a leading, non-terminal text
//                                                   message (agent-harness-epic
//                                                   WS1); the script continues
//                                                   after it. Lets a scenario
//                                                   script the model announcing
//                                                   its plan before its first
//                                                   tool call, the same way a
//                                                   real provider can interleave
//                                                   a text preamble with tool
//                                                   calls.
//
// A string arg value of "$lastArtifactId" is substituted with the artifact ID
// parsed out of the immediately preceding tool call's raw result text (the
// offload preview always embeds "Artifact: <id> ..." — see
// lib/context/toolResultOffload.js's previewText()) so a scenario can round-trip
// through an offloaded result without the harness needing a side channel into
// the emitter's event stream.
//
// resolveProvider() (lib/providers/index.js) already refuses to resolve this
// provider name outside NODE_ENV=test, so this module only ever runs under
// `node --test`.

const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
const ARTIFACT_ID_RE = /Artifact:\s*([^\s·]+)/;

function resolvePlaceholders(args, lastResultText) {
  if (!args || typeof args !== "object") return args;
  const resolved = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === "$lastArtifactId") {
      const match = typeof lastResultText === "string" ? lastResultText.match(ARTIFACT_ID_RE) : null;
      resolved[key] = match ? match[1] : value;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

export async function runMockLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}, ctx) {
  const { provider, callTool, prepareModelContext } = ctx;
  const script = Array.isArray(provider.script) ? provider.script : [];
  let lastResultText = null;
  let toolCallIndex = 0;

  for (const turn of script) {
    if (getAbort()?.signal?.aborted) {
      emitter.send({ type: "stream_end", text: "", usage: zeroUsage() });
      return "";
    }
    // Exercise the real beforeModel/selectTools middleware chain like every
    // other provider loop, even though the mock ignores the returned prompt —
    // this is what makes the harness a regression net for that chain.
    if (prepareModelContext) {
      await prepareModelContext({
        messages,
        observedInputTokens: 0,
        lang: opts.lang,
        extraSystem: opts.extraSystem,
        providerLabel: "mock",
      });
    }

    if (turn.plan !== undefined) {
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "token", text: turn.plan });
      emitter.send({ type: "stream_end", text: turn.plan, usage: zeroUsage() });
      messages.push({ role: "assistant", content: [{ type: "text", text: turn.plan }] });
      continue;
    }

    if (turn.text !== undefined) {
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "token", text: turn.text });
      emitter.send({ type: "stream_end", text: turn.text, usage: zeroUsage() });
      messages.push({ role: "assistant", content: [{ type: "text", text: turn.text }] });
      return turn.text;
    }

    if (turn.tool) {
      emitter.send({ type: "stream_start" });
      const id = `mock_tool_${++toolCallIndex}`;
      const args = resolvePlaceholders(turn.args ?? {}, lastResultText);
      messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: turn.tool, input: args }] });
      const result = await callTool(turn.tool, args);
      lastResultText = typeof result === "string" ? result : null;
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] });
      emitter.send({ type: "stream_end", text: "", usage: zeroUsage() });
      if (emitter._confirmPending) { delete emitter._confirmPending; return ""; }
      continue;
    }
  }

  // Script exhausted without a final `{ text }` turn (including an empty
  // script) — end the turn cleanly with no answer, same as a real model
  // that stopped issuing tool calls without ever answering.
  emitter.send({ type: "stream_start" });
  emitter.send({ type: "stream_end", text: "", usage: zeroUsage() });
  return "";
}
