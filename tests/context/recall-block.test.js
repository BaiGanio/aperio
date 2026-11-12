// T2.6 - the recall block (spec S2.6 §2 behaviour 1-9, §3 acceptance).
// Restored by S2.7 rev 4 (both): each row now carries its id (rev 4 §2), so the
// model can call update / forget without a recall first.
//
// Deterministic: a real in-memory store (sqlite-vec) and a fake 4-dim embedder,
// so every score is known. No v1 test fits (spec §1: v1 has no auto-recall at
// the tag; its tokenCount test uses the wrong tokenizer for gemma / Ornith).

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/store/open-store.js';
import {
  RECALL_HEADER, buildRecallBlock, createRecallSession, estimateTokens,
} from '../../src/context/recall-block.js';

const SIG = 'fake|4|test';
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });

/** Each topic is one axis. Text with no topic word points at the "other" axis. */
const AXES = { coffee: [1, 0, 0, 0], nimbus: [0, 1, 0, 0], beacon: [0, 0, 1, 0] };
function vectorFor(text) {
  const t = String(text).toLowerCase();
  for (const [word, v] of Object.entries(AXES)) if (t.includes(word)) return Float32Array.from(v);
  return Float32Array.from([0, 0, 0, 1]);
}
function fakeEmbedder() {
  const calls = [];
  const embed = async (text) => { calls.push(text); return vectorFor(text); };
  return { sig: SIG, dims: 4, embed, embedQuery: embed, calls };
}

const CONFIG = Object.freeze({ RECALL_TOP_K: 5, RECALL_TOKEN_BUDGET: 1200, RECALL_MIN_SCORE: 50 });

async function storeWith(rows) {
  const store = await openStore({ path: ':memory:', dims: 4, log: quiet() });
  for (const r of rows) {
    await store.insert({ type: 'fact', createdAt: '2026-10-01T09:00:00.000Z', ...r }, r.vector ?? vectorFor(`${r.title} ${r.content}`), SIG);
  }
  return store;
}

const COFFEE = { title: 'Oat-milk flat white', content: 'Maya drinks an oat-milk flat white, coffee with no sugar.' };
const NIMBUS = { title: 'Nimbus SLO', content: 'Nimbus answers under 50ms p99.' };

describe('buildRecallBlock: what gets injected', () => {
  test('a matching row is injected with preview framing and its date (L-M01)', async () => {
    const store = await storeWith([COFFEE, NIMBUS]);
    const r = await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'what coffee for Maya?', session: createRecallSession(), config: CONFIG });
    assert.ok(r.block, 'a block');
    const lines = r.block.split('\n');
    assert.equal(lines[0], RECALL_HEADER);
    assert.equal(RECALL_HEADER, 'Memories that may help (a preview, not everything stored):');
    assert.equal(lines[1], `- [2026-10-01] (id ${r.rows[0].id}) ${COFFEE.title}: ${COFFEE.content}`);
    assert.equal(lines.length, 2, 'the off-axis Nimbus row is below the minimum score');
    assert.deepEqual(r.rows.map((x) => x.title), [COFFEE.title]);
    assert.ok(r.rows[0].score > 0.99 && typeof r.rows[0].id === 'string');
    assert.equal(r.tokens, estimateTokens(r.block));
    assert.ok(typeof r.ms === 'number' && r.ms >= 0);
    await store.close();
  });

  test('zero relevant memories: an off-topic prompt injects nothing, no "none found" line', async () => {
    const store = await storeWith([COFFEE, NIMBUS]);
    const r = await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'tell me a joke', session: createRecallSession(), config: CONFIG });
    assert.equal(r.block, null);
    assert.deepEqual(r.rows, []);
    assert.equal(r.tokens, 0);
    await store.close();
  });

  test('zero relevant memories: an empty store injects nothing', async () => {
    const store = await storeWith([]);
    const r = await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'what coffee for Maya?', session: createRecallSession(), config: CONFIG });
    assert.equal(r.block, null);
    await store.close();
  });

  test('empty user text: no search at all', async () => {
    const real = await storeWith([COFFEE]);
    const store = { ...real, search: mock.fn(real.search) }; // the store object is frozen
    const search = store.search;
    const embedder = fakeEmbedder();
    for (const text of ['', '   ', '\n']) {
      const r = await buildRecallBlock({ store, embedder, text, session: createRecallSession(), config: CONFIG });
      assert.equal(r.block, null);
    }
    assert.equal(embedder.calls.length, 0, 'no embed');
    assert.equal(search.mock.callCount(), 0, 'no search');
    await store.close();
  });

  test('searches in semantic mode, top RECALL_TOP_K, filtered by the embedder sig', async () => {
    const real = await storeWith([COFFEE]);
    const store = { ...real, search: mock.fn(real.search) }; // the store object is frozen
    const search = store.search;
    await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: createRecallSession(), config: { ...CONFIG, RECALL_TOP_K: 3 } });
    const args = search.mock.calls[0].arguments[0];
    assert.equal(args.mode, 'semantic');
    assert.equal(args.limit, 3);
    assert.equal(args.sig, SIG);
    await store.close();
  });

  test('RECALL_MIN_SCORE is a percent: a row just under it is dropped, a row at it is kept', async () => {
    // cos([1,0,0,0], [0.6,0.8,0,0]) = 0.6
    const store = await storeWith([{ title: 'Edge row', content: 'neither topic word here', vector: Float32Array.from([0.6, 0.8, 0, 0]) }]);
    const at = await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: createRecallSession(), config: { ...CONFIG, RECALL_MIN_SCORE: 59 } });
    assert.ok(at.block, 'score 0.6 >= 0.59');
    const under = await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: createRecallSession(), config: { ...CONFIG, RECALL_MIN_SCORE: 61 } });
    assert.equal(under.block, null, 'score 0.6 < 0.61');
    await store.close();
  });
});

