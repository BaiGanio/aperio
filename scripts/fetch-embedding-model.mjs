#!/usr/bin/env node
// scripts/fetch-embedding-model.mjs - download the embedding model into the
// local cache (spec S2.4 #2). This is the only code that downloads; at run
// time the embedder never touches the network.
//
//   npm run model:fetch

import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { env, pipeline } from '@huggingface/transformers';
import { loadConfig } from '../src/config/load-config.js';
import { createEmbedder } from '../src/embeddings/local-embedder.js';

const { values } = await loadConfig({ envPath: fileURLToPath(new URL('../.env', import.meta.url)) });
const model = values.EMBEDDING_MODEL;
const cacheDir = values.TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());

console.log(`Fetching ${model} (q8) into ${cacheDir} ...`);
env.allowRemoteModels = true;
env.cacheDir = cacheDir;
const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
await extractor.dispose();

// Prove it loads offline, the way the app loads it.
const embedder = await createEmbedder({ model, cacheDir, threads: values.EMBEDDING_THREADS, log: { warn() {}, info() {} } });
console.log(`Done. ${embedder.sig}`);
await embedder.close();
