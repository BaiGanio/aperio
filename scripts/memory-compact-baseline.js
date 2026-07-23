#!/usr/bin/env node
// scripts/memory-compact-baseline.js
//
// WS0 baseline for the memory-compaction EPIC (#286): prints a deterministic
// token-cost + recall hit-rate@k report against a throwaway in-memory SQLite
// DB, seeded fresh on every invocation. Never touches a real/production DB —
// refuses to run unless SQLITE_PATH=":memory:" (Co-pilot Contract: no stray
// state). Appends one row per metric to var/memory-compaction/baseline.tsv,
// following the same append-only, lazily-headered TSV convention as
// var/toolrepair/events.tsv and var/autotune/results.tsv.
//
// Usage: npm run memory:baseline
//
// Env overrides (for tests only — point the script at small fixtures instead
// of the full exam set so hand-verification stays tractable):
//   MEMORY_COMPACT_EXAM_PATH   — path to a {"memories":[...]} JSON file
//   MEMORY_COMPACT_CORPUS_PATH — path to a {"queries":[...]} JSON file

import { readFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.env.SQLITE_PATH !== ":memory:") {
  console.error(
    "memory-compact-baseline: refusing to run — SQLITE_PATH must be exactly ':memory:' " +
    "(got " + JSON.stringify(process.env.SQLITE_PATH ?? null) + "). " +
    "This script seeds and measures against a throwaway DB only; use `npm run memory:baseline`, " +
    "which sets this for you."
  );
  process.exit(1);
}
// Force sqlite regardless of DB_BACKEND / a running Postgres container —
// this script's numbers are only meaningful against the scratch sqlite path
// it just validated above.
process.env.DB_BACKEND = "sqlite";

const { getStore } = await import("../db/index.js");
const { generateEmbedding } = await import("../lib/helpers/embeddings.js");
const { countTokens } = await import("../lib/memory/tokenCount.js");
const { formatRecallPayload, formatSelfPreload, SESSION_POINTER, median, avg, isHit, clearSeedData } =
  await import("../lib/memory/compactionBaseline.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAM_PATH = process.env.MEMORY_COMPACT_EXAM_PATH
  || join(__dirname, "../.github/capability-exam/exam.memories.json");
const CORPUS_PATH = process.env.MEMORY_COMPACT_CORPUS_PATH
  || join(__dirname, "../tests/fixtures/memory-compaction/recall-corpus.json");
const LEDGER_DIR = join(__dirname, "../var/memory-compaction");
const LEDGER_FILE = join(LEDGER_DIR, "baseline.tsv");
const LEDGER_HEADER = ["ts", "metric", "mode", "avg_tokens", "median_tokens", "hit_rate", "k", "sample_n", "notes"].join("\t");

const K = 3;

// No self-memory exam fixture exists yet (#286 §WS0 targets user memories via
// exam.memories.json only) — this small, fixed inline sample exists solely to
// measure the self-preload token cost (the actual tightest spot per the
// issue: getSelfMemCtx() injects real content, unlike the user-memory
// pointer). Not part of the recall-hit-rate corpus.
// Importance values are deliberately all-distinct (5..1): self_recall's
// no-query preload orders by "importance DESC, created_at DESC", and
// same-millisecond inserts can tie on created_at — a distinct importance per
// row guarantees a total order, so preload block order (and therefore its
// token count) doesn't depend on insert-timing luck.
const SELF_SAMPLE = [
  { title: "Never run destructive git ops without asking", content: "Force-push, reset --hard, and branch -D all require explicit confirmation first.", tags: ["safety", "git"], importance: 5 },
  { title: "Prefers terse responses", content: "The developer wants short, direct answers with no trailing summaries unless asked.", tags: ["preference", "communication"], importance: 4 },
  { title: "Prompt-cache hygiene matters", content: "Keep system-prompt-adjacent strings byte-stable across a session where possible to preserve cache hits.", tags: ["performance", "context"], importance: 3 },
  { title: "Ledger convention: tab-separated, ts first column", content: "New measurement ledgers under var/ follow the autotune/toolrepair convention: header written lazily on first !existsSync, ts (ISO) is always the first column.", tags: ["convention", "ledger"], importance: 2 },
  { title: "Token counting goes through gpt-tokenizer", content: "lib/memory/tokenCount.js wraps gpt-tokenizer's encode() — do not add a fourth char-based estimator.", tags: ["convention", "tokens"], importance: 1 },
];

// clearSeedData (imported above) exists because SqliteStore.init() seeds
// baseline demo content (MEMORY_SEED, WIKI_SEED, SELF_MEMORY_SEED,
// AGENT_JOB_SEED) into any empty table unconditionally — including a fresh
// ":memory:" DB — with no opt-out flag. That would pollute WS0's controlled
// fixture (mixed-in rows change hit-rate@k and make token counts
// non-hand-verifiable). We clear it here rather than touching store.js's
// seeding itself (out of scope, and a Fragile Zone) — raw DELETEs run through
// the same DB-level triggers (trg_memories_vec_cleanup etc., #286 §2) that
// keep vec_*/*_fts in sync.

async function seedMemories(store) {
  const { memories } = JSON.parse(readFileSync(EXAM_PATH, "utf8"));
  for (const m of memories) {
    const embedding = await generateEmbedding(`${m.title}. ${m.content}`);
    await store.insert({ type: m.type, title: m.title, content: m.content, tags: m.tags, importance: m.importance }, embedding);
  }
  return memories.length;
}

async function seedSelfMemories(store) {
  for (const m of SELF_SAMPLE) {
    const embedding = await generateEmbedding(`${m.title}. ${m.content}`);
    await store.insertSelf({ title: m.title, content: m.content, tags: m.tags, importance: m.importance, source: "self", confidence: 1.0, generated_by: "baseline-seed" }, embedding);
  }
  return SELF_SAMPLE.length;
}

async function measureSelfPreload(store) {
  const rows = await store.recallSelf({ limit: 6, mode: "auto" });
  return { tokens: countTokens(formatSelfPreload(rows)), sampleN: rows.length };
}

async function measureRecallPayload(store, queries) {
  const tokenCounts = [];
  for (const q of queries) {
    const queryEmbedding = await generateEmbedding(q.query, "query");
    const rows = await store.recall({ query: q.query, queryEmbedding, limit: 10, mode: "auto" });
    tokenCounts.push(countTokens(formatRecallPayload(rows)));
  }
  return tokenCounts;
}

async function measureHitRate(store, queries, mode) {
  let hits = 0;
  for (const q of queries) {
    const queryEmbedding = mode === "fulltext" ? null : await generateEmbedding(q.query, "query");
    const rows = await store.recall({ query: q.query, queryEmbedding, limit: K, mode });
    if (isHit(q.expectedTitles, rows)) hits++;
  }
  return queries.length ? hits / queries.length : 0;
}

function appendLedgerRow(fields) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  if (!existsSync(LEDGER_FILE)) appendFileSync(LEDGER_FILE, LEDGER_HEADER + "\n");
  const clean = fields.map(f => String(f).replace(/\t|\n/g, " "));
  appendFileSync(LEDGER_FILE, clean.join("\t") + "\n");
}

