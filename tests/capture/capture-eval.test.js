// T2.7 - the capture eval (spec S2.7 §3), on evals/capture.json.
//
// Part 1, deterministic (CI): hash embedder, exact bars - every save case
// saves one row with every required term, no skip or secret case saves.
// Part 2, real embedder (skips when the S2.4 model is not cached): the
// duplicate cases score >= CAPTURE_DUP_SCORE against the seeded store and no
// save case does (the default must sit in that gap, measured on TRAIN, L-M10).
// Latency at 1000 rows needs APERIO_LIVE=1.

import { describe, test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../src/config/read-config.js';
import { openStore } from '../../src/store/open-store.js';
import { createEmbedder } from '../../src/embeddings/local-embedder.js';
import { reindex } from '../../src/embeddings/embed-reindex.js';
import { loadEvalFixtures, seedRows } from '../../src/eval/fixtures.js';
import { captureTurn, createCaptureSession } from '../../src/capture/capture-turn.js';

const EVALS = fileURLToPath(new URL('../../evals/', import.meta.url));
const { cases } = JSON.parse(await readFile(join(EVALS, 'capture.json'), 'utf8'));
const CONFIG = readConfig({}).values;
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });
const by = (label, split) => cases.filter((c) => c.label === label && (!split || c.split === split));

test('fixture shape: 20/10 save, 16/8 skip, 6 secret, unique ids, required terms are in the text', () => {
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.equal(by('save', 'train').length, 20);
  assert.equal(by('save', 'holdout').length, 10);
  assert.equal(by('skip').length, 24);
  assert.equal(by('skip', 'holdout').length, 8);
  assert.equal(by('secret').length, 6);
  for (const c of by('save')) for (const t of c.requiredTerms) assert.ok(c.text.includes(t), `${c.id}: "${t}"`);
  assert.ok(by('skip').some((c) => c.text.startsWith('Heads-up: from next week the Nimbus team standup')), 'the old Heads-up wording is a skip case');
});

describe('capture eval, deterministic', () => {
  const DIMS = 64;
  const vec = (t) => {
    const b = createHash('sha512').update(t).digest();
    const v = Array.from({ length: DIMS }, (_, i) => b[i] - 127.5 + i * 0.01);
    const n = Math.hypot(...v);
    return Float32Array.from(v.map((x) => x / n));
  };
  const embed = async (t) => vec(t);
  const embedder = { sig: 'hash|64', dims: DIMS, embed, embedQuery: embed };

  async function score(config) {
    const store = await openStore({ path: ':memory:', dims: DIMS, log: quiet() });
    const out = { hit: { train: 0, holdout: 0 }, falseSave: [], secretSaved: [], unresolvedMiss: [], miss: [] };
    for (const c of cases.filter((x) => x.label !== 'duplicate')) {
      const before = (await store.counts()).total;
      const r = await captureTurn({ text: c.text, store, embedder, session: createCaptureSession(), config, emit() {}, log: quiet() });
      const added = (await store.list({ limit: 200, order: 'recent' })).slice(0, (await store.counts()).total - before);
      if (c.label === 'save') {
        if (added.length === 1 && c.requiredTerms.every((t) => added[0].content.includes(t))) out.hit[c.split]++;
        else out.miss.push(c.id);
      } else if (c.label === 'skip') {
        if (added.length) out.falseSave.push(c.id);
        if (c.unresolved && r.unresolved !== 1) out.unresolvedMiss.push(c.id);
      } else if (c.label === 'secret') {
        if (added.length || r.secretRefused !== 1) out.secretSaved.push(c.id);
      }
    }
    await store.close();
    return out;
  }

  test('bars: save train 20/20, holdout 10/10; false saves 0/24; secrets 0; every pointer is unresolved', async (t) => {
    const o = await score(CONFIG);
    t.diagnostic(JSON.stringify(o));
    assert.equal(o.hit.train, 20, `train misses: ${o.miss}`);
    assert.equal(o.hit.holdout, 10, `holdout misses: ${o.miss}`);
    assert.deepEqual(o.falseSave, []);
    assert.deepEqual(o.secretSaved, []);
    assert.deepEqual(o.unresolvedMiss, []);
  });

  test('teeth: CAPTURE_MODE=off scores 0 saves (the bar above would be red)', async () => {
    const o = await score({ ...CONFIG, CAPTURE_MODE: 'off' });
    assert.equal(o.hit.train + o.hit.holdout, 0);
  });
});

