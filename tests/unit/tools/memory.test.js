// tests/tools/memory.test.js
// Tests for all memory tool handlers:
// rememberHandler, recallHandler, updateMemoryHandler,
// forgetHandler, backfillHandler, dedupHandler.
// Imports directly from mcp/tools/memory.js — no inline copies.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  rememberHandler,
  recallHandler,
  updateMemoryHandler,
  forgetHandler,
  backfillHandler,
  dedupHandler,
  takeRedactionMap,
} from "../../../lib/handlers/memory/memoryHandlers.js";
import { restore } from "../../../lib/privacy/redact.js";

// ─── ctx / store factories ────────────────────────────────────────────────────

function makeMemory(overrides = {}) {
  return {
    id:         "aaaaaaaa-0000-0000-0000-000000000001",
    type:       "fact",
    title:      "Test title",
    content:    "Test content",
    tags:       ["testing"],
    importance: 3,
    tier:       1,
    source:     "claude",
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    insert:               async (data) => ({ ...makeMemory(), ...data }),
    recall:               async () => [],
    getById:              async () => makeMemory(),
    update:               async (id, input) => ({ ...makeMemory(), ...input }),
    delete:               async () => "Test title",
    listWithoutEmbeddings: async () => [],
    setEmbedding:         async () => {},
    findDuplicates:       async () => [],
    mergeDuplicate:       async () => {},
    ...overrides,
  };
}

function makeCtx(storeOverrides = {}, { vectorOn = true } = {}) {
  return {
    store:            makeStore(storeOverrides),
    generateEmbedding: async () => [0.1, 0.2, 0.3],
    vectorEnabled:    () => vectorOn,
  };
}

// ─── rememberHandler ─────────────────────────────────────────────────────────

describe("rememberHandler", () => {
  test("saves a memory and returns confirmation with id", async () => {
    const ctx = makeCtx();
    const result = await rememberHandler(ctx, {
      type: "fact", title: "Sky color", content: "The sky is blue.",
    });
    const text = result.content[0].text;
    assert.ok(text.includes("✅ Memory saved"));
    assert.ok(text.includes("[fact]"));
    assert.ok(text.includes("Sky color"));
  });

  test("includes semantic embedding note when embedding is generated", async () => {
    const ctx = makeCtx();
    const result = await rememberHandler(ctx, {
      type: "fact", title: "T", content: "C",
    });
    assert.ok(result.content[0].text.includes("with semantic embedding"));
  });

  test("omits embedding note when generateEmbedding returns null", async () => {
    const ctx = { ...makeCtx(), generateEmbedding: async () => null };
    const result = await rememberHandler(ctx, { type: "fact", title: "T", content: "C" });
    assert.ok(!result.content[0].text.includes("semantic embedding"));
  });

  test("forwards tags and importance to store", async () => {
    let received;
    const ctx = makeCtx({ insert: async (data) => { received = data; return makeMemory(data); } });
    await rememberHandler(ctx, {
      type: "preference", title: "T", content: "C", tags: ["a", "b"], importance: 5,
    });
    assert.deepEqual(received.tags, ["a", "b"]);
    assert.equal(received.importance, 5);
  });

  test("defaults type to 'fact' when omitted (weak models skip it)", async () => {
    let received;
    const ctx = makeCtx({ insert: async (data) => { received = data; return makeMemory(data); } });
    const result = await rememberHandler(ctx, { title: "Meeting", content: "tonight at 21:00" });
    assert.equal(received.type, "fact");
    assert.match(result.content[0].text, /Memory saved \[fact\]/);
  });
});

// ─── recallHandler ────────────────────────────────────────────────────────────

