// T2.6 - turn assembly and the stable prefix (spec S2.6 §2 behaviour 7, §3;
// plan Appendix A1 item 4, A2; L-M03, L-M04, L-M22).
//
// The v2-live adapter runs with the REAL chat provider and a scripted fetch,
// so the test reads the exact bytes that would go on the wire. No server.

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/store/open-store.js';
import { RECALL_HEADER } from '../../src/context/recall-block.js';
import { assembleUserTurn, stablePrefix } from '../../src/context/assemble-turn.js';
import { createV2LiveAdapter } from '../../src/eval/v2-live-adapter.js';
import { assertSession, assertTargetAdapter } from '../../src/eval/adapter-contract.js';
import { sliceTurnEvents } from '../../src/eval/runner.js';

const { Response } = globalThis; // Node global the lint config does not list
const SIG = 'fake|4|test';
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });

const AXES = { coffee: [1, 0, 0, 0], nimbus: [0, 1, 0, 0], beacon: [0, 0, 1, 0] };
function vectorFor(text) {
  const t = String(text).toLowerCase();
  for (const [word, v] of Object.entries(AXES)) if (t.includes(word)) return Float32Array.from(v);
  return Float32Array.from([0, 0, 0, 1]);
}
const embed = async (text) => vectorFor(text);
const fakeEmbedder = () => ({ sig: SIG, dims: 4, embed, embedQuery: embed, close: async () => {} });

const TOOLS = [{ name: 'recall', description: 'Search memories.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
const CONFIG = Object.freeze({ RECALL_TOP_K: 5, RECALL_TOKEN_BUDGET: 1200, RECALL_MIN_SCORE: 50 });
const ROWS = [
  { type: 'preference', title: 'Oat-milk flat white', content: 'Maya drinks an oat-milk flat white coffee.', createdAt: '2026-10-01T09:00:00.000Z' },
  { type: 'decision', title: 'Nimbus SLO', content: 'Nimbus answers under 50ms p99.', createdAt: '2026-10-02T09:00:00.000Z' },
];

/** A fetch that answers every call with one short streamed reply and records the raw body. */
function wire() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ body: JSON.parse(init.body), raw: init.body });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: `answer ${calls.length}` } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, calls };
}

function makeAdapter({ recall = true, embedder = fakeEmbedder, log = quiet() } = {}) {
  const w = wire();
  const adapter = createV2LiveAdapter({
    config: CONFIG,
    recall,
    tools: TOOLS,
    deps: {
      openStore: (opts) => openStore({ ...opts, path: ':memory:', log: quiet() }),
      createEmbedder: async () => embedder(),
      startLlama: async () => ({ baseURL: 'http://127.0.0.1:1', capabilities: { tools: true, thinking: false }, stop: async () => {} }),
      fetch: w.fetch,
      dims: 4,
      log,
    },
  });
  return { adapter, wire: w, log };
}
const SANDBOX = { dbPath: ':memory:', port: 1, releasePort: async () => {} };
const start = (adapter) => adapter.start({ sandbox: SANDBOX, settings: {}, model: { id: 'fake-model' } });

describe('assembleUserTurn', () => {
  test('the block goes BEFORE the user text, in the same message', () => {
    assert.equal(assembleUserTurn({ recallBlock: 'B', text: 'hi' }), 'B\n\nhi');
  });
  test('no block: the user text exactly', () => {
    assert.equal(assembleUserTurn({ recallBlock: null, text: 'hi' }), 'hi');
  });
  test('stablePrefix is toolsJson + system', () => {
    assert.equal(stablePrefix({ toolsJson: '[x]', system: 'S', userTurn: 'u' }), '[x]S');
  });
});

describe('v2-live adapter: contract', () => {
  test('satisfies the TargetAdapter and Session shapes', async () => {
    const { adapter } = makeAdapter();
    assertTargetAdapter(adapter);
    assertSession(await start(adapter));
    await adapter.stop();
  });

  test('recall() returns titles from the store; seedMemories embeds the rows', async () => {
    const { adapter } = makeAdapter();
    const s = await start(adapter);
    await s.seedMemories(ROWS);
    const { titles } = await s.recall('coffee order', 5, { mode: 'semantic' });
    assert.equal(titles[0], 'Oat-milk flat white');
    await adapter.stop();
  });
});

