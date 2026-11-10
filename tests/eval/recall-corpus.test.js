// tests/eval/recall-corpus.test.js — T2.1 fixture self-test.
//
// Ported from archive/v1-final:tests/unit/memory/recall-corpus.test.js and
// retargeted at evals/. All four v1 checks are kept as they were. Added for
// v2 scope (spec S2.1 §3): every query carries a split, the split is 16/8,
// and an expected title must belong to a row that is actually seeded — a
// title that is never in the store scores a meaningless 0%.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = join(here, '../../evals');

async function loadJson(name) {
  return JSON.parse(await readFile(join(evalsDir, name), 'utf8'));
}

const corpus = (await loadJson('corpus.json')).queries;
const memories = (await loadJson('memories.json')).memories;
const allTitles = new Set(memories.map((m) => m.title));
const seededTitles = new Set(memories.filter((m) => m.seed !== false).map((m) => m.title));

describe('eval recall corpus', () => {
  test('every expectedTitles entry exists verbatim in memories.json', () => {
    for (const q of corpus) {
      for (const title of q.expectedTitles) {
        assert.ok(allTitles.has(title), `corpus entry "${q.id}" names a title not in memories.json: ${JSON.stringify(title)}`);
      }
    }
  });

  test('every expectedTitles entry belongs to a seeded row', () => {
    for (const q of corpus) {
      for (const title of q.expectedTitles) {
        assert.ok(seededTitles.has(title), `corpus entry "${q.id}" expects an unseeded row: ${JSON.stringify(title)}`);
      }
    }
  });

  test('has at least 6 semantic and 6 keyword queries', () => {
    const semantic = corpus.filter((q) => q.category === 'semantic');
    const keyword = corpus.filter((q) => q.category === 'keyword');
    assert.ok(semantic.length >= 6, `expected >=6 semantic queries, got ${semantic.length}`);
    assert.ok(keyword.length >= 6, `expected >=6 keyword queries, got ${keyword.length}`);
  });

  test('keyword queries are literal phrases, not prose describing a tag/type filter', () => {
    // v1 regression guard: prose like "show me everything tagged X" never
    // appears in memory content/title, so it scores a meaningless 0% against
    // fulltext search — a corpus bug, not a recall regression.
    const banned = /^(show|list|find|search for)\b.*\b(tagged|type:)/i;
    for (const q of corpus.filter((x) => x.category === 'keyword')) {
      assert.ok(!banned.test(q.query), `keyword query "${q.id}" looks like filter prose, not a literal phrase: ${JSON.stringify(q.query)}`);
    }
  });

  test('every query has at least one expected title', () => {
    for (const q of corpus) {
      assert.ok(Array.isArray(q.expectedTitles) && q.expectedTitles.length >= 1, `corpus entry "${q.id}" has no expectedTitles`);
    }
  });

  test('every query has a split, and the split is 16 train / 8 holdout', () => {
    for (const q of corpus) {
      assert.ok(q.split === 'train' || q.split === 'holdout', `corpus entry "${q.id}" has no valid split: ${JSON.stringify(q.split)}`);
    }
    assert.equal(corpus.length, 24);
    assert.equal(corpus.filter((q) => q.split === 'train').length, 16);
    assert.equal(corpus.filter((q) => q.split === 'holdout').length, 8);
  });

  test('the holdout split has both semantic and keyword queries', () => {
    const holdout = corpus.filter((q) => q.split === 'holdout');
    assert.ok(holdout.filter((q) => q.category === 'semantic').length >= 2);
    assert.ok(holdout.filter((q) => q.category === 'keyword').length >= 2);
  });

  test('query ids are unique', () => {
    const ids = corpus.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
