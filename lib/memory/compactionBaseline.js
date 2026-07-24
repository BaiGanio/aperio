// lib/memory/compactionBaseline.js
// Pure helpers for the memory-compaction EPIC's WS0 baseline (#286).
// Extracted out of scripts/memory-compact-baseline.js so they're importable
// and unit-testable without triggering the script's DB seeding/CLI guard —
// mirrors the scripts/model-tier-bench.js + lib/helpers/modelTierBench.js
// split already used elsewhere in this repo (thin CLI entry point, testable
// logic in lib/).

// Every seeded row gets a fresh random UUID (store.insert/insertSelf always
// call randomUUID() internally — no caller override). The formatted payload
// embeds "ID: <uuid>", and BPE tokenizes different hex digit sequences into
// slightly different token counts even at the same 36-char length — so
// token-counting the *real* id makes the baseline jitter by a few tokens on
// every reseed, for no measurement-relevant reason (the id's specific digits
// don't matter to what compaction is trying to save). Substitute a canonical
// fixed-length placeholder before token-counting only — the real id still
// governs actual recall()/self_recall() behavior and is never altered in the
// DB, only in the string this module measures.
export const CANONICAL_ID = "00000000-0000-4000-8000-000000000000";

export function canon(rows) {
  return rows.map(m => ({ ...m, id: CANONICAL_ID }));
}

// Mirrors recallHandler's formatter (lib/handlers/memory/memoryHandlers.js)
// exactly — this is the real string injected into a model's context, not an
// approximation of it (aside from the id substitution above).
export function formatRecallPayload(rows) {
  return canon(rows).map(m => {
    const simNote  = m.similarity  !== undefined ? ` [similarity: ${(m.similarity * 100).toFixed(1)}%]` : "";
    const confNote = m.confidence  !== undefined && m.confidence < 1.0 ? ` [confidence: ${(m.confidence * 100).toFixed(0)}%]` : "";
    return `[${m.type.toUpperCase()}] ${m.title}${simNote}${confNote} (importance: ${m.importance})\n${m.content}\nTags: ${(m.tags || []).join(", ") || "none"}\nID: ${m.id}`;
  }).join("\n---\n");
}

// Mirrors selfRecallHandler's formatter (lib/handlers/memory/selfMemoryHandlers.js).
export function formatSelfPreload(rows) {
  return canon(rows).map(m => {
    return `${m.title} (importance: ${m.importance})\n${m.content}\nTags: ${(m.tags || []).join(", ") || "none"}\nID: ${m.id}`;
  }).join("\n---\n");
}

// Byte-stable pointer string from lib/agent/memory-context.js's
// refreshSessionMemCtx() when memory is on — no memory content, so it is
// reported but flagged as not a compaction target.
export const SESSION_POINTER =
  `MEMORY — you have saved memories about the user and past work, stored outside this ` +
  `conversation. Whenever the user asks what you know or remember, or refers to themselves or an ` +
  `earlier session, call the \`recall\` tool with a query before answering. Never tell the user you ` +
  `have no memory of something without calling recall first.`;

export function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

// A corpus entry is a hit at k if any of its expectedTitles appears among the
// top-k recall() result rows (by title).
export function isHit(expectedTitles, resultRows) {
  const topTitles = new Set(resultRows.map(r => r.title));
  return expectedTitles.some(t => topTitles.has(t));
}

// SqliteStore.init() unconditionally seeds baseline demo content into any
// empty table — including a fresh ":memory:" DB — with no opt-out flag (see
// scripts/memory-compact-baseline.js's top-level comment for the full
// rationale). Shared here so the script and its tests clear the same way.
export async function clearSeedData(store) {
  store.db.exec(`DELETE FROM agent_jobs; DELETE FROM wiki_articles; DELETE FROM self_memories; DELETE FROM memories;`);
  await store.refreshCache();
}
