// T2.8 - the update, forget and list tools (spec S2.8 §2, §3).
//
// Ported from v1 tests/unit/tools/memory.test.js (updateMemoryHandler,
// forgetHandler, recall no-query footer) at archive/v1-final, cut to v2 scope:
// no MCP envelope, no embedding queue, no tags / importance args. v2 change:
// update keeps the id (v1 gave a new id, so seen ids went stale).
// A real in-memory store and a fake 64-dim hash embedder, as in memory-tools.test.js.

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../../src/store/open-store.js';
import { rememberTool, recallTool, updateTool, forgetTool, listTool } from '../../src/tools/memory-tools.js';

const DIMS = 64;
const SIG = 'fake|64|test';
const CONFIG = Object.freeze({ REMEMBER_DUP_SCORE: 80, RECALL_TOP_K: 5, LIST_LIMIT: 20 });
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });
const MISSING = '00000000-0000-4000-8000-000000000000';

function vectorFor(text) {
  const bytes = createHash('sha512').update(String(text)).digest();
  const v = Array.from({ length: DIMS }, (_, i) => bytes[i % bytes.length] - 127.5 + i * 0.01);
  const norm = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / norm));
}
const fakeEmbedder = () => {
  const embed = mock.fn(async (t) => vectorFor(t));
  return { sig: SIG, dims: DIMS, embed, embedQuery: embed };
};

async function setup({ embedder = fakeEmbedder() } = {}) {
  const store = await openStore({ path: ':memory:', dims: DIMS, log: quiet() });
  const log = quiet();
  return { store, ctx: { store, embedder, config: CONFIG, log }, log, embedder };
}
async function saved(ctx, content, extra = {}) {
  const r = await rememberTool.run({ content, ...extra }, ctx);
  assert.equal(r.ok, true);
  return r.id;
}

describe('recall gives ids', () => {
  test('each hit carries the memory id, so the model can update or forget it', async () => {
    const { store, ctx } = await setup();
    const id = await saved(ctx, 'My dentist is Dr. Ivanova.');
    const r = await recallTool.run({ query: 'My dentist is Dr. Ivanova.' }, ctx);
    assert.equal(r.memories[0].id, id);
    assert.deepEqual(Object.keys(r.memories[0]).sort(), ['content', 'date', 'id', 'title']);
    await store.close();
  });
});

