// tests/eval/eval-runner.test.js — T2.1 runner against the fake adapter
// (spec S2.1 §2 "Scenario contract", "Runs", "Errors", "Limits").

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModel, turnWithRetry } from '../../src/eval/runner.js';
import { resolveEvalSettings } from '../../src/eval/settings.js';
import { makeFakeAdapter } from './fake-adapter.js';

const memories = {
  asOf: '2026-11-01T12:00:00.000Z',
  memories: [
    { type: 'decision', title: 'Nimbus uses NATS', content: 'NATS JetStream.', tags: [], importance: 3, daysAgo: 3 },
    { type: 'fact', title: 'Beacon is SwiftUI', content: 'iOS 16.', tags: [], importance: 2, daysAgo: 20 },
    { type: 'fact', title: 'Lunch is at noon', content: 'Set live.', tags: [], importance: 1, daysAgo: 1, seed: false, setBy: 'cross' },
  ],
};
const corpus = {
  queries: [
    { id: 'q1', category: 'semantic', split: 'train', query: 'nimbus events', expectedTitles: ['Nimbus uses NATS'] },
    { id: 'q2', category: 'keyword', split: 'holdout', query: 'beacon ui', expectedTitles: ['Beacon is SwiftUI'] },
  ],
};
const scenarios = [
  {
    id: 'cross', kind: 'used-without-hint', split: 'train', title: 'A fact said in one session is used in the next',
    sessions: [
      { id: 'a', turns: [{ user: 'Note: lunch is at noon.', expect: {} }] },
      { id: 'b', turns: [{ user: 'When is lunch?', expect: { metric: 'usedWithoutHint', requiredAnswerTerms: ['noon'] } }] },
    ],
  },
  {
    id: 'tool', kind: 'tool-call', split: 'holdout', title: 'The assistant looks a fact up with a tool',
    sessions: [{ id: 'a', turns: [
      { user: 'hello', expect: {} },
      { user: 'What does Nimbus use?', expect: { metric: 'toolSuccess', expectedToolSequence: ['recall'], requiredAnswerTerms: ['NATS'] } },
    ] }],
  },
  {
    id: 'hold-hint', kind: 'used-without-hint', split: 'holdout', title: 'A seeded fact is used without a hint',
    sessions: [{ id: 'a', turns: [{ user: 'hi', expect: {} }, { user: 'What UI does Beacon use?', expect: { metric: 'usedWithoutHint', requiredAnswerTerms: ['SwiftUI'] } }] }],
  },
  {
    id: 'train-tool', kind: 'tool-call', split: 'train', title: 'The assistant looks up a second fact with a tool',
    sessions: [{ id: 'a', turns: [{ user: 'hi', expect: {} }, { user: 'What does Nimbus use?', expect: { metric: 'toolSuccess', expectedToolSequence: ['recall'], requiredAnswerTerms: ['NATS'] } }] }],
  },
];
const fixtures = { memories, corpus, scenarios };

function smartAdapter(extra = {}) {
  return makeFakeAdapter({
    answer: (text, { sessionIndex }) => {
      if (/lunch/i.test(text) && sessionIndex === 1) return 'Lunch is at noon.';
      if (/Nimbus/.test(text)) return 'Nimbus uses NATS.';
      if (/Beacon/.test(text)) return 'Beacon is SwiftUI.';
      return 'ok';
    },
    toolEvents: (text) => (/Nimbus/.test(text) ? [{ type: 'tool_start', name: 'recall' }, { type: 'tool_result', name: 'recall', ok: true }] : []),
    titles: (query, _mode, store) => store.filter((m) => query.split(' ').some((w) => m.title.toLowerCase().includes(w))).map((m) => m.title),
    ...extra,
  });
}