describe("recallHandler", () => {
  test("returns 'No memories found' when store returns empty", async () => {
    const result = await recallHandler(makeCtx(), { query: "anything" });
    assert.ok(result.content[0].text.includes("No memories found"));
  });

  test("formats and returns memories when rows exist", async () => {
    const ctx = makeCtx({
      recall: async () => [makeMemory({ similarity: 0.95 })],
    });
    const result = await recallHandler(ctx, { query: "test" });
    const text = result.content[0].text;
    assert.ok(text.includes("[FACT]"));
    assert.ok(text.includes("Test title"));
    assert.ok(text.includes("95.0%"));
    assert.ok(text.includes("testing"));
  });

  test("skips embedding when vectorEnabled is false", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore({ recall: async () => [] }),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => false,
    };
    await recallHandler(ctx, { query: "test" });
    assert.equal(embeddingCalled, false);
  });

  test("skips embedding when search_mode is fulltext", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore({ recall: async () => [] }),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => true,
    };
    await recallHandler(ctx, { query: "test", search_mode: "fulltext" });
    assert.equal(embeddingCalled, false);
  });

  test("applies default limit of 10 when not specified", async () => {
    let capturedLimit;
    const ctx = makeCtx({ recall: async ({ limit }) => { capturedLimit = limit; return []; } });
    await recallHandler(ctx, {});
    assert.equal(capturedLimit, 10);
  });

  test("formats rows without similarity score (full-text path)", async () => {
    const ctx = makeCtx({
      recall: async () => [makeMemory()], // no similarity field
    });
    const result = await recallHandler(ctx, { query: "test", search_mode: "fulltext" });
    assert.ok(!result.content[0].text.includes("similarity"));
  });

  test("no-query recall appends a preview footer when more memories exist", async () => {
    const ctx = makeCtx({
      recall: async () => [makeMemory()],            // 1 row returned
      counts: async () => ({ total: 70, embedded: 65, current: 67 }),
    });
    const text = (await recallHandler(ctx, { limit: 5 })).content[0].text;
    assert.ok(text.includes("Preview only: showing the 1 highest-priority of 67"),
      "footer must report shown-of-total so the model knows the listing is partial");
  });

  test("no footer when a query is supplied (semantic search, not core-context load)", async () => {
    const ctx = makeCtx({
      recall: async () => [makeMemory()],
      counts: async () => ({ total: 70, embedded: 65, current: 67 }),
    });
    const text = (await recallHandler(ctx, { query: "meeting", limit: 5 })).content[0].text;
    assert.ok(!text.includes("Preview only"), "query recalls already search the full store");
  });

  test("no footer when the returned rows are the whole store", async () => {
    const ctx = makeCtx({
      recall: async () => [makeMemory(), makeMemory({ id: "b" })],
      counts: async () => ({ total: 2, embedded: 2, current: 2 }),
    });
    const text = (await recallHandler(ctx, { limit: 5 })).content[0].text;
    assert.ok(!text.includes("Preview only"));
  });

  // PRIVACY-01 — local-only tag filtering by provider locality
  const taggedRows = () => [
    makeMemory({ id: "pub", title: "Public note", tags: ["work"], tier: 1 }),
    makeMemory({ id: "sec", title: "Secret note", tags: ["Local-Only"], tier: 2 }),
  ];

  test("cloud provider hides memories tagged local-only", async () => {
    const ctx = { ...makeCtx({ recall: async () => taggedRows() }), providerIsLocal: false };
    const text = (await recallHandler(ctx, { query: "x" })).content[0].text;
    assert.ok(text.includes("Public note"));
    assert.ok(!text.includes("Secret note"), "local-only memory must not reach a cloud model");
  });

  test("local provider surfaces local-only memories", async () => {
    const ctx = { ...makeCtx({ recall: async () => taggedRows() }), providerIsLocal: true };
    const text = (await recallHandler(ctx, { query: "x" })).content[0].text;
    assert.ok(text.includes("Public note") && text.includes("Secret note"));
  });

  test("absent providerIsLocal defaults to surfacing everything (back-compat)", async () => {
    const ctx = makeCtx({ recall: async () => taggedRows() }); // no providerIsLocal
    const text = (await recallHandler(ctx, { query: "x" })).content[0].text;
    assert.ok(text.includes("Secret note"));
  });

  test("filtering everything out returns the empty message", async () => {
    const ctx = {
      ...makeCtx({ recall: async () => [makeMemory({ tags: ["local-only"], tier: 2 })] }),
      providerIsLocal: false,
    };
    const text = (await recallHandler(ctx, { query: "x" })).content[0].text;
    assert.equal(text, "No memories found.");
  });

  // Issue #531 — redact mode must hand back a restore()-able map, not just
  // scrub the outgoing text. This is the *response path* half of the fix
  // (lib/agent/index.js + tool-hooks.js restore() using this map); this
  // block only pins recallHandler's own contract.
  describe("redact mode (APERIO_CLOUD_SENSITIVE_MODE=redact)", () => {
    let previousMode;
    test.beforeEach(() => { previousMode = process.env.APERIO_CLOUD_SENSITIVE_MODE; process.env.APERIO_CLOUD_SENSITIVE_MODE = "redact"; });
    test.afterEach(() => {
      if (previousMode === undefined) delete process.env.APERIO_CLOUD_SENSITIVE_MODE;
      else process.env.APERIO_CLOUD_SENSITIVE_MODE = previousMode;
    });

    // Review round 2, P1: the public CallToolResult (what a standalone
    // cloud-backed MCP client — Claude Desktop, Cursor, … — receives
    // verbatim) must never carry the actual redaction map, only an opaque
    // lookup id. The real map is fetched separately via takeRedactionMap(),
    // exactly as mcp/index.js's "aperio/takeRedactionMap" side channel does
    // for the real agent.
    test("tier-2 content is scrubbed in the outgoing text; the public result carries only an opaque correlation id, never the map", async () => {
      const ctx = {
        ...makeCtx({ recall: async () => [makeMemory({ tier: 2, content: "call me at alice@example.com" })] }),
        providerIsLocal: false,
      };
      const result = await recallHandler(ctx, { query: "x" });
      const text = result.content[0].text;
      assert.ok(!text.includes("alice@example.com"), "raw PII must not reach a cloud model");
      assert.ok(/«[0-9a-f-]{36}_0_EMAIL_0»/.test(text), "a placeholder token must stand in for it");

      const sc = result.structuredContent;
      assert.equal(typeof sc.redactionCorrelationId, "string");
      assert.equal(sc.redactionMap, undefined, "the actual map must never be in the public result");
      assert.equal(JSON.stringify(result).includes("alice@example.com"), false,
        "no raw PII anywhere in the serialized public result");

      const map = new Map(Object.entries(takeRedactionMap(sc.redactionCorrelationId)));
      assert.ok(restore(text, map).includes("call me at alice@example.com"),
        "restore() using the redeemed map must reproduce the original content");
    });

    test("the correlation id is single-use — redeeming it twice returns null the second time", async () => {
      const ctx = {
        ...makeCtx({ recall: async () => [makeMemory({ tier: 2, content: "alice@example.com" })] }),
        providerIsLocal: false,
      };
      const { structuredContent } = await recallHandler(ctx, { query: "x" });
      assert.ok(takeRedactionMap(structuredContent.redactionCorrelationId), "first redemption succeeds");
      assert.equal(takeRedactionMap(structuredContent.redactionCorrelationId), null,
        "a replayed/leaked id must be worthless the second time");
    });

    test("an unknown correlation id redeems to null", () => {
      assert.equal(takeRedactionMap("not-a-real-id"), null);
    });

    test("two rows in ONE recall call do not collide on the same placeholder token", async () => {
      const ctx = {
        ...makeCtx({
          recall: async () => [
            makeMemory({ id: "a", tier: 2, content: "alice@example.com" }),
            makeMemory({ id: "b", tier: 2, content: "bob@example.com" }),
          ],
        }),
        providerIsLocal: false,
      };
      const result = await recallHandler(ctx, { query: "x" });
      const map = new Map(Object.entries(takeRedactionMap(result.structuredContent.redactionCorrelationId)));
      assert.equal(map.size, 2, "both rows' tokens must survive the merge, not overwrite each other");

      const restored = restore(result.content[0].text, map);
      assert.ok(restored.includes("alice@example.com"));
      assert.ok(restored.includes("bob@example.com"));
    });

    // Review round 2, P2: the model can call recall more than once in the
    // same turn. Each call independently restarts its own row index at 0,
    // so two SEPARATE calls used to be able to mint the identical token
    // (e.g. «0_EMAIL_0» from both) — the agent loop merges every call's map
    // into one turn-wide Map via .set(), so the second call would silently
    // clobber the first entry and both placeholders would restore to the
    // wrong email. Each call now gets its own random correlation id woven
    // into every token it mints, so no two calls can ever collide.
    test("two SEPARATE recall calls in the same turn mint non-colliding tokens", async () => {
      const ctx = {
        ...makeCtx({ recall: async () => [makeMemory({ id: "a", tier: 2, content: "alice@example.com" })] }),
        providerIsLocal: false,
      };
      const first = await recallHandler(ctx, { query: "x" });
      const second = await recallHandler(ctx, { query: "y" }); // same shape — same row idx (0), different call

      assert.notEqual(first.structuredContent.redactionCorrelationId, second.structuredContent.redactionCorrelationId);

      const [firstToken] = Object.keys(takeRedactionMap(first.structuredContent.redactionCorrelationId));
      const [secondToken] = Object.keys(takeRedactionMap(second.structuredContent.redactionCorrelationId));
      assert.notEqual(firstToken, secondToken, "identical row shape across two calls must not mint the same token");

      // Simulate the agent loop's turn-wide merge (tool-hooks.js) — both
      // entries must survive, not overwrite each other.
      const turnMap = new Map();
      turnMap.set(firstToken, "alice@example.com");
      turnMap.set(secondToken, "alice@example.com"); // same original value here, but a DIFFERENT key
      assert.equal(turnMap.size, 2);
    });

    test("withhold mode (default) attaches no structuredContent — nothing to restore", async () => {
      process.env.APERIO_CLOUD_SENSITIVE_MODE = "withhold";
      const ctx = {
        ...makeCtx({ recall: async () => [makeMemory({ tier: 1, content: "plain note" })] }),
        providerIsLocal: false,
      };
      const result = await recallHandler(ctx, { query: "x" });
      assert.equal(result.structuredContent, undefined);
    });

    // Review round 3, P2: a lazy "prune on next read" sweep never fires for
    // an entry nobody ever reads again (a standalone client that ignores the
    // id, or the agent crashing before it asks) — the map would then hold
    // real PII forever. Each entry now schedules its OWN deletion at
    // insertion time, so it disappears on its own even with zero reads.
    test("an abandoned correlation id is actively expired after its TTL — never redeemed, no other read triggers it", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const ctx = {
        ...makeCtx({ recall: async () => [makeMemory({ tier: 2, content: "alice@example.com" })] }),
        providerIsLocal: false,
      };
      const { structuredContent } = await recallHandler(ctx, { query: "x" });

      t.mock.timers.tick(20 * 60_000); // the full TTL, with nothing else ever calling takeRedactionMap

      assert.equal(
        takeRedactionMap(structuredContent.redactionCorrelationId), null,
        "the scheduled expiry must have deleted it on its own — proactive, not contingent on some other read"
      );
    });

    test("redeeming before the TTL cancels the scheduled expiry — no dangling timer fires later", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const ctx = {
        ...makeCtx({ recall: async () => [makeMemory({ tier: 2, content: "alice@example.com" })] }),
        providerIsLocal: false,
      };
      const { structuredContent } = await recallHandler(ctx, { query: "x" });

      const map = takeRedactionMap(structuredContent.redactionCorrelationId);
      assert.ok(map, "redeeming well within the TTL must succeed");

      // The expiry timer firing later (against an already-redeemed, already-
      // deleted file) must not throw or otherwise misbehave.
      assert.doesNotThrow(() => t.mock.timers.tick(20 * 60_000));
    });
  });
});

