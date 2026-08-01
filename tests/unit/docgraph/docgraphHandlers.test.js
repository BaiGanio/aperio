// tests/lib/handlers/docgraph/docgraphHandlers.test.js
// Tests for document graph MCP/HTTP handlers.
//
// Handlers wrap backend functions from pickBackend(ctx.store) which checks
// for store.pool (postgres) or store.db (sqlite). We provide a mock pool
// so the real postgres backend functions execute against controlled data.

import { describe, test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import logger from "../../../lib/helpers/logger.js";
import {
  searchHandler,
  reposHandler,
  batchHandler,
  outlineHandler,
  contextHandler,
  refsHandler,
  deleteRepoHandler,
} from "../../../lib/handlers/docgraph/docgraphHandlers.js";

// ─── Mock pool — routes SQL content to controlled rows ──────────────────────

function mockPool(routeMap) {
  const routes = Object.entries(routeMap);
  return {
    query: async (sql, params) => {
      for (const [pattern, rows] of routes) {
        if (sql.includes(pattern)) return { rows, rowCount: rows.length };
      }
      // Default: empty rows
      return { rows: [], rowCount: 0 };
    },
  };
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});
});

after(() => mock.restoreAll());

// ─── Mock ctx factory ────────────────────────────────────────────────────────

function makeCtx(withPool = false, poolRoutes = {}) {
  return {
    store: withPool ? { pool: mockPool(poolRoutes) } : {},
    generateEmbedding: async (text) => new Array(1024).fill(0.01),
    vectorEnabled: () => false, // fulltext only for tests
  };
}

// Convenience: expect the handler result is an error
function isError(result) {
  return result.isError === true || result.content?.[0]?.text?.startsWith("❌");
}

// =============================================================================
// searchHandler
// =============================================================================

describe("searchHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await searchHandler(makeCtx(false), { query: "test" });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns results when backend succeeds", async () => {
    const ctx = makeCtx(true, {
      "docgraph_repos WHERE root_path": [],
      "FROM docgraph_chunks": [
        { chunk_id: 1, section_id: 10, chunk_text: "Budget document text", heading: "Budget", level: 1, rel_path: "budget.md", title: "Budget", mime: "text/markdown", root_path: "/repo", score: 0.85 },
      ],
    });
    const result = await searchHandler(ctx, { query: "budget" });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.matches.length, 1);
    assert.strictEqual(payload.matches[0].document.title, "Budget");
    assert.strictEqual(payload.matches[0].score, 0.85);
  });

  test("returns error when backend throws", async () => {
    const pool = { query: async () => { throw new Error("pg down"); } };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await searchHandler(ctx, { query: "test" });
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("pg down"));
  });
});

// =============================================================================
// reposHandler
// =============================================================================

