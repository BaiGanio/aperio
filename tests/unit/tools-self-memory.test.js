// tests/mcp/tools/self-memory.test.js
// Tests for the self-memory handlers (the agent's own walled-off store):
// selfRememberHandler, selfRecallHandler, selfUpdateHandler, selfForgetHandler.
// Imports directly from the handler module — no MCP server boot.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  selfRememberHandler,
  selfRecallHandler,
  selfUpdateHandler,
  selfForgetHandler,
} from "../../../lib/handlers/memory/selfMemoryHandlers.js";

function makeSelf(overrides = {}) {
  return {
    id:         "bbbbbbbb-0000-0000-0000-000000000001",
    title:      "Work terse here",
    content:    "Keep replies short.",
    tags:       ["style"],
    importance: 4,
    source:     "self",
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    insertSelf:  async (data) => ({ ...makeSelf(), ...data }),
    recallSelf:  async () => [],
    getSelfById: async () => makeSelf(),
    updateSelf:  async (id, input) => ({ ...makeSelf(), ...input }),
    deleteSelf:  async () => "Work terse here",
    ...overrides,
  };
}

function makeCtx(storeOverrides = {}, { vectorOn = true, local = true } = {}) {
  return {
    store:             makeStore(storeOverrides),
    generateEmbedding: async () => [0.1, 0.2, 0.3],
    vectorEnabled:     () => vectorOn,
    providerIsLocal:   local,
  };
}

const text = (r) => r.content[0].text;

// ─── selfRememberHandler ──────────────────────────────────────────────────────
describe("selfRememberHandler", () => {
  test("saves a self-memory and returns confirmation with id", async () => {
    const result = await selfRememberHandler(makeCtx(), { title: "T", content: "C" });
    assert.ok(text(result).includes("🧠 Self-memory saved"));
    assert.ok(text(result).includes("id:"));
  });

  test("notes when an embedding is generated", async () => {
    const result = await selfRememberHandler(makeCtx(), { title: "T", content: "C" });
    assert.ok(text(result).includes("with semantic embedding"));
  });

  test("derives a title from content when title is omitted (weak-model path)", async () => {
    let received;
    const ctx = makeCtx({ insertSelf: async (d) => { received = d; return makeSelf(d); } });
    const out = await selfRememberHandler(ctx, { content: "Keep my answers terse from now on." });
    assert.equal(received.title, "Keep my answers terse from now on.");
    assert.ok(text(out).includes("🧠 Self-memory saved"));
  });

  test("derived title is capped at 60 chars / first line", async () => {
    let received;
    const ctx = makeCtx({ insertSelf: async (d) => { received = d; return makeSelf(d); } });
    await selfRememberHandler(ctx, { content: "x".repeat(200) });
    assert.equal(received.title.length, 60);
  });

  test("forwards tags and importance to the store", async () => {
    let received;
    const ctx = makeCtx({ insertSelf: async (d) => { received = d; return makeSelf(d); } });
    await selfRememberHandler(ctx, { title: "T", content: "C", tags: ["a", "b"], importance: 5 });
    assert.deepEqual(received.tags, ["a", "b"]);
    assert.equal(received.importance, 5);
  });
});

// ─── selfRecallHandler ────────────────────────────────────────────────────────
describe("selfRecallHandler", () => {
  test("formats rows without a [TYPE] prefix", async () => {
    const ctx = makeCtx({ recallSelf: async () => [makeSelf({ similarity: 0.9 })] });
    const out = text(await selfRecallHandler(ctx, { query: "terse" }));
    assert.ok(out.includes("Work terse here"));
    assert.ok(out.includes("ID: bbbbbbbb-0000-0000-0000-000000000001"));
    assert.ok(!/\[FACT\]|\[PREFERENCE\]/.test(out));
  });

  test("returns a friendly message when empty", async () => {
    const out = text(await selfRecallHandler(makeCtx(), { query: "nothing" }));
    assert.equal(out, "No self-memories yet.");
  });

  test("no-query listing omits the similarity note", async () => {
    const ctx = makeCtx({ recallSelf: async () => [makeSelf({ similarity: 1.0 })] });
    const out = text(await selfRecallHandler(ctx, {}));
    assert.ok(!out.includes("similarity"));
  });
});

// ─── selfUpdateHandler ────────────────────────────────────────────────────────
describe("selfUpdateHandler", () => {
  test("updates and confirms", async () => {
    const out = text(await selfUpdateHandler(makeCtx(), { id: "x", importance: 2 }));
    assert.ok(out.includes("✅ Updated self-memory"));
  });

  test("errors when the id is unknown", async () => {
    const ctx = makeCtx({ getSelfById: async () => null });
    const out = text(await selfUpdateHandler(ctx, { id: "missing", title: "x" }));
    assert.ok(out.includes("❌ No self-memory found"));
  });

  test("errors when no fields are provided", async () => {
    const out = text(await selfUpdateHandler(makeCtx(), { id: "x" }));
    assert.ok(out.includes("No fields to update"));
  });
});

// ─── selfForgetHandler ────────────────────────────────────────────────────────
describe("selfForgetHandler", () => {
  test("deletes and confirms", async () => {
    const out = text(await selfForgetHandler(makeCtx(), { id: "x" }));
    assert.ok(out.includes("🗑️ Forgotten (self)"));
  });

  test("errors when the id is unknown", async () => {
    const ctx = makeCtx({ deleteSelf: async () => null });
    const out = text(await selfForgetHandler(ctx, { id: "missing" }));
    assert.ok(out.includes("❌ No self-memory found"));
  });
});

// ─── cloud gate (option (a): strict local-only) ───────────────────────────────
describe("cloud provider gets zero self-memory surface", () => {
  const cloud = (over = {}) => makeCtx(over, { local: false });

  test("self_remember refuses and never calls the store", async () => {
    let called = false;
    const ctx = cloud({ insertSelf: async () => { called = true; return makeSelf(); } });
    const out = text(await selfRememberHandler(ctx, { title: "secret", content: "leaked?" }));
    assert.ok(out.includes("🔒"));
    assert.equal(called, false);
  });

  test("self_recall refuses and never reads the store (no leak)", async () => {
    let called = false;
    const ctx = cloud({ recallSelf: async () => { called = true; return [makeSelf()]; } });
    const out = text(await selfRecallHandler(ctx, { query: "terse" }));
    assert.ok(out.includes("🔒"));
    assert.ok(!out.includes("Keep replies short"));
    assert.equal(called, false);
  });

  test("self_update refuses on cloud", async () => {
    const out = text(await selfUpdateHandler(cloud(), { id: "x", title: "y" }));
    assert.ok(out.includes("🔒"));
  });

  test("self_forget refuses on cloud", async () => {
    const out = text(await selfForgetHandler(cloud(), { id: "x" }));
    assert.ok(out.includes("🔒"));
  });
});