async function tmpBase(t) {
  const dir = await mkdtemp(join(tmpdir(), 'aperio-eval-runner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('turnWithRetry', () => {
  test('an empty completion is retried and counted as emptyRetry', async () => {
    const adapter = makeFakeAdapter({ emptyCompletions: 2 });
    const session = await adapter.start({});
    const out = await turnWithRetry(session, 'hi', { maxEmptyRetries: 2 });
    assert.equal(out.emptyRetry, 2);
    assert.equal(out.empty, false);
    assert.equal(out.text, 'echo: hi');
  });

  test('still empty after the retry budget is reported, never silent', async () => {
    const adapter = makeFakeAdapter({ emptyCompletions: 5 });
    const session = await adapter.start({});
    const out = await turnWithRetry(session, 'hi', { maxEmptyRetries: 2 });
    assert.equal(out.emptyRetry, 2);
    assert.equal(out.empty, true);
  });
});

describe('runModel', () => {
  test('scores all 4 metrics for train and holdout separately, with spread', async (t) => {
    const settings = resolveEvalSettings({ runs: 3, tmpBase: await tmpBase(t) });
    const block = await runModel({ adapter: smartAdapter(), fixtures, settings, model: { id: 'fake-model' } });
    assert.equal(block.id, 'fake-model');
    for (const split of ['train', 'holdout']) {
      const b = block.splits[split];
      assert.equal(b.hitRateAt5.semantic.n, 3);
      assert.equal(b.hitRateAt5.semantic.mean, 1);
      assert.equal(b.usedWithoutHint.mean, 1, `${split} usedWithoutHint`);
      assert.equal(b.toolSuccess.mean, 1, `${split} toolSuccess`);
      assert.ok(b.latency.maxMs >= 0 && 'maxEventLoopLagMs' in b.latency);
      assert.ok('stdev' in b.toolSuccess);
    }
  });

  test('a new session keeps the store and drops the history: seed once, reset between sessions', async (t) => {
    const settings = resolveEvalSettings({ runs: 2, tmpBase: await tmpBase(t) });
    const adapter = smartAdapter();
    await runModel({ adapter, fixtures, settings, model: { id: 'm' } });
    // per run: one recall-corpus start + one start per scenario
    assert.equal(adapter.calls.start, 2 * (1 + scenarios.length));
    assert.equal(adapter.calls.stop, adapter.calls.start, 'every start is stopped');
    assert.equal(adapter.calls.seed, adapter.calls.start, 'each store is seeded exactly once');
    assert.equal(adapter.calls.reset, 2, 'one reset per run, for the one 2-session scenario');
  });

  test('the unseeded rows never reach the store', async (t) => {
    const settings = resolveEvalSettings({ runs: 2, tmpBase: await tmpBase(t) });
    const seen = [];
    const adapter = smartAdapter();
    const start = adapter.start;
    adapter.start = async (opts) => {
      const session = await start(opts);
      const seed = session.seedMemories;
      session.seedMemories = async (rows) => { seen.push(...rows.map((r) => r.title)); return seed(rows); };
      return session;
    };
    await runModel({ adapter, fixtures, settings, model: { id: 'm' } });
    assert.ok(!seen.includes('Lunch is at noon'));
    assert.ok(seen.includes('Nimbus uses NATS'));
  });

  test('seeded rows carry absolute dates resolved from asOf', async (t) => {
    const settings = resolveEvalSettings({ runs: 2, tmpBase: await tmpBase(t) });
    let first;
    const adapter = smartAdapter();
    const start = adapter.start;
    adapter.start = async (opts) => {
      const session = await start(opts);
      const seed = session.seedMemories;
      session.seedMemories = async (rows) => { first ??= rows[0]; return seed(rows); };
      return session;
    };
    await runModel({ adapter, fixtures, settings, model: { id: 'm' } });
    assert.equal(first.createdAt, '2026-10-29T12:00:00.000Z');
  });

  test('emptyRetry is counted into the split block', async (t) => {
    const settings = resolveEvalSettings({ runs: 2, tmpBase: await tmpBase(t) });
    const block = await runModel({ adapter: smartAdapter({ emptyCompletions: 1 }), fixtures, settings, model: { id: 'm' } });
    assert.ok(block.splits.train.emptyRetry > 0);
  });

  test('events beyond the per-turn bound are dropped and counted', async (t) => {
    const settings = resolveEvalSettings({ runs: 2, maxEventsPerTurn: 3, tmpBase: await tmpBase(t) });
    const block = await runModel({ adapter: smartAdapter(), fixtures, settings, model: { id: 'm' } });
    assert.ok(block.eventsDropped > 0);
    assert.ok(!JSON.stringify(block).includes('stream_start'), 'raw events are not kept after scoring');
  });

  test('a target that will not start fails loudly and leaves no temp dir', async (t) => {
    const base = await tmpBase(t);
    const settings = resolveEvalSettings({ runs: 2, tmpBase: base });
    const adapter = smartAdapter();
    adapter.start = async () => { throw new Error('llama-server exited 1'); };
    await assert.rejects(runModel({ adapter, fixtures, settings, model: { id: 'm' } }), /llama-server exited 1/);
    assert.deepEqual(await readdir(base), []);
  });

  test('an adapter that breaks the contract is refused before any run', async (t) => {
    const settings = resolveEvalSettings({ runs: 2, tmpBase: await tmpBase(t) });
    const adapter = smartAdapter();
    delete adapter.stop;
    await assert.rejects(runModel({ adapter, fixtures, settings, model: { id: 'm' } }), /stop/);
  });
});