describe("reposHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await reposHandler(makeCtx(false));
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns repo list when backend succeeds", async () => {
    let callIndex = 0;
    const pool = {
      query: async (sql) => {
        callIndex++;
        if (callIndex === 1) return { rows: [{ id: 1, root_path: "/repo/a", last_indexed_at: "2026-06-01T00:00:00Z", docs: 2, chunks: 5, by_mime_raw: {} }], rowCount: 1 };
        if (callIndex === 2) return { rows: [{ mime: "text/markdown", n: 2 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await reposHandler(ctx);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.repos.length, 1);
    assert.strictEqual(payload.repos[0].root_path, "/repo/a");
  });

  test("returns error when backend throws", async () => {
    const pool = { query: async () => { throw new Error("db error"); } };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await reposHandler(ctx);
    assert.ok(isError(result));
  });
});

// =============================================================================
// batchHandler — cancellation signal wiring
// =============================================================================
//
// Regression: ctx has no per-request `signal` field (it's one shared,
// process-lifetime object — see mcp/index.js's createContext), so
// `ctx.signal` used to always be undefined and every abort check inside
// retrieveInBatches was dead in real tool calls. The real signal must be the
// MCP SDK's per-call RequestHandlerExtra#signal, passed as batchHandler's
// third argument (mirroring mcp/tools/docgraph.js's `(args, extra) =>
// batchHandler(ctx, args, extra?.signal)` wiring), not read off ctx.

describe("batchHandler", () => {
  test("an already-aborted request signal stops retrieval before any read", async () => {
    const pool = mockPool({}); // must never be reached — retrieval aborts first
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const controller = new AbortController();
    controller.abort();
    const result = await batchHandler(ctx, { candidates: [{ id: 1, rel_path: "a.md", size: 10 }] }, controller.signal);
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("aborted"));
  });

  test("a live (non-aborted) request signal lets the batch complete normally", async () => {
    const pool = mockPool({
      "FROM docgraph_documents": [{ id: 1, mime: "text/markdown", title: "Doc", rel_path: "a.md", root_path: "/repo", text: "hello" }],
    });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const controller = new AbortController();
    const result = await batchHandler(ctx, { candidates: [{ id: 1, rel_path: "a.md", size: 10 }] }, controller.signal);
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.coverage.read, 1);
  });

  test("ctx.signal is never consulted — a signal on ctx must not substitute for the real request signal", async () => {
    const pool = mockPool({}); // must never be reached
    const abortedCtxSignal = new AbortController();
    abortedCtxSignal.abort();
    // If _batch ever regresses back to reading ctx.signal, this aborted
    // decoy would cause a false-positive abort even though the real request
    // signal (passed as the third arg) is live and unaborted.
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false, signal: abortedCtxSignal.signal };
    const livePool = mockPool({
      "FROM docgraph_documents": [{ id: 1, mime: "text/markdown", title: "Doc", rel_path: "a.md", root_path: "/repo", text: "hello" }],
    });
    ctx.store.pool = livePool;
    const controller = new AbortController();
    const result = await batchHandler(ctx, { candidates: [{ id: 1, rel_path: "a.md", size: 10 }] }, controller.signal);
    assert.strictEqual(result.isError, undefined, "a decoy aborted ctx.signal must not abort a call with a live request signal");
  });
});

// =============================================================================
// batchHandler — deterministic aggregation (facts pipeline, issue #250)
// =============================================================================
//
// doc_batch must hand the model settled totals, not raw documents to add up:
// the facts pipeline (aggregateDocuments) runs over the documents the batch
// actually read, with duplicates merged and unresolvable documents excluded
// with reasons. These tests exercise the handler-level wiring — field-name
// normalization (rel_path/root_path → document/root) is covered in
// extract.test.js; totals, dedup, period filtering, and the skipped-document
// boundary are covered here against the real retrieval + extraction code.

// The June-gate fixtures, kept small: a fuel receipt, the statement row that
// records the same purchase, and an electricity bill. Together they exercise
// terminal-amount picking, adjudicated dedup, and per-category totals.
const AGG_FUEL_RECEIPT = [
  "P E T R O L M A X",
  "Fuel Station #17 - Sofia",
  "FISCAL RECEIPT",
  "Date: 09.06.2026",
  "Receipt No: 0417-000239",
  "TOTAL                         120.00 BGN",
  "Card payment                  120.00 BGN",
].join("\n");

const AGG_STATEMENT = [
  "FIRST DIGITAL BANK",
  "Account Statement",
  "Currency:         BGN",
  "Opening balance:  4 250.00 BGN",
  " Date        Description                    Category     Amount (BGN)",
  " 07.06.2026  FreshMarket #218 groceries      Groceries          -87.45",
  " 09.06.2026  PetrolMax fuel station         Fuel              -120.00",
].join("\n");

const AGG_ELECTRICITY = [
  "СофияЕнерго ЕАД",
  "ФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ",
  "Фактура №: 0000451287",
  "Дата на издаване: 03.06.2026",
  "ЗА ПЛАЩАНЕ (с ДДС): 142,50 лв",
].join("\n");

