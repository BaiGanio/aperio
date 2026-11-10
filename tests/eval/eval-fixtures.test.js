// tests/eval/eval-fixtures.test.js — T2.1: memories.json dates and the
// scenario schema (spec S2.1 §2 "Fixtures", "Scenario contract", §3).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEvalFixtures, resolveMemoryDates, seedRows, trimArithmetic } from '../../src/eval/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = join(here, '../../evals');
const DAY = 86_400_000;
const SPLITS = new Set(['train', 'holdout']);

const fixtures = await loadEvalFixtures(evalsDir);

describe('memories.json', () => {
  test('has ~30 rows: the 28 v1 exam rows plus 2 rows set in one session and used in another', () => {
    const rows = fixtures.memories.memories;
    assert.ok(rows.length >= 28 && rows.length <= 32, `expected ~30 rows, got ${rows.length}`);
    const unseeded = rows.filter((m) => m.seed === false);
    assert.equal(unseeded.length, 2, 'exactly 2 rows are set by a scenario instead of seeded');
    assert.equal(seedRows(fixtures.memories).length, rows.length - 2);
  });

  test('every resolved date derives from the one fixed asOf and spreads over 8 weeks', () => {
    const asOf = Date.parse(fixtures.memories.asOf);
    assert.ok(Number.isFinite(asOf), 'asOf is an absolute ISO date');
    const resolved = resolveMemoryDates(fixtures.memories);
    const weeks = new Set();
    for (const row of resolved) {
      const at = Date.parse(row.createdAt);
      assert.ok(Number.isFinite(at), `${row.title}: createdAt is absolute`);
      const daysAgo = (asOf - at) / DAY;
      assert.ok(Number.isInteger(daysAgo) && daysAgo >= 0 && daysAgo < 56, `${row.title}: ${daysAgo} days before asOf`);
      weeks.add(Math.floor(daysAgo / 7));
    }
    assert.equal(weeks.size, 8, `every one of the 8 weeks holds a row, got weeks ${[...weeks].sort()}`);
  });

  test('resolving twice gives the same dates (no clock read)', () => {
    assert.deepEqual(resolveMemoryDates(fixtures.memories), resolveMemoryDates(fixtures.memories));
  });

  test('a row with no daysAgo fails loudly with its title', () => {
    const broken = { asOf: '2026-11-01T12:00:00.000Z', memories: [{ title: 'No date row' }] };
    assert.throws(() => resolveMemoryDates(broken), /No date row/);
  });
});

describe('scenarios', () => {
  const scenarios = fixtures.scenarios;

  test('every scenario has id, title, split, at least 1 session and at least 2 turns in total', () => {
    assert.ok(scenarios.length > 0);
    for (const s of scenarios) {
      assert.ok(typeof s.id === 'string' && s.id, 'scenario id');
      assert.ok(typeof s.title === 'string' && s.title.length > 10, `${s.id}: plain-sentence title`);
      assert.ok(SPLITS.has(s.split), `${s.id}: split`);
      assert.ok(Array.isArray(s.sessions) && s.sessions.length >= 1, `${s.id}: sessions`);
      const turns = s.sessions.flatMap((x) => x.turns);
      assert.ok(turns.length >= 2, `${s.id}: needs >= 2 turns, has ${turns.length}`);
      for (const turn of turns) {
        assert.ok(typeof turn.user === 'string' && turn.user, `${s.id}: every turn has user text`);
        assert.ok(turn.expect && typeof turn.expect === 'object', `${s.id}: every turn has expect{}`);
      }
    }
  });

  test('scenario ids are unique', () => {
    const ids = scenarios.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('at least one scenario has 2 or more sessions over one store', () => {
    assert.ok(scenarios.some((s) => s.sessions.length >= 2));
  });

  test('the minimum scenario set is present', () => {
    const count = (kind) => scenarios.filter((s) => s.kind === kind).length;
    assert.ok(count('used-without-hint') >= 3, 'used-without-hint >= 3');
    assert.ok(count('tool-call') >= 2, 'tool-call >= 2');
    assert.ok(count('trim') >= 1, 'trim >= 1');
    assert.ok(count('tail-slice') >= 1, 'tail-slice >= 1');
    assert.ok(count('cross-turn-guardrail') >= 1, 'cross-turn-guardrail >= 1');
    assert.ok(count('empty-completion') >= 1, 'empty-completion >= 1');
  });

  test('each scored metric has turns in both train and holdout', () => {
    for (const metric of ['usedWithoutHint', 'toolSuccess']) {
      for (const split of SPLITS) {
        const turns = scenarios.filter((s) => s.split === split)
          .flatMap((s) => s.sessions.flatMap((x) => x.turns))
          .filter((t) => t.expect.metric === metric);
        assert.ok(turns.length >= 1, `${metric} has no ${split} turn`);
      }
    }
  });

  test('a used-without-hint turn never names the recall tool and lists its required terms', () => {
    for (const s of scenarios) {
      for (const turn of s.sessions.flatMap((x) => x.turns)) {
        if (turn.expect.metric !== 'usedWithoutHint') continue;
        assert.ok(!/\brecall\b/i.test(turn.user), `${s.id}: the user names recall: ${turn.user}`);
        assert.ok(turn.expect.requiredAnswerTerms?.length >= 1, `${s.id}: requiredAnswerTerms`);
      }
    }
  });

  test('every unseeded memory row is set by a cross-session scenario', () => {
    const unseeded = fixtures.memories.memories.filter((m) => m.seed === false);
    for (const row of unseeded) {
      const owner = scenarios.find((s) => s.id === row.setBy);
      assert.ok(owner, `${row.title}: setBy names a real scenario`);
      assert.ok(owner.sessions.length >= 2, `${row.title}: set in one session and used in another`);
    }
  });

  test('trim and tail-slice arithmetic lands inside its branch, never on the boundary', () => {
    for (const s of scenarios.filter((x) => x.kind === 'trim' || x.kind === 'tail-slice')) {
      const math = trimArithmetic(s);
      if (s.kind === 'trim') {
        assert.ok(math.totalTokens > math.windowTokens, `${s.id}: history exceeds the window`);
        assert.equal(s.budget.expectedDropped, math.dropped, `${s.id}: expectedDropped is computed`);
        assert.ok(math.marginTokens >= s.budget.padTokensPerTurn / 2, `${s.id}: margin is not on the boundary`);
      } else {
        assert.ok(math.totalTokens < math.windowTokens, `${s.id}: stays under the window`);
        assert.ok(math.turns > s.budget.maxHistory, `${s.id}: more turns than maxHistory`);
      }
    }
  });
});
