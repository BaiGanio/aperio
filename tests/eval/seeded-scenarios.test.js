// T2.6 - the seeded used-without-hint scenarios (spec S2.6 §4 decision 4).
// Each one is answerable from a SEEDED row only: every required term is in a
// seeded memory, and no required term is in the user text (no hint).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadEvalFixtures, seedRows } from '../../src/eval/fixtures.js';

const fx = await loadEvalFixtures(fileURLToPath(new URL('../../evals/', import.meta.url)));
const SEEDED = { 'uwh-seeded-slo': 'train', 'uwh-seeded-coffee': 'train', 'uwh-seeded-beacon': 'holdout' };
const seededText = seedRows(fx.memories).map((m) => `${m.title} ${m.content}`.toLowerCase());

test('the 3 seeded scenarios exist with their split', () => {
  for (const [id, split] of Object.entries(SEEDED)) {
    const s = fx.scenarios.find((x) => x.id === id);
    assert.ok(s, id);
    assert.equal(s.kind, 'used-without-hint');
    assert.equal(s.split, split, id);
    assert.equal(s.sessions.length, 1, `${id}: one session, no capture needed`);
  }
});

test('every required term is in a seeded row, and never in the user text', () => {
  for (const id of Object.keys(SEEDED)) {
    const s = fx.scenarios.find((x) => x.id === id);
    const turns = s.sessions.flatMap((x) => x.turns);
    const scored = turns.filter((t) => t.expect.metric === 'usedWithoutHint');
    assert.equal(scored.length, 1, id);
    const userText = turns.map((t) => t.user).join(' ').toLowerCase();
    for (const term of scored[0].expect.requiredAnswerTerms) {
      const t = term.toLowerCase();
      assert.ok(seededText.some((m) => m.includes(t)), `${id}: "${term}" is in a seeded memory`);
      assert.ok(!userText.includes(t), `${id}: "${term}" is not a hint in the user text`);
    }
  }
});
