// lib/helpers/datasetRuns.js
// In-memory registry for dataset-lab runs.
//
// Only *active* runs need to live in memory. A completed run's full artifact —
// including every per-row result — is already persisted to disk, so retaining a
// second copy grew the heap with dataset content for the lifetime of the
// process. Terminal runs are therefore reduced to a small record (status,
// timestamps, summary, error) and evicted after a short grace period; anything
// older is served by reading the artifact back.

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

// Fields kept when a run reaches a terminal state. `results` — the large one —
// is deliberately absent; /datasets/runs/:id/results reads the artifact.
const TERMINAL_FIELDS = [
  "id", "status", "config", "createdAt", "startedAt", "finishedAt",
  "summary", "error", "dataset", "split", "revision",
];

/**
 * @param {object} [opts]
 * @param {number} [opts.terminalTtlMs] how long a finished run stays queryable in memory
 * @param {number} [opts.staleTtlMs]    hard cap for runs that never reached a terminal state
 * @param {number} [opts.maxEntries]    upper bound on retained entries
 * @param {Function} [opts.now]         injectable clock (ms)
 */
export function createDatasetRunRegistry({
  terminalTtlMs = 60_000,
  staleTtlMs = 6 * 60 * 60 * 1000,
  maxEntries = 100,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, object>} insertion-ordered: oldest first */
  const runs = new Map();
  /** Internal timing, kept out of the state object so it never hits the wire. */
  const timing = new Map();

  function isExpired(id, state, at) {
    const t = timing.get(id) ?? {};
    if (TERMINAL.has(state.status)) return at - (t.finishedAt ?? at) >= terminalTtlMs;
    // An active run that stopped reporting (crashed worker, lost await) must not
    // pin its config and partial state forever.
    return at - (t.createdAt ?? at) >= staleTtlMs;
  }

  function drop(id) {
    runs.delete(id);
    timing.delete(id);
  }

  function prune() {
    const at = now();
    for (const [id, state] of runs) {
      if (isExpired(id, state, at)) drop(id);
    }
    if (runs.size <= maxEntries) return;
    // Over the cap: drop finished runs first (they are on disk), oldest first,
    // and only then the oldest active ones.
    for (const [id, state] of [...runs]) {
      if (runs.size <= maxEntries) break;
      if (TERMINAL.has(state.status)) drop(id);
    }
    for (const id of [...runs.keys()]) {
      if (runs.size <= maxEntries) break;
      drop(id);
    }
  }

  return {
    create(id, config) {
      const state = {
        id,
        status: "queued",
        config,
        createdAt: new Date(now()).toISOString(),
        cancel: false,
      };
      runs.set(id, state);
      timing.set(id, { createdAt: now() });
      prune();          // after insert: the newest run is never the one shed
      return state;
    },

    get(id) {
      prune();
      return runs.get(id);
    },

    /**
     * Collapse a run to its terminal record, dropping retained result rows.
     * Mutates `state` in place — callers hold a reference to it.
     */
    finish(state, patch = {}) {
      const merged = { ...state, ...patch, finishedAt: new Date(now()).toISOString() };
      const trimmed = {};
      for (const key of TERMINAL_FIELDS) {
        if (merged[key] !== undefined) trimmed[key] = merged[key];
      }
      for (const key of Object.keys(state)) if (!(key in trimmed)) delete state[key];
      Object.assign(state, trimmed);
      const t = timing.get(state.id);
      if (t) t.finishedAt = now();
      return state;
    },

    prune,
    get size() { return runs.size; },
  };
}

export { TERMINAL as DATASET_TERMINAL_STATUSES };
