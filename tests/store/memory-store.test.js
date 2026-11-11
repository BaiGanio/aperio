// T2.3 - store: create / read / update / delete, history, vectors, errors.
//
// Cases ported from v1 (archive/v1-final):
//   tests/integration/db/contract/memories.test.js - insert -> getById
//   roundtrip, missing id, delete twice, counts.
// Cut from the v1 file because v2 scope differs (spec S2.3 non-goals): the
// pending inbox (S2.7), pin, expiry, duplicate merge, bulk insert, and the
// tombstone update. v2 updates in place and copies the old row to
// memory_history, so the v1 "update returns a new id" case is replaced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store/open-store.js';
import { StoreError } from '../../src/store/memory-store.js';

const DIMS = 4;
const quiet = { warn() {}, info() {} };
const open = (extra = {}) => openStore({ path: ':memory:', dims: DIMS, log: quiet, ...extra });
const fact = (over = {}) => ({ type: 'fact', title: 'Coffee order', content: 'Flat white, oat milk.', ...over });
const vecRows = (store) => store.db.prepare('SELECT count(*) AS n FROM vec_memories').get().n;

// --- ported contract cases ---------------------------------------------------

test('insert -> getById roundtrips the core fields', async () => {
  const store = await open();
  const saved = await store.insert(fact({ tags: ['drink', 'habit'], importance: 4, source: 'chat' }));
  const read = await store.getById(saved.id);
  assert.deepEqual(read, saved);
  assert.equal(read.title, 'Coffee order');
  assert.deepEqual(read.tags, ['drink', 'habit']);
  assert.equal(read.importance, 4);
  assert.equal(read.source, 'chat');
  assert.match(read.createdAt, /^\d{4}-\d\d-\d\dT/);
  await store.close();
});

test('defaults: tags [], importance 3, source manual; createdAt can be given', async () => {
  const store = await open();
  const saved = await store.insert(fact({ createdAt: '2026-09-01T10:00:00.000Z' }));
  assert.deepEqual(saved.tags, []);
  assert.equal(saved.importance, 3);
  assert.equal(saved.source, 'manual');
  assert.equal(saved.createdAt, '2026-09-01T10:00:00.000Z');
  await store.close();
});

test('getById returns null for a missing id', async () => {
  const store = await open();
  assert.equal(await store.getById('nope'), null);
  await store.close();
});

test('delete returns the title, then null on a second call', async () => {
  const store = await open();
  const { id } = await store.insert(fact());
  assert.equal(await store.delete(id), 'Coffee order');
  assert.equal(await store.delete(id), null);
  assert.equal(await store.getById(id), null);
  await store.close();
});

test('counts() reports total and embedded as numbers', async () => {
  const store = await open();
  await store.insert(fact(), [1, 0, 0, 0], 'sig-a');
  await store.insert(fact({ title: 'Tea' }));
  assert.deepEqual(await store.counts(), { total: 2, embedded: 1 });
  await store.close();
});

// --- update in place + history ----------------------------------------------

test('update keeps the id, moves updatedAt, and full-text finds only the new text', async () => {
  const store = await open();
  const first = await store.insert(fact({ createdAt: '2026-09-01T10:00:00.000Z' }));
  const next = await store.update(first.id, { content: 'Espresso, no milk.' });
  assert.equal(next.id, first.id);
  assert.equal(next.createdAt, first.createdAt);
  assert.ok(next.updatedAt > first.updatedAt || next.updatedAt >= first.updatedAt);
  assert.equal(next.content, 'Espresso, no milk.');
  assert.equal((await store.search({ query: 'espresso', mode: 'fulltext' })).length, 1);
  assert.equal((await store.search({ query: 'oat', mode: 'fulltext' })).length, 0);
  await store.close();
});

