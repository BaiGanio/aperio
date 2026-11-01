// tests/integration/docgraph/indexing-responsiveness.test.js
//
// T2.1, docgraph half. Sibling of
// tests/integration/codegraph/indexing-responsiveness.test.js — read that one
// first for why this is measured rather than reasoned about.
//
// Docgraph was the worse of the two. A measured pass over 189 documents (one of
// them a 13 MB Markdown file) put /api/version p95 at 294 ms against a 200 ms
// target, with a worst case of 1.25 s: the gate failed outright, not just at
// the tail. The cost was not only the extraction — chunkText() and
// extractRefs() run per section inside the write loop, and better-sqlite3
// inserts are synchronous, so one large document was a single unbroken slice.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { runSqliteMigrations } from "../../../db/migrate-sqlite.js";
import * as sqliteBackend from "../../../lib/docgraph/backends/sqlite.js";
import { walk } from "../../../lib/docgraph/indexer.js";

const SLOW_SLICE_MS = 200;
const MAX_SLOW_SLICES = 1;
const MIN_LOOP_COVERAGE = 0.5;

async function createDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  await runSqliteMigrations(db);
  return db;
}

/** A document with `sections` headings and plenty of body text under each. */
function bigMarkdown(sections, paragraphsPerSection) {
  const out = [];
  for (let s = 0; s < sections; s++) {
    out.push(`## Section ${s}`);
    for (let p = 0; p < paragraphsPerSection; p++) {
      out.push(`Body text for paragraph ${p} of section ${s}, with enough words to chunk. `.repeat(6));
    }
  }
  return out.join("\n\n");
}

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
  root = await mkdtemp(path.join(tmpdir(), "aperio-s21-docs-"));
  // One large document — the shape that broke the gate — plus ordinary ones.
  await writeFile(path.join(root, "huge.md"), bigMarkdown(700, 14));
  for (let i = 0; i < 30; i++) {
    await writeFile(
      path.join(root, `note${i}.md`),
      `# Note ${i}\n\nSome body text, see https://example.com/${i} and [a link](./note${i}.md).\n\n## Detail\n\nMore text.\n`,
    );
  }
});

describe("docgraph indexing stays responsive (T2.1)", () => {
  test("a corpus with one large document never holds the event loop", async (t) => {
    const store = { db: await createDb() };
    t.after(() => { store.db.close(); });

    const watch = startLoopWatch();
    const counts = await sqliteBackend.indexRepoFiles(store, root, walk(root), {
      deferEmbedding: true,
    });
    const loop = watch.stop();

    assert.equal(counts.skipped, 0, "no document may be skipped");
    assert.equal(counts.docs, 31);
    assert.ok(counts.chunks > 1000, `expected a large corpus, got ${counts.chunks} chunks`);

    const report =
      `${Math.round(loop.wallMs)} ms pass, ${loop.samples}/${loop.expectedSamples} heartbeats ` +
      `(${Math.round(loop.coverage * 100)}% coverage), worst slice ${Math.round(loop.max)} ms, ` +
      `${loop.slow} slice(s) over ${SLOW_SLICE_MS} ms`;

    assert.ok(
      loop.coverage >= MIN_LOOP_COVERAGE,
      `indexing starved the event loop — ${report}`,
    );
    assert.ok(
      loop.slow <= MAX_SLOW_SLICES,
      `indexing is blocking the server again — ${report}`,
    );
  });

  test("the indexing result is exactly what it was before the change", async (t) => {
    const store = { db: await createDb() };
    t.after(() => { store.db.close(); });

    const counts = await sqliteBackend.indexRepoFiles(store, root, walk(root), {
      deferEmbedding: true,
    });
    const rows = (sql) => store.db.prepare(sql).get().n;

    // huge.md: 700 headings. Each note: a heading plus one nested heading.
    assert.equal(counts.docs, 31);
    assert.equal(counts.sections, 700 + 30 * 2);
    assert.equal(rows("SELECT COUNT(*) n FROM docgraph_sections"), counts.sections);
    assert.equal(rows("SELECT COUNT(*) n FROM docgraph_chunks"), counts.chunks);
    assert.equal(counts.chunks, counts.pending.length,
      "every chunk written must be queued for embedding");

    // Refs are extracted inside the same sliced loop, so a yield must not lose
    // them: each note carries a URL and a relative link.
    assert.ok(rows("SELECT COUNT(*) n FROM docgraph_refs") >= 30,
      "the per-section ref extraction stopped producing rows");
  });

  test("re-indexing an unchanged corpus is a cheap no-op", async (t) => {
    const store = { db: await createDb() };
    t.after(() => { store.db.close(); });

    await sqliteBackend.indexRepoFiles(store, root, walk(root), { deferEmbedding: true });
    const again = await sqliteBackend.indexRepoFiles(store, root, walk(root), { deferEmbedding: true });

    assert.equal(again.docs, 31);
    assert.equal(again.changed, 0, "sha256 must still short-circuit unchanged documents");
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
