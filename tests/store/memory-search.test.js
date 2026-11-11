// T2.3 - store search: full-text, semantic, hybrid, the eval number, speed.
//
// Ported from v1 (archive/v1-final): the FTS5 operator-safety cases behind
// db/sqlite/mappers.js ftsMatchQuery (tests/integration/db/sqlite.test.js),
// and "recall (fulltext) finds an inserted memory by content" from
// tests/integration/db/contract/memories.test.js.
// New in v2: tokens join with OR (spec S2.3 decision 4), so the eval number
// below replaces v1's implicit-AND behaviour. v1 scored 10/24 on this corpus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/store/open-store.js';
import { ftsMatchQuery } from '../../src/store/memory-search.js';
import { loadEvalFixtures, seedRows } from '../../src/eval/fixtures.js';
import { hitRateAtK } from '../../src/eval/metrics.js';

const EVALS = fileURLToPath(new URL('../../evals/', import.meta.url));
const quiet = { warn() {}, info() {} };
const open = (dims = 4) => openStore({ path: ':memory:', dims, log: quiet });
const fact = (title, content, over = {}) => ({ type: 'fact', title, content, ...over });

test('full-text finds a memory by a word in its content, with a score and a match kind', async () => {
  const store = await open();
  await store.insert(fact('Deploy day', 'We deploy the pricing service on Thursday.'));
  await store.insert(fact('Garden', 'Tomatoes need water.'));
  const hits = await store.search({ query: 'pricing', mode: 'fulltext' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Deploy day');
  assert.deepEqual(hits[0].matched, ['fts']);
  assert.ok(hits[0].score > 0 && hits[0].score <= 1);
  await store.close();
});

test('full-text joins tokens with OR: a sentence finds a memory that has one of its words', async () => {
  const store = await open();
  await store.insert(fact('Nimbus uses NATS for events, not Kafka', 'Chosen for low latency.'));
  const hits = await store.search({ query: 'What event bus does the Nimbus service use?', mode: 'fulltext' });
  assert.equal(hits[0]?.title, 'Nimbus uses NATS for events, not Kafka');
  await store.close();
});

test('full-text ranks a title match above a content-only match', async () => {
  const store = await open();
  await store.insert(fact('Weekly notes', 'The standup moved, and the standup is short.'));
  await store.insert(fact('Standup time', 'Every day at ten.'));
  const hits = await store.search({ query: 'standup', mode: 'fulltext' });
  assert.deepEqual(hits.map((h) => h.title), ['Standup time', 'Weekly notes']);
  await store.close();
});

test('FTS safety: operator characters never throw (ported)', async () => {
  const store = await open();
  await store.insert(fact('Meeting', 'The meeting is at 21:00 in the foo-bar room.'));
  for (const query of ['meeting at 21:00', 'foo-bar', '"quoted', '*', '', '   ', 'a AND (b', 'NEAR(x y)', '^start']) {
    const hits = await store.search({ query, mode: 'fulltext' });
    assert.ok(Array.isArray(hits), query);
  }
  assert.equal((await store.search({ query: 'meeting at 21:00', mode: 'fulltext' }))[0].title, 'Meeting');
  assert.equal(ftsMatchQuery('"a" - *'), '"a"');
  assert.equal(ftsMatchQuery(' - * '), '');
  await store.close();
});

test('unicode: a Cyrillic memory is found by a Cyrillic word', async () => {
  const store = await open();
  await store.insert(fact('Кафе', 'Обичам кафе с овесено мляко.'));
  await store.insert(fact('Tea', 'Green tea.'));
  const hits = await store.search({ query: 'какво мляко пия', mode: 'fulltext' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Кафе');
  await store.close();
});

test('a query with no words falls back to list order, bounded by limit', async () => {
  const store = await open();
  await store.insert(fact('low', 'x', { importance: 1 }));
  await store.insert(fact('high', 'x', { importance: 5 }));
  const hits = await store.search({ query: '***', mode: 'auto', limit: 1 });
  assert.deepEqual(hits.map((h) => h.title), ['high']);
  assert.deepEqual(hits[0].matched, []);
  await store.close();
});

test('semantic finds the nearest vector, with no words in common', async () => {
  const store = await open();
  await store.insert(fact('Far', 'alpha'), [0, 0, 0, 1], 's');
  await store.insert(fact('Near', 'beta'), [1, 0, 0, 0], 's');
  const hits = await store.search({ query: 'gamma', queryEmbedding: [0.9, 0.1, 0, 0], mode: 'semantic', limit: 1 });
  assert.equal(hits[0].title, 'Near');
  assert.deepEqual(hits[0].matched, ['vec']);
  await store.close();
});

test('hybrid ranks a row that matches both above a row that matches one', async () => {
  const store = await open();
  // No vector here: in a tiny store the KNN list holds every embedded row,
  // so a row is "words only" only when it has no vector at all.
  await store.insert(fact('Words only', 'the budget word budget budget'));
  await store.insert(fact('Vector only', 'nothing shared'), [1, 0, 0, 0], 's');
  await store.insert(fact('Both', 'the budget is here'), [0.95, 0.05, 0, 0], 's');
  const hits = await store.search({ query: 'budget', queryEmbedding: [1, 0, 0, 0], mode: 'auto' });
  assert.equal(hits[0].title, 'Both');
  assert.deepEqual([...hits[0].matched].sort(), ['fts', 'vec']);
  assert.equal(hits[0].score, 1);
  assert.equal(hits.length, 3);
  await store.close();
});

test('auto with no query vector is full-text; type and tag filters apply', async () => {
  const store = await open();
  await store.insert(fact('A', 'shared word', { tags: ['x'] }));
  await store.insert(fact('B', 'shared word', { type: 'preference' }));
  assert.equal((await store.search({ query: 'shared', mode: 'auto' })).length, 2);
  assert.deepEqual((await store.search({ query: 'shared', type: 'preference' })).map((h) => h.title), ['B']);
  assert.deepEqual((await store.search({ query: 'shared', tags: ['x'] })).map((h) => h.title), ['A']);
  await store.close();
});

test('limit is clamped to 1..50 and a bad mode is refused', async () => {
  const store = await open();
  for (let i = 0; i < 60; i++) await store.insert(fact(`m${i}`, 'common word'));
  assert.equal((await store.search({ query: 'common', limit: 500 })).length, 50);
  assert.equal((await store.search({ query: 'common', limit: 0 })).length, 1);
  assert.equal((await store.search({ query: 'common' })).length, 10);
  await assert.rejects(store.search({ query: 'common', mode: 'psychic' }), /mode/);
  await store.close();
});

// --- the eval number (port protocol rule 9) --------------------------------------

test('eval: full-text hitRateAt5 on evals/corpus.json is >= 20/24, train and holdout apart', async (t) => {
  const { memories, corpus } = await loadEvalFixtures(EVALS);
  const store = await open();
  for (const row of seedRows(memories)) await store.insert(row);
  const rows = [];
  for (const q of corpus.queries) {
    const hits = await store.search({ query: q.query, mode: 'fulltext', limit: 5 });
    rows.push({ id: q.id, split: q.split, expectedTitles: q.expectedTitles, titles: hits.map((h) => h.title) });
  }
  const all = hitRateAtK(rows, 5);
  const train = hitRateAtK(rows.filter((r) => r.split === 'train'), 5);
  const holdout = hitRateAtK(rows.filter((r) => r.split === 'holdout'), 5);
  t.diagnostic(`fulltext hitRateAt5: all ${all.toFixed(3)} · train ${train.toFixed(3)} · holdout ${holdout.toFixed(3)} (v1: 0.417 / 0.375 / 0.500)`);
  assert.ok(all >= 20 / 24, `all ${all}`);
  assert.ok(train >= 12 / 16, `train ${train}`);
  assert.ok(holdout >= 6 / 8, `holdout ${holdout}`);
  await store.close();
});

// --- 10 000 rows: measured, not assumed (L-C16: report the max) -------------------

test('10 000 rows: hybrid top-5 search max <= 50 ms over 120 runs; never more rows than limit', async (t) => {
  const DIMS = 1024;
  const store = await open(DIMS);
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const WORDS = 'memory project decision coffee database sqlite model budget recall token prefix cache meeting Sofia garden bicycle ключ памет проект решение кафе server deploy test harness eval vector search index config port bug fix lesson plan ledger store embed provider tool skill window socket schema'.split(' ');
  const words = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
  const vec = () => Float32Array.from({ length: DIMS }, () => rnd() - 0.5);

  const t0 = performance.now();
  for (let i = 0; i < 10_000; i++) await store.insert(fact(words(6), words(60)), vec(), 'sig');
  const insertMs = performance.now() - t0;

  for (let i = 0; i < 10; i++) await store.search({ query: words(3), queryEmbedding: vec(), limit: 5 });
  const times = [];
  for (let i = 0; i < 120; i++) {
    const query = words(3);
    const queryEmbedding = vec();
    const start = performance.now();
    const hits = await store.search({ query, queryEmbedding, mode: 'auto', limit: 5 });
    times.push(performance.now() - start);
    assert.ok(hits.length <= 5);
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const max = Math.max(...times);
  t.diagnostic(`10k rows x ${DIMS} dims: insert ${Math.round(insertMs)} ms · hybrid mean ${mean.toFixed(2)} ms · max ${max.toFixed(2)} ms (v1: mean 8.28, max 9.19)`);
  // 50 ms, not 25 (developer, 2026-11-11): under the parallel `npm test` the max
  // reached 31-36 ms with no code change (2 of 5 runs failed). Mean stays ~11 ms.
  assert.ok(max <= 50, `max ${max.toFixed(2)} ms`);
  await store.close();
});