describe("batchHandler — deterministic aggregation", () => {
  const rows = [
    { id: 1, mime: "text/plain", title: null, rel_path: "June/fuel-receipt-09-jun.txt", root_path: "/repo/household", text: AGG_FUEL_RECEIPT },
    { id: 2, mime: "text/plain", title: null, rel_path: "June/bank-statement-jun.txt", root_path: "/repo/household", text: AGG_STATEMENT },
    { id: 3, mime: "text/plain", title: null, rel_path: "June/electricity-bill-03-jun.txt", root_path: "/repo/household", text: AGG_ELECTRICITY },
  ];
  const pool = mockPool({ "FROM docgraph_documents": rows });
  const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
  const args = { candidates: rows.map(r => ({ id: r.id, rel_path: r.rel_path, size: 10 })) };

  test("attaches deterministic per-category totals computed by application code", async () => {
    const result = await batchHandler(ctx, args);
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.ok(payload.aggregate, "doc_batch must expose the facts pipeline's totals");
    const bgn = payload.aggregate.by_currency.BGN;
    // The receipt and the statement row that records it are one purchase;
    // the bill adds its own charge.
    assert.equal(bgn.by_category.Fuel.total, 120);
    assert.equal(bgn.by_category.Groceries.total, 87.45);
    assert.equal(bgn.by_category.Utilities.total, 142.5);
    assert.equal(bgn.total, 349.95);
    assert.equal(payload.aggregate.duplicates.length, 1);
    assert.equal(payload.aggregate.duplicates[0].kept.document, "June/fuel-receipt-09-jun.txt");
    assert.equal(payload.aggregate.coverage.documents_seen, 3);
  });

  test("aggregate_period restricts totals and reports out-of-period documents", async () => {
    const result = await batchHandler(ctx, { ...args, aggregate_period: "2026-07" });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.aggregate.period, "2026-07");
    assert.deepEqual(payload.aggregate.by_currency, {});
    // Four facts total (receipt, two statement rows, bill), all in June.
    assert.equal(payload.aggregate.excluded.filter(e => e.reason === "out_of_period").length, 4);
    assert.equal(payload.aggregate.coverage.facts_extracted, 4);
    assert.equal(payload.aggregate.coverage.facts_in_period, 0);
  });

  test("skipped documents never leak into the aggregate as no_text exclusions", async () => {
    // Candidate 99 has no row in the mock store — retrieval reports it
    // skipped with a reason, and the aggregate must not re-flag it.
    const result = await batchHandler(ctx, {
      ...args,
      candidates: [...args.candidates, { id: 99, rel_path: "gone.txt", size: 10 }],
    });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.coverage.skipped, 1);
    assert.equal(payload.coverage.skipped_reasons["gone.txt"], "reader returned no result");
    assert.equal(payload.aggregate.coverage.documents_seen, 3);
    assert.ok(!payload.aggregate.excluded.some(e => e.document === "gone.txt"));
  });
});

// =============================================================================
// batchHandler — docgraph → memory bridge (#314)
// =============================================================================
//
// The bridge auto-promotes high-confidence terminal facts (amount_due/
// grand_total + due_date/invoice_date/service_period) read during a batch
// into the memory store, gated behind process.env.DOCGRAPH_AUTO_MEMORY.
// composeMemoryFromDoc's own selection logic is covered exhaustively in
// retrieval.test.js; these tests exercise the handler-level wiring around
// it: dedup lookup, the no-op/hasEmbedding gate, retry-queue enqueue on a
// failed embedding, stale-doc retirement, and duplicate reconciliation.

// Mirrors the handler's private bridgeTag() so fixtures can pre-seed a
// matching dedup tag deterministically, without exporting the internal fn.
function expectedDedupTag(rootPath, relPath) {
  const hash = createHash("sha256").update(`${rootPath}/${relPath}`).digest("hex");
  return "dag:" + hash.slice(0, 16);
}

