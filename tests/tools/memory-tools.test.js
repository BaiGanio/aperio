// T2.7 rev 3 - the remember and recall tools (spec S2.7 rev 3 §2.3, §3).
//
// The model decides when to call them; these tests check what a call does.
// A real in-memory store and a fake 64-dim embedder whose vector is a hash of
// the text, so the same text scores 1.0 and different texts score near 0.

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../../src/store/open-store.js';
import { MEMORY_TOOLS, rememberTool, recallTool } from '../../src/tools/memory-tools.js';

const DIMS = 64;
const SIG = 'fake|64|test';
const CONFIG = Object.freeze({ REMEMBER_DUP_SCORE: 80, RECALL_TOP_K: 5 });
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });

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
  const ctx = { store, embedder, config: CONFIG, log };
  return { store, ctx, log };
}
const all = (store) => store.list({ limit: 100, order: 'recent' });

describe('the tool set', () => {
  test('remember and recall come first, each with name, description, JSON schema and run() (all 5: tools-contract.test.js)', () => {
    assert.deepEqual(MEMORY_TOOLS.map((t) => t.name).slice(0, 2), ['remember', 'recall']);
    for (const t of MEMORY_TOOLS) {
      assert.equal(typeof t.description, 'string');
      assert.equal(t.parameters.type, 'object');
      assert.equal(typeof t.run, 'function');
    }
    assert.deepEqual(rememberTool.parameters.required, ['content']);
    assert.deepEqual(recallTool.parameters.required, ['query']);
  });

  test('the definitions are frozen: the tool bytes cannot drift between turns', () => {
    for (const t of MEMORY_TOOLS) assert.ok(Object.isFrozen(t));
    assert.ok(Object.isFrozen(MEMORY_TOOLS));
  });
});

