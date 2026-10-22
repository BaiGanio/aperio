// tests/integration/codegraph/indexing-responsiveness.test.js
//
// T2.1: indexing must not freeze the server.
//
// What this guards, and why a unit test cannot: before this change, indexing a
// repository that contained one bundle-shaped file (everything on line 1, dense
// call sites) held the main thread for seconds at a time. A measured run on an
// 810-file corpus with six such files showed /api/version p99 at 2.65 s and a
// worst case of 3.0 s, against a target of 200 ms. Nothing was broken — every
// symbol was indexed correctly — so only a latency measurement could see it.
//
// Two assertions, both over a real better-sqlite3 database and the real
// extractors:
//
//   1. The event loop is never held for long. Measured with a heartbeat timer,
//      which is what an inbound HTTP request competes with.
//   2. The indexing RESULT is unchanged. The whole change is worthless if it
//      quietly indexes less, so the counts are pinned exactly.
//
// On timing: the lag bound is deliberately loose (ONE slow slice is allowed to
// be large, because a shared CI runner can be descheduled for a while) while
// the *number* of slow slices is what carries the teeth. Before the change this
// file produced dozens of multi-second slices; a loose bound still fails hard.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { runSqliteMigrations } from "../../../db/migrate-sqlite.js";
import * as sqliteBackend from "../../../lib/codegraph/backends/sqlite.js";
import { walk } from "../../../lib/codegraph/indexer.js";

// A slice longer than this counts as "the server stopped answering".
const SLOW_SLICE_MS = 200;
// How many such slices a pass may contain. One tolerates a descheduled CI
// runner; the old code produced dozens.
const MAX_SLOW_SLICES = 1;
// Fraction of the heartbeats that were due which actually fired. 0.5 leaves a
// lot of room for a loaded runner and still fails hard: against the old code
// this pass delivered 4 of ~70, about 6%.
const MIN_LOOP_COVERAGE = 0.5;

async function createDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE"); // vec0 requires DELETE mode
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  await runSqliteMigrations(db);
  return db;
}

/** One bundle-shaped source file: N functions and 2N call sites, all on line 1. */
function bundleSource(tag, n) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(`function ${tag}_${i}(a,b){return h${i % 40}(a)+${tag}_${(i + 1) % n}(b);}`);
  }
  return parts.join("");
}

/**
 * Watches how long the event loop is held, the way an inbound request would
 * feel it. `interval` is the heartbeat; anything beyond it is a slice during
 * which nothing else could run.
 */
function startLoopWatch(interval = 10) {
  const slices = [];
  const t0 = performance.now();
  let last = t0;
  const timer = setInterval(() => {
    const now = performance.now();
    slices.push(now - last - interval);
    last = now;
  }, interval);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      const wallMs = performance.now() - t0;
      const sorted = [...slices].sort((a, b) => a - b);
      // Coverage is the sharper signal. A heartbeat that cannot fire records no
      // slice at all, so a blocked loop shows up as *missing* samples: against
      // the old code this pass produced 4 beats where ~70 were due.
      const expected = Math.floor(wallMs / interval);
      return {
        wallMs,
        samples: slices.length,
        expectedSamples: expected,
        coverage: expected ? slices.length / expected : 1,
        max: sorted.at(-1) ?? 0,
        slow: slices.filter((ms) => ms > SLOW_SLICE_MS).length,
      };
    },
  };
}

let root;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aperio-s21-"));
  await mkdir(path.join(root, "vendor"), { recursive: true });
  // Two bundle-shaped files — the pathological case T2.1 names — plus ordinary
  // sources, so the pass is a mix rather than one giant file.
  await writeFile(path.join(root, "vendor", "bundle-a.js"), bundleSource("a", 4000));
  await writeFile(path.join(root, "vendor", "bundle-b.js"), bundleSource("b", 4000));
  for (let i = 0; i < 40; i++) {
    await writeFile(
      path.join(root, `mod${i}.js`),
      `import { x } from './mod${(i + 1) % 40}.js';\n` +
      `export function f${i}(a) { return x(a) + f${i}(a); }\n` +
      `export class C${i} { m() { return f${i}(1); } }\n`,
    );
  }
});

