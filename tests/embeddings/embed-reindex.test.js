// T2.4 - reindex: embed every row whose sig is not the current one.
//
// Ported from v1 (archive/v1-final) tests/integration/embeddings/reindex.test.js:
// "a killed reindex resumes and costs exactly one embedding call per row",
// "a store with nothing to embed completes", "a provider that returns nothing
// leaves the rows for the next run", "no vector support - nothing is embedded".
// From tests/unit/helpers/embeddings.test.js: "counts failed rows".
// Not ported: leases, vec_meta states, the CLI, multi-store sweeps. v2 keeps a
// sig per row (S2.3), so "rows still to do" is one query (spec S2.4).
// New: model change flags rows; mid-reindex search never mixes two models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/store/open-store.js';
import { reindex } from '../../src/embeddings/embed-reindex.js';

const DIMS = 4;
const quiet = { warn() {}, info() {} };
const open = (over = {}) => openStore({ path: ':memory:', dims: DIMS, log: quiet, ...over });
const fact = (title, content) => ({ type: 'fact', title, content });

/** A fake embedder: deterministic vectors, every call recorded. */
function fakeEmbedder(sig = 'fake|4|q8-cls', { failOn = () => false, onCall = () => {} } = {}) {
  const calls = [];
  return {
    sig, dims: DIMS, calls,
    async embed(text) {
      calls.push(text);
      onCall(calls.length);
      if (failOn(text)) throw new Error(`cannot embed ${text}`);
      return [text.length % 7, 1, calls.length % 3, 2];
    },
    async embedQuery(text) { return this.embed(text); },
    async close() {},
  };
}

async function seed(store, n) {
  for (let i = 0; i < n; i++) await store.insert(fact(`Row ${i}`, `Content of row ${i}.`));
}

test('empty store: done 0, failed 0, no embed call (ported)', async () => {
  const store = await open();
  const emb = fakeEmbedder();
  assert.deepEqual(await reindex(store, emb), { done: 0, failed: 0 });
  assert.equal(emb.calls.length, 0);
  await store.close();
});

test('embeds every row without a vector, as "title. content"; a second run does 0 calls', async () => {
  const store = await open();
  await store.insert(fact('Coffee', 'Oat-milk flat white.'));
  await seed(store, 2);
  const emb = fakeEmbedder();
  assert.deepEqual(await reindex(store, emb), { done: 3, failed: 0 });
  assert.ok(emb.calls.includes('Coffee. Oat-milk flat white.'), emb.calls.join(' | '));
  assert.deepEqual(await store.counts(), { total: 3, embedded: 3 });
  assert.deepEqual(await store.listNeedingEmbedding(emb.sig, 50), []);

  const again = fakeEmbedder();
  assert.deepEqual(await reindex(store, again), { done: 0, failed: 0 });
  assert.equal(again.calls.length, 0);
  await store.close();
});

test('pages past 50 rows: 120 rows all get embedded', async () => {
  const store = await open();
  await seed(store, 120);
  const emb = fakeEmbedder();
  assert.deepEqual(await reindex(store, emb), { done: 120, failed: 0 });
  assert.equal(emb.calls.length, 120);
  await store.close();
});

test('model change: rows with the old sig come back and are embedded again (L-C17)', async () => {
  const store = await open();
  await seed(store, 3);
  await reindex(store, fakeEmbedder('model-a|4|q8-cls'));
  const b = fakeEmbedder('model-b|4|q8-cls');
  assert.equal((await store.listNeedingEmbedding(b.sig, 50)).length, 3);
  assert.deepEqual(await reindex(store, b), { done: 3, failed: 0 });
  assert.deepEqual(await store.listNeedingEmbedding(b.sig, 50), []);
  assert.equal((await store.listNeedingEmbedding('model-a|4|q8-cls', 50)).length, 3);
  await store.close();
});

test('resume: an aborted run, run again, costs exactly one embed call per row (ported)', async () => {
  const store = await open();
  await seed(store, 5);
  const ac = new AbortController();
  const first = fakeEmbedder('fake|4|q8-cls', { onCall: (n) => { if (n === 2) ac.abort(); } });
  const r1 = await reindex(store, first, { signal: ac.signal });
  assert.equal(r1.done, 2, 'a vector already made is written, then the run stops');
  const second = fakeEmbedder();
  const r2 = await reindex(store, second);
  assert.equal(r2.done, 3);
  assert.equal(first.calls.length + second.calls.length, 5);
  assert.deepEqual(await store.counts(), { total: 5, embedded: 5 });
  await store.close();
});

test('one row fails: failed 1, the row keeps no sig, others are done, the run ends (ported)', async () => {
  const store = await open();
  await store.insert(fact('Good one', 'fine'));
  const bad = await store.insert(fact('Bad one', 'poison'));
  await store.insert(fact('Good two', 'fine'));
  const warnings = [];
  const emb = fakeEmbedder('fake|4|q8-cls', { failOn: (t) => t.includes('poison') });
  const result = await reindex(store, emb, { log: { warn: (m) => warnings.push(m), info() {} } });
  assert.deepEqual(result, { done: 2, failed: 1 });
  assert.equal(emb.calls.length, 3, 'the failed row is not retried in the same run');
  assert.deepEqual((await store.listNeedingEmbedding(emb.sig, 50)).map((r) => r.id), [bad.id]);
  assert.ok(warnings.some((w) => w.includes(bad.id)), 'the failure is logged with the row id (AP5)');
  await store.close();
});

test('every row fails: the run ends, it does not loop forever', async () => {
  const store = await open();
  await seed(store, 3);
  const emb = fakeEmbedder('fake|4|q8-cls', { failOn: () => true });
  assert.deepEqual(await reindex(store, emb, { log: quiet }), { done: 0, failed: 3 });
  assert.equal(emb.calls.length, 3);
  await store.close();
});

test('no vector support: zero embed calls, rows stay for later (ported)', async () => {
  const store = await open({ loadVector: () => { throw new Error('Unsupported platform for sqlite-vec'); } });
  await seed(store, 3);
  const emb = fakeEmbedder();
  assert.deepEqual(await reindex(store, emb, { log: quiet }), { done: 0, failed: 0 });
  assert.equal(emb.calls.length, 0);
  await store.close();
});

test('mid-reindex search uses only vectors with the current sig (store change, spec S2.4 #7)', async () => {
  const store = await open();
  const target = [1, 0, 0, 0];
  const old = await store.insert(fact('Old space row', 'alpha'), target, 'model-a|4|q8-cls');
  const cur = await store.insert(fact('New space row', 'beta'), [0, 1, 0, 0], 'model-b|4|q8-cls');
  const hits = await store.search({ query: '', queryEmbedding: target, mode: 'semantic', sig: 'model-b|4|q8-cls' });
  const ids = hits.filter((h) => h.matched.includes('vec')).map((h) => h.id);
  assert.ok(!ids.includes(old.id), 'a vector from another model must never be ranked');
  assert.ok(ids.includes(cur.id));

  // Without a sig the store keeps its S2.3 behaviour (every vector counts).
  const all = await store.search({ query: '', queryEmbedding: target, mode: 'semantic' });
  assert.equal(all[0].id, old.id);
  await store.close();
});