describe('buildRecallBlock: the token budget', () => {
  test('1000 memories that all match: the block stays <= RECALL_TOKEN_BUDGET, best rows first', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      title: `Coffee note ${i}`,
      content: `Coffee fact number ${i}. ${'The team likes good coffee in the morning and after lunch. '.repeat(4)}`,
      vector: Float32Array.from([1, (i % 7) / 100, 0, 0]),
    }));
    const store = await storeWith(rows);
    const config = { ...CONFIG, RECALL_TOP_K: 50 };
    const r = await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: createRecallSession(), config });
    assert.ok(r.block);
    assert.ok(r.tokens <= config.RECALL_TOKEN_BUDGET, `${r.tokens} <= ${config.RECALL_TOKEN_BUDGET}`);
    assert.equal(r.tokens, estimateTokens(r.block));
    assert.ok(r.rows.length >= 2 && r.rows.length < 50, `filled best-first, then stopped: ${r.rows.length} rows`);
    for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1].score >= r.rows[i].score, 'best first');
    await store.close();
  });

  test('one row bigger than the budget is clipped and marked with …', async () => {
    const store = await storeWith([{ title: 'Long coffee essay', content: `Coffee. ${'word '.repeat(1500)}` }]);
    const config = { ...CONFIG, RECALL_TOKEN_BUDGET: 100 };
    const r = await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: createRecallSession(), config });
    assert.ok(r.block, 'still injected');
    assert.ok(r.block.endsWith('…'), 'clipped with …');
    assert.ok(r.tokens <= 100, `${r.tokens} <= 100`);
    assert.ok(r.block.includes('Long coffee essay'));
    await store.close();
  });

  test('a later row that does not fit is skipped, a smaller one after it still fits', async () => {
    const store = await storeWith([
      { title: 'A small', content: 'Coffee one.', vector: Float32Array.from([1, 0, 0, 0]) },
      { title: 'B huge', content: `Coffee ${'x'.repeat(3000)}`, vector: Float32Array.from([0.99, 0.14, 0, 0]) },
      { title: 'C small', content: 'Coffee two.', vector: Float32Array.from([0.98, 0.2, 0, 0]) },
    ]);
    const r = await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: createRecallSession(), config: { ...CONFIG, RECALL_TOKEN_BUDGET: 200 } });
    assert.deepEqual(r.rows.map((x) => x.title), ['A small', 'C small']);
    await store.close();
  });

  test('estimateTokens is ceil(chars / 3)', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('a'), 1);
    assert.equal(estimateTokens('abc'), 1);
    assert.equal(estimateTokens('abcd'), 2);
  });
});

describe('buildRecallBlock: session state', () => {
  test('a row injected in turn 1 is not injected again in turn 2; reset() clears it', async () => {
    const store = await storeWith([COFFEE]);
    const session = createRecallSession();
    const args = { store, embedder: fakeEmbedder(), text: 'coffee for Maya', session, config: CONFIG };
    assert.ok((await buildRecallBlock(args)).block, 'turn 1');
    assert.equal(session.injectedIds.size, 1);
    assert.equal((await buildRecallBlock(args)).block, null, 'turn 2: already in history');
    session.reset();
    assert.equal(session.injectedIds.size, 0);
    assert.ok((await buildRecallBlock(args)).block, 'after reset: injected again');
    await store.close();
  });

  test('two sessions never share injected ids (no module state, AP6)', async () => {
    const store = await storeWith([COFFEE]);
    const a = createRecallSession();
    const b = createRecallSession();
    await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: a, config: CONFIG });
    assert.ok((await buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: b, config: CONFIG })).block);
    await store.close();
  });
});

describe('buildRecallBlock: errors', () => {
  test('embedder missing: recall_skipped event every turn, ONE warn per session, no block', async () => {
    const store = await storeWith([COFFEE]);
    const session = createRecallSession();
    const log = quiet();
    const events = [];
    for (let i = 0; i < 3; i++) {
      const r = await buildRecallBlock({ store, embedder: null, text: 'coffee', session, config: CONFIG, emit: (e) => events.push(e), log });
      assert.equal(r.block, null);
    }
    assert.equal(events.filter((e) => e.type === 'recall_skipped').length, 3);
    assert.match(events[0].reason, /embedder/i);
    assert.equal(log.warn.mock.callCount(), 1, 'one warn, not one per turn');
    await store.close();
  });

  test('embed() throws: recall_skipped with the reason, logged (AP5), no block', async () => {
    const store = await storeWith([COFFEE]);
    const embedder = { ...fakeEmbedder(), embedQuery: async () => { throw new Error('onnx died'); } };
    const log = quiet();
    const events = [];
    const r = await buildRecallBlock({ store, embedder, text: 'coffee', session: createRecallSession(), config: CONFIG, emit: (e) => events.push(e), log });
    assert.equal(r.block, null);
    assert.match(events.find((e) => e.type === 'recall_skipped').reason, /onnx died/);
    assert.equal(log.warn.mock.callCount(), 1);
    await store.close();
  });

  test('a store error is rethrown, never read as "no memories"', async () => {
    const real = await storeWith([COFFEE]);
    const store = { ...real, search: async () => { throw new Error('disk I/O error'); } }; // the store object is frozen
    await assert.rejects(
      buildRecallBlock({ store, embedder: fakeEmbedder(), text: 'coffee', session: createRecallSession(), config: CONFIG, log: quiet() }),
      /disk I\/O error/,
    );
    await store.close();
  });
});