describe('update', () => {
  test('unknown or missing id -> ok: false; the hint says to find the id with recall or list', async () => {
    const { store, ctx } = await setup();
    for (const args of [{ id: MISSING, content: 'x is y.' }, { content: 'x is y.' }, { id: '', title: 't' }, null]) {
      const r = await updateTool.run(args, ctx);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.match(r.error, /id/);
      assert.match(r.error, /recall or list/);
    }
    await store.close();
  });

  test('no field to change -> ok: false naming the fields; the row is unchanged', async () => {
    const { store, ctx } = await setup();
    const id = await saved(ctx, 'My dentist is Dr. Ivanova.');
    const r = await updateTool.run({ id }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.error, /content, title, type/);
    assert.equal((await store.getById(id)).content, 'My dentist is Dr. Ivanova.');
    await store.close();
  });

  test('a title change keeps the id; the old text goes to history', async () => {
    const { store, ctx } = await setup();
    const id = await saved(ctx, 'My dentist is Dr. Ivanova.', { title: 'Dentist' });
    const r = await updateTool.run({ id, title: 'My dentist' }, ctx);
    assert.deepEqual(r, { ok: true, id, message: 'Updated.' });
    assert.equal((await store.getById(id)).title, 'My dentist');
    assert.equal((await store.history(id))[0].title, 'Dentist');
    await store.close();
  });

  test('a content change re-embeds: the new text is found by meaning, the vector stays signed', async () => {
    const { store, ctx, embedder } = await setup();
    const id = await saved(ctx, 'My dentist is Dr. Ivanova.');
    const before = embedder.embed.mock.callCount();
    await updateTool.run({ id, content: 'My dentist is Dr. Georgiev now.' }, ctx);
    assert.equal(embedder.embed.mock.callCount(), before + 1);
    assert.deepEqual(await store.counts(), { total: 1, embedded: 1 });
    const r = await recallTool.run({ query: 'My dentist is Dr. Georgiev now.' }, ctx);
    assert.equal(r.memories[0].id, id);
    await store.close();
  });

  test('only a type change -> no re-embed', async () => {
    const { store, ctx, embedder } = await setup();
    const id = await saved(ctx, 'Maya prefers written updates.');
    const before = embedder.embed.mock.callCount();
    const r = await updateTool.run({ id, type: 'preference' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(embedder.embed.mock.callCount(), before);
    assert.equal((await store.getById(id)).type, 'preference');
    await store.close();
  });

  test('a bad type -> ok: false naming the field and the allowed values; nothing changed', async () => {
    const { store, ctx } = await setup();
    const id = await saved(ctx, 'Priya leads Beacon.');
    const r = await updateTool.run({ id, type: 'gossip' }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.error, /type/);
    assert.match(r.error, /fact/);
    assert.equal((await store.getById(id)).type, 'fact');
    await store.close();
  });

  test('embedder fails on new content -> updated, the stale vector is removed, one warn (the reindex fills it)', async () => {
    const { store, ctx, embedder } = await setup();
    const id = await saved(ctx, 'My dentist is Dr. Ivanova.');
    embedder.embed.mock.mockImplementation(async () => { throw new Error('model gone'); });
    const r = await updateTool.run({ id, content: 'My dentist is Dr. Georgiev now.' }, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(await store.counts(), { total: 1, embedded: 0 });
    assert.equal(ctx.log.warn.mock.callCount(), 1);
    await store.close();
  });

  test('a secret in new content or title is refused: row unchanged, secret not repeated or logged', async () => {
    const secret = 'sk-proj-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c';
    for (const field of ['content', 'title']) {
      const { store, ctx, log } = await setup();
      const id = await saved(ctx, 'My dentist is Dr. Ivanova.');
      const r = await updateTool.run({ id, [field]: `My key is ${secret}.` }, ctx);
      assert.equal(r.ok, false, field);
      assert.match(r.error, /secret/i);
      assert.ok(!JSON.stringify(r).includes(secret));
      assert.ok(!JSON.stringify([log.error, log.warn, log.info].flatMap((f) => f.mock.calls.map((c) => c.arguments))).includes(secret));
      assert.equal((await store.getById(id)).content, 'My dentist is Dr. Ivanova.');
      assert.deepEqual(await store.history(id), []);
      await store.close();
    }
  });

  test('a store error throws: the tool loop turns it into ok: false (AP5)', async () => {
    const { store: real, ctx } = await setup();
    const id = await saved(ctx, 'My dentist is Dr. Ivanova.');
    const store = { ...real, update: async () => { throw new Error('disk full'); } };
    await assert.rejects(updateTool.run({ id, title: 'Dentist' }, { ...ctx, store }), /disk full/);
    await real.close();
  });
});

describe('forget', () => {
  test('deletes the row, its vector and its history; returns the title (L-C13)', async () => {
    const { store, ctx } = await setup();
    const id = await saved(ctx, 'My dentist is Dr. Ivanova.', { title: 'Dentist' });
    await updateTool.run({ id, title: 'My dentist' }, ctx);
    const r = await forgetTool.run({ id }, ctx);
    assert.deepEqual(r, { ok: true, id, message: 'Forgotten: "My dentist".' });
    assert.equal(await store.getById(id), null);
    assert.deepEqual(await store.counts(), { total: 0, embedded: 0 });
    assert.deepEqual(await store.history(id), []);
    assert.deepEqual((await recallTool.run({ query: 'My dentist is Dr. Ivanova.' }, ctx)).memories, []);
    await store.close();
  });

  test('unknown or missing id -> ok: false with the recall-or-list hint; nothing deleted', async () => {
    const { store, ctx } = await setup();
    await saved(ctx, 'My dentist is Dr. Ivanova.');
    for (const args of [{ id: MISSING }, {}, { id: 42 }, null]) {
      const r = await forgetTool.run(args, ctx);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.match(r.error, /recall or list/);
    }
    assert.equal((await store.counts()).total, 1);
    await store.close();
  });

  test('the description limits it to an explicit ask from the user', () => {
    assert.match(forgetTool.description, /only when the user asks/i);
  });
});

describe('list', () => {
  async function many(ctx, n) {
    for (let i = 0; i < n; i++) await saved(ctx, `Nimbus fact number ${i} is here.`, { title: `Nimbus ${i}` });
  }

  test('returns id, title, type and date only (no content); newest first with order recent', async () => {
    const { store, ctx } = await setup({ embedder: null });
    await many(ctx, 3);
    const r = await listTool.run({ order: 'recent' }, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(r.memories.map((m) => m.title), ['Nimbus 2', 'Nimbus 1', 'Nimbus 0']);
    for (const m of r.memories) {
      assert.deepEqual(Object.keys(m).sort(), ['date', 'id', 'title', 'type']);
      assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.equal(r.more, false);
    await store.close();
  });

  test('order importance (the default) puts the most important first', async () => {
    const { store, ctx } = await setup({ embedder: null });
    await many(ctx, 2);
    await store.insert({ type: 'fact', title: 'Key fact', content: 'The key fact.', importance: 5 });
    assert.equal((await listTool.run({}, ctx)).memories[0].title, 'Key fact');
    await store.close();
  });

  test('type filter returns only that type', async () => {
    const { store, ctx } = await setup({ embedder: null });
    await many(ctx, 2);
    await saved(ctx, 'Maya prefers written updates.', { type: 'preference' });
    const r = await listTool.run({ type: 'preference' }, ctx);
    assert.deepEqual(r.memories.map((m) => m.type), ['preference']);
    await store.close();
  });

  test('limit defaults to LIST_LIMIT, is capped at 50; more: true when rows were cut', async () => {
    const { store, ctx } = await setup({ embedder: null });
    await many(ctx, 55);
    const def = await listTool.run({}, ctx);
    assert.equal(def.memories.length, 20);
    assert.equal(def.more, true);
    assert.equal((await listTool.run({ limit: 500 }, ctx)).memories.length, 50);
    assert.equal((await listTool.run({ limit: 3 }, ctx)).memories.length, 3);
    await store.close();
  });

  test('an empty store -> ok: true, an empty list, more: false, a plain message', async () => {
    const { store, ctx } = await setup();
    assert.deepEqual(await listTool.run({}, ctx), { ok: true, memories: [], more: false, message: 'No memories saved.' });
    await store.close();
  });

  test('a bad type or order -> ok: false naming the field and the allowed values', async () => {
    const { store, ctx } = await setup();
    const t = await listTool.run({ type: 'gossip' }, ctx);
    assert.equal(t.ok, false);
    assert.match(t.error, /type/);
    const o = await listTool.run({ order: 'random' }, ctx);
    assert.equal(o.ok, false);
    assert.match(o.error, /order/);
    assert.match(o.error, /recent/);
    await store.close();
  });
});
