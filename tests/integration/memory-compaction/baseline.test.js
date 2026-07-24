// tests/integration/memory-compaction/baseline.test.js
// WS0 groups G0-3, G0-4, G0-5 (memory-compaction EPIC #286).
//
// Exercises scripts/memory-compact-baseline.js as a real subprocess (its own
// getStore() singleton must not be shared across "separate runs" — see G0-3)
// against a tiny, hand-authored fixture, and cross-checks its printed numbers
// against an independent in-process recall() + shared-formatter computation
// (lib/memory/compactionBaseline.js) rather than trusting the script's own
// bookkeeping. No live model/provider — real SQLite + real local embeddings.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/memory-compact-baseline.js");
const LEDGER_DIR = join(REPO_ROOT, "var/memory-compaction");
const LEDGER_FILE = join(LEDGER_DIR, "baseline.tsv");

// Small, unambiguous fixture: each memory owns distinct vocabulary so both
// semantic and lexical matching have a clear single winner.
const TINY_MEMORIES = [
  { type: "fact", title: "Team standup is at 9am", content: "The daily standup meeting happens every weekday at 9am sharp over video call.", tags: ["standup"], importance: 3 },
  { type: "decision", title: "Chose PostgreSQL over MongoDB", content: "The team picked PostgreSQL as the primary database for strong consistency guarantees, rejecting MongoDB.", tags: ["database"], importance: 4 },
  { type: "preference", title: "Favorite editor is Neovim", content: "The engineer configures Neovim with LSP support and treesitter highlighting for every project.", tags: ["editor"], importance: 2 },
  { type: "solution", title: "Fixed memory leak in worker pool", content: "A leaked event listener in the worker pool caused steadily rising memory usage; removing the listener on worker exit fixed it.", tags: ["performance"], importance: 4 },
];
// memories_fts has no tokenize= clause (db/migrations-sqlite/001_core.sql), so
// it uses FTS5's default unicode61 tokenizer: no stemming, and ftsMatchQuery
// (db/sqlite/mappers.js) ANDs every token. Keyword queries below therefore use
// only word forms that appear verbatim in the target memory's title+content —
// "leaked"/"configures" would NOT match a query containing "leak"/"configure".
const TINY_QUERIES = [
  { id: "t-sem-1", category: "semantic", query: "What time does the daily standup happen?", expectedTitles: ["Team standup is at 9am"] },
  { id: "t-sem-2", category: "semantic", query: "Why did the team pick Postgres instead of Mongo?", expectedTitles: ["Chose PostgreSQL over MongoDB"] },
  { id: "t-kw-1", category: "keyword", query: "Neovim LSP treesitter highlighting", expectedTitles: ["Favorite editor is Neovim"] },
  { id: "t-kw-2", category: "keyword", query: "worker pool event listener memory usage", expectedTitles: ["Fixed memory leak in worker pool"] },
];

let tmpDir, examPath, corpusPath;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-compact-baseline-test-"));
  examPath = join(tmpDir, "exam.json");
  corpusPath = join(tmpDir, "corpus.json");
  writeFileSync(examPath, JSON.stringify({ memories: TINY_MEMORIES }));
  writeFileSync(corpusPath, JSON.stringify({ queries: TINY_QUERIES }));
  rmSync(LEDGER_DIR, { recursive: true, force: true });
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(LEDGER_DIR, { recursive: true, force: true });
});

