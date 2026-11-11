// T2.6 - the recall eval numbers with the real embedder (spec S2.6 §3):
// inject hit rate, off-topic inject rate (+ teeth), RECALL_MIN_SCORE from the
// TRAIN split only (L-M10), recall step latency at 30 and 1000 rows
// (APERIO_LIVE=1 only).
//
// Needs the S2.4 model on disk. Not cached -> SKIP with the reason, like
// tests/embeddings/embeddings-live.test.js. No llama-server here.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../src/config/read-config.js';
import { createEmbedder } from '../../src/embeddings/local-embedder.js';
import { reindex } from '../../src/embeddings/embed-reindex.js';
import { openStore } from '../../src/store/open-store.js';
import { loadEvalFixtures, seedRows } from '../../src/eval/fixtures.js';
import { buildRecallBlock, createRecallSession } from '../../src/context/recall-block.js';

const EVALS = fileURLToPath(new URL('../../evals/', import.meta.url));
const quiet = { warn() {}, info() {}, error() {} };
const CONFIG = readConfig({}).values; // registry defaults only (TR15)
const { EMBEDDING_MODEL: MODEL, TRANSFORMERS_CACHE, EMBEDDING_THREADS: THREADS } = CONFIG;
const CACHE = TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());
const gate = existsSync(join(CACHE, MODEL, 'onnx')) ? {} : { skip: `SKIPPED: ${MODEL} is not in ${CACHE}. Run: npm run model:fetch` };

const stat = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(xs.length - 1, 1));
  return { n: xs.length, mean: +mean.toFixed(2), sd: +sd.toFixed(2), max: +Math.max(...xs).toFixed(2) };
};

/** A tiny seeded PRNG, so the filler rows are the same on every run. */
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
}

describe('recall eval (real embedder)', gate, () => {
  let embedder;
  let store;
  let corpus;
  let offTopic;

  before(async () => {
    embedder = await createEmbedder({ model: MODEL, cacheDir: CACHE, threads: THREADS, log: quiet });
    store = await openStore({ path: ':memory:', dims: embedder.dims, log: quiet });
    const fx = await loadEvalFixtures(EVALS);
    for (const row of seedRows(fx.memories)) await store.insert(row);
    await reindex(store, embedder, { log: quiet });
    corpus = fx.corpus.queries;
    offTopic = JSON.parse(await readFile(join(EVALS, 'off-topic.json'), 'utf8')).prompts;
  });
  after(async () => {
    await store?.close();
    await embedder?.close();
  });

  const recall = (text, config = CONFIG) =>
    buildRecallBlock({ store, embedder, text, session: createRecallSession(), config, log: quiet });

  /** The best cosine for a text, with no threshold. */
  const topScore = async (text) => (await recall(text, { ...CONFIG, RECALL_MIN_SCORE: 0 })).rows[0]?.score ?? 0;

  // Developer decision 2026-11-11: RECALL_MIN_SCORE = 50, the spec study value.
  // A first build used the midpoint of the train gap (62); live, it dropped vague
  // chat turns (SLO 0.59, coffee 0.53) while clean corpus questions scored >= 0.69.
  test('RECALL_MIN_SCORE fits the TRAIN split: all 16 train queries over it, <= 1/8 train off-topic over it', async (t) => {
    const min = CONFIG.RECALL_MIN_SCORE / 100;
    const trainHit = [];
    for (const q of corpus.filter((x) => x.split === 'train')) trainHit.push(await topScore(q.query));
    const trainOff = [];
    for (const p of offTopic.filter((x) => x.split === 'train')) trainOff.push(await topScore(p.text));
    t.diagnostic(JSON.stringify({ registryDefault: CONFIG.RECALL_MIN_SCORE, trainCorpusTop1Min: +Math.min(...trainHit).toFixed(3), trainOffTopicTop1: trainOff.map((x) => +x.toFixed(3)) }));
    assert.equal(CONFIG.RECALL_MIN_SCORE, 50, 'the developer-approved value');
    assert.ok(trainHit.every((x) => x >= min), 'every train query clears the minimum');
    assert.ok(trainOff.filter((x) => x >= min).length <= 1, '<= 1 of 8 train off-topic prompts clears it');
  });

  test('inject hit rate: an expected title is in the block for >= 22/24, holdout >= 7/8', async (t) => {
    const hits = { train: 0, holdout: 0 };
    const total = { train: 0, holdout: 0 };
    const tokens = [];
    const miss = [];
    for (const q of corpus) {
      const r = await recall(q.query);
      total[q.split]++;
      if (r.block) tokens.push(r.tokens);
      if (r.rows.some((row) => q.expectedTitles.includes(row.title))) hits[q.split]++;
      else miss.push(q.id);
    }
    t.diagnostic(JSON.stringify({ train: `${hits.train}/${total.train}`, holdout: `${hits.holdout}/${total.holdout}`, miss, blockTokens: stat(tokens) }));
    assert.ok(hits.train + hits.holdout >= 22, `all ${hits.train + hits.holdout}/24`);
    assert.ok(hits.holdout >= 7, `holdout ${hits.holdout}/8`);
  });

  test('off-topic inject rate <= 1/12, train and holdout apart', async (t) => {
    const injected = [];
    for (const p of offTopic) if ((await recall(p.text)).block) injected.push(p.id);
    t.diagnostic(JSON.stringify({ injected, train: injected.filter((id) => !id.startsWith('hold')).length, holdout: injected.filter((id) => id.startsWith('hold')).length }));
    assert.ok(injected.length <= 1, `${injected.length}/12 off-topic prompts got a block: ${injected.join(', ')}`);
  });

  test('teeth: RECALL_MIN_SCORE = 0 lets off-topic prompts in (the bar above would be red)', async () => {
    let injected = 0;
    for (const p of offTopic) if ((await recall(p.text, { ...CONFIG, RECALL_MIN_SCORE: 0 })).block) injected++;
    assert.ok(injected > 1, `with no minimum, ${injected}/12 got a block`);
  });

  // A timing measurement: it runs 240 embeddings and would load the CPU under the
  // parallel `npm test` and make other timing tests flaky. Run with APERIO_LIVE=1.
  const latencyGate = process.env.APERIO_LIVE === '1' ? {} : { skip: 'SKIPPED: latency measurement. Run with APERIO_LIVE=1.' };
  test('recall step latency at ~30 and 1000 rows: max <= 100 ms', latencyGate, async (t) => {
    const measure = async () => {
      const ms = [];
      for (let run = 0; run < 5; run++) for (const q of corpus) ms.push((await recall(q.query)).ms);
      return stat(ms);
    };
    const { total: rows30 } = await store.counts();
    const small = await measure();
    // Fill to 1000 rows with random unit vectors under the same sig: the search cost is the same.
    const rand = prng(42);
    for (let i = rows30; i < 1000; i++) {
      const v = Array.from({ length: embedder.dims }, rand);
      await store.insert({ type: 'fact', title: `Filler ${i}`, content: `Filler memory ${i}.` }, v, embedder.sig);
    }
    assert.equal((await store.counts()).total, 1000);
    const big = await measure();
    t.diagnostic(JSON.stringify({ [`rows${rows30}`]: small, rows1000: big }));
    assert.ok(small.max <= 100, `max ${small.max} ms at ${rows30} rows`);
    assert.ok(big.max <= 100, `max ${big.max} ms at 1000 rows`);
  });
});
