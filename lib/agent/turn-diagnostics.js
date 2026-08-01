// Post-turn diagnostics: evidence-gated warnings emitted after a provider loop
// returns.
//
// Extracted from lib/agent/index.js:runAgentLoop. Both checks mutate the shared
// `state` object in place (streak counters + one-shot "already warned" flags),
// which is what makes them evidence-gated across turns rather than per-turn —
// so `state` is passed by reference, never copied.

import { isLocalProvider, recommendPerfFix, resolvePerfProfile, SLOW_GEN_TPS } from "../providers/index.js";

// Consecutive slow turns required before the diagnostic fires (llamacpp.md
// Phase 5) — a single slow turn is often a cold model load or a router
// model swap (fast-low-vram's models-max=1), not sustained bad throughput.
const SLOW_TURN_EVIDENCE = 3;

/**
 * Detect models that habitually answer in prose instead of using tools.
 * A single prose-with-codeblock turn is NOT evidence the model can't call
 * tools — capable small models often describe code when the target is
 * vague, and any tool call clears suspicion. So we track a streak and only
 * warn after two consecutive offered-tools turns that produced a code block
 * and zero tool calls. Reset the streak the moment a tool is actually used.
 */
export function checkNoToolUse({ state, provider, emitter, finalText, toolCallCount, answerArtifactCount = 0, noTools }) {
  if (noTools || state.noTools) return;
  const proseWithCode =
    toolCallCount === 0 &&
    answerArtifactCount === 0 &&
    typeof finalText === "string" &&
    finalText.includes("```");
  if (toolCallCount > 0 || answerArtifactCount > 0) {
    state.noToolStreak = 0;
    return;
  }
  if (!proseWithCode) return;
  state.noToolStreak += 1;
  if (state.noToolStreak >= 2 && !state.toolWarningEmitted) {
    state.toolWarningEmitted = true;
    emitter.send({ type: "no_tool_use_detected", model: provider.model });
  }
}

/**
 * Slow-turn diagnostic (llamacpp.md Phase 5 / issue #222).
 *
 * state.lastTimings is set by runLlamaCppLoop from llama-server's own
 * reported generation speed (real prompt/gen tok/s, not wall-clock —
 * wall-clock also counts tool execution and network, which would make
 * a tool-heavy turn look "slow" for reasons a profile/ctx change can't
 * fix). Gated on isLocalProvider so a slow cloud turn (rate limits,
 * network) never suggests a local-only profile switch; gated on
 * genTps !== null so providers that never report timings (Ollama over
 * its OpenAI-compatible /v1, per Phase 0's spike) simply never trigger
 * this — no false positives from an absent signal. Evidence-gated like
 * the no-tool-use warning above: a single slow turn is often a cold
 * model load or router model swap, not sustained bad throughput.
 */
export function checkSlowTurn({ state, provider, emitter }) {
  if (!isLocalProvider(provider.name)) return;
  const genTps = state.lastTimings?.predicted_per_second;
  if (typeof genTps !== "number" || !Number.isFinite(genTps)) return;
  if (genTps >= SLOW_GEN_TPS) {
    state.slowTurnStreak = 0;
    return;
  }
  state.slowTurnStreak += 1;
  if (state.slowTurnStreak >= SLOW_TURN_EVIDENCE && !state.slowTurnWarningEmitted) {
    state.slowTurnWarningEmitted = true;
    const hint = recommendPerfFix({ genTps, profile: resolvePerfProfile() });
    emitter.send({
      type: "slow_local_turn_detected",
      model: provider.model,
      genTps: Math.round(genTps * 10) / 10,
      hint,
    });
  }
}