// A bill with an invoice date, a May service period, and an amount due —
// the same fixture retrieval.test.js uses for "attaches structured
// date/amount evidence" — guaranteed to produce a qualifying memory.
const QUALIFYING_TEXT = [
  "ACME Utilities Co.",
  "Invoice Date: 03.06.2026",
  "Service Period: 01.05.2026 to 31.05.2026",
  "Amount Due: 142.50 BGN",
].join("\n");
const QUALIFYING_REL_PATH = "bills/electricity-june-invoice.txt";
const QUALIFYING_ROOT_PATH = "/repo";
const QUALIFYING_DOC_ROW = {
  id: 1, mime: "text/plain", title: null,
  rel_path: QUALIFYING_REL_PATH, root_path: QUALIFYING_ROOT_PATH,
  text: QUALIFYING_TEXT,
};
const QUALIFYING_DEDUP_TAG = expectedDedupTag(QUALIFYING_ROOT_PATH, QUALIFYING_REL_PATH);
const EXPECTED_TITLE = "bills/electricity-june-invoice summary — 2026-05";
const EXPECTED_CONTENT = "bills/electricity-june-invoice summary — 2026-05: 142.50 BGN. Service period 2026-05";
const FAKE_EMBEDDING = [0.01, 0.02, 0.03];

// A memory row that exactly matches what composeMemoryFromDoc would produce
// for QUALIFYING_DOC_ROW, so the no-op path is reachable in fixtures.
function matchingBridgeRow(overrides = {}) {
  return {
    id: "mem-existing",
    title: EXPECTED_TITLE,
    content: EXPECTED_CONTENT,
    tags: ["fact", "bill", "docgraph", QUALIFYING_DEDUP_TAG],
    importance: 4,
    tier: 2,
    source: "docgraph",
    ...overrides,
  };
}

