// T2.7 rev 3 - the remember duplicate bar, real embedder (spec S2.7 rev 3 §2.3).
//
// evals/remember-dup.json: every duplicate case scores >= REMEMBER_DUP_SCORE
// against its seeded row, every save case scores below it. Measured on train
// (L-M10). SKIPS when the S2.4 model is not cached.

import { describe, test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../src/config/read-config.js';
import { openStore } from '../../src/store/open-store.js';
import { createEmbedder } from '../../src/embeddings/local-embedder.js';
import { reindex } from '../../src/embeddings/embed-reindex.js';
import { loadEvalFixtures, seedRows } from '../../src/eval/fixtures.js';
import { rememberTool } from '../../src/tools/memory-tools.js';

const EVALS = fileURLToPath(new URL('../../evals/', import.meta.url));
const { cases } = JSON.parse(await readFile(join(EVALS, 'remember-dup.json'), 'utf8'));
const CONFIG = readConfig({}).values;
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });
const by = (label) => cases.filter((c) => c.label === label);
/** The content the model would pass: the ask without its "Remember (that)" cue. */
const contentOf = (text) => text.replace(/^.*?remember(\s+that)?\s*:?\s*/i, '').replace(/\s+(Thanks|That is all)\.$/, '');

test('fixture shape: 30 save, 4 duplicate, unique ids', () => {
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.equal(by('save').length, 30);
  assert.equal(by('duplicate').length, 4);
});

const MODEL = CONFIG.EMBEDDING_MODEL;
const CACHE = CONFIG.TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());
const gate = existsSync(join(CACHE, MODEL, 'onnx')) ? {} : { skip: `SKIPPED: ${MODEL} is not in ${CACHE}. Run: npm run model:fetch` };

describe('remember duplicate bar, real embedder', gate, () => {
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
    const content = contentOf(text);
    const [hit] = await store.search({ query: content, queryEmbedding: await embedder.embed(content), mode: 'semantic', limit: 1, sig: embedder.sig });
    return { title: hit?.title, score: Math.round((hit?.score ?? 0) * 100) };
  };

  test('REMEMBER_DUP_SCORE sits in the gap: every duplicate >= it, every save case < it', async (t) => {
    const dup = [];
    for (const c of by('duplicate')) dup.push({ id: c.id, ...(await top(c.text)), want: c.duplicateOf });
    const save = [];
    for (const c of by('save')) save.push({ id: c.id, ...(await top(c.text)) });
    t.diagnostic(JSON.stringify({ bar: CONFIG.REMEMBER_DUP_SCORE, dup, saveMax: save.reduce((m, x) => (x.score > m.score ? x : m)) }));
    for (const d of dup) {
      assert.equal(d.title, d.want, `${d.id} finds its seeded row`);
      assert.ok(d.score >= CONFIG.REMEMBER_DUP_SCORE, `${d.id}: ${d.score} >= ${CONFIG.REMEMBER_DUP_SCORE}`);
    }
    for (const s of save) assert.ok(s.score < CONFIG.REMEMBER_DUP_SCORE, `${s.id}: ${s.score} < ${CONFIG.REMEMBER_DUP_SCORE}`);
  });

  test('the remember tool returns duplicate: true for every duplicate case and saves no row', async () => {
    const before = (await store.counts()).total;
    for (const c of by('duplicate')) {
      const r = await rememberTool.run({ content: contentOf(c.text) }, { store, embedder, config: CONFIG, log: quiet() });
      assert.equal(r.duplicate, true, c.id);
    }
    assert.equal((await store.counts()).total, before);
  });
});