// ─── updateMemoryHandler ──────────────────────────────────────────────────────

describe("updateMemoryHandler", () => {
  test("returns error when memory id does not exist", async () => {
    const ctx = makeCtx({ getById: async () => null });
    const result = await updateMemoryHandler(ctx, { id: "missing-id", title: "X" });
    assert.ok(result.content[0].text.includes("❌ No memory found"));
  });

  test("returns error when no fields are provided", async () => {
    const result = await updateMemoryHandler(makeCtx(), { id: "some-id" });
    assert.ok(result.content[0].text.includes("❌ No fields to update"));
  });

  test("updates title and returns confirmation", async () => {
    const result = await updateMemoryHandler(makeCtx(), {
      id: "some-id", title: "New title",
    });
    assert.ok(result.content[0].text.includes("✅ Updated"));
    assert.ok(result.content[0].text.includes("New title"));
  });

  test("updates content and regenerates embedding when vectorEnabled", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore(),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => true,
    };
    await updateMemoryHandler(ctx, { id: "id", content: "Updated content" });
    assert.equal(embeddingCalled, true);
  });

  test("does not regenerate embedding when vectorEnabled is false", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore(),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => false,
    };
    await updateMemoryHandler(ctx, { id: "id", content: "Updated" });
    assert.equal(embeddingCalled, false);
  });

  test("updates tags and importance without regenerating embedding", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore(),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => true,
    };
    await updateMemoryHandler(ctx, { id: "id", tags: ["new"], importance: 4 });
    assert.equal(embeddingCalled, false);
  });
});