// A tiny in-memory fake standing in for the memory store's bridge-relevant
// methods (recall/insert/update/delete/hasEmbedding), so dedup/reconciliation
// behavior can be exercised against realistic tag-filtering semantics
// instead of hand-scripted fixed returns. `_hasEmbedding: true` on a seed
// row marks it as already embedded.
function makeMemoryStore(initial = []) {
  let seq = 0;
  const rows = initial.map(m => ({ ...m }));
  const embedded = new Set(initial.filter(m => m._hasEmbedding).map(m => m.id));
  return {
    _rows: rows,
    recall: mock.fn(async ({ tags = [] } = {}) =>
      rows.filter(m => tags.every(t => m.tags.includes(t)))),
    insert: mock.fn(async (input, embedding) => {
      const row = { id: `mem-new-${++seq}`, ...input };
      rows.push(row);
      if (embedding) embedded.add(row.id);
      return row;
    }),
    update: mock.fn(async (id, input, embedding) => {
      const idx = rows.findIndex(r => r.id === id);
      rows[idx] = { ...rows[idx], ...input };
      if (embedding) embedded.add(id); else embedded.delete(id);
      return rows[idx];
    }),
    delete: mock.fn(async (id) => {
      const idx = rows.findIndex(r => r.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      embedded.delete(id);
    }),
    hasEmbedding: mock.fn(async (id) => embedded.has(id)),
  };
}

function makeBridgeCtx({ docRow = QUALIFYING_DOC_ROW, memoryRows = [], generateEmbedding = async () => FAKE_EMBEDDING, embeddingQueue } = {}) {
  const pool = mockPool({ "FROM docgraph_documents": [docRow] });
  const memStore = makeMemoryStore(memoryRows);
  // vectorEnabled matches generateEmbedding presence: when a generator is
  // provided the bridge considers embeddings enabled and checks hasEmbedding;
  // when null the check is skipped entirely.
  const ctx = { store: { pool, ...memStore }, generateEmbedding, vectorEnabled: () => generateEmbedding != null };
  if (embeddingQueue !== undefined) ctx.embeddingQueue = embeddingQueue;
  return { ctx, memStore };
}

const qualifyingArgs = { candidates: [{ id: 1, rel_path: QUALIFYING_REL_PATH, size: 10 }] };

describe("batchHandler — docgraph → memory bridge (#314)", () => {
  beforeEach(() => { delete process.env.DOCGRAPH_AUTO_MEMORY; });
  afterEach(() => { delete process.env.DOCGRAPH_AUTO_MEMORY; });

  test("is a no-op when DOCGRAPH_AUTO_MEMORY is unset", async () => {
    const { ctx, memStore } = makeBridgeCtx();
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(memStore.recall.mock.callCount(), 0);
    assert.strictEqual(memStore.insert.mock.callCount(), 0);
  });

  test("creates a new bridge memory for a qualifying document", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const { ctx, memStore } = makeBridgeCtx();
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(memStore.insert.mock.callCount(), 1);
    const [input, embedding] = memStore.insert.mock.calls[0].arguments;
    assert.strictEqual(input.title, EXPECTED_TITLE);
    assert.strictEqual(input.content, EXPECTED_CONTENT);
    assert.strictEqual(input.source, "docgraph");
    assert.strictEqual(input.tier, 2);
    assert.strictEqual(input.confidence, 1.0);
    assert.ok(input.tags.includes("docgraph"));
    assert.ok(input.tags.includes(QUALIFYING_DEDUP_TAG));
    assert.deepEqual(embedding, FAKE_EMBEDDING);
  });

  test("skips as a no-op when content is unchanged and the memory already has an embedding", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const { ctx, memStore } = makeBridgeCtx({ memoryRows: [matchingBridgeRow({ _hasEmbedding: true })] });
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(memStore.hasEmbedding.mock.callCount(), 1);
    assert.strictEqual(memStore.update.mock.callCount(), 0);
    assert.strictEqual(memStore.insert.mock.callCount(), 0);
    assert.strictEqual(memStore.delete.mock.callCount(), 0);
  });

  test("requeues existing memory for embedding retry without versioning when content matches but embedding is missing", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const queue = [];
    const { ctx, memStore } = makeBridgeCtx({
      memoryRows: [matchingBridgeRow()], // no _hasEmbedding — missing embedding
      embeddingQueue: { enqueue: (id, text) => queue.push({ id, text }) },
    });
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(memStore.hasEmbedding.mock.callCount(), 1);
    // No versioning — the existing memory is requeued without update/delete
    assert.strictEqual(memStore.update.mock.callCount(), 0);
    assert.strictEqual(memStore.insert.mock.callCount(), 0);
    assert.strictEqual(memStore.delete.mock.callCount(), 0);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].id, "mem-existing");
  });

  test("never queries hasEmbedding when embeddings are disabled (ctx.generateEmbedding absent)", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    // null, not omitted — default-parameter destructuring only substitutes
    // for an omitted/undefined property, so this must be an explicit falsy
    // value to actually simulate "no ctx.generateEmbedding" here.
    const { ctx, memStore } = makeBridgeCtx({ memoryRows: [matchingBridgeRow()], generateEmbedding: null });
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(memStore.hasEmbedding.mock.callCount(), 0);
    assert.strictEqual(memStore.update.mock.callCount(), 0);
    assert.strictEqual(memStore.insert.mock.callCount(), 0);
  });

  test("enqueues for retry when embedding generation returns null", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const enqueue = mock.fn();
    const { ctx, memStore } = makeBridgeCtx({ generateEmbedding: async () => null, embeddingQueue: { enqueue } });
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(memStore.insert.mock.callCount(), 1);
    const [, embedding] = memStore.insert.mock.calls[0].arguments;
    assert.strictEqual(embedding, null);
    assert.strictEqual(enqueue.mock.callCount(), 1);
    const [enqueuedId, enqueuedText] = enqueue.mock.calls[0].arguments;
    assert.strictEqual(enqueuedId, "mem-new-1");
    assert.strictEqual(enqueuedText, `${EXPECTED_TITLE}. ${EXPECTED_CONTENT}`);
  });

  test("retires an existing bridge memory when the document no longer has qualifying facts", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const plainRelPath = "notes/plain.txt";
    const plainDocRow = {
      id: 1, mime: "text/plain", title: null,
      rel_path: plainRelPath, root_path: QUALIFYING_ROOT_PATH,
      text: "Just a plain note with no financial data.",
    };
    const staleTag = expectedDedupTag(QUALIFYING_ROOT_PATH, plainRelPath);
    const staleRow = matchingBridgeRow({ id: "mem-stale", tags: ["fact", "bill", "docgraph", staleTag] });
    const { ctx, memStore } = makeBridgeCtx({ docRow: plainDocRow, memoryRows: [staleRow] });
    const result = await batchHandler(ctx, { candidates: [{ id: 1, rel_path: plainRelPath, size: 10 }] });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(memStore.delete.mock.callCount(), 1);
    assert.strictEqual(memStore.delete.mock.calls[0].arguments[0], "mem-stale");
    assert.strictEqual(memStore.insert.mock.callCount(), 0);
    assert.strictEqual(memStore.update.mock.callCount(), 0);
  });

  test("reconciles duplicate bridge memories sharing the same dedup tag before mutating", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const dupA = matchingBridgeRow({ id: "mem-dup-a", _hasEmbedding: true });
    const dupB = matchingBridgeRow({ id: "mem-dup-b", _hasEmbedding: true });
    const { ctx, memStore } = makeBridgeCtx({ memoryRows: [dupA, dupB] });
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    // Only the second (non-surviving) duplicate is retired...
    assert.strictEqual(memStore.delete.mock.callCount(), 1);
    assert.strictEqual(memStore.delete.mock.calls[0].arguments[0], "mem-dup-b");
    // ...and the survivor, already matching and embedded, is left as a no-op.
    assert.strictEqual(memStore.update.mock.callCount(), 0);
    assert.strictEqual(memStore.insert.mock.callCount(), 0);
  });

  test("never mutates a non-bridge memory that happens to carry a matching dedup tag", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const userRow = matchingBridgeRow({ id: "mem-user", source: "user" });
    const { ctx, memStore } = makeBridgeCtx({ memoryRows: [userRow] });
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(memStore.update.mock.callCount(), 0);
    assert.strictEqual(memStore.delete.mock.callCount(), 0);
    // Treated as "no bridge-owned memory exists yet" — a new one is created
    // alongside the untouched user memory, never overwriting it.
    assert.strictEqual(memStore.insert.mock.callCount(), 1);
    assert.ok(memStore._rows.some(r => r.id === "mem-user" && r.source === "user"));
  });

  test("cleans up a concurrent duplicate inserted between the pre-insert recall and this insert", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const rows = [];
    let insertCallCount = 0;
    const store = {
      pool: mockPool({ "FROM docgraph_documents": [QUALIFYING_DOC_ROW] }),
      recall: async ({ tags = [] } = {}) => rows.filter(m => tags.every(t => m.tags.includes(t))),
      insert: async (input) => {
        insertCallCount++;
        const row = { id: "mem-primary", ...input };
        rows.push(row);
        // Simulate a second doc_batch call racing in a duplicate bridge-owned
        // memory for the same document between this insert and the handler's
        // post-insert dedup recall.
        rows.push({ id: "mem-concurrent", ...input });
        return row;
      },
      update: mock.fn(),
      delete: async (id) => {
        const idx = rows.findIndex(r => r.id === id);
        if (idx >= 0) rows.splice(idx, 1);
      },
      hasEmbedding: async () => false,
    };
    const ctx = { store, generateEmbedding: async () => FAKE_EMBEDDING, vectorEnabled: () => false };
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(insertCallCount, 1);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, "mem-primary");
  });

  test("does not touch the memory store for a skipped (unread) document", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const { ctx, memStore } = makeBridgeCtx();
    const result = await batchHandler(ctx, { ...qualifyingArgs, max_file_bytes: 1 });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.documents[0].status, "skipped");
    assert.strictEqual(memStore.recall.mock.callCount(), 0);
    assert.strictEqual(memStore.insert.mock.callCount(), 0);
  });

  test("a bridge-store failure for one document is logged and does not fail the batch", async () => {
    process.env.DOCGRAPH_AUTO_MEMORY = "on";
    const { ctx, memStore } = makeBridgeCtx();
    memStore.recall.mock.mockImplementationOnce(async () => { throw new Error("store unavailable"); });
    const result = await batchHandler(ctx, qualifyingArgs);
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.documents[0].status, "read");
    assert.strictEqual(memStore.insert.mock.callCount(), 0);
    assert.strictEqual(logger.error.mock.callCount() > 0, true);
  });
});

