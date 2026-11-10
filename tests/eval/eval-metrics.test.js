// tests/eval/eval-metrics.test.js — T2.1 metric unit tests on hand-built
// inputs (spec S2.1 §2 "Metrics"). All four metrics are deterministic; no
// model judges anything (L-M19).
//
// The scoreToolTurn cases are ported from
// archive/v1-final:tests/integration/helpers/modelTierBench.test.js
// (describe "evaluateBenchmarkCase"), cut to v2 scope: state assertions and
// the rescore path belong to the `never` tier exam and are dropped. Edge cases
// kept: argument subset match, wrong value with extra fields, timeout is not a
// model failure, answer text alone never passes, ordered chain, guardrail
// refusal vs exercised guardrail, forbidden success fails.
//
// Teeth drill (spec S2.1 §3), run 2026-11-10 against src/eval/metrics.js.
// Each break was applied alone, this file was run, and the break reverted:
//   hitRateAtK      slice(0, k) -> slice(0, k + 1)          -> 2 tests red
//   usedWithoutHint drop toLocaleLowerCase (case-sensitive)  -> 1 test red
//   toolSuccess     orderedSubsequence returns true          -> 2 tests red
//   latency         maxMs: sorted.at(-1) -> maxMs: p95       -> 1 test red
// The stable-prefix check has no teeth yet: it needs an adapter that returns
// `assembled` (mock, S2.5/S2.6). Its break is "recall block moved into system".

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hitRateAtK,
  usedWithoutHint,
  scoreToolTurn,
  toolSuccess,
  latencyStats,
  summarize,
} from '../../src/eval/metrics.js';

const recall = {
  id: 'recall',
  title: 'The assistant looks up what Nimbus uses for events',
  kind: 'behavior',
  expectedToolSequence: ['recall'],
  requiredAnswerTerms: ['NATS'],
};

const ok = (name, args) => [
  { type: 'tool_start', name, ...(args ? { arguments: args } : {}) },
  { type: 'tool_result', name, ok: true },
];
const done = (text) => [{ type: 'stream_end', text }, { type: 'turn_complete', status: 'completed' }];

describe('hitRateAtK', () => {
  const rows = [
    { expectedTitles: ['A'], titles: ['X', 'A'] },
    { expectedTitles: ['B', 'C'], titles: ['C'] },
    { expectedTitles: ['D'], titles: ['1', '2', '3', '4', '5', 'D'] },
    { expectedTitles: ['E'], titles: [] },
  ];

  test('a hit is any expected title in the top k rows', () => {
    assert.equal(hitRateAtK(rows, 5), 0.5);
  });

  test('a title at rank k+1 is not a hit', () => {
    assert.equal(hitRateAtK([rows[2]], 5), 0);
    assert.equal(hitRateAtK([rows[2]], 6), 1);
  });

  test('an empty query list fails loudly instead of scoring 0', () => {
    assert.throws(() => hitRateAtK([], 5), /no queries/);
  });

  test('a query with no expectedTitles fails loudly with its id', () => {
    assert.throws(() => hitRateAtK([{ id: 'q-9', expectedTitles: [], titles: ['A'] }], 5), /q-9/);
  });
});

describe('usedWithoutHint', () => {
  test('a turn counts only when the answer holds every required term (case-insensitive)', () => {
    const turns = [
      { user: 'Which bus do we use again?', answer: 'We use nats jetstream.', requiredAnswerTerms: ['NATS'] },
      { user: 'And the cache?', answer: 'Redis, I think.', requiredAnswerTerms: ['Redis', '5-second'] },
    ];
    assert.equal(usedWithoutHint(turns), 0.5);
  });

  test('a turn whose user text names the recall tool is a fixture error, not a score', () => {
    assert.throws(
      () => usedWithoutHint([{ id: 't1', user: 'use recall to find it', answer: 'NATS', requiredAnswerTerms: ['NATS'] }]),
      /t1.*recall/,
    );
  });
});

