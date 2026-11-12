#!/usr/bin/env node
// scripts/import-v1.mjs - copy memories from a v1 DB into the v2 DB (spec S2.12, TR3).
//
//   npm run import:v1 -- --from /path/to/v1/aperio.db [--dry-run]
//
// The target is the v2 DB from config (SQLITE_PATH). The v1 file is only
// copied, never opened in place. Stop v1 before you import, so its -wal is still.

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load-config.js';
import { createEmbedder, EmbeddingUnavailable } from '../src/embeddings/local-embedder.js';
import { openStore } from '../src/store/open-store.js';
import { ImportError, formatReport, importV1 } from '../src/store/import-v1.js';

const fail = (message) => {
  console.error(`import:v1: ${message}`);
  process.exit(1);
};

let args;
try {
  args = parseArgs({ options: { from: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } }).values;
} catch (err) {
  fail(err.message);
}
if (!args.from) fail('usage: npm run import:v1 -- --from <v1.db> [--dry-run]');

const quiet = { warn() {}, info() {} };
const { values } = await loadConfig({ envPath: fileURLToPath(new URL('../.env', import.meta.url)) });
const v1Path = resolve(args.from);
const v2Path = resolve(values.SQLITE_PATH);
if (v1Path === v2Path) fail(`--from is the v2 DB itself (${v2Path}). Give the v1 DB.`);
// Check the source before the v2 DB is opened: a typo must not create an empty v2 DB.
try {
  await access(v1Path);
} catch {
  fail(`the v1 file was not found: ${v1Path}`);
}

// The store's vector width comes from the model. A guessed width would drop
// every vector already in the v2 DB, so no model means no import.
let embedder;
try {
  embedder = await createEmbedder({ model: values.EMBEDDING_MODEL, cacheDir: values.TRANSFORMERS_CACHE, threads: values.EMBEDDING_THREADS, log: quiet });
} catch (err) {
  if (!(err instanceof EmbeddingUnavailable)) throw err;
  fail(`no embedding model (${values.EMBEDDING_MODEL}). Run: npm run model:fetch`);
}

let store;
try {
  store = await openStore({ path: v2Path, dims: embedder.dims, log: console });
} catch (err) {
  await embedder.close();
  fail(`cannot open the v2 DB at ${v2Path}: ${err.message}`);
}

try {
  console.log(`From (v1, read from a copy): ${v1Path}`);
  console.log(`To   (v2):                   ${v2Path}\n`);
  const report = await importV1({ v1Path, store, embedder, log: console, dryRun: args['dry-run'] });
  console.log(formatReport(report));
} catch (err) {
  if (!(err instanceof ImportError)) throw err;
  process.exitCode = 1;
  console.error(`import:v1: ${err.message}`);
} finally {
  await store.close();
  await embedder.close();
}