// =============================================================================
// outlineHandler
// =============================================================================

describe("outlineHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await outlineHandler(makeCtx(false), { path: "doc.md" });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns outline when document found", async () => {
    // outline with no folder skips resolveRepoId; only 2 queries run.
    const pool = mockPool({
      "JOIN docgraph_repos": [{ id: 1, title: "Budget", mime: "text/markdown", summary: "Q3", root_path: "/repo" }],
      "FROM docgraph_sections": [{ id: 10, parent_id: null, ord: 1, level: 1, heading: "Q3 Budget", chunks: 2 }],
    });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await outlineHandler(ctx, { path: "budget.md" });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.title, "Budget");
    assert.strictEqual(payload.sections.length, 1);
  });

  test("returns error when document not found", async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await outlineHandler(ctx, { path: "missing.md" });
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("No indexed document"));
  });
});

// =============================================================================
// contextHandler
// =============================================================================

describe("contextHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await contextHandler(makeCtx(false), { chunk_id: 5 });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns chunk context when found", async () => {
    const pool = mockPool({
      "docgraph_chunks c": [{ text: "Chunk text content", ord: 0, heading: "Section 1", rel_path: "doc.md", root_path: "/repo" }],
    });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await contextHandler(ctx, { chunk_id: 5 });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.text, "Chunk text content");
    assert.strictEqual(payload.heading, "Section 1");
  });

  test("returns error when chunk not found", async () => {
    const pool = mockPool({});
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await contextHandler(ctx, { chunk_id: 999 });
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("chunk_id=999"));
  });
});