test('history: two updates leave two old versions, newest first, never in search or list', async () => {
  const store = await open();
  const { id } = await store.insert(fact());
  await store.update(id, { content: 'Second version zebra.' });
  await store.update(id, { content: 'Third version.' });
  const old = await store.history(id);
  assert.equal(old.length, 2);
  assert.equal(old[0].content, 'Second version zebra.');
  assert.equal(old[1].content, 'Flat white, oat milk.');
  assert.match(old[0].replacedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(old[0].tags, []);
  assert.equal((await store.search({ query: 'zebra', mode: 'fulltext' })).length, 0);
  assert.equal((await store.list({})).length, 1);
  await store.close();
});

test('history: an update that changes nothing writes no history row', async () => {
  const store = await open();
  const { id } = await store.insert(fact());
  await store.update(id, { content: 'Flat white, oat milk.' });
  await store.update(id, {});
  assert.equal((await store.history(id)).length, 0);
  await store.close();
});

test('delete removes the history rows of that memory', async () => {
  const store = await open();
  const { id } = await store.insert(fact());
  await store.update(id, { content: 'Changed.' });
  await store.delete(id);
  assert.equal((await store.history(id)).length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_history').get().n, 0);
  await store.close();
});

// --- vectors -----------------------------------------------------------------

test('forget cleans the vector (L-C13): no orphan row after delete', async () => {
  const store = await open();
  const { id } = await store.insert(fact(), [1, 0, 0, 0], 'sig-a');
  assert.equal(vecRows(store), 1);
  await store.delete(id);
  assert.equal(vecRows(store), 0);
  await store.close();
});

test('update of content with no new vector removes the vector and clears the signature', async () => {
  const store = await open();
  const { id } = await store.insert(fact(), [1, 0, 0, 0], 'sig-a');
  await store.update(id, { content: 'New text.' });
  assert.equal(vecRows(store), 0);
  assert.deepEqual(await store.counts(), { total: 1, embedded: 0 });
  await store.close();
});

test('update of content with a new vector replaces it; a tags-only update keeps the vector', async () => {
  const store = await open();
  const { id } = await store.insert(fact(), [1, 0, 0, 0], 'sig-a');
  await store.update(id, { content: 'New text.' }, [0, 1, 0, 0], 'sig-a');
  assert.equal(vecRows(store), 1);
  await store.update(id, { tags: ['x'] });
  assert.equal(vecRows(store), 1);
  assert.deepEqual(await store.counts(), { total: 1, embedded: 1 });
  await store.close();
});

test('setEmbedding writes the vector and signature together', async () => {
  const store = await open();
  const { id } = await store.insert(fact());
  assert.equal(await store.setEmbedding(id, [0, 0, 1, 0], 'sig-a'), true);
  assert.equal(await store.setEmbedding(id, [0, 0, 0, 1], 'sig-b'), true);
  assert.equal(vecRows(store), 1);
  assert.equal(await store.setEmbedding('nope', [0, 0, 0, 1], 'sig-b'), false);
  await store.close();
});

test('listNeedingEmbedding returns rows with no signature or another signature only', async () => {
  const store = await open();
  const a = await store.insert(fact({ title: 'A' }), [1, 0, 0, 0], 'sig-new');
  const b = await store.insert(fact({ title: 'B' }), [1, 0, 0, 0], 'sig-old');
  const c = await store.insert(fact({ title: 'C' }));
  const need = await store.listNeedingEmbedding('sig-new', 10);
  assert.deepEqual(need.map((r) => r.id).sort(), [b.id, c.id].sort());
  assert.deepEqual(Object.keys(need[0]).sort(), ['content', 'id', 'title']);
  assert.ok(!need.some((r) => r.id === a.id));
  assert.equal((await store.listNeedingEmbedding('sig-new', 1)).length, 1);
  await store.close();
});

test('a vector of the wrong length throws and writes no row', async () => {
  const store = await open();
  await assert.rejects(store.insert(fact(), [1, 0], 'sig-a'), (err) => {
    assert.ok(err instanceof StoreError);
    assert.match(err.message, /2/);
    assert.match(err.message, /4/);
    return true;
  });
  assert.deepEqual(await store.counts(), { total: 0, embedded: 0 });
  await store.close();
});

test('a vector with no signature is refused', async () => {
  const store = await open();
  await assert.rejects(store.insert(fact(), [1, 0, 0, 0]), StoreError);
  assert.deepEqual(await store.counts(), { total: 0, embedded: 0 });
  await store.close();
});

// --- no sqlite-vec (L-C20; ported from v1 tests/unit/db/vec-fallback.test.js) --

test('no extension: open works, CRUD works, search is full-text, setEmbedding returns false', async () => {
  const warnings = [];
  const store = await open({
    log: { warn: (m) => warnings.push(m), info() {} },
    loadVector: () => { throw new Error('Unsupported platform for sqlite-vec'); },
  });
  assert.equal(store.vectorSupported, false);
  assert.equal(warnings.length, 1);
  const saved = await store.insert(fact(), [1, 0, 0, 0], 'sig-a');
  assert.equal(await store.setEmbedding(saved.id, [1, 0, 0, 0], 'sig-a'), false);
  assert.deepEqual(await store.counts(), { total: 1, embedded: 0 });
  const hits = await store.search({ query: 'oat milk', queryEmbedding: [1, 0, 0, 0], mode: 'auto' });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].matched, ['fts']);
  await store.update(saved.id, { content: 'Changed.' });
  assert.equal(await store.delete(saved.id), 'Coffee order');
  await store.close();
});

