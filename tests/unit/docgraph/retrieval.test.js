import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  RETRIEVAL_LIMITS,
  buildCandidateManifest,
  retrieveInBatches,
  composeMemoryFromDoc,
  buildDocumentHighlights,
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
    assert.ok(first.candidates.every(c => "file_mtime" in c && "filename_date_hint" in c && "selection_reason" in c));
    assert.ok(!("date_hint" in first.candidates[0]) && !("mtime" in first.candidates[0]),
      "the old blended date_hint/mtime fields must not resurface (#311)");
  });

  test("links merged content-duplicates on the surviving candidate instead of dropping them silently", () => {
    const rows = [
      { id: 2, repo_id: 1, root_path: "/fictional/a", rel_path: "utilities/water-copy.txt", mime: "text/plain", size: 21, mtime: "2026-06-03", sha256: "water" },
      { id: 3, repo_id: 2, root_path: "/fictional/b", rel_path: "utilities/water.txt", mime: "text/plain", size: 20, mtime: "2026-06-03", sha256: "water" },
    ];
    const result = buildCandidateManifest(rows, { query: "water" });
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.candidates[0].duplicates, [
      { id: 3, rel_path: "utilities/water.txt", root_path: "/fictional/b" },
    ]);
  });

  test("applies a requested period before the candidate bound, not after", () => {
    // 50 unrelated-month utility rows plus 2 from the requested month. A flat
    // utility score treats all 52 alike, so without period-aware filtering
    // the requested month's 2 rows can lose the maxCandidates=48 bound to
    // alphabetically-earlier unrelated months. The period signal here must
    // come from the filename, never from mtime (#311).
    const unrelated = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, repo_id: 1, root_path: "/fictional/a",
      rel_path: `utilities/aaa-electricity-${String(i).padStart(2, "0")}.txt`,
      mime: "text/plain", size: 10, mtime: "2025-01-15", sha256: `unrelated-${i}`,
    }));
    const wanted = [
      { id: 101, repo_id: 1, root_path: "/fictional/a", rel_path: "utilities/zzz-water-2026-06.txt", mime: "text/plain", size: 10, mtime: "2026-06-03", sha256: "wanted-1" },
      { id: 102, repo_id: 1, root_path: "/fictional/a", rel_path: "utilities/zzz-electric-2026-06.txt", mime: "text/plain", size: 10, mtime: "2026-06-05", sha256: "wanted-2" },
    ];
    const now = new Date("2026-07-23T00:00:00Z");
    const result = buildCandidateManifest([...unrelated, ...wanted], { query: "utilities last month", now });

    assert.equal(result.candidates.length, 2, "the requested month's 2 documents must survive the bound");
    assert.deepEqual(
      result.candidates.map(c => c.sha256).sort(),
      ["wanted-1", "wanted-2"],
    );
  });

  test("an explicit YYYY-MM in the query selects that period from the filename hint", () => {
    const rows = [
      { id: 1, repo_id: 1, root_path: "/a", rel_path: "utilities/jan-2026-01.txt", mime: "text/plain", size: 10, mtime: "2026-01-10", sha256: "jan" },
      { id: 2, repo_id: 1, root_path: "/a", rel_path: "utilities/june-2026-06.txt", mime: "text/plain", size: 10, mtime: "2026-06-10", sha256: "june" },
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

  test("never uses filesystem mtime for period matching, so indexing-time noise cannot exclude an eligible document (#311)", () => {
    // The exact reported failure: a document actually relevant to "June" (no
    // date in its filename — only discoverable by reading its body later)
    // must not be excluded just because some other unrelated document's
    // mtime happens to fall in June. Previously dateHint() blended mtime
    // into the period-matching source, so a June mtime alone was enough to
    // hard-filter the candidate pool down to the wrong document.
    const rows = [
      { id: 1, repo_id: 1, root_path: "/a", rel_path: "bills/electricity.txt", mime: "text/plain", size: 10, mtime: "2026-06-15", sha256: "unrelated-june-mtime" },
      { id: 2, repo_id: 1, root_path: "/a", rel_path: "bills/internet.txt", mime: "text/plain", size: 10, mtime: "2026-07-01", sha256: "actually-relevant" },
    ];
    const now = new Date("2026-07-23T00:00:00Z");
    const result = buildCandidateManifest(rows, { query: "bills 2026-06", now });
    // Neither filename carries a parseable date, so filename_date_hint is
    // null for both — the period filter must find no matches and fall back
    // to the full pool rather than trusting mtime to pick a "winner".
    assert.equal(result.candidates.length, 2, "both documents must remain — mtime must not decide period membership");
    assert.ok(result.candidates.every(c => c.filename_date_hint === null));
  });

  test("normalizes a Date-typed mtime (the Postgres row shape) into file_mtime, but never uses it for period matching", () => {
    // node-postgres auto-parses TIMESTAMPTZ columns into Date objects; SQLite's
    // TEXT mtime column never does. file_mtime must normalize either shape to
    // ISO for display, independent of period-matching (which is filename-only).
    const rows = [
      { id: 1, repo_id: 1, root_path: "/a", rel_path: "utilities/jan.txt", mime: "text/plain", size: 10, mtime: new Date("2026-01-10T00:00:00Z"), sha256: "jan" },
      { id: 2, repo_id: 1, root_path: "/a", rel_path: "utilities/june.txt", mime: "text/plain", size: 10, mtime: new Date("2026-06-10T00:00:00Z"), sha256: "june" },
    ];
    const result = buildCandidateManifest(rows, { query: "utilities" });
    const june = result.candidates.find(c => c.sha256 === "june");
    assert.equal(june.file_mtime, "2026-06-10T00:00:00.000Z");
    assert.equal(june.filename_date_hint, null, "the filename carries no date token — mtime must not leak into it");
  });

  test("recognizes a month-name path as a filename date hint when a year is also present (household corpus convention)", () => {
    // Real corpus layout: a year folder, a month-NAME folder, and a day-month
    // abbreviation in the filename — no adjacent digit pair anywhere, so the
    // numeric-only pattern never matches and the period filter silently
    // never engaged on this corpus before this fix.
    const rows = [
      { id: 1, repo_id: 1, root_path: "/h", rel_path: "2026/June/electricity-bill-03-jun.txt", mime: "text/plain", size: 10, sha256: "june-elec" },
      { id: 2, repo_id: 1, root_path: "/h", rel_path: "2026/May/electricity-bill-04-may.txt", mime: "text/plain", size: 10, sha256: "may-elec" },
    ];
    // Query deliberately names no period, so the hint is checked without
    // triggering the period filter (which is exercised separately below).
    const result = buildCandidateManifest(rows, { query: "electricity bill" });
    const june = result.candidates.find(c => c.sha256 === "june-elec");
    const may = result.candidates.find(c => c.sha256 === "may-elec");
    assert.equal(june.filename_date_hint, "2026-06");
    assert.equal(may.filename_date_hint, "2026-05");
  });

  test("a bare month name with no year still resolves to a null filename date hint", () => {
    // "utilities/june.txt" alone is not a date — requiring a year alongside
    // the month name keeps this test's original guarantee intact.
    const rows = [
      { id: 1, repo_id: 1, root_path: "/a", rel_path: "utilities/june.txt", mime: "text/plain", size: 10, sha256: "bare-june" },
    ];
    const result = buildCandidateManifest(rows, { query: "utilities" });
    assert.equal(result.candidates[0].filename_date_hint, null);
  });

  test("a month-name period filter excludes unrelated months from a corpus that exceeds maxCandidates", () => {
    // The real regression: once the household corpus's ~9 months of
    // month-name-dated documents exceed the 48-candidate cap, June-specific
    // documents (bank statement, transport top-up, waste fee) must not lose
    // to unrelated months on a flat aggregation-cue score alone.
    const otherMonths = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, repo_id: 1, root_path: "/h",
      rel_path: `2026/January/aaa-bill-${String(i).padStart(2, "0")}-jan.txt`,
      mime: "text/plain", size: 10, sha256: `unrelated-${i}`,
    }));
    const june = [
      { id: 201, repo_id: 1, root_path: "/h", rel_path: "2026/June/zzz-bank-statement-jun.txt", mime: "text/plain", size: 10, sha256: "june-statement" },
      { id: 202, repo_id: 1, root_path: "/h", rel_path: "2026/June/zzz-transport-topup-28-jun.txt", mime: "text/plain", size: 10, sha256: "june-transport" },
    ];
    const result = buildCandidateManifest([...otherMonths, ...june], { query: "How much did I spend in total in June 2026, broken down by category?" });
    assert.deepEqual(
      result.candidates.map(c => c.sha256).sort(),
      ["june-statement", "june-transport"],
      "the requested month's documents must survive the bound even when the period is spelled with a month name",
    );
  });

  test("returns an empty manifest without assuming a repository", () => {
    assert.deepEqual(buildCandidateManifest([], { query: "utilities" }), {
      candidates: [], found: 0, selected: 0, truncated: false, continuation: null,
    });
  });

  test("a multi-category query naming 'utilities' alongside other categories doesn't drop documents outside the utility keyword set (#313)", () => {
    // The real #313 household gate prompt asks for utilities AND fuel AND
    // internet in one breath. A fuel receipt and a generic "payment order"
    // form (the household corpus's internet bill, whose title/filename carry
    // none of electric/water/heating/waste/internet/utility) must not be
    // hard-filtered out of a small pool that was never at risk of truncation.
    const rows = [
      { id: 1, repo_id: 1, root_path: "/a", rel_path: "electricity-bill.txt", mime: "text/plain", size: 10, sha256: "electric" },
      { id: 2, repo_id: 1, root_path: "/a", rel_path: "fuel-receipt-2.txt", mime: "text/plain", size: 10, sha256: "fuel-2" },
      { id: 3, repo_id: 1, root_path: "/a", rel_path: "payment-form-completed-2.txt", mime: "text/plain", size: 10, sha256: "internet-form" },
    ];
    const query = "Break it down by category: utilities, fuel, groceries, transport, and internet. Give me each category total.";
    const result = buildCandidateManifest(rows, { query });
    assert.equal(result.found, 3);
    assert.equal(result.selected, 3, "no candidate should be silently dropped when the pool never exceeds the bound");
    assert.deepEqual(result.candidates.map(c => c.sha256).sort(), ["electric", "fuel-2", "internet-form"]);
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

  test("attaches structured date/amount evidence to every read document (#311)", async () => {
    // The acceptance-criteria fixture: a bill with a June invoice/document
    // date but a May service period. Both dates must surface with distinct
    // role labels — collapsing them into one undifferentiated date_hint (or
    // a single unlabeled date) is exactly the bug that caused eligible May
    // bills to be treated as excluded.
    const text = [
      "ACME Utilities Co.",
      "Invoice Date: 03.06.2026",
      "Service Period: 01.05.2026 to 31.05.2026",
      "Amount Due: 142.50 BGN",
    ].join("\n");
    const result = await retrieveInBatches([{ id: 1, size: 10, rel_path: "bills/electricity-june-invoice.txt" }], {
      readBatch: async (batch) => batch.map(c => ({ id: c.id, text })),
    });
    const doc = result.documents[0];
    assert.equal(doc.status, "read");
    assert.deepEqual(doc.dates.map(d => d.role).sort(), ["invoice_date", "service_period_end", "service_period_start"]);
    assert.equal(doc.dates.find(d => d.role === "invoice_date").value, "2026-06-03");
    assert.equal(doc.dates.find(d => d.role === "service_period_start").value, "2026-05-01");
    assert.equal(doc.dates.find(d => d.role === "service_period_end").value, "2026-05-31");
    assert.deepEqual(doc.amounts, [{ value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" }]);
  });

  test("reports no dates/amounts as an explicit empty array, never a fabricated value", async () => {
    const result = await retrieveInBatches([{ id: 1, size: 10, rel_path: "notes/plain.txt" }], {
      readBatch: async (batch) => batch.map(c => ({ id: c.id, text: "Just a note with no dates or money in it." })),
    });
    const doc = result.documents[0];
    assert.deepEqual(doc.dates, []);
    assert.deepEqual(doc.amounts, []);
  });

  test("skipped documents never get a dates/amounts field fabricated from text they weren't read for", async () => {
    const result = await retrieveInBatches([{ id: 1, size: 3, rel_path: "small-source-huge-text.txt" }], {
      maxFileBytes: 5,
      readBatch: async (batch) => batch.map(c => ({ id: c.id, text: "Invoice Date: 03.06.2026 Amount Due: 10 USD but this is too long to fit" })),
    });
    const doc = result.documents[0];
    assert.equal(doc.status, "skipped");
    assert.ok(!("dates" in doc) && !("amounts" in doc));
  });

  test("keeps limits explicit and bounded", () => {
    assert.ok(RETRIEVAL_LIMITS.maxCandidates > 0);
    assert.ok(RETRIEVAL_LIMITS.batchSize > 0);
    assert.ok(RETRIEVAL_LIMITS.maxBatchBytes > 0);
    assert.ok(RETRIEVAL_LIMITS.maxTotalBytes >= RETRIEVAL_LIMITS.maxBatchBytes);
  });
});

describe("composeMemoryFromDoc — docgraph → memory bridge (#314)", () => {
  // ── Guard / edge cases ────────────────────────────────────────────

  test("returns null when dates or amounts are empty", () => {
    assert.equal(composeMemoryFromDoc([], [{ value: 100, currency: "BGN", raw: "100 BGN", label: "amount_due" }]), null);
    assert.equal(composeMemoryFromDoc([{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }], []), null);
    assert.equal(composeMemoryFromDoc([], []), null);
    assert.equal(composeMemoryFromDoc(null, [{ value: 100, currency: "BGN", raw: "100 BGN", label: "amount_due" }]), null);
    assert.equal(composeMemoryFromDoc([{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }], null), null);
  });

  test("returns null when no terminal-labeled amount exists", () => {
    const dates = [{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }];
    const amounts = [{ value: 100, currency: "BGN", raw: "100 BGN", label: "subtotal" }];
    assert.equal(composeMemoryFromDoc(dates, amounts), null);
  });

  test("returns null when no high-confidence terminal date exists", () => {
    const dates = [{ role: "unlabeled_date", raw: "03.06.2026", value: "2026-06-03", confidence: "low" }];
    const amounts = [{ value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" }];
    assert.equal(composeMemoryFromDoc(dates, amounts), null);
  });

  test("ignores likely_total amounts (not terminal-confidence)", () => {
    const dates = [{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }];
    const amounts = [{ value: 100, currency: "BGN", raw: "100 BGN", label: "likely_total" }];
    assert.equal(composeMemoryFromDoc(dates, amounts), null);
  });

  // ── Amount selection: amount_due > grand_total (semantic, not numeric) ─

  test("prefers amount_due over grand_total regardless of value", () => {
    // A partially paid 100 BGN invoice with 20 BGN still due must promote 20.
    const dates = [{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }];
    const amounts = [
      { value: 100, currency: "BGN", raw: "100.00 BGN", label: "grand_total" },
      { value: 20, currency: "BGN", raw: "20.00 BGN", label: "amount_due" },
    ];
    const mem = composeMemoryFromDoc(dates, amounts);
    assert.match(mem.content, /20\.00 BGN/);
    assert.doesNotMatch(mem.content, /100\.00 BGN/);
  });

  test("falls back to grand_total when amount_due is absent", () => {
    const dates = [{ role: "service_period_start", raw: "01.05.2026", value: "2026-05-01", confidence: "high" }];
    const amounts = [
      { value: 64.8, currency: "BGN", raw: "64,80 BGN", label: "subtotal" },
      { value: 64.8, currency: "BGN", raw: "64,80 BGN", label: "grand_total" },
    ];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "noamountdue" });
    assert.match(mem.content, /64,80 BGN/);
  });

  test("rejects terminal amounts with no resolved currency", () => {
    const dates = [{ role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" }];
    const amounts = [{ value: 100, currency: null, raw: "100", label: "amount_due" }];
    assert.equal(composeMemoryFromDoc(dates, amounts), null);
  });

  test("rejects same numeric value in different currencies (100 USD vs 100 EUR)", () => {
    const dates = [{ role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" }];
    const amounts = [
      { value: 100, currency: "USD", raw: "100.00 USD", label: "amount_due" },
      { value: 100, currency: "EUR", raw: "100.00 EUR", label: "amount_due" },
    ];
    assert.equal(composeMemoryFromDoc(dates, amounts), null);
  });

  // ── Period selection: service_period > invoice_date > due_date ──────

  test("uses service_period_start as the period, appends due date as context", () => {
    // May service period, June due date — the memory belongs to May, not June.
    const dates = [
      { role: "service_period_start", raw: "01.05.2026", value: "2026-05-01", confidence: "high" },
      { role: "service_period_end", raw: "31.05.2026", value: "2026-05-31", confidence: "high" },
      { role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" },
    ];
    const amounts = [{ value: 64.8, currency: "BGN", raw: "64,80 BGN", label: "grand_total" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "sp", root_path: "/docs", rel_path: "bills/may-heating.txt" });
    assert.match(mem.title, /may-heating summary — 2026-05/);
    assert.match(mem.content, /Service period 2026-05/);
    assert.match(mem.content, /Due 2026-06-20/);
  });

  test("uses invoice_date as period when no service period exists", () => {
    // Only invoice date + due date — period comes from the invoice date.
    const dates = [
      { role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" },
      { role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" },
    ];
    const amounts = [{ value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "id", root_path: "/docs", rel_path: "bills/june-invoice.txt" });
    assert.match(mem.title, /june-invoice summary — 2026-06/);
    assert.match(mem.content, /Issued 2026-06-0?1/);
    assert.match(mem.content, /Due 2026-06-20/);
  });

  test("uses due_date as period only when it is the only terminal date", () => {
    const dates = [{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }];
    const amounts = [{ value: 29.99, currency: "BGN", raw: "29,99 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "nodate" });
    assert.match(mem.title, /document summary — 2026-06/);
    assert.match(mem.content, /Due 2026-06-20/);
  });

  test("skips ambiguous (value: null) dates and falls back to a valid one (#314)", () => {
    // service_period_start has value: null (unparseable format), so the
    // period must fall back to invoice_date instead of returning null.
    const dates = [
      { role: "service_period_start", raw: "03/06/2026", value: null, confidence: "high" },
      { role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" },
    ];
    const amounts = [{ value: 100, currency: "BGN", raw: "100.00 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "nullval" });
    assert.notEqual(mem, null);
    assert.match(mem.content, /Issued 2026-06-01/);
  });

  // ── Multi-record guard ────────────────────────────────────────────

  test("rejects when multiple amounts share the winning label (two invoices)", () => {
    const dates = [{ role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" }];
    const amounts = [
      { value: 100, currency: "BGN", raw: "100.00 BGN", label: "amount_due" },
      { value: 200, currency: "BGN", raw: "200.00 BGN", label: "amount_due" },
    ];
    assert.equal(composeMemoryFromDoc(dates, amounts), null);
  });

  test("rejects when multiple dates share the winning role (two invoice dates)", () => {
    const dates = [
      { role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" },
      { role: "invoice_date", raw: "15.06.2026", value: "2026-06-15", confidence: "high" },
    ];
    const amounts = [{ value: 100, currency: "BGN", raw: "100.00 BGN", label: "amount_due" }];
    assert.equal(composeMemoryFromDoc(dates, amounts), null);
  });

  test("allows one amount_due + one grand_total (single invoice, both present)", () => {
    const dates = [{ role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" }];
    const amounts = [
      { value: 20, currency: "BGN", raw: "20.00 BGN", label: "amount_due" },
      { value: 100, currency: "BGN", raw: "100.00 BGN", label: "grand_total" },
    ];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "single" });
    assert.notEqual(mem, null);
    assert.match(mem.content, /20\.00 BGN/);
  });

  test("accepts repeated identical amount_due values (payment stub/footer duplication)", () => {
    const dates = [{ role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" }];
    const amounts = [
      { value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" },
      { value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" }, // duplicate in footer
    ];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "footerrepeat" });
    assert.notEqual(mem, null);
    assert.match(mem.content, /142\.50 BGN/);
  });

  test("accepts repeated identical invoice_date values (header/footer duplication)", () => {
    const dates = [
      { role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" },
      { role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" }, // duplicate in footer
    ];
    const amounts = [{ value: 100, currency: "BGN", raw: "100.00 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "datefooterrepeat" });
    assert.notEqual(mem, null);
    assert.match(mem.content, /Issued 2026-06-01/);
  });

  test("suppresses due-date context when multiple distinct due dates exist", () => {
    // Original due date (15th) and revised due date (20th) — ambiguous.
    const dates = [
      { role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" },
      { role: "due_date", raw: "15.06.2026", value: "2026-06-15", confidence: "high" },
      { role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" },
    ];
    const amounts = [{ value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "ambigdd" });
    assert.notEqual(mem, null);
    assert.match(mem.content, /Issued 2026-06-01/);
    // Due date suppressed — neither date appears in output
    assert.doesNotMatch(mem.content, /Due 2026-06/);
  });

  test("includes due-date context when exactly one due date exists", () => {
    // Single due date — unambiguous, included as context.
    const dates = [
      { role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" },
      { role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" },
    ];
    const amounts = [{ value: 100, currency: "BGN", raw: "100.00 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "singledd" });
    assert.match(mem.content, /Due 2026-06-20/);
  });

  test("includes due-date context when the same due date is repeated (header + footer dedup)", () => {
    const dates = [
      { role: "invoice_date", raw: "01.06.2026", value: "2026-06-01", confidence: "high" },
      { role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" },
      { role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }, // footer duplicate
    ];
    const amounts = [{ value: 100, currency: "BGN", raw: "100.00 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "ddrepeat" });
    assert.match(mem.content, /Due 2026-06-20/);
  });

  // ── No PII or filesystem paths in returned tags ─────────────────────

  test("includes only semantic tags — no filesystem paths", () => {
    const dates = [{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }];
    const amounts = [{ value: 100, currency: "BGN", raw: "100 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, {
      sha256: "abc", root_path: "/home/user/docs", rel_path: "bills/water.txt",
    });
    assert.deepEqual(mem.tags, ["fact", "bill"]);
    assert.equal(mem.importance, 4);
    // composeMemoryFromDoc no longer returns dedupKey — it lives in the handler
    assert.equal(mem.dedupKey, undefined);
  });

  // ── Content composition ────────────────────────────────────────────

  test("composes full content with period context + separate due line", () => {
    const dates = [
      { role: "service_period_start", raw: "01.05.2026", value: "2026-05-01", confidence: "high" },
      { role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" },
    ];
    const amounts = [{ value: 64.8, currency: "BGN", raw: "64,80 BGN", label: "grand_total" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "x", title: "heating.pdf" });
    assert.equal(mem.content,
      "heating summary — 2026-05: 64,80 BGN. Service period 2026-05. Due 2026-06-20");
  });

  test("uses rel_path as fallback title when no title is provided", () => {
    const dates = [{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }];
    const amounts = [{ value: 100, currency: "BGN", raw: "100 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "x", rel_path: "bills/water.txt" });
    assert.match(mem.title, /water summary/);
  });

  test("does not duplicate currency already present in raw amount text", () => {
    const dates = [{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }];
    const amounts = [{ value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "nodup" });
    assert.match(mem.content, /142\.50 BGN\. /);
    assert.doesNotMatch(mem.content, /BGN BGN/);
  });

  test("appends currency when raw amount lacks it (separate-label case)", () => {
    const dates = [{ role: "due_date", raw: "20.06.2026", value: "2026-06-20", confidence: "high" }];
    const amounts = [{ value: 29.99, currency: "BGN", raw: "29,99", label: "amount_due" }];
    const mem = composeMemoryFromDoc(dates, amounts, { sha256: "append" });
    assert.match(mem.content, /29,99 BGN\. /);
  });
});

describe("buildDocumentHighlights — doc_batch highlights (#313)", () => {
  test("reports zero documents when given an empty array", () => {
    assert.match(buildDocumentHighlights([]), /0 documents read/);
  });

  test("returns a zero-note when no documents have terminal amounts", () => {
    const docs = [
      { status: "read", rel_path: "notes/plain.txt", title: "plain.txt", amounts: [] },
      { status: "read", rel_path: "form/blank.pdf", title: "blank.pdf", amounts: [] },
    ];
    const result = buildDocumentHighlights(docs);
    assert.match(result, /none with detected terminal amounts/);
  });

  test("lists only documents with terminal amount_due or grand_total, filtered from non-terminal labels", () => {
    const docs = [
      { status: "read", rel_path: "bills/electric.txt", title: "electric.txt",
        amounts: [{ value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" }] },
      { status: "read", rel_path: "bills/water.txt", title: "water.txt",
        amounts: [{ value: 38.2, currency: "BGN", raw: "38.20 BGN", label: "subtotal" }] },
      { status: "read", rel_path: "fuel/receipt.txt", title: "receipt.txt",
        amounts: [{ value: 215.6, currency: "BGN", raw: "215.60 BGN", label: "total" }] },
    ];
    const result = buildDocumentHighlights(docs);
    // Only amount_due is terminal => only electric shows up
    assert.match(result, /electric\.txt/);
    assert.doesNotMatch(result, /water\.txt/);
    assert.doesNotMatch(result, /receipt\.txt/);
  });

  test("assigns correct category hints from filenames", () => {
    const docs = [
      { status: "read", rel_path: "bills/electricity-jun.txt", title: "electricity-jun.txt",
        amounts: [{ value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" }] },
      { status: "read", rel_path: "fuel/petrol-receipt.txt", title: "petrol-receipt.txt",
        amounts: [{ value: 50, currency: "BGN", raw: "50.00 BGN", label: "grand_total" }] },
      { status: "read", rel_path: "shop/grocery-receipt.txt", title: "grocery-receipt.txt",
        amounts: [{ value: 45, currency: "BGN", raw: "45.00 BGN", label: "amount_due" }] },
      { status: "read", rel_path: "commute/transport-topup.txt", title: "transport-topup.txt",
        amounts: [{ value: 50, currency: "BGN", raw: "50.00 BGN", label: "amount_due" }] },
      { status: "read", rel_path: "web/internet-payment.txt", title: "internet-payment.txt",
        amounts: [{ value: 29.99, currency: "BGN", raw: "29.99 BGN", label: "amount_due" }] },
      { status: "read", rel_path: "tax/notice-2026.txt", title: "notice-2026.txt",
        amounts: [{ value: 100, currency: "BGN", raw: "100.00 BGN", label: "amount_due" }] },
      { status: "read", rel_path: "trade/commercial-invoice.txt", title: "commercial-invoice.txt",
        amounts: [{ value: 1000, currency: "EUR", raw: "1000.00 EUR", label: "amount_due" }] },
    ];
    const result = buildDocumentHighlights(docs);
    assert.match(result, /electricity-jun\.txt.*utility/);
    assert.match(result, /petrol-receipt\.txt.*fuel/);
    assert.match(result, /grocery-receipt\.txt.*groceries/);
    assert.match(result, /transport-topup\.txt.*transport/);
    assert.match(result, /internet-payment\.txt.*internet/);
    assert.match(result, /notice-2026\.txt.*tax_notice/);
    assert.match(result, /commercial-invoice\.txt.*commercial/);
  });

  test("assigns null category hint for unrecognized filenames", () => {
    const docs = [
      { status: "read", rel_path: "misc/unknown-file.txt", title: "unknown-file.txt",
        amounts: [{ value: 50, currency: "BGN", raw: "50.00 BGN", label: "amount_due" }] },
    ];
    const result = buildDocumentHighlights(docs);
    assert.match(result, /unknown-file\.txt.*—/);
  });

  test("skips skipped documents silently (only read docs are counted)", () => {
    const docs = [
      { status: "read", rel_path: "bills/electric.txt", title: "electric.txt",
        amounts: [{ value: 100, currency: "BGN", raw: "100.00 BGN", label: "amount_due" }] },
      { status: "skipped", rel_path: "bills/unread.txt", title: "unread.txt",
        amounts: [{ value: 200, currency: "BGN", raw: "200.00 BGN", label: "amount_due" }] },
    ];
    const result = buildDocumentHighlights(docs);
    assert.match(result, /electric\.txt/);
    assert.doesNotMatch(result, /unread\.txt/);
  });

  test("rejects amounts with null currency", () => {
    const docs = [
      { status: "read", rel_path: "bills/bill.txt", title: "bill.txt",
        amounts: [{ value: 100, currency: null, raw: "100", label: "amount_due" }] },
    ];
    assert.match(buildDocumentHighlights(docs), /none with detected terminal amounts/);
  });

  test("rejects amounts with null value", () => {
    const docs = [
      { status: "read", rel_path: "bills/bill.txt", title: "bill.txt",
        amounts: [{ value: null, currency: "BGN", raw: "N/A", label: "amount_due" }] },
    ];
    assert.match(buildDocumentHighlights(docs), /none with detected terminal amounts/);
  });
});