// ─── forgetHandler ────────────────────────────────────────────────────────────

describe("forgetHandler", () => {
  test("returns confirmation when memory is deleted", async () => {
    const result = await forgetHandler(makeCtx(), { id: "some-id" });
    assert.ok(result.content[0].text.includes("🗑️ Forgotten"));
    assert.ok(result.content[0].text.includes("Test title"));
  });

  test("returns error when memory id does not exist", async () => {
    const ctx = makeCtx({ delete: async () => null });
    const result = await forgetHandler(ctx, { id: "missing-id" });
    assert.ok(result.content[0].text.includes("❌ No memory found"));
  });
});

// ─── backfillHandler ─────────────────────────────────────────────────────────

describe("backfillHandler", () => {
  test("returns error when vector search is not enabled", async () => {
    const ctx = makeCtx({}, { vectorOn: false });
    const result = await backfillHandler(ctx, {});
    assert.ok(result.content[0].text.includes("❌ Vector search not enabled"));
  });

  test("returns success when no pending memories exist", async () => {
    const result = await backfillHandler(makeCtx(), {});
    assert.ok(result.content[0].text.includes("✅ All memories already have embeddings"));
  });

  test("embeds pending memories and reports success count", async () => {
    const pending = [
      { id: "1", title: "A", content: "Content A" },
      { id: "2", title: "B", content: "Content B" },
    ];
    const ctx = makeCtx({ listWithoutEmbeddings: async () => pending });
    const result = await backfillHandler(ctx, { limit: 10 });
    const text = result.content[0].text;
    assert.ok(text.includes("✅ Backfill complete"));
    assert.ok(text.includes("2 embedded"));
    assert.ok(text.includes("0 failed"));
  });

  test("counts failed embeddings when generateEmbedding returns null", async () => {
    const pending = [{ id: "1", title: "A", content: "C" }];
    const ctx = {
      store: makeStore({ listWithoutEmbeddings: async () => pending }),
      generateEmbedding: async () => null,
      vectorEnabled: () => true,
    };
    const result = await backfillHandler(ctx, {});
    assert.ok(result.content[0].text.includes("1 failed"));
    assert.ok(result.content[0].text.includes("0 embedded"));
  });

  test("respects limit and slices pending list", async () => {
    const pending = Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: "T", content: "C" }));
    let processed = 0;
    const ctx = {
      store: makeStore({
        listWithoutEmbeddings: async () => pending,
        setEmbedding: async () => { processed++; },
      }),
      generateEmbedding: async () => [0.1],
      vectorEnabled: () => true,
    };
    await backfillHandler(ctx, { limit: 3 });
    assert.equal(processed, 3);
  });
});

