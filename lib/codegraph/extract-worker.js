// lib/codegraph/extract-worker.js
// Worker-thread entry for codegraph extraction. See lib/helpers/extractorPool.js
// for why extraction moved off the main thread.
//
// The registry below is closed on purpose: the main thread sends a key, never a
// module path, so this file is the only place that decides what can be loaded.
// Keys match lib/codegraph/indexer.js's pickExtractor().

import { parentPort } from 'node:worker_threads';
import { extract as extractTs } from './extract-ts.js';
import { extract as extractGeneric } from './extract-generic.js';

const EXTRACTORS = {
  ts: extractTs,
  generic: extractGeneric,
};

parentPort.on('message', async ({ id, key, source, relPath }) => {
  const fn = EXTRACTORS[key];
  if (!fn) {
    parentPort.postMessage({ id, ok: false, error: { message: `unknown extractor key: ${key}`, code: 'EXTRACT_NO_KEY' } });
    return;
  }
  try {
    // { symbols, edges } — plain arrays of plain objects, so the reply is
    // structured-cloneable without any massaging.
    parentPort.postMessage({ id, ok: true, result: await fn(source, relPath) });
  } catch (err) {
    // Errors do not survive structured clone with their own class, and the
    // stack is already logged by the caller's per-file handler. Send the two
    // fields the caller uses.
    parentPort.postMessage({ id, ok: false, error: { message: err?.message ?? String(err), code: err?.code } });
  }
});
