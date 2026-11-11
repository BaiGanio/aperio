#!/usr/bin/env node
// scripts/try-search.mjs - type a sentence, see which memories the store finds
// (spec S2.3 "Try it", S2.4 #8). It loads evals/memories.json into an
// in-memory store, so it writes nothing to disk. With the embedding model in
// the cache it searches by words and meaning ('auto'); without it, words only.
//
//   npm run try:search -- "What event bus does Nimbus use?"

import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load-config.js';
import { createEmbedder, EmbeddingUnavailable } from '../src/embeddings/local-embedder.js';
import { reindex } from '../src/embeddings/embed-reindex.js';
import { openStore } from '../src/store/open-store.js';
import { loadEvalFixtures, seedRows } from '../src/eval/fixtures.js';

const sentence = process.argv.slice(2).join(' ').trim();
if (!sentence) {
  console.error('Usage: npm run try:search -- "your sentence"');
  process.exit(1);
}

const quiet = { warn() {}, info() {} };
const { values } = await loadConfig({ envPath: fileURLToPath(new URL('../.env', import.meta.url)) });

let embedder = null;
let note = '';
try {
  embedder = await createEmbedder({ model: values.EMBEDDING_MODEL, cacheDir: values.TRANSFORMERS_CACHE, threads: values.EMBEDDING_THREADS, log: quiet });
} catch (err) {
  if (!(err instanceof EmbeddingUnavailable)) throw err;
  note = `No embedding model (${values.EMBEDDING_MODEL}), so word search only. Run: npm run model:fetch`;
}

const store = await openStore({ path: ':memory:', dims: embedder?.dims ?? 4, log: quiet });
try {
  const { memories } = await loadEvalFixtures(fileURLToPath(new URL('../evals/', import.meta.url)));
  const rows = seedRows(memories);
  for (const row of rows) await store.insert(row);
  if (embedder) await reindex(store, embedder);
  const hits = embedder
    ? await store.search({ query: sentence, queryEmbedding: await embedder.embedQuery(sentence), mode: 'auto', limit: 5, sig: embedder.sig })
    : await store.search({ query: sentence, mode: 'fulltext', limit: 5 });

  console.log(`Sentence: ${sentence}`);
  console.log(`Store:    ${rows.length} test memories (evals/memories.json), ${embedder ? 'words + meaning' : 'words only'}`);
  if (note) console.log(note);
  console.log('');
  if (hits.length === 0) {
    console.log('No match. The code would add nothing to the turn.');
  } else {
    console.log('Rank  Score  Match    Title');
    hits.forEach((hit, i) => {
      console.log(`${String(i + 1).padStart(4)}  ${hit.score.toFixed(2).padStart(5)}  ${hit.matched.join('+').padEnd(7)}  ${hit.title}`);
    });
    console.log('\nScore is relative to the best row (best = 1.00). Match: which search found the row (words, meaning, or both).');
  }
} finally {
  await store.close();
  await embedder?.close();
}