describe('remember', () => {
  test('saves one fact with its vector and signature; title = first 8 words; source = tool', async () => {
    const { store, ctx } = await setup();
    const r = await rememberTool.run({ content: 'The quarterly planning review for the platform team is in room 4.12.' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Saved.');
    const [row] = await all(store);
    assert.equal(row.id, r.id);
    assert.equal(row.title, 'The quarterly planning review for the platform team');
    assert.equal(row.type, 'fact');
    assert.equal(row.source, 'tool');
    assert.deepEqual(await store.counts(), { total: 1, embedded: 1 });
    assert.deepEqual(await store.listNeedingEmbedding(SIG), []);
    await store.close();
  });

  test('a title and a valid type from the model are kept', async () => {
    const { store, ctx } = await setup();
    await rememberTool.run({ content: 'Maya prefers written updates.', title: 'Maya: written updates', type: 'preference' }, ctx);
    const [row] = await all(store);
    assert.equal(row.title, 'Maya: written updates');
    assert.equal(row.type, 'preference');
    await store.close();
  });

  test('a bad type falls back to fact, not an error', async () => {
    const { store, ctx } = await setup();
    const r = await rememberTool.run({ content: 'Priya leads Beacon.', type: 'gossip' }, ctx);
    assert.equal(r.ok, true);
    assert.equal((await all(store))[0].type, 'fact');
    await store.close();
  });

  test('missing or empty content -> ok: false with a reason, nothing saved', async () => {
    const { store, ctx } = await setup();
    for (const args of [{}, { content: '' }, { content: '   ' }, { content: 42 }, null]) {
      const r = await rememberTool.run(args, ctx);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.match(r.error, /content/);
    }
    assert.equal((await all(store)).length, 0);
    await store.close();
  });

  test('a secret is refused: nothing saved, the reason says why, the secret is not repeated or logged', async () => {
    const { store, ctx, log } = await setup();
    const secret = 'sk-proj-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c';
    const r = await rememberTool.run({ content: `My key is ${secret}.` }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.error, /secret/i);
    assert.ok(!JSON.stringify(r).includes(secret));
    assert.ok(!JSON.stringify([log.error, log.warn, log.info].flatMap((f) => f.mock.calls.map((c) => c.arguments))).includes(secret));
    assert.equal((await all(store)).length, 0);
    await store.close();
  });

  test('the same fact twice -> 1 row; the second call returns the old id, duplicate: true', async () => {
    const { store, ctx } = await setup();
    const first = await rememberTool.run({ content: 'My dentist is Dr. Ivanova.' }, ctx);
    const second = await rememberTool.run({ content: 'My dentist is Dr. Ivanova.' }, ctx);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);
    assert.equal((await all(store)).length, 1);
    await store.close();
  });

  test('a different fact is not a duplicate', async () => {
    const { store, ctx } = await setup();
    await rememberTool.run({ content: 'My dentist is Dr. Ivanova.' }, ctx);
    const r = await rememberTool.run({ content: 'My vet is Dr. Petrova.' }, ctx);
    assert.equal(r.duplicate, undefined);
    assert.equal((await all(store)).length, 2);
    await store.close();
  });

  test('no embedder, or embed() throws -> saved without a vector, one warn per call', async () => {
    for (const embedder of [null, { sig: SIG, dims: DIMS, embed: async () => { throw new Error('model gone'); } }]) {
      const { store, ctx, log } = await setup({ embedder });
      const r = await rememberTool.run({ content: 'My dentist is Dr. Ivanova.' }, ctx);
      assert.equal(r.ok, true);
      assert.deepEqual(await store.counts(), { total: 1, embedded: 0 }, 'the S2.4 reindex fills it later');
      assert.equal(log.warn.mock.callCount(), 1);
      await store.close();
    }
  });

  test('a store error throws: the tool loop turns it into ok: false (AP5)', async () => {
    const { store: real, ctx } = await setup();
    const store = { ...real, insert: async () => { throw new Error('disk full'); } };
    await assert.rejects(rememberTool.run({ content: 'My dentist is Dr. Ivanova.' }, { ...ctx, store }), /disk full/);
    await real.close();
  });
});

describe('recall', () => {
  test('finds a saved memory by meaning; returns title, content and date', async () => {
    const { store, ctx } = await setup();
    await rememberTool.run({ content: 'My dentist is Dr. Ivanova.' }, ctx);
    const r = await recallTool.run({ query: 'My dentist is Dr. Ivanova.' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.memories[0].content, 'My dentist is Dr. Ivanova.');
    assert.match(r.memories[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(Object.keys(r.memories[0]).sort(), ['content', 'date', 'id', 'title'], 'S2.8: id added');
    await store.close();
  });

  test('finds by words too (hybrid), even with no embedder', async () => {
    const { store, ctx } = await setup({ embedder: null });
    await rememberTool.run({ content: 'The Nimbus standup moves to Thursdays at 11:30.' }, ctx);
    const r = await recallTool.run({ query: 'Nimbus standup' }, ctx);
    assert.equal(r.memories.length, 1);
    await store.close();
  });

  test('limit defaults to RECALL_TOP_K and is capped at 10', async () => {
    const { store, ctx } = await setup({ embedder: null });
    for (let i = 0; i < 12; i++) await rememberTool.run({ content: `Nimbus fact number ${i} is here.` }, ctx);
    assert.equal((await recallTool.run({ query: 'Nimbus' }, ctx)).memories.length, 5);
    assert.equal((await recallTool.run({ query: 'Nimbus', limit: 50 }, ctx)).memories.length, 10);
    assert.equal((await recallTool.run({ query: 'Nimbus', limit: 2 }, ctx)).memories.length, 2);
    await store.close();
  });

  test('nothing found -> ok: true, an empty list and a plain message', async () => {
    const { store, ctx } = await setup();
    const r = await recallTool.run({ query: 'anything at all' }, ctx);
    assert.deepEqual(r, { ok: true, memories: [], message: 'No memories match.' });
    await store.close();
  });

  test('missing query -> ok: false with a reason', async () => {
    const { store, ctx } = await setup();
    for (const args of [{}, { query: '' }, null]) {
      const r = await recallTool.run(args, ctx);
      assert.equal(r.ok, false);
      assert.match(r.error, /query/);
    }
    await store.close();
  });
});