describe('v2-live adapter: the stable prefix over 3 turns (A1 item 4)', () => {
  async function threeTurns() {
    const { adapter, wire: w } = makeAdapter();
    const s = await start(adapter);
    await s.seedMemories(ROWS);
    const results = [];
    for (const text of ['Hello there.', 'What coffee should I get Maya?', 'And is Nimbus inside its target at 70ms?']) {
      results.push(await s.turn(text));
    }
    await adapter.stop();
    return { results, calls: w.calls };
  }

  test('toolsJson + system byte-identical on every turn, one prefixHash; recall really ran', async () => {
    const { results, calls } = await threeTurns();
    const prefixes = new Set(results.map((r) => stablePrefix(r.assembled)));
    assert.equal(prefixes.size, 1, 'one stable prefix');
    assert.equal(new Set(results.map((r) => r.prefixHash)).size, 1, 'one prefixHash');
    assert.ok(results[1].assembled.userTurn.startsWith(RECALL_HEADER), 'turn 2 carries a block');
    assert.ok(results[2].assembled.userTurn.includes('Nimbus SLO'), 'turn 3 carries a block');
    // On the wire: the system message and the tools bytes never change.
    const systems = new Set(calls.map((c) => c.body.messages[0].content));
    assert.equal(systems.size, 1);
    assert.ok(![...systems][0].includes(RECALL_HEADER), 'recall is never in the system message');
    const tools = new Set(calls.map((c) => JSON.stringify(c.body.tools)));
    assert.equal(tools.size, 1);
  });

  test('teeth: the block moved into system (the v1 way) changes the prefix', async () => {
    const { results } = await threeTurns();
    const broken = results.map((r) => {
      const block = r.recall.block ?? '';
      return { ...r.assembled, system: `${r.assembled.system}${block}` };
    });
    assert.notEqual(new Set(broken.map(stablePrefix)).size, 1, 'the check must see the v1 break');
  });

  test('history keeps the injected user message byte for byte', async () => {
    const { results, calls } = await threeTurns();
    // Turn 3 wire: [system, user1, assistant1, user2, assistant2, user3]
    const m = calls[2].body.messages;
    assert.equal(m.length, 6);
    assert.equal(m[1].content, results[0].assembled.userTurn);
    assert.equal(m[3].content, results[1].assembled.userTurn);
    assert.equal(m[5].content, results[2].assembled.userTurn);
    assert.equal(m[2].content, 'answer 1');
    // Turn 2's wire is an exact prefix of turn 3's wire (KV reuse).
    const turn2 = JSON.stringify(calls[1].body.messages);
    assert.ok(JSON.stringify(m).startsWith(turn2.slice(0, -1)), 'turn 2 messages are a prefix of turn 3');
  });

  test('a turn returns the event slice the runner scores', async () => {
    const { results } = await threeTurns();
    const types = results[1].events.map((e) => e.type);
    // Recall runs before the model call, so its event comes before stream_start;
    // the runner's slice starts at stream_start (S2.1).
    assert.ok(types.indexOf('recall_injected') >= 0 && types.indexOf('recall_injected') < types.indexOf('stream_start'));
    assert.equal(sliceTurnEvents(results[1].events, 100).events[0].type, 'stream_start');
    assert.ok(!types.includes('token'), 'streamed tokens are not kept');
    assert.equal(types.at(-1), 'turn_complete');
    assert.equal(results[1].events.at(-1).status, 'completed');
    assert.equal(results[1].text, 'answer 2');
  });

  test('reset() starts a new session: history gone, injected rows can come back, store kept', async () => {
    const { adapter, wire: w } = makeAdapter();
    const s = await start(adapter);
    await s.seedMemories(ROWS);
    await s.turn('coffee for Maya?');
    await s.reset();
    const r = await s.turn('coffee for Maya?');
    assert.ok(r.assembled.userTurn.startsWith(RECALL_HEADER), 'injected again after reset');
    assert.equal(w.calls[1].body.messages.length, 2, 'system + this user turn only');
    await adapter.stop();
  });
});

describe('v2-live adapter: switches and failures', () => {
  test('recall off (the baseline run): the user turn is the text exactly', async () => {
    const { adapter } = makeAdapter({ recall: false });
    const s = await start(adapter);
    await s.seedMemories(ROWS);
    const r = await s.turn('What coffee should I get Maya?');
    assert.equal(r.assembled.userTurn, 'What coffee should I get Maya?');
    assert.notEqual(adapter.name, makeAdapter().adapter.name, 'the two runs report apart');
    await adapter.stop();
  });

  test('embedder missing: recall_skipped + one warn, and the turn still answers', async () => {
    const log = quiet();
    const missing = () => { throw Object.assign(new Error('model not in cache. Run: npm run model:fetch'), { name: 'EmbeddingUnavailable' }); };
    const { adapter } = makeAdapter({ embedder: missing, log });
    const s = await start(adapter);
    await s.seedMemories(ROWS);
    const r1 = await s.turn('coffee for Maya?');
    const r2 = await s.turn('and Nimbus?');
    assert.equal(r1.text, 'answer 1');
    assert.equal(r2.text, 'answer 2');
    assert.ok(r1.events.some((e) => e.type === 'recall_skipped'));
    assert.ok(r2.events.some((e) => e.type === 'recall_skipped'));
    assert.equal(r1.assembled.userTurn, 'coffee for Maya?');
    assert.equal(log.warn.mock.callCount(), 1, 'one warn for the whole session');
    await adapter.stop();
  });

  test('stop() frees everything: store closed, embedder closed, server stopped', async () => {
    const closed = { embedder: 0, server: 0 };
    const w = wire();
    const adapter = createV2LiveAdapter({
      config: CONFIG,
      tools: TOOLS,
      deps: {
        openStore: (opts) => openStore({ ...opts, path: ':memory:', log: quiet() }),
        createEmbedder: async () => ({ ...fakeEmbedder(), close: async () => { closed.embedder++; } }),
        startLlama: async () => ({ baseURL: 'http://127.0.0.1:1', capabilities: { tools: true, thinking: false }, stop: async () => { closed.server++; } }),
        fetch: w.fetch,
        dims: 4,
        log: quiet(),
      },
    });
    const s = await start(adapter);
    await s.seedMemories(ROWS);
    await adapter.stop();
    assert.deepEqual(closed, { embedder: 1, server: 1 });
    await adapter.stop(); // a second stop is safe
    assert.deepEqual(closed, { embedder: 1, server: 1 });
  });
});
