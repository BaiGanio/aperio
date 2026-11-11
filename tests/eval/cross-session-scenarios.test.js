// T2.7 - the 2 cross-session scenarios use the explicit "Remember that" ask
// in session A (spec S2.7 §2 "Fixture change", approved 2026-11-11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadEvalFixtures } from '../../src/eval/fixtures.js';

const fx = await loadEvalFixtures(fileURLToPath(new URL('../../evals/', import.meta.url)));
const CROSS = { 'uwh-cross-session-standup': 'train', 'uwh-cross-session-pager': 'holdout' };

test('session A starts with "Remember that"; its text holds every required term; session B gives no hint', () => {
  for (const [id, split] of Object.entries(CROSS)) {
    const s = fx.scenarios.find((x) => x.id === id);
    assert.ok(s, id);
    assert.equal(s.split, split, id);
    assert.equal(s.sessions.length, 2, id);
    const ask = s.sessions[0].turns[0].user;
    assert.match(ask, /^Remember that /, `${id}: ${ask}`);
    const scored = s.sessions[1].turns.find((t) => t.expect.metric === 'usedWithoutHint');
    for (const term of scored.expect.requiredAnswerTerms) {
      assert.ok(ask.includes(term), `${id}: "${term}" is in the ask`);
      assert.ok(!s.sessions[1].turns.some((t) => t.user.includes(term)), `${id}: "${term}" is no hint in session B`);
    }
  }
});
