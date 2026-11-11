// T2.7 - one capture step (spec S2.7 §2 behaviour 1-8, Errors, Limits; §3).
//
// Deterministic: a real in-memory store (sqlite-vec) and a fake 64-dim
// embedder whose vector is a hash of the text, so the same text always scores
// 1.0 and two different texts score near 0. No v1 test fits (spec §1).

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../../src/store/open-store.js';
import { captureTurn, createCaptureSession } from '../../src/capture/capture-turn.js';

const DIMS = 64;
const SIG = 'fake|64|test';
const CONFIG = Object.freeze({ CAPTURE_MODE: 'on', CAPTURE_DUP_SCORE: 85, CAPTURE_MAX_PER_TURN: 3 });
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });

/** A unit vector from the text's hash: same text -> same vector. */
function vectorFor(text) {
  const bytes = createHash('sha512').update(String(text)).digest();
  const v = Array.from({ length: DIMS }, (_, i) => bytes[i % bytes.length] - 127.5 + i * 0.01);
  const norm = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / norm));
}
function fakeEmbedder() {
  const calls = [];
  const embed = mock.fn(async (text) => { calls.push(text); return vectorFor(text); });
  return { sig: SIG, dims: DIMS, embed, embedQuery: embed, calls };
}

async function setup({ embedder = fakeEmbedder(), config = CONFIG } = {}) {
  const store = await openStore({ path: ':memory:', dims: DIMS, log: quiet() });
  const session = createCaptureSession();
  const log = quiet();
  const events = [];
  const emit = (e) => events.push(e);
  const run = (text, over = {}) => captureTurn({ text, store, embedder, session, config, emit, log, ...over });
  return { store, embedder, session, log, events, emit, run };
}
const all = (store) => store.list({ limit: 100, order: 'recent' });
const types = (events) => events.map((e) => e.type);

describe('captureTurn: an explicit ask is saved', () => {
  test('"Remember that ..." -> 1 memory, cue removed, with its vector and signature', async () => {
    const { store, run, events } = await setup();
    const r = await run('Remember that my dentist is Dr. Ivanova.');
    assert.equal(r.saved, 1);
    assert.equal(r.ids.length, 1);
    const rows = await all(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, 'My dentist is Dr. Ivanova.');
    assert.equal(rows[0].type, 'fact');
    assert.equal(rows[0].source, 'capture');
    assert.equal(rows[0].id, r.ids[0]);
    assert.deepEqual(await store.counts(), { total: 1, embedded: 1 });
    assert.deepEqual(await store.listNeedingEmbedding(SIG), [], 'the vector is stored under the embedder signature');
    const hits = await store.search({ query: 'dentist', queryEmbedding: vectorFor('My dentist is Dr. Ivanova.'), mode: 'semantic', sig: SIG });
    assert.equal(hits[0].id, r.ids[0], 'semantic search finds it (the v1 null-vector bug)');
    const done = events.at(-1);
    assert.equal(done.type, 'capture_done', 'capture_done is the last event');
    assert.deepEqual({ ...done }, { type: 'capture_done', saved: 1, duplicate: 0, unresolved: 0, secretRefused: 0, ids: r.ids });
    await store.close();
  });

  test('title is the first 8 words of the content', async () => {
    const { store, run } = await setup();
    await run('Remember that the quarterly planning review for the platform team is in room 4.12.');
    const [row] = await all(store);
    assert.equal(row.title, 'The quarterly planning review for the platform team');
    await store.close();
  });

  test('a short content keeps all its words as the title', async () => {
    const { store, run } = await setup();
    await run('Remember that Priya leads Beacon.');
    const [row] = await all(store);
    assert.equal(row.title, 'Priya leads Beacon.');
    await store.close();
  });

  test('two asks in one message -> 2 rows', async () => {
    const { store, run } = await setup();
    const r = await run('Remember that the port is 8443. Remember that the host is db2.example.net.');
    assert.equal(r.saved, 2);
    assert.equal((await all(store)).length, 2);
    await store.close();
  });

  test('CAPTURE_MAX_PER_TURN caps the saves in one turn', async () => {
    const { store, run } = await setup();
    const text = ['Remember that alpha is one.', 'Remember that beta is two.', 'Remember that gamma is three.', 'Remember that delta is four.'].join(' ');
    const r = await run(text);
    assert.equal(r.saved, 3);
    assert.equal((await all(store)).length, 3);
    await store.close();
  });
});

describe('captureTurn: plain chat saves nothing', () => {
  for (const text of ['Do you remember my dentist?', "I can't remember the staging port.", 'Heads-up: the standup moves to Thursday.', 'Good. Talk later.', '', '   ']) {
    test(JSON.stringify(text), async () => {
      const { store, run, embedder, events } = await setup();
      const r = await run(text);
      assert.deepEqual({ saved: r.saved, duplicate: r.duplicate, unresolved: r.unresolved, secretRefused: r.secretRefused }, { saved: 0, duplicate: 0, unresolved: 0, secretRefused: 0 });
      assert.equal((await all(store)).length, 0);
      assert.equal(embedder.embed.mock.callCount(), 0, 'no embedding work for plain chat');
      assert.deepEqual(types(events), ['capture_done']);
      await store.close();
    });
  }
});

