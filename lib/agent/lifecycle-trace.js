export const DEFAULT_LIFECYCLE_TRACE_LIMIT = 200;
export const MAX_LIFECYCLE_TRACE_LIMIT = 1_000;

const DECISIONS = new Set(["continue", "update", "stop", "error"]);
const ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "AggregateError",
  "LifecycleMiddlewareError",
]);

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_LIFECYCLE_TRACE_LIMIT;
  return Math.min(parsed, MAX_LIFECYCLE_TRACE_LIMIT);
}

function finiteMilliseconds(value) {
  return Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000) / 1_000
    : 0;
}

/**
 * Bounded, metadata-only trace for one agent run.
 *
 * record() deliberately accepts only lifecycle identity, timing, decision, and
 * error class fields. Requests, arguments, prompts, results, and artifact
 * content have no storage path in this contract.
 */
export function createLifecycleTrace({
  limit = DEFAULT_LIFECYCLE_TRACE_LIMIT,
  now = () => performance.now(),
} = {}) {
  const capacity = normalizeLimit(limit);
  const startedAt = now();
  const records = [];
  let sequence = 0;
  let dropped = 0;

  return Object.freeze({
    limit: capacity,

    record({ hook, middleware, durationMs, decision, errorType = null }) {
      const entry = Object.freeze({
        sequence: ++sequence,
        atMs: finiteMilliseconds(now() - startedAt),
        durationMs: finiteMilliseconds(durationMs),
        hook: String(hook),
        middleware: String(middleware),
        decision: DECISIONS.has(decision) ? decision : "continue",
        ...(errorType ? {
          errorType: ERROR_TYPES.has(String(errorType)) ? String(errorType) : "Error",
        } : {}),
      });
      if (records.length >= capacity) {
        records.shift();
        dropped++;
      }
      records.push(entry);
    },

    entries() {
      return Object.freeze([...records]);
    },

    stats() {
      return Object.freeze({
        retained: records.length,
        dropped,
        limit: capacity,
      });
    },
  });
}