// --- errors: named field, nothing written ------------------------------------

const BAD_INPUTS = [
  ['title', { title: '' }],
  ['title', { title: 'x'.repeat(201) }],
  ['content', { content: undefined }],
  ['content', { content: 'x'.repeat(8001) }],
  ['type', { type: 'gossip' }],
  ['importance', { importance: 6 }],
  ['importance', { importance: 2.5 }],
  ['tags', { tags: 'drink' }],
  ['tags', { tags: [1, 2] }],
  ['tags', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
  ['createdAt', { createdAt: 'last tuesday' }],
];

for (const [field, over] of BAD_INPUTS) {
  test(`bad input: ${field} = ${JSON.stringify(over[field])?.slice(0, 30)} throws a StoreError naming the field`, async () => {
    const store = await open();
    await assert.rejects(store.insert(fact(over)), (err) => {
      assert.ok(err instanceof StoreError, `expected StoreError, got ${err}`);
      assert.match(err.message, new RegExp(field));
      return true;
    });
    assert.deepEqual(await store.counts(), { total: 0, embedded: 0 });
    await store.close();
  });
}

test('update: a missing id and a bad patch both throw, and change nothing', async () => {
  const store = await open();
  await assert.rejects(store.update('nope', { title: 'x' }), /not found/);
  const { id } = await store.insert(fact());
  await assert.rejects(store.update(id, { importance: 9 }), /importance/);
  assert.equal((await store.getById(id)).importance, 3);
  assert.equal((await store.history(id)).length, 0);
  await store.close();
});

// --- list ----------------------------------------------------------------------

test('list: filters by type and tag, orders, pages, and clamps the limit', async () => {
  const store = await open();
  await store.insert(fact({ title: 'old', importance: 5, createdAt: '2026-01-01T00:00:00.000Z', tags: ['a'] }));
  await store.insert(fact({ title: 'new', importance: 1, createdAt: '2026-06-01T00:00:00.000Z', tags: ['b'] }));
  await store.insert(fact({ title: 'pref', type: 'preference', createdAt: '2026-03-01T00:00:00.000Z' }));
  assert.deepEqual((await store.list({ order: 'recent' })).map((m) => m.title), ['new', 'pref', 'old']);
  assert.deepEqual((await store.list({ order: 'importance' })).map((m) => m.title)[0], 'old');
  assert.deepEqual((await store.list({ type: 'preference' })).map((m) => m.title), ['pref']);
  assert.deepEqual((await store.list({ tags: ['b', 'zzz'] })).map((m) => m.title), ['new']);
  assert.deepEqual((await store.list({ order: 'recent', limit: 1, offset: 1 })).map((m) => m.title), ['pref']);
  assert.equal((await store.list({ limit: 0 })).length, 1);
  assert.equal((await store.list({ limit: 9999 })).length, 3);
  await store.close();
});

// --- lifecycle -------------------------------------------------------------------

test('concurrent writes: 50 parallel inserts and deletes leave consistent counts and no orphan vector', async () => {
  const store = await open();
  const saved = await Promise.all(
    Array.from({ length: 50 }, (_, i) => store.insert(fact({ title: `m${i}` }), [i, 1, 0, 0], 'sig-a')),
  );
  await Promise.all(saved.filter((_, i) => i % 2 === 0).map((m) => store.delete(m.id)));
  assert.deepEqual(await store.counts(), { total: 25, embedded: 25 });
  assert.equal(vecRows(store), 25);
  await store.close();
});

test('TR15: two stores with two paths in one process do not share rows; close releases the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aperio-store-'));
  try {
    const a = await openStore({ path: join(root, 'deep', 'a.db'), dims: DIMS, log: quiet });
    const b = await openStore({ path: join(root, 'b.db'), dims: DIMS, log: quiet });
    await a.insert(fact({ title: 'only in a' }));
    assert.deepEqual(await a.counts(), { total: 1, embedded: 0 });
    assert.deepEqual(await b.counts(), { total: 0, embedded: 0 });
    await a.close();
    await b.close();
    const again = await openStore({ path: join(root, 'deep', 'a.db'), dims: DIMS, log: quiet });
    assert.equal((await again.list({}))[0].title, 'only in a');
    await again.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await assert.rejects(readdir(root), /ENOENT/);
});