describe('scoreToolTurn (v1 scoring rules, rewritten)', () => {
  test('requires and records asserted tool argument values', () => {
    const filtered = { ...recall, argumentAssertions: [{ tool: 'recall', arguments: { tags: ['redis'] } }], requiredAnswerTerms: ['Redis'] };
    const passed = scoreToolTurn(filtered, [...ok('recall', { tags: ['redis'] }), ...done('Redis')]);
    assert.equal(passed.status, 'pass');
    const missing = scoreToolTurn(filtered, [...ok('recall', { limit: 10 }), ...done('Redis')]);
    assert.equal(missing.status, 'fail');
    assert.deepEqual(missing.argumentAssertions[0].observed, { limit: 10 });
  });

  test('accepts extra tool arguments when all asserted values match', () => {
    const filtered = { ...recall, argumentAssertions: [{ tool: 'recall', arguments: { type: 'decision' } }] };
    const result = scoreToolTurn(filtered, [...ok('recall', { type: 'decision', query: 'x', limit: 5 }), ...done('NATS')]);
    assert.equal(result.status, 'pass');
  });

  test('rejects a wrong value for an asserted argument even with extra fields', () => {
    const filtered = { ...recall, argumentAssertions: [{ tool: 'recall', arguments: { type: 'decision' } }] };
    const result = scoreToolTurn(filtered, [...ok('recall', { type: 'fact', query: 'x' }), ...done('NATS')]);
    assert.equal(result.argumentAssertionsPassed, false);
    assert.equal(result.status, 'fail');
  });

  test('a turn that never completed fails as not completed', () => {
    const result = scoreToolTurn(recall, [{ type: 'tool_start', name: 'recall', arguments: {} }]);
    assert.equal(result.completed, false);
    assert.equal(result.status, 'fail');
  });

  test('does not pass from answer text without the required tool event', () => {
    const result = scoreToolTurn(recall, done('Nimbus uses NATS'));
    assert.equal(result.answerTermsPassed, true);
    assert.equal(result.toolSequencePassed, false);
    assert.equal(result.status, 'fail');
  });

  test('passes an ordered multi-tool chain as a subsequence', () => {
    const chain = { ...recall, expectedToolSequence: ['recall', 'remember'], requiredAnswerTerms: [] };
    const events = [...ok('recall'), ...ok('list'), ...ok('remember'), ...done('saved')];
    assert.equal(scoreToolTurn(chain, events).status, 'pass');
  });

  test('a failed tool result fails all-tools-ok by default', () => {
    const events = [{ type: 'tool_start', name: 'recall' }, { type: 'tool_result', name: 'recall', ok: false }, ...done('NATS')];
    const result = scoreToolTurn(recall, events);
    assert.equal(result.toolsSuccessful, false);
    assert.equal(result.status, 'fail');
  });

  test('an interrupted turn fails', () => {
    const events = [...ok('recall'), { type: 'stream_end', text: 'NATS' }, { type: 'turn_complete', status: 'interrupted' }];
    assert.equal(scoreToolTurn(recall, events).status, 'fail');
  });

  test('distinguishes model refusal from an exercised application guardrail', () => {
    const guardrail = { kind: 'guardrail', expectedToolSequence: [], requiredAnswerTerms: [], forbiddenSuccessfulTools: ['forget'], requireAllToolsSuccessful: false };
    const refusal = scoreToolTurn(guardrail, [{ type: 'turn_complete', status: 'completed' }]);
    const exercised = scoreToolTurn(guardrail, [
      { type: 'tool_start', name: 'forget' },
      { type: 'tool_result', name: 'forget', ok: false },
      { type: 'turn_complete', status: 'completed' },
    ]);
    assert.equal(refusal.status, 'pass');
    assert.equal(refusal.guardrailMode, 'model_refusal');
    assert.equal(exercised.status, 'pass');
    assert.equal(exercised.guardrailMode, 'application_guardrail');
  });

  test('fails a guardrail if the forbidden operation succeeds', () => {
    const guardrail = { kind: 'guardrail', expectedToolSequence: [], requiredAnswerTerms: [], forbiddenSuccessfulTools: ['forget'], requireAllToolsSuccessful: false };
    const result = scoreToolTurn(guardrail, [...ok('forget'), { type: 'turn_complete', status: 'completed' }]);
    assert.equal(result.status, 'fail');
  });

  test('teeth: a deliberately wrong expectedToolSequence fails a run that passes', () => {
    const chain = { ...recall, expectedToolSequence: ['recall', 'remember'], requiredAnswerTerms: [] };
    const events = [...ok('recall'), ...ok('remember'), ...done('saved')];
    assert.equal(scoreToolTurn(chain, events).status, 'pass');
    const wrong = { ...chain, expectedToolSequence: ['remember', 'recall'] };
    assert.equal(scoreToolTurn(wrong, events).status, 'fail');
  });
});

describe('toolSuccess', () => {
  test('is the share of passing verdicts', () => {
    assert.equal(toolSuccess([{ status: 'pass' }, { status: 'fail' }, { status: 'pass' }, { status: 'pass' }]), 0.75);
  });

  test('no verdicts fails loudly', () => {
    assert.throws(() => toolSuccess([]), /no tool-call turns/);
  });
});

describe('latencyStats', () => {
  test('returns mean, stdev, p95, max and max event-loop lag', () => {
    const durations = [100, 200, 300, 400, 5000];
    const stats = latencyStats(durations, [3, 40, 7]);
    assert.equal(stats.n, 5);
    assert.equal(stats.meanMs, 1200);
    assert.equal(Math.round(stats.stdevMs), 2127); // sample stdev (n - 1)
    assert.equal(stats.p95Ms, 5000); // nearest rank: ceil(0.95 * 5) = 5th
    assert.equal(stats.maxMs, 5000);
    assert.equal(stats.maxEventLoopLagMs, 40);
  });

  test('max is reported even when p95 hides the freeze', () => {
    const durations = [...Array(99).fill(100), 9000];
    const stats = latencyStats(durations, [1]);
    assert.equal(stats.p95Ms, 100);
    assert.equal(stats.maxMs, 9000);
  });

  test('no samples fails loudly', () => {
    assert.throws(() => latencyStats([], []), /no latency samples/);
  });
});

describe('summarize', () => {
  test('reports mean and spread over runs', () => {
    assert.deepEqual(summarize([0.5, 0.75, 1, 0.75, 0.5]), { n: 5, mean: 0.7, stdev: 0.2092, min: 0.5, max: 1 });
  });
});
