// T2.4 - the real local model: round-trip, no network, the eval number, try:search.
//
// These tests need the model on disk. When it is not in the cache they SKIP
// with a loud reason (spec S2.4 acceptance); `npm run model:fetch` gets it.
// The "missing model" test needs only the package, so it always runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../src/config/read-config.js';
import { createEmbedder, EmbeddingUnavailable } from '../../src/embeddings/local-embedder.js';
import { reindex } from '../../src/embeddings/embed-reindex.js';
import { openStore } from '../../src/store/open-store.js';
import { loadEvalFixtures, seedRows } from '../../src/eval/fixtures.js';
import { hitRateAtK } from '../../src/eval/metrics.js';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const EVALS = fileURLToPath(new URL('../../evals/', import.meta.url));
const quiet = { warn() {}, info() {} };

// Registry defaults only: a test never reads the developer's .env (TR15).
const { EMBEDDING_MODEL: MODEL, TRANSFORMERS_CACHE } = readConfig({}).values;
const CACHE = TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());
const cached = existsSync(join(CACHE, MODEL, 'onnx'));
const live = cached ? {} : { skip: `SKIPPED: ${MODEL} is not in ${CACHE}. Run: npm run model:fetch` };

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aperio-embed-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('missing model: EmbeddingUnavailable naming npm run model:fetch, no download', () => withTemp(async (empty) => {
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error('network is off in this test'); };
  try {
    await assert.rejects(createEmbedder({ model: MODEL, cacheDir: empty, log: quiet }), (err) => {
      assert.ok(err instanceof EmbeddingUnavailable, `got ${err?.name}: ${err?.message}`);
      assert.match(err.message, /npm run model:fetch/);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetches, 0, 'run time never calls the network');
  assert.deepEqual(await readdir(empty), [], 'nothing is written to the cache');
}));

test('no network: the real model loads and embeds with fetch stubbed to throw', live, async () => {
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error('network is off in this test'); };
  try {
    const embedder = await createEmbedder({ model: MODEL, cacheDir: TRANSFORMERS_CACHE, log: quiet });
    const v = await embedder.embed('hello');
    assert.equal(v.length, embedder.dims);
    await embedder.close();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetches, 0);
});

test('round-trip: embed -> store -> semantic search finds itself at rank 1; sig stored per row', live, async () => {
  const embedder = await createEmbedder({ model: MODEL, cacheDir: CACHE, log: quiet });
  assert.equal(embedder.dims, 1024);
  assert.equal(embedder.sig, `${MODEL}|1024|q8-cls`);
  const store = await openStore({ path: ':memory:', dims: embedder.dims, log: quiet });
  try {
    const rows = [
      { type: 'preference', title: 'Oat-milk flat white, no sugar', content: 'My morning coffee is an oat-milk flat white.' },
      { type: 'fact', title: 'Nimbus uses NATS for events', content: 'The Nimbus event bus is NATS, not Kafka.' },
      { type: 'fact', title: 'Garden tomatoes', content: 'The tomatoes need water every evening.' },
    ];
    for (const r of rows) await store.insert(r);
    assert.deepEqual(await reindex(store, embedder), { done: 3, failed: 0 });
    assert.deepEqual(await store.listNeedingEmbedding(embedder.sig, 50), [], 'every row carries the current sig');
    const q = await embedder.embedQuery('My morning coffee is an oat-milk flat white.');
    const hits = await store.search({ query: '', queryEmbedding: q, mode: 'semantic', sig: embedder.sig });
    assert.equal(hits[0].title, 'Oat-milk flat white, no sugar');
  } finally {
    await store.close();
    await embedder.close();
  }
});

test('eval: hybrid hitRateAt5 on evals/corpus.json >= 22/24, train and holdout apart; coffee at rank 1', live, async (t) => {
  const embedder = await createEmbedder({ model: MODEL, cacheDir: CACHE, log: quiet });
  const store = await openStore({ path: ':memory:', dims: embedder.dims, log: quiet });
  try {
    const { memories, corpus } = await loadEvalFixtures(EVALS);
    for (const row of seedRows(memories)) await store.insert(row);
    await reindex(store, embedder);
    const search = async (query) => store.search({
      query, queryEmbedding: await embedder.embedQuery(query), mode: 'auto', limit: 5, sig: embedder.sig,
    });
    const rows = [];
    for (const q of corpus.queries) {
      rows.push({ id: q.id, split: q.split, expectedTitles: q.expectedTitles, titles: (await search(q.query)).map((h) => h.title) });
    }
    const all = hitRateAtK(rows, 5);
    const train = hitRateAtK(rows.filter((r) => r.split === 'train'), 5);
    const holdout = hitRateAtK(rows.filter((r) => r.split === 'holdout'), 5);
    t.diagnostic(`hybrid hitRateAt5: all ${all.toFixed(3)} · train ${train.toFixed(3)} · holdout ${holdout.toFixed(3)} (bar: full-text 22/24 = 0.917; measured at spec time 24/24)`);
    assert.ok(all >= 22 / 24, `all ${all}`);
    assert.ok(train >= 15 / 16, `train ${train}`);
    assert.ok(holdout >= 7 / 8, `holdout ${holdout}`);

    const coffee = await search('what coffee do I drink in the morning');
    assert.match(coffee[0].title, /flat white/i, `rank 1 was "${coffee[0]?.title}" (S2.3 open finding)`);
  } finally {
    await store.close();
    await embedder.close();
  }
});

test('close() frees the model: a child process that embeds and closes exits by itself', live, async () => {
  const script = `
    import { createEmbedder } from ${JSON.stringify(join(REPO, 'src/embeddings/local-embedder.js'))};
    const e = await createEmbedder({ model: ${JSON.stringify(MODEL)}, cacheDir: ${JSON.stringify(CACHE)}, log: { warn() {}, info() {} } });
    await e.embed('x');
    await e.close();
    console.log('closed');`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 60_000 });
  assert.match(stdout, /closed/);
});

test('try:search uses meaning search too: the coffee sentence shows a vec match at rank 1', live, () => withTemp(async (root) => {
  const { stdout } = await run(process.execPath, [join(REPO, 'scripts/try-search.mjs'), 'what coffee do I drink in the morning'], { cwd: root, timeout: 120_000 });
  const firstRow = stdout.split('\n').find((line) => /^\s+1\s/.test(line));
  assert.ok(firstRow, stdout);
  assert.match(firstRow, /vec/);
  assert.match(firstRow, /flat white/i);
  assert.deepEqual(await readdir(root), [], 'try:search writes nothing to disk');
}));