// ─── dedupHandler ─────────────────────────────────────────────────────────────

describe("dedupHandler", () => {
  test("returns error when vector search is not enabled", async () => {
    const ctx = makeCtx({}, { vectorOn: false });
    const result = await dedupHandler(ctx, {});
    assert.ok(result.content[0].text.includes("❌ Vector search not enabled"));
  });

  test("returns success message when no duplicates found", async () => {
    const result = await dedupHandler(makeCtx(), { threshold: 0.97 });
    assert.ok(result.content[0].text.includes("✅ No duplicates found"));
    assert.ok(result.content[0].text.includes("97%"));
  });

  test("reports duplicate pairs in dry_run mode without merging", async () => {
    const pairs = [{
      similarity: 0.99, id_a: "1", id_b: "2",
      type_a: "fact", type_b: "fact",
      title_a: "Same A", title_b: "Same B",
    }];
    const ctx = makeCtx({ findDuplicates: async () => pairs });
    const result = await dedupHandler(ctx, { dry_run: true });
    const text = result.content[0].text;
    assert.ok(text.includes("99.0% similar"));
    assert.ok(text.includes("Same A"));
    assert.ok(text.includes("Same B"));
    assert.ok(text.includes("dry_run=false"));
  });

  test("merges duplicates when dry_run is false", async () => {
    let mergedPair;
    const pairs = [{
      similarity: 0.99, id_a: "1", id_b: "2",
      type_a: "fact", type_b: "fact",
      title_a: "Dup A", title_b: "Dup B",
    }];
    const ctx = makeCtx({
      findDuplicates: async () => pairs,
      mergeDuplicate: async (a, b) => { mergedPair = [a, b]; },
    });
    const result = await dedupHandler(ctx, { dry_run: false });
    assert.ok(result.content[0].text.includes("🧹 Merged 1"));
    assert.deepEqual(mergedPair, ["1", "2"]);
  });
});