// =============================================================================
// refsHandler
// =============================================================================

describe("refsHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await refsHandler(makeCtx(false), { ref: "https://example.com" });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns ref matches when found", async () => {
    // refs with no folder skips resolveRepoId; only 1 query runs.
    const pool = mockPool({
      "FROM docgraph_refs": [{ kind: "url", value: "https://example.com", section_id: 10, heading: "Links", rel_path: "doc.md", title: "Doc", mime: "text/markdown", root_path: "/repo" }],
    });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await refsHandler(ctx, { ref: "https://example.com" });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.ref, "https://example.com");
    assert.strictEqual(payload.matches.length, 1);
  });

  test("returns userFacing error when ref is missing", async () => {
    const pool = mockPool({});
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await refsHandler(ctx, {});
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("ref is required"));
  });
});

// =============================================================================
// deleteRepoHandler
// =============================================================================

describe("deleteRepoHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await deleteRepoHandler(makeCtx(false), { path: "/repo" });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("deletes repo when path provided", async () => {
    const pool = mockPool({
      "DELETE FROM docgraph_repos": [],
    });
    // Need rowCount > 0 for deleted: true. Override the default mock.
    pool.query = async () => ({ rows: [], rowCount: 1 });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await deleteRepoHandler(ctx, { path: "/repo/a" });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.deleted, true);
  });

  test("returns userFacing error when path is missing", async () => {
    const pool = mockPool({});
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await deleteRepoHandler(ctx, {});
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("path is required"));
  });

  test("returns error when backend throws", async () => {
    const pool = { query: async () => { throw new Error("delete failed"); } };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await deleteRepoHandler(ctx, { path: "/repo" });
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("delete failed"));
  });
});
