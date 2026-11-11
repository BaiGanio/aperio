#!/usr/bin/env node
// scripts/try-search.mjs - type a sentence, see which memories the store finds
// (spec S2.3 "Try it"). It loads evals/memories.json into an in-memory store,
// so it writes nothing to disk. Full-text only until embeddings exist (S2.4).
//
//   npm run try:search -- "What event bus does Nimbus use?"

import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store/open-store.js';
import { loadEvalFixtures, seedRows } from '../src/eval/fixtures.js';

const sentence = process.argv.slice(2).join(' ').trim();
if (!sentence) {
  console.error('Usage: npm run try:search -- "your sentence"');
  process.exit(1);
}

const quiet = { warn() {}, info() {} };
const store = await openStore({ path: ':memory:', dims: 4, log: quiet });
try {
  const { memories } = await loadEvalFixtures(fileURLToPath(new URL('../evals/', import.meta.url)));
  const rows = seedRows(memories);
  for (const row of rows) await store.insert(row);
  const hits = await store.search({ query: sentence, mode: 'fulltext', limit: 5 });

  console.log(`Sentence: ${sentence}`);
  console.log(`Store:    ${rows.length} test memories (evals/memories.json), full-text only\n`);
  if (hits.length === 0) {
    console.log('No match. The code would add nothing to the turn.');
  } else {
    console.log('Rank  Score  Match  Title');
    hits.forEach((hit, i) => {
      console.log(`${String(i + 1).padStart(4)}  ${hit.score.toFixed(2).padStart(5)}  ${hit.matched.join('+').padEnd(5)}  ${hit.title}`);
    });
    console.log('\nScore is word-match strength, relative to the best row (best = 1.00).');
  }
} finally {
  await store.close();
}