describe('captureTurn: unresolved, secret, duplicate', () => {
  test('"Remember that." -> 0 rows, capture_unresolved (left to the remember tool, decision 2)', async () => {
    const { store, run, events } = await setup();
    const r = await run('Remember that.');
    assert.equal(r.saved, 0);
    assert.equal(r.unresolved, 1);
    assert.equal((await all(store)).length, 0);
    assert.deepEqual(types(events), ['capture_unresolved', 'capture_done']);
    await store.close();
  });

  test('a secret -> 0 rows, capture_secret_refused, and the text is in no event and no log', async () => {
    const { store, run, events, log } = await setup();
    const secret = 'sk-proj-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c';
    const r = await run(`Remember that my key is ${secret}.`);
    assert.equal(r.saved, 0);
    assert.equal(r.secretRefused, 1);
    assert.equal((await all(store)).length, 0);
    assert.deepEqual(types(events), ['capture_secret_refused', 'capture_done']);
    const said = JSON.stringify(events) + JSON.stringify([log.error, log.warn, log.info].flatMap((f) => f.mock.calls.map((c) => c.arguments)));
    assert.ok(!said.includes(secret), 'the secret is not repeated');
    assert.ok(!said.includes('my key is'), 'the sentence is not repeated');
    await store.close();
  });

  test('the same ask twice -> 1 row; the second is capture_duplicate', async () => {
    const { store, run, events } = await setup();
    await run('Remember that my dentist is Dr. Ivanova.');
    events.length = 0;
    const r = await run('Remember that my dentist is Dr. Ivanova.');
    assert.equal(r.saved, 0);
    assert.equal(r.duplicate, 1);
    assert.equal((await all(store)).length, 1);
    assert.deepEqual(types(events), ['capture_duplicate', 'capture_done']);
    await store.close();
  });

  test('a memory the remember tool already saved this turn -> capture_duplicate, no second row', async () => {
    const { store, run } = await setup();
    const content = 'My dentist is Dr. Ivanova.';
    await store.insert({ type: 'fact', title: 'Dentist', content, source: 'tool' }, vectorFor(content), SIG);
    const r = await run('Remember that my dentist is Dr. Ivanova.');
    assert.equal(r.duplicate, 1);
    assert.equal((await all(store)).length, 1);
    await store.close();
  });

  test('a different fact is not a duplicate', async () => {
    const { store, run } = await setup();
    await run('Remember that my dentist is Dr. Ivanova.');
    const r = await run('Remember that my vet is Dr. Petrova.');
    assert.equal(r.saved, 1);
    assert.equal((await all(store)).length, 2);
    await store.close();
  });

  test('every event and the result carry counts and ids only, never text', async () => {
    const { store, run, events } = await setup();
    await run('Remember that my dentist is Dr. Ivanova. Remember that. Remember that my dentist is Dr. Ivanova.');
    for (const e of events) assert.ok(!JSON.stringify(e).includes('Ivanova'), `${e.type} holds no memory text`);
    await store.close();
  });
});

describe('captureTurn: switches and failures', () => {
  test('CAPTURE_MODE=off -> nothing saved, no embedding, no events', async () => {
    const { store, run, embedder, events } = await setup({ config: { ...CONFIG, CAPTURE_MODE: 'off' } });
    const r = await run('Remember that my dentist is Dr. Ivanova.');
    assert.equal(r.saved, 0);
    assert.equal((await all(store)).length, 0);
    assert.equal(embedder.embed.mock.callCount(), 0);
    assert.deepEqual(events, []);
    await store.close();
  });

  test('no embedder -> saved without a vector; one warn per session, not per turn', async () => {
    const { store, run, log, session } = await setup({ embedder: null });
    await run('Remember that my dentist is Dr. Ivanova.');
    await run('Remember that my vet is Dr. Petrova.');
    assert.deepEqual(await store.counts(), { total: 2, embedded: 0 }, 'the S2.4 reindex fills the vectors later');
    assert.equal(log.warn.mock.callCount(), 1, 'one warn for the session');
    session.reset();
    await run('Remember that my gym closes at 22:00.');
    assert.equal(log.warn.mock.callCount(), 2, 'a new session warns again');
    await store.close();
  });

  test('embed() throws -> same as no embedder: saved without a vector, one warn', async () => {
    const embedder = { sig: SIG, dims: DIMS, embed: async () => { throw new Error('model gone'); }, embedQuery: async () => { throw new Error('model gone'); } };
    const { store, run, log } = await setup({ embedder });
    const r = await run('Remember that my dentist is Dr. Ivanova.');
    assert.equal(r.saved, 1);
    assert.deepEqual(await store.counts(), { total: 1, embedded: 0 });
    assert.equal(log.warn.mock.callCount(), 1);
    await store.close();
  });

  test('a store error -> no throw, one log.error, capture_failed, then capture_done (AP5)', async () => {
    const { store: real, run, log, events } = await setup();
    const store = { ...real, insert: async () => { throw new Error('disk full'); } };
    const r = await run('Remember that my dentist is Dr. Ivanova.', { store });
    assert.equal(r.saved, 0);
    assert.equal(log.error.mock.callCount(), 1);
    assert.deepEqual(types(events), ['capture_failed', 'capture_done']);
    assert.ok(!JSON.stringify(log.error.mock.calls[0].arguments).includes('Ivanova'), 'the error log holds no memory text');
    await real.close();
  });
});
