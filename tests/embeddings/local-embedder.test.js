// T2.4 - the local embedder, with a fake transformers module (no model needed).
//
// Ported from v1 (archive/v1-final) tests/unit/helpers/embeddings.test.js,
// "generateEmbedding - Transformers": "passes text and pooling options to the
// pipeline" and "returns null when pipeline throws". v2 changes the second
// one on purpose: a failure throws, it never returns a silent null (spec S2.4
// errors, AP5). The Voyage cases are not ported (one local model only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder, EmbeddingUnavailable } from '../../src/embeddings/local-embedder.js';

const quiet = { warn() {}, info() {} };

/** A fake `@huggingface/transformers`: records every call, returns a fixed-width vector. */
function fakeTransformers({ width = 8, failLoad = false, failEmbed = false } = {}) {
  const calls = { pipeline: [], extract: [], envAtLoad: null, disposed: 0 };
  const env = { allowRemoteModels: true, cacheDir: null };
  async function pipeline(task, model, opts) {
    calls.pipeline.push({ task, model, opts });
    calls.envAtLoad = { ...env };
    if (failLoad) throw new Error('Could not locate file: model.onnx');
    const extractor = async (text, options) => {
      calls.extract.push({ text, options });
      if (failEmbed && text !== 'probe' && calls.extract.length > 1) throw new Error('onnx run failed');
      return { data: Float32Array.from({ length: width }, (_, i) => (i + text.length) % 5) };
    };
    extractor.dispose = async () => { calls.disposed++; };
    return extractor;
  }
  return { module: { pipeline, env }, calls };
}

const make = (fake, over = {}) => createEmbedder({
  model: 'acme/tiny-embed', cacheDir: '/tmp/aperio-test-cache', log: quiet, transformers: fake.module, ...over,
});

test('loads one feature-extraction pipeline, q8, with remote models off and the given cache dir', async () => {
  const fake = fakeTransformers();
  const embedder = await make(fake);
  assert.equal(fake.calls.pipeline.length, 1);
  assert.deepEqual(fake.calls.pipeline[0], { task: 'feature-extraction', model: 'acme/tiny-embed', opts: { dtype: 'q8' } });
  assert.equal(fake.calls.envAtLoad.allowRemoteModels, false, 'no network at run time');
  assert.equal(fake.calls.envAtLoad.cacheDir, '/tmp/aperio-test-cache');
  await embedder.close();
});

test('passes the text with cls pooling and normalize to the pipeline (ported)', async () => {
  const fake = fakeTransformers();
  const embedder = await make(fake);
  const vector = await embedder.embed('Oat-milk flat white. Every morning.');
  const last = fake.calls.extract.at(-1);
  assert.equal(last.text, 'Oat-milk flat white. Every morning.');
  assert.deepEqual(last.options, { pooling: 'cls', normalize: true });
  assert.ok(Array.isArray(vector) || vector instanceof Float32Array);
  assert.equal(vector.length, 8);
  await embedder.close();
});

test('embedQuery uses the same recipe as embed (no query prefix, spec S2.4)', async () => {
  const fake = fakeTransformers();
  const embedder = await make(fake);
  await embedder.embedQuery('what coffee do I drink');
  assert.equal(fake.calls.extract.at(-1).text, 'what coffee do I drink');
  await embedder.close();
});

test('dims comes from a probe embedding; sig is model|dims|q8-cls', async () => {
  const fake = fakeTransformers({ width: 12 });
  const embedder = await make(fake);
  assert.equal(embedder.dims, 12);
  assert.equal(embedder.sig, 'acme/tiny-embed|12|q8-cls');
  await embedder.close();
});

test('a different model gives a different sig; two embedders share no state (TR15)', async () => {
  const a = await make(fakeTransformers({ width: 8 }));
  const b = await make(fakeTransformers({ width: 8 }), { model: 'acme/other-embed' });
  assert.notEqual(a.sig, b.sig);
  assert.equal(a.sig, 'acme/tiny-embed|8|q8-cls');
  await a.close();
  await b.close();
});

test('a model that cannot load throws EmbeddingUnavailable that names npm run model:fetch', async () => {
  await assert.rejects(make(fakeTransformers({ failLoad: true })), (err) => {
    assert.ok(err instanceof EmbeddingUnavailable, `got ${err?.name}`);
    assert.match(err.message, /npm run model:fetch/);
    assert.match(err.message, /acme\/tiny-embed/);
    return true;
  });
});

test('an embed failure throws, never a silent null (AP5)', async () => {
  const embedder = await make(fakeTransformers({ failEmbed: true }));
  await assert.rejects(embedder.embed('some text'), /onnx run failed/);
  await embedder.close();
});

test('close() disposes the pipeline; embed after close rejects', async () => {
  const fake = fakeTransformers();
  const embedder = await make(fake);
  await embedder.close();
  assert.equal(fake.calls.disposed, 1);
  await assert.rejects(embedder.embed('late'), /closed/);
});

test('a leading ~ in cacheDir means the home folder (the config default is ~/.cache/aperio/transformers)', async () => {
  const { homedir } = await import('node:os');
  const fake = fakeTransformers();
  const embedder = await make(fake, { cacheDir: '~/.cache/aperio/transformers' });
  assert.equal(fake.calls.envAtLoad.cacheDir, `${homedir()}/.cache/aperio/transformers`);
  await embedder.close();
});

test('model and cacheDir are required', async () => {
  const fake = fakeTransformers();
  await assert.rejects(make(fake, { model: '' }), /model/);
  await assert.rejects(make(fake, { cacheDir: '' }), /cacheDir/);
});
