import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  RETRIEVAL_LIMITS,
  buildCandidateManifest,
  retrieveInBatches,
} from "../../../lib/docgraph/retrieval.js";

describe("document retrieval contract", () => {
  test("builds a deterministic bounded manifest across repositories", () => {
    const rows = [
      { id: 3, repo_id: 2, root_path: "/fictional/b", rel_path: "utilities/water.txt", mime: "text/plain", size: 20, mtime: "2026-06-03", sha256: "water" },
      { id: 1, repo_id: 1, root_path: "/fictional/a", rel_path: "tax.txt", mime: "text/plain", size: 10, mtime: "2026-06-01", sha256: "tax" },
      { id: 2, repo_id: 1, root_path: "/fictional/a", rel_path: "utilities/water-copy.txt", mime: "text/plain", size: 21, mtime: "2026-06-03", sha256: "water" },
      { id: 4, repo_id: 1, root_path: "/fictional/a", rel_path: "utilities/electricity.png", mime: "image/png", size: 30, mtime: "2026-06-03", sha256: "electricity" },
    ];
    const first = buildCandidateManifest(rows, { query: "water last month", limit: 3 });
    const second = buildCandidateManifest([...rows].reverse(), { query: "water last month", limit: 3 });

    assert.deepEqual(first, second);
    assert.equal(first.found, 4);
    assert.equal(first.candidates.length, 3);
    assert.equal(first.truncated, true);
    assert.equal(first.candidates[0].rel_path, "utilities/water-copy.txt");
    assert.equal(first.candidates.filter(c => c.sha256 === "water").length, 1);
    assert.ok(first.candidates.every(c => "date_hint" in c && "selection_reason" in c));
  });

  test("applies a requested period before the candidate bound, not after", () => {
    // 50 unrelated-month utility rows plus 2 from the requested month. A flat
    // utility score treats all 52 alike, so without period-aware filtering
    // the requested month's 2 rows can lose the maxCandidates=48 bound to
    // alphabetically-earlier unrelated months.
    const unrelated = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, repo_id: 1, root_path: "/fictional/a",
      rel_path: `utilities/aaa-electricity-${String(i).padStart(2, "0")}.txt`,
      mime: "text/plain", size: 10, mtime: "2025-01-15", sha256: `unrelated-${i}`,
    }));
    const wanted = [
      { id: 101, repo_id: 1, root_path: "/fictional/a", rel_path: "utilities/zzz-water.txt", mime: "text/plain", size: 10, mtime: "2026-06-03", sha256: "wanted-1" },
      { id: 102, repo_id: 1, root_path: "/fictional/a", rel_path: "utilities/zzz-electric.txt", mime: "text/plain", size: 10, mtime: "2026-06-05", sha256: "wanted-2" },
    ];
    const now = new Date("2026-07-23T00:00:00Z");
    const result = buildCandidateManifest([...unrelated, ...wanted], { query: "utilities last month", now });

    assert.equal(result.candidates.length, 2, "the requested month's 2 documents must survive the bound");
    assert.deepEqual(
      result.candidates.map(c => c.sha256).sort(),
      ["wanted-1", "wanted-2"],
    );
  });

  test("an explicit YYYY-MM in the query selects that period", () => {
    const rows = [
      { id: 1, repo_id: 1, root_path: "/a", rel_path: "utilities/jan.txt", mime: "text/plain", size: 10, mtime: "2026-01-10", sha256: "jan" },
      { id: 2, repo_id: 1, root_path: "/a", rel_path: "utilities/june.txt", mime: "text/plain", size: 10, mtime: "2026-06-10", sha256: "june" },
    ];
    const result = buildCandidateManifest(rows, { query: "utilities 2026-06" });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sha256, "june");
  });

  test("falls back to the unfiltered pool when nothing matches the requested period", () => {
    const rows = [
      { id: 1, repo_id: 1, root_path: "/a", rel_path: "utilities/jan.txt", mime: "text/plain", size: 10, mtime: "2026-01-10", sha256: "jan" },
    ];
    const now = new Date("2026-07-23T00:00:00Z");
    const result = buildCandidateManifest(rows, { query: "utilities last month", now });
    assert.equal(result.candidates.length, 1, "no candidate matches June 2026, so the January row must still surface rather than an empty manifest");
  });

  test("matches a requested period when mtime is a JS Date object (the Postgres row shape)", () => {
    // node-postgres auto-parses TIMESTAMPTZ columns into Date objects; SQLite's
    // TEXT mtime column never does. Interpolating a Date directly produces its
    // default toString() ("Tue Jun 03 2026...") — not matchable by the numeric
    // date regex — silently losing every Postgres row's period signal.
    const rows = [
      { id: 1, repo_id: 1, root_path: "/a", rel_path: "utilities/jan.txt", mime: "text/plain", size: 10, mtime: new Date("2026-01-10T00:00:00Z"), sha256: "jan" },
      { id: 2, repo_id: 1, root_path: "/a", rel_path: "utilities/june.txt", mime: "text/plain", size: 10, mtime: new Date("2026-06-10T00:00:00Z"), sha256: "june" },
    ];
    const result = buildCandidateManifest(rows, { query: "utilities 2026-06" });
    assert.equal(result.candidates.length, 1, "a Date-typed mtime must still be usable for period matching");
    assert.equal(result.candidates[0].sha256, "june");
  });

  test("returns an empty manifest without assuming a repository", () => {
    assert.deepEqual(buildCandidateManifest([], { query: "utilities" }), {
      candidates: [], found: 0, selected: 0, truncated: false, continuation: null,
    });
  });

  test("reads bounded batches and accounts for every outcome", async () => {
    const calls = [];
    const result = await retrieveInBatches([
      { id: 1, size: 3, rel_path: "a.txt" },
      // Large declared (source) size, tiny actual extracted text — the PDF
      // case: must now be READ, not pre-emptively skipped on source size.
      { id: 2, size: 500, rel_path: "big-source-tiny-text.pdf" },
      // Small declared size, but the actual extracted text is the one that's
      // too large — this is what maxFileBytes should catch instead.
      { id: 3, size: 3, rel_path: "small-source-huge-text.txt" },
    ], {
      batchSize: 3,
      maxFileBytes: 50,
      maxTotalBytes: 1000,
      readBatch: async (batch) => {
        calls.push(batch.map(c => c.id));
        return batch.map(c => c.id === 3
          ? { id: c.id, text: "x".repeat(200) }
          : { id: c.id, text: `doc-${c.id}` });
      },
    });

    assert.deepEqual(calls, [[1, 2, 3]], "all three are admitted by declared-size budget checks in one batch");
    assert.deepEqual(result.coverage, {
      found: 3, read: 2, skipped: 1, bytes: 10, complete: false,
      skipped_reasons: { "small-source-huge-text.txt": "extracted text exceeds maxFileBytes" },
    });
    assert.equal(result.documents.length, 3);
    assert.equal(result.documents.filter(d => d.status === "read").length, 2);
    assert.equal(
      result.documents.find(d => d.id === 2).status, "read",
      "a large declared source size with small actual text must be read, not skipped on source size alone",
    );
  });

  test("splits a batch into byte-bounded sub-batches instead of discarding the whole group", async () => {
    // Two 60KB documents with a 100KB batch cap and 160KB total cap: neither
    // fits alongside the other in one batch call, but each fits alone. The
    // old all-or-nothing check would skip both; splitting must read both.
    const calls = [];
    const result = await retrieveInBatches([
      { id: 1, size: 60_000, rel_path: "a.pdf" },
      { id: 2, size: 60_000, rel_path: "b.pdf" },
    ], {
      batchSize: 6,
      maxFileBytes: 120_000,
      maxBatchBytes: 100_000,
      maxTotalBytes: 160_000,
      readBatch: async batch => {
        calls.push(batch.map(c => c.id));
        return batch.map(c => ({ id: c.id, text: `doc-${c.id}` }));
      },
    });

    assert.deepEqual(calls, [[1], [2]], "each document must be read in its own sub-batch");
    assert.equal(result.coverage.read, 2);
    assert.equal(result.coverage.skipped, 0);
  });

  test("a single candidate whose declared size alone exceeds maxBatchBytes still gets its own sub-batch read", async () => {
    const result = await retrieveInBatches([
      { id: 1, size: 150_000, rel_path: "huge-declared-tiny-actual.pdf" },
    ], {
      maxFileBytes: 120_000,
      maxBatchBytes: 100_000,
      maxTotalBytes: 160_000,
      readBatch: async batch => batch.map(c => ({ id: c.id, text: "tiny extracted text" })),
    });

    assert.equal(result.coverage.read, 1, "an oversized-by-declared-size single candidate must still be attempted");
    assert.equal(result.coverage.skipped, 0);
  });

  test("enforces maxTotalBytes cumulatively within a single batch", async () => {
    // Two 50-byte candidates each individually fit under a 60-byte budget,
    // but together they don't — the pre-batch admission check must accumulate
    // a running total, not compare each candidate against the same stale
    // starting point.
    const result = await retrieveInBatches([
      { id: 1, size: 50, rel_path: "a.txt" },
      { id: 2, size: 50, rel_path: "b.txt" },
    ], {
      batchSize: 2,
      maxTotalBytes: 60,
      readBatch: async batch => batch.map(c => ({ id: c.id, text: "x".repeat(50) })),
    });

    assert.equal(result.coverage.read, 1);
    assert.equal(result.coverage.bytes, 50);
    assert.ok(result.coverage.bytes <= 60, "cumulative bytes must never exceed maxTotalBytes");
    assert.equal(result.documents.find(d => d.id === 2).status, "skipped");
    assert.equal(result.documents.find(d => d.id === 2).reason, "retrieval exceeds maxTotalBytes");
  });

  test("re-checks actual returned bytes against maxTotalBytes, not just declared size", async () => {
    // The declared candidate.size understates what the reader actually
    // returns — the pre-batch check alone would wrongly admit it.
    const result = await retrieveInBatches([
      { id: 1, size: 10, rel_path: "understated.txt" },
    ], {
      maxTotalBytes: 20,
      readBatch: async batch => batch.map(c => ({ id: c.id, text: "x".repeat(100) })), // 100 actual bytes
    });

    assert.equal(result.coverage.read, 0);
    assert.equal(result.coverage.bytes, 0, "an oversized actual read must not be counted into the total");
    assert.equal(result.documents[0].status, "skipped");
    assert.equal(result.documents[0].reason, "retrieval exceeds maxTotalBytes");
  });

  test("propagates cancellation between bounded batches", async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(
      retrieveInBatches([{ id: 1 }, { id: 2 }], {
        batchSize: 1,
        signal: controller.signal,
        readBatch: async (batch) => {
          calls++;
          controller.abort();
          return batch.map(c => ({ id: c.id, text: "ok" }));
        },
      }),
      (err) => err?.name === "AbortError",
    );
    assert.equal(calls, 1);
  });

  test("keeps limits explicit and bounded", () => {
    assert.ok(RETRIEVAL_LIMITS.maxCandidates > 0);
    assert.ok(RETRIEVAL_LIMITS.batchSize > 0);
    assert.ok(RETRIEVAL_LIMITS.maxBatchBytes > 0);
    assert.ok(RETRIEVAL_LIMITS.maxTotalBytes >= RETRIEVAL_LIMITS.maxBatchBytes);
  });
});