describe("codegraph indexing stays responsive (T2.1)", () => {
  test("a repository with bundle-shaped files never holds the event loop", async (t) => {
    const store = { db: await createDb() };
    t.after(() => { store.db.close(); });

    const watch = startLoopWatch();
    const counts = await sqliteBackend.indexRepoFiles(store, root, walk(root), {
      deferEmbedding: true,
    });
    const loop = watch.stop();

    // The pass must have done real work, or the latency result is meaningless.
    assert.equal(counts.skipped, 0, "no file may be skipped");
    assert.equal(counts.files, 42);
    assert.ok(counts.symbols > 8000, `expected a large graph, got ${counts.symbols} symbols`);

    const report =
      `${Math.round(loop.wallMs)} ms pass, ${loop.samples}/${loop.expectedSamples} heartbeats ` +
      `(${Math.round(loop.coverage * 100)}% coverage), worst slice ${Math.round(loop.max)} ms, ` +
      `${loop.slow} slice(s) over ${SLOW_SLICE_MS} ms`;

    assert.ok(
      loop.coverage >= MIN_LOOP_COVERAGE,
      `indexing starved the event loop — ${report}. A timer that cannot fire records ` +
      `nothing, so missing heartbeats are the server failing to answer.`,
    );
    assert.ok(
      loop.slow <= MAX_SLOW_SLICES,
      `indexing is blocking the server again — ${report}`,
    );
  });

  test("the indexing result is exactly what it was before the change", async (t) => {
    // Pinned counts, not ">= something". The point of the measurement is that
    // responsiveness was bought without losing a single symbol or edge, so a
    // change that indexes differently must fail here and be looked at.
    const store = { db: await createDb() };
    t.after(() => { store.db.close(); });

    const counts = await sqliteBackend.indexRepoFiles(store, root, walk(root), {
      deferEmbedding: true,
    });

    const rows = (sql) => store.db.prepare(sql).get().n;
    assert.equal(counts.files, 42);
    assert.equal(counts.changed, 42);
    assert.equal(rows("SELECT COUNT(*) n FROM cg_files"), 42);

    // Each bundle: 4000 functions + 1 synthetic file node. Each ordinary
    // module: f, C, m + 1 file node.
    assert.equal(counts.symbols, 2 * 4001 + 40 * 4);
    assert.equal(rows("SELECT COUNT(*) n FROM cg_symbols"), counts.symbols);

    // Each bundle: 2 calls per function. Each module: 1 import + 3 calls.
    assert.equal(counts.edges, 2 * 8000 + 40 * 4);
    assert.equal(rows("SELECT COUNT(*) n FROM cg_edges"), counts.edges);

    // The resolver must still have resolved: a count of zero here would mean a
    // batched resolve silently stopped doing its job.
    const resolved = rows("SELECT COUNT(*) n FROM cg_edges WHERE dst_symbol_id IS NOT NULL");
    assert.ok(resolved > 0, "the edge resolver resolved nothing");
    assert.equal(
      rows("SELECT COUNT(*) n FROM cg_edges WHERE dst_symbol_id IS NOT NULL AND dst_unresolved IS NOT NULL"),
      0,
      "a resolved edge must not keep its unresolved name",
    );
  });

  test("re-indexing an unchanged repository is a cheap no-op", async (t) => {
    const store = { db: await createDb() };
    t.after(() => { store.db.close(); });

    await sqliteBackend.indexRepoFiles(store, root, walk(root), { deferEmbedding: true });
    const again = await sqliteBackend.indexRepoFiles(store, root, walk(root), { deferEmbedding: true });

    assert.equal(again.files, 42);
    assert.equal(again.changed, 0, "sha256 must still short-circuit unchanged files");
    assert.equal(again.skipped, 0);
  });
});

describe("teardown", () => {
  test("the fixture leaves nothing behind", async () => {
    await rm(root, { recursive: true, force: true });
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(root), false);
  });
});