const MODEL = CONFIG.EMBEDDING_MODEL;
const CACHE = CONFIG.TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());
const gate = existsSync(join(CACHE, MODEL, 'onnx')) ? {} : { skip: `SKIPPED: ${MODEL} is not in ${CACHE}. Run: npm run model:fetch` };

describe('capture eval, real embedder', gate, () => {
  let embedder;
  let store;
  before(async () => {
    embedder = await createEmbedder({ model: MODEL, cacheDir: CACHE, threads: CONFIG.EMBEDDING_THREADS, log: quiet() });
    store = await openStore({ path: ':memory:', dims: embedder.dims, log: quiet() });
    for (const row of seedRows((await loadEvalFixtures(EVALS)).memories)) await store.insert(row);
    await reindex(store, embedder, { log: quiet() });
  });
  after(async () => {
    await store?.close();
    await embedder?.close();
  });

  const top = async (text) => {
    const content = text.replace(/^remember(\s+that)?\s*:?\s*/i, '');
    const [hit] = await store.search({ query: content, queryEmbedding: await embedder.embedQuery(content), mode: 'semantic', limit: 1, sig: embedder.sig });
    return { title: hit?.title, score: Math.round((hit?.score ?? 0) * 100) };
  };

  test('CAPTURE_DUP_SCORE sits in the gap: every duplicate >= it, every save case < it', async (t) => {
    const dup = [];
    for (const c of by('duplicate')) dup.push({ id: c.id, ...(await top(c.text)), want: c.duplicateOf });
    const save = [];
    for (const c of by('save')) save.push({ id: c.id, ...(await top(c.text)) });
    t.diagnostic(JSON.stringify({ bar: CONFIG.CAPTURE_DUP_SCORE, dup, saveMax: save.reduce((m, x) => (x.score > m.score ? x : m)) }));
    for (const d of dup) {
      assert.equal(d.title, d.want, `${d.id} finds its seeded row`);
      assert.ok(d.score >= CONFIG.CAPTURE_DUP_SCORE, `${d.id}: ${d.score} >= ${CONFIG.CAPTURE_DUP_SCORE}`);
    }
    for (const s of save) assert.ok(s.score < CONFIG.CAPTURE_DUP_SCORE, `${s.id}: ${s.score} < ${CONFIG.CAPTURE_DUP_SCORE} (would be a false duplicate)`);
  });

  test('captureTurn drops every duplicate case', async () => {
    for (const c of by('duplicate')) {
      const r = await captureTurn({ text: c.text, store, embedder, session: createCaptureSession(), config: CONFIG, emit() {}, log: quiet() });
      assert.equal(r.duplicate, 1, c.id);
    }
  });

  const latencyGate = process.env.APERIO_LIVE === '1' ? {} : { skip: 'SKIPPED: latency measurement. Run with APERIO_LIVE=1.' };
  test('capture step max <= 100 ms at 1000 rows (N = 5)', latencyGate, async (t) => {
    let s = 42;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
    for (let i = (await store.counts()).total; i < 1000; i++) {
      await store.insert({ type: 'fact', title: `Filler ${i}`, content: `Filler memory ${i}.` }, Array.from({ length: embedder.dims }, rand), embedder.sig);
    }
    const ms = [];
    for (let run = 0; run < 5; run++) {
      for (const c of by('save')) {
        const t0 = performance.now();
        await captureTurn({ text: c.text.replace(/\.$/, ` (run ${run}).`), store, embedder, session: createCaptureSession(), config: CONFIG, emit() {}, log: quiet() });
        ms.push(performance.now() - t0);
      }
    }
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    const sd = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (ms.length - 1));
    t.diagnostic(JSON.stringify({ n: ms.length, mean: +mean.toFixed(1), sd: +sd.toFixed(1), max: +Math.max(...ms).toFixed(1) }));
    assert.ok(Math.max(...ms) <= 100);
  });
});
