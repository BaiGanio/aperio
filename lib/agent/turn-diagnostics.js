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
 *
 * `hadMutationToolOffered` gates the whole check on whether tool-profiles.js
 * actually attached a persistence-capable tool (file-edit/file-generate) to
 * THIS turn — without it, a bare "implement an LRU cache" prompt is neither
 * mutation-intent (tool-profiles.js's own fileEditIntent regex correctly
 * withholds file-edit for it, tool-profiles.js:413-425) nor was the model
 * ever given a file tool to have skipped. Confirmed live in session
 * 10d42bab-7081-4842-aa51-b9913dfc9e14: the model answered normally with an
 * inline code block and this diagnostic still fired, telling the user the
 * model answered with code "instead of writing files" when no file tool was
 * ever on offer. A turn without the tool offered is neutral evidence either
 * way, so it neither builds nor breaks an existing streak.
 */
export function checkNoToolUse({ state, provider, emitter, finalText, toolCallCount, answerArtifactCount = 0, noTools, hadMutationToolOffered = false }) {
  if (noTools || state.noTools) return;
  if (toolCallCount > 0 || answerArtifactCount > 0) {
    state.noToolStreak = 0;
    return;
  }
  if (!hadMutationToolOffered) return;
  const proseWithCode =
    toolCallCount === 0 &&
    answerArtifactCount === 0 &&
    typeof finalText === "string" &&
    finalText.includes("```");
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
