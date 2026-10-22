import { performance } from "node:perf_hooks";

const DEFAULTS = Object.freeze({
  maxToolCalls: 64,
  maxSteps: 128,
  timeoutMs: 1_200_000,
  maxProcessedTokens: 300_000,
});

const TOOL_TYPES = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
const STEP_TYPES = new Set(["reasoning", ...TOOL_TYPES, "plan_update"]);
const MAX_SEEN_IDS = 4096;

function resolveLimit(value, fallback, key, onInvalid) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  onInvalid?.(key);
  return fallback;
}

export function resolveCodexTurnBudgets(env = process.env, { onInvalid } = {}) {
  return {
    maxToolCalls: resolveLimit(env.CODEX_TURN_MAX_TOOL_CALLS, DEFAULTS.maxToolCalls, "CODEX_TURN_MAX_TOOL_CALLS", onInvalid),
    maxSteps: resolveLimit(env.CODEX_TURN_MAX_STEPS, DEFAULTS.maxSteps, "CODEX_TURN_MAX_STEPS", onInvalid),
    timeoutMs: resolveLimit(env.CODEX_TURN_TIMEOUT_MS, DEFAULTS.timeoutMs, "CODEX_TURN_TIMEOUT_MS", onInvalid),
    maxProcessedTokens: resolveLimit(env.CODEX_TURN_MAX_PROCESSED_TOKENS, DEFAULTS.maxProcessedTokens, "CODEX_TURN_MAX_PROCESSED_TOKENS", onInvalid),
  };
}

function settingFor(kind) {
  return {
    tool_calls: "CODEX_TURN_MAX_TOOL_CALLS",
    internal_steps: "CODEX_TURN_MAX_STEPS",
    elapsed_ms: "CODEX_TURN_TIMEOUT_MS",
    processed_tokens: "CODEX_TURN_MAX_PROCESSED_TOKENS",
  }[kind];
}

function workType(item) {
  return typeof item?.type === "string" ? item.type : null;
}

export function createCodexTurnMeter({ budgets = resolveCodexTurnBudgets(), now = () => performance.now() } = {}) {
  const startedAt = now();
  const seenIds = new Set();
  let anonymousSequence = 0;
  let toolCalls = 0;
  let internalSteps = 0;
  let exhausted = null;

  function identity(item) {
    if (item?.id != null) return `id:${String(item.id)}`;
    return `anonymous:${++anonymousSequence}`;
  }

  function remember(id) {
    if (seenIds.size >= MAX_SEEN_IDS) seenIds.delete(seenIds.values().next().value);
    seenIds.add(id);
  }

  function exhaust(kind, value, limit, enforcement = "live", inclusive = false) {
    if (exhausted || limit <= 0 || (inclusive ? value < limit : value <= limit)) return exhausted;
    exhausted = { kind, limit, value, enforcement, setting: settingFor(kind) };
    return exhausted;
  }

  function observeItem(eventType, item) {
    const type = workType(item);
    if (!type || !STEP_TYPES.has(type)) return null;
    // A completed-only reasoning item is a real Codex event shape. Other work
    // items are counted at item.started so a live limit can stop before the
    // next side effect begins.
    if (eventType !== "item.started" && !(eventType === "item.completed" && type === "reasoning")) return null;
    const id = identity(item);
    if (item?.id != null && seenIds.has(id)) return null;
    remember(id);
    if (TOOL_TYPES.has(type)) {
      toolCalls += 1;
      if (budgets.maxToolCalls > 0 && toolCalls > budgets.maxToolCalls) {
        return exhaust("tool_calls", toolCalls, budgets.maxToolCalls);
      }
    }
    internalSteps += 1;
    if (budgets.maxSteps > 0 && internalSteps > budgets.maxSteps) {
      return exhaust("internal_steps", internalSteps, budgets.maxSteps);
    }
    return null;
  }

  function observeProcessedTokens(value) {
    const tokens = Number(value) || 0;
    return exhaust("processed_tokens", tokens, budgets.maxProcessedTokens, "observed");
  }

  function observeElapsed() {
    const elapsedMs = Math.max(0, now() - startedAt);
    if (budgets.timeoutMs > 0 && elapsedMs >= budgets.timeoutMs) {
      exhaust("elapsed_ms", elapsedMs, budgets.timeoutMs, "live", true);
    }
    return elapsedMs;
  }

  function snapshot() {
    return {
      tool_calls: toolCalls,
      internal_steps: internalSteps,
      elapsed_ms: observeElapsed(),
      guardrail: exhausted,
    };
  }

  return {
    observeElapsed,
    observeItem,
    observeProcessedTokens,
    snapshot,
    get guardrail() { return exhausted; },
    get startedAt() { return startedAt; },
    tripElapsed() {
      const elapsedMs = observeElapsed();
      return exhausted || exhaust("elapsed_ms", elapsedMs, budgets.timeoutMs, "live", true);
    },
  };
}

export { DEFAULTS as CODEX_TURN_DEFAULTS };
