// tests/lib/handlers/data/dataHandlers.test.js
// Tests for data export/import handlers.
//
// The handlers use writeFileSync / readFileSync / existsSync (module-level fs
// imports), so we test via actual temp files — writing exports, reading them
// back, and cleaning up.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import logger from "../../../../lib/helpers/logger.js";
import { exportDataHandler, importDataHandler } from "../../../../lib/handlers/data/dataHandlers.js";

let tmpDir;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});

  tmpDir = mkdtempSync(join(tmpdir(), "aperio-data-test-"));
});

after(() => {
  mock.restoreAll();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

// ─── Mock ctx factories ──────────────────────────────────────────────────────

function mockCtx(overrides = {}) {
  return {
    store: {
      exportAll: async () => ({ memories: [], wiki_articles: [] }),
      importAll: async () => ({ imported: { memories: 0, wiki: 0 }, skipped: { memories: 0, wiki: 0 } }),
      ...overrides.store,
    },
    embeddingQueue: null,
    ...overrides,
  };
}

// =============================================================================
// exportDataHandler
// =============================================================================

describe("exportDataHandler", () => {
  test("exports data to the given output path", async () => {
    const outPath = join(tmpDir, "export-test.json");
    const ctx = mockCtx({
      store: {
        exportAll: async () => ({
          memories: [{ id: "m1", title: "Test", content: "Hello" }],
          wiki_articles: [{ slug: "w1", title: "Wiki", body_md: "# Content" }],
        }),
      },
    });

    const result = await exportDataHandler(ctx, { output_path: outPath });
    assert.ok(result.content[0].text.includes("Exported"));
    assert.ok(result.content[0].text.includes("1 memories"));
    assert.ok(result.content[0].text.includes("1 wiki articles"));

    // Verify the file was written correctly
    const raw = readFileSync(outPath, "utf8");
    const payload = JSON.parse(raw);
    assert.strictEqual(payload.aperio_export, 1);
    assert.ok(payload.exported_at);
    assert.strictEqual(payload.counts.memories, 1);
    assert.strictEqual(payload.memories[0].id, "m1");
    assert.strictEqual(payload.wiki_articles[0].slug, "w1");
  });

  test("handles empty data gracefully", async () => {
    const outPath = join(tmpDir, "empty-export.json");
    const ctx = mockCtx();

    const result = await exportDataHandler(ctx, { output_path: outPath });
    assert.ok(result.content[0].text.includes("0 memories"));
    assert.ok(result.content[0].text.includes("0 wiki articles"));

    const payload = JSON.parse(readFileSync(outPath, "utf8"));
    assert.strictEqual(payload.counts.memories, 0);
    assert.strictEqual(payload.memories.length, 0);
  });

  test("creates the file with valid JSON", async () => {
    const outPath = join(tmpDir, "valid-json.json");
    const ctx = mockCtx({
      store: {
        exportAll: async () => ({
          memories: [{ id: "m1", title: "T", content: "C" }],
          wiki_articles: [],
        }),
      },
    });

    await exportDataHandler(ctx, { output_path: outPath });
    // File must exist and be parseable
    assert.ok(existsSync(outPath));
    const payload = JSON.parse(readFileSync(outPath, "utf8"));
    assert.strictEqual(payload.aperio_export, 1);
    assert.strictEqual(payload.memories.length, 1);
    assert.strictEqual(payload.wiki_articles.length, 0);
  });

  test("forwards store.exportAll errors", async () => {
    const ctx = mockCtx({
      store: {
        exportAll: async () => { throw new Error("export failed"); },
      },
    });
    const outPath = join(tmpDir, "should-not-exist.json");
    await assert.rejects(
      () => exportDataHandler(ctx, { output_path: outPath }),
      /export failed/,
    );
  });
});

// =============================================================================
// importDataHandler
// =============================================================================

describe("importDataHandler", () => {
  function makeExportFile(data) {
    const p = join(tmpDir, "import-data.json");
    writeFileSync(p, JSON.stringify(data), "utf8");
    return p;
  }

  test("imports a valid export file", async () => {
    let captured;
    const ctx = mockCtx({
      store: {
        importAll: async (data) => {
          captured = data;
          return { imported: { memories: 2, wiki: 1 }, skipped: { memories: 0, wiki: 0 } };
        },
      },
    });
    const path = makeExportFile({
      aperio_export: 1,
      exported_at: "2026-01-01T00:00:00Z",
      counts: { memories: 2, wiki_articles: 1 },
      memories: [{ id: "m1", title: "M1", content: "One" }, { id: "m2", title: "M2", content: "Two" }],
      wiki_articles: [{ slug: "w1", title: "W1", body_md: "# Hello" }],
    });

    const result = await importDataHandler(ctx, { input_path: path });
    assert.ok(result.content[0].text.includes("Import complete"));
    assert.ok(result.content[0].text.includes("2 memories imported"));
    assert.strictEqual(captured.memories.length, 2);
    assert.strictEqual(captured.wiki_articles.length, 1);
  });

  test("returns error when file does not exist", async () => {
    const ctx = mockCtx();
    const result = await importDataHandler(ctx, { input_path: join(tmpDir, "nonexistent.json") });
    assert.ok(result.content[0].text.includes("File not found"));
  });

  test("returns error when file is not valid JSON", async () => {
    const p = join(tmpDir, "bad-json.json");
    writeFileSync(p, "not valid json{{{", "utf8");
    const ctx = mockCtx();
    const result = await importDataHandler(ctx, { input_path: p });
    assert.ok(result.content[0].text.includes("Could not parse"));
  });

  test("returns error when export file lacks aperio_export field", async () => {
    const path = makeExportFile({ memories: [], wiki_articles: [] });
    const ctx = mockCtx();
    const result = await importDataHandler(ctx, { input_path: path });
    assert.ok(result.content[0].text.includes("not a valid Aperio export file"));
  });

  test("returns error when export file lacks memories or wiki_articles", async () => {
    const path = makeExportFile({ aperio_export: 1 });
    const ctx = mockCtx();
    const result = await importDataHandler(ctx, { input_path: path });
    assert.ok(result.content[0].text.includes("not a valid Aperio export file"));
  });

  test("enqueues embeddings when embeddingQueue is provided", async () => {
    const queued = [];
    const ctx = mockCtx({
      store: {
        importAll: async () => ({ imported: { memories: 1, wiki: 0 }, skipped: { memories: 0, wiki: 0 } }),
      },
      embeddingQueue: {
        enqueue: (id, text) => { queued.push({ id, text }); },
      },
    });
    const path = makeExportFile({
      aperio_export: 1,
      exported_at: "2026-01-01T00:00:00Z",
      counts: { memories: 1, wiki_articles: 0 },
      memories: [{ id: "m1", title: "My Memory", content: "Content here" }],
      wiki_articles: [],
    });

    const result = await importDataHandler(ctx, { input_path: path });
    assert.ok(result.content[0].text.includes("1 embeddings queued"));
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(queued[0].id, "m1");
    assert.ok(queued[0].text.includes("My Memory"));
  });

  test("skips embedding queue when no memories were imported", async () => {
    let enqueued = false;
    const ctx = mockCtx({
      store: {
        importAll: async () => ({ imported: { memories: 0, wiki: 0 }, skipped: { memories: 0, wiki: 0 } }),
      },
      embeddingQueue: {
        enqueue: () => { enqueued = true; },
      },
    });
    const path = makeExportFile({
      aperio_export: 1,
      exported_at: "2026-01-01T00:00:00Z",
      counts: { memories: 0, wiki_articles: 0 },
      memories: [],
      wiki_articles: [],
    });

    await importDataHandler(ctx, { input_path: path });
    assert.strictEqual(enqueued, false);
  });

  test("forwards store.importAll errors", async () => {
    const ctx = mockCtx({
      store: {
        importAll: async () => { throw new Error("import crashed"); },
      },
    });
    const path = makeExportFile({
      aperio_export: 1,
      exported_at: "2026-01-01T00:00:00Z",
      counts: { memories: 1, wiki_articles: 0 },
      memories: [{ id: "m1", title: "T", content: "C" }],
      wiki_articles: [],
    });

    await assert.rejects(
      () => importDataHandler(ctx, { input_path: path }),
      /import crashed/,
    );
  });
});