async function main() {
  const ts = new Date().toISOString();
  const store = await getStore();
  await clearSeedData(store);

  const memCount = await seedMemories(store);
  await seedSelfMemories(store);

  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")).queries;

  const selfPreload = await measureSelfPreload(store);
  const sessionPointerTokens = countTokens(SESSION_POINTER);
  const recallTokenCounts = await measureRecallPayload(store, corpus);
  const semanticHitRate = await measureHitRate(store, corpus, "semantic");
  const fulltextHitRate = await measureHitRate(store, corpus, "fulltext");

  console.log("=== Memory Compaction — WS0 Baseline ===");
  console.log(`Seeded ${memCount} memories, ${SELF_SAMPLE.length} self-memories, ${corpus.length} corpus queries.\n`);

  console.log("-- Token baseline --");
  console.log(`self_preload         avg=${selfPreload.tokens} median=${selfPreload.tokens} n=1 (self_recall limit=6, no query)`);
  console.log(`session_pointer      avg=${sessionPointerTokens} median=${sessionPointerTokens} n=1 (static pointer only — no memory content, NOT a compaction target)`);
  console.log(`recall_payload       avg=${avg(recallTokenCounts).toFixed(1)} median=${median(recallTokenCounts)} n=${recallTokenCounts.length} (formatted recall() payload, mode=auto)`);
  console.log(`wiki_ondemand        skipped — no wiki content seeded (no wiki-preload path exists today, see plan §2)\n`);

  console.log(`-- Hit-rate@${K} (separate per mode) --`);
  console.log(`semantic  ${(semanticHitRate * 100).toFixed(1)}%  (${corpus.length} queries)`);
  console.log(`fulltext  ${(fulltextHitRate * 100).toFixed(1)}%  (${corpus.length} queries)`);

  appendLedgerRow([ts, "token_self_preload", "n/a", selfPreload.tokens, selfPreload.tokens, "—", "—", 1, "self_recall limit=6, no query"]);
  appendLedgerRow([ts, "token_session_pointer", "n/a", sessionPointerTokens, sessionPointerTokens, "—", "—", 1, "static pointer only — not a compaction target"]);
  appendLedgerRow([ts, "token_recall_payload", "auto", avg(recallTokenCounts).toFixed(2), median(recallTokenCounts), "—", "—", recallTokenCounts.length, "formatted recall() payload over corpus queries"]);
  appendLedgerRow([ts, "token_wiki_ondemand", "n/a", "—", "—", "—", "—", 0, "no wiki content seeded — skipped, not measured as zero"]);
  appendLedgerRow([ts, "hitrate", "semantic", "—", "—", semanticHitRate.toFixed(4), K, corpus.length, "recall() search_mode=semantic"]);
  appendLedgerRow([ts, "hitrate", "fulltext", "—", "—", fulltextHitRate.toFixed(4), K, corpus.length, "recall() search_mode=fulltext"]);

  await store.close();
}

await main();