function runScript(extraEnv = {}) {
  const out = execFileSync(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      SQLITE_PATH: ":memory:",
      MEMORY_COMPACT_EXAM_PATH: examPath,
      MEMORY_COMPACT_CORPUS_PATH: corpusPath,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const idx = out.indexOf("=== Memory Compaction — WS0 Baseline ===");
  assert.ok(idx >= 0, `script output missing the expected banner:\n${out}`);
  return out.slice(idx);
}

function parseReport(report) {
  const num = (re) => {
    const m = report.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    recallAvg: num(/recall_payload\s+avg=([\d.]+)/),
    recallMedian: num(/recall_payload\s+avg=[\d.]+ median=([\d.]+)/),
    semanticHitRate: num(/semantic\s+([\d.]+)%/),
    fulltextHitRate: num(/fulltext\s+([\d.]+)%/),
  };
}

describe("memory-compact-baseline script (G0-3)", () => {
  test("is byte-identical across three consecutive runs against a fresh scratch DB", () => {
    const runs = [runScript(), runScript(), runScript()];
    assert.equal(runs[0], runs[1]);
    assert.equal(runs[1], runs[2]);
  });

  test("refuses to run unless SQLITE_PATH is exactly ':memory:'", () => {
    assert.throws(() => execFileSync(process.execPath, [SCRIPT_PATH], {
      env: { ...process.env, SQLITE_PATH: "" },
      encoding: "utf8",
    }));
    assert.throws(() => execFileSync(process.execPath, [SCRIPT_PATH], {
      env: { ...process.env, SQLITE_PATH: "./.sqlite/aperio.db" },
      encoding: "utf8",
    }));
  });

  test("ledger gains exactly one header line ever, and exactly 6 rows per run", () => {
    const readLines = () => existsSync(LEDGER_FILE) ? readFileSync(LEDGER_FILE, "utf8").trim().split("\n") : [];
    const linesBefore = readLines().length;

    runScript();
    runScript();

    const lines = readLines();
    const headerLines = lines.filter(l => l.startsWith("ts\tmetric\tmode"));
    assert.equal(headerLines.length, 1, "header must be written exactly once across the file's whole run history, not once per invocation");
    // 6 metrics per run × 2 runs, on top of whatever earlier tests in this
    // file already appended (this file's tests share one ledger, by design —
    // the ledger is meant to accumulate across real invocations).
    assert.equal(lines.length - linesBefore, 12);
  });
});

describe("memory-compact-baseline script (G0-4)", () => {
  test("printed recall-payload and hit-rate numbers match an independent in-process recomputation", async () => {
    const report = runScript();
    const parsed = parseReport(report);
    assert.ok(parsed.recallAvg !== null, `could not parse recall_payload avg from:\n${report}`);

    process.env.SQLITE_PATH = ":memory:";
    process.env.DB_BACKEND = "sqlite";
    const { getStore } = await import("../../../db/index.js");
    const { generateEmbedding } = await import("../../../lib/helpers/embeddings.js");
    const { countTokens } = await import("../../../lib/memory/tokenCount.js");
    const { formatRecallPayload, avg, median, isHit, clearSeedData } = await import("../../../lib/memory/compactionBaseline.js");

    const store = await getStore();
    await clearSeedData(store);
    for (const m of TINY_MEMORIES) {
      const embedding = await generateEmbedding(`${m.title}. ${m.content}`);
      await store.insert({ type: m.type, title: m.title, content: m.content, tags: m.tags, importance: m.importance }, embedding);
    }

    const tokenCounts = [];
    let semanticHits = 0, fulltextHits = 0, keywordFulltextHits = 0;
    for (const q of TINY_QUERIES) {
      const queryEmbedding = await generateEmbedding(q.query, "query");
      const autoRows = await store.recall({ query: q.query, queryEmbedding, limit: 10, mode: "auto" });
      tokenCounts.push(countTokens(formatRecallPayload(autoRows)));

      const semRows = await store.recall({ query: q.query, queryEmbedding, limit: 3, mode: "semantic" });
      if (isHit(q.expectedTitles, semRows)) semanticHits++;
      const ftRows = await store.recall({ query: q.query, queryEmbedding: null, limit: 3, mode: "fulltext" });
      if (isHit(q.expectedTitles, ftRows)) {
        fulltextHits++;
        if (q.category === "keyword") keywordFulltextHits++;
      }
    }
    await store.close();

    assert.equal(parsed.recallAvg, Number(avg(tokenCounts).toFixed(1)));
    assert.equal(parsed.recallMedian, median(tokenCounts));
    assert.equal(parsed.semanticHitRate, Number(((semanticHits / TINY_QUERIES.length) * 100).toFixed(1)));
    assert.equal(parsed.fulltextHitRate, Number(((fulltextHits / TINY_QUERIES.length) * 100).toFixed(1)));

    // Fixture is designed so EVERY query has an unambiguous semantic winner —
    // a lower number signals a scoring bug, not a real regression. Fulltext is
    // NOT expected to hit 100% blended across categories: the two `semantic`
    // entries are natural sentences that legitimately miss FTS5's exact,
    // unstemmed AND-match (this is real signal, same as the full corpus's
    // 37.5% fulltext rate — not a bug to force away). Only the two `keyword`
    // entries (literal phrases built from real content) are expected to hit.
    assert.equal(parsed.semanticHitRate, 100);
    const keywordQueries = TINY_QUERIES.filter(q => q.category === "keyword");
    assert.equal(keywordFulltextHits, keywordQueries.length, "literal keyword queries should all hit under exact FTS matching");
  });
});

describe("memory-compact-baseline script (G0-5)", () => {
  test("npm run memory:baseline exits 0 and writes nothing outside var/memory-compaction/", () => {
    // Earlier describe blocks in this file already ran the script and left
    // var/memory-compaction/ behind (only the file-level after() cleans it
    // up) — clear it here so "before" is a true pre-run snapshot.
    rmSync(LEDGER_DIR, { recursive: true, force: true });
    const before = existsSync(join(REPO_ROOT, "var")) ? readdirSync(join(REPO_ROOT, "var")) : [];
    execFileSync("npm", ["run", "memory:baseline"], {
      cwd: REPO_ROOT,
      env: { ...process.env, MEMORY_COMPACT_EXAM_PATH: examPath, MEMORY_COMPACT_CORPUS_PATH: corpusPath },
      encoding: "utf8",
    });
    const afterList = readdirSync(join(REPO_ROOT, "var"));
    const newEntries = afterList.filter(e => !before.includes(e));
    assert.deepEqual(newEntries, ["memory-compaction"]);
    assert.ok(existsSync(LEDGER_FILE));
  });
});
