// T2.7 rev 3 - the v2-live adapter: the model calls remember / recall, code
// runs them in-process and feeds the result back (spec S2.7 rev 3 §2.3-2.5, §3;
// plan Appendix A1 item 4, A2; L-M04, L-M22).
//
// The REAL chat provider and a scripted fetch, so the test reads the exact
// bytes that would go on the wire. No server.

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/store/open-store.js';
import { stablePrefix } from '../../src/context/assemble-turn.js';
import { createV2LiveAdapter, TEST_SYSTEM } from '../../src/eval/v2-live-adapter.js';
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

const CONFIG = Object.freeze({ RECALL_TOP_K: 5, REMEMBER_DUP_SCORE: 80 });
const ROWS = [
  { type: 'preference', title: 'Oat-milk flat white', content: 'Maya drinks an oat-milk flat white coffee.', createdAt: '2026-10-01T09:00:00.000Z' },
  { type: 'decision', title: 'Nimbus SLO', content: 'Nimbus answers under 50ms p99.', createdAt: '2026-10-02T09:00:00.000Z' },
];

const sse = (...chunks) => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } });
const say = (text) => sse({ choices: [{ delta: { content: text } }] });
const call = (name, args, id = 'call_1') => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });

/** A fetch that plays a script: each reply is a function of the request number and body. */
function wire(script = (n) => say(`answer ${n}`)) {
  const calls = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, raw: init.body });
    return script(calls.length, body);
  };
  return { fetch, calls };
}

function makeAdapter({ script, memoryTools = true, embedder = fakeEmbedder, log = quiet(), onStore } = {}) {
  const w = wire(script);
  const adapter = createV2LiveAdapter({
    config: CONFIG,
    memoryTools,
    deps: {
      openStore: async (opts) => {
        const store = await openStore({ ...opts, path: ':memory:', log: quiet() });
        return onStore?.(store) ?? store; // a hook may wrap the (frozen) store
      },
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

  test('the system prompt tells the model when to call remember and recall; it stays small', () => {
    assert.match(TEST_SYSTEM, /remember/);
    assert.match(TEST_SYSTEM, /recall/);
    assert.ok(TEST_SYSTEM.length / 3 < 1500, 'system prompt <= ~1.5k tokens');
  });
});

describe('v2-live adapter: the model calls a tool, code runs it', () => {
  test('remember: the row is saved, the result goes back as a tool message, then the model answers', async () => {
    let store;
    const script = (n) => (n === 1 ? call('remember', { content: 'Maya drinks an oat-milk flat white coffee.' }) : say('Saved.'));
    const { adapter, wire: w } = makeAdapter({ script, onStore: (s) => { store = s; } });
    const s = await start(adapter);
    const r = await s.turn('Remember that Maya drinks an oat-milk flat white coffee.');
    assert.equal(r.text, 'Saved.');
    const rows = await store.list({ limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'tool');
    assert.equal(w.calls.length, 2);
    const msgs = w.calls[1].body.messages;
    const asst = msgs.at(-2);
    assert.equal(asst.role, 'assistant');
    assert.equal(asst.tool_calls[0].function.name, 'remember');
    const tool = msgs.at(-1);
    assert.equal(tool.role, 'tool');
    assert.equal(tool.tool_call_id, asst.tool_calls[0].id);
    assert.equal(JSON.parse(tool.content).ok, true);
    await adapter.stop();
  });

  test('recall: the model gets the stored memory back and can answer with it', async () => {
    const script = (n) => (n === 1 ? call('recall', { query: 'Maya coffee' }) : say('An oat-milk flat white.'));
    const { adapter, wire: w } = makeAdapter({ script });
    const s = await start(adapter);
    await s.seedMemories(ROWS);
    const r = await s.turn('What coffee should I get Maya?');
    const result = JSON.parse(w.calls[1].body.messages.at(-1).content);
    assert.equal(result.memories[0].title, 'Oat-milk flat white');
    assert.equal(r.text, 'An oat-milk flat white.');
    await adapter.stop();
  });

  test('events: tool_start (name, arguments) and tool_result (ok) before turn_complete; the runner slice keeps them', async () => {
    const script = (n) => (n === 1 ? call('recall', { query: 'Nimbus' }) : say('50ms p99.'));
    const { adapter } = makeAdapter({ script });
    const s = await start(adapter);
    const r = await s.turn('What is the Nimbus target?');
    const types = r.events.map((e) => e.type);
    const ts = types.indexOf('tool_start');
    const tr = types.indexOf('tool_result');
    assert.ok(ts >= 0 && tr > ts && types.indexOf('turn_complete') > tr, types.join(','));
    assert.deepEqual(r.events[ts].arguments, { query: 'Nimbus' });
    assert.equal(r.events[tr].ok, true);
    const { events } = sliceTurnEvents(r.events, 100);
    assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'recall'));
    await adapter.stop();
  });

  test('a tool that fails (bad args) -> tool_result ok: false, the model still answers', async () => {
    const script = (n) => (n === 1 ? call('remember', {}) : say('Sorry, I could not save that.'));
    const { adapter } = makeAdapter({ script });
    const s = await start(adapter);
    const r = await s.turn('Remember that.');
    assert.equal(r.events.find((e) => e.type === 'tool_result').ok, false);
    assert.equal(r.text, 'Sorry, I could not save that.');
    assert.ok(r.events.some((e) => e.type === 'turn_complete' && e.status === 'completed'));
    await adapter.stop();
  });

  test('a store error inside a tool -> one log.error, tool_result ok: false, no throw (AP5)', async () => {
    let store;
    const script = (n) => (n === 1 ? call('remember', { content: 'Maya drinks an oat-milk flat white coffee.' }) : say('Not saved.'));
    const { adapter, log } = makeAdapter({ script, onStore: (s) => { store = s; return { ...s, insert: async () => { throw new Error('disk full'); } }; } });
    const s = await start(adapter);
    const r = await s.turn('Remember that Maya drinks an oat-milk flat white coffee.');
    assert.ok(store);
    assert.equal(r.events.find((e) => e.type === 'tool_result').ok, false);
    assert.equal(log.error.mock.callCount(), 1);
    await adapter.stop();
  });

  test('a model that never stops calling tools is cut after 4 rounds; the turn still completes', async () => {
    const { adapter, wire: w } = makeAdapter({ script: (n) => call('recall', { query: `q${n}` }, `call_${n}`) });
    const s = await start(adapter);
    const r = await s.turn('Loop forever.');
    assert.equal(w.calls.length, 5, '4 tool rounds + 1 request whose calls are not run');
    assert.ok(r.events.some((e) => e.type === 'turn_complete'));
    await adapter.stop();
  });

  test('no tool call -> one request, the plain answer', async () => {
    const { adapter, wire: w } = makeAdapter();
    const s = await start(adapter);
    const r = await s.turn('Hello there.');
    assert.equal(w.calls.length, 1);
    assert.equal(r.text, 'answer 1');
    await adapter.stop();
  });
});

describe('v2-live adapter: the stable prefix (A1 item 4, L-M22)', () => {
  async function threeTurns() {
    const script = (n) => (n === 1 ? call('remember', { content: 'Maya drinks an oat-milk flat white coffee.' }) : n === 3 ? call('recall', { query: 'Maya coffee' }, 'call_2') : say(`answer ${n}`));
    const { adapter, wire: w } = makeAdapter({ script });
    const s = await start(adapter);
    const results = [];
    for (const text of ['Remember that Maya drinks an oat-milk flat white coffee.', 'What coffee should I get Maya?', 'Thanks, that is all.']) results.push(await s.turn(text));
    await adapter.stop();
    return { results, calls: w.calls };
  }

  test('tools + system byte-identical on every request, one prefixHash; the user turn is the text exactly', async () => {
    const { results, calls } = await threeTurns();
    assert.equal(new Set(results.map((r) => stablePrefix(r.assembled))).size, 1);
    assert.equal(new Set(results.map((r) => r.prefixHash)).size, 1);
    assert.equal(new Set(calls.map((c) => c.body.messages[0].content)).size, 1, 'the system message never changes');
    assert.equal(new Set(calls.map((c) => JSON.stringify(c.body.tools))).size, 1, 'the tool bytes never change');
    assert.deepEqual(calls[0].body.tools.map((t) => t.function.name), ['remember', 'recall']);
    assert.equal(results[1].assembled.userTurn, 'What coffee should I get Maya?', 'no code-injected block');
  });

  test('client prefix: every request starts with the previous request\'s messages, exactly', async () => {
    const { calls } = await threeTurns();
    for (let i = 1; i < calls.length; i++) {
      const prev = calls[i - 1].body.messages;
      assert.deepEqual(calls[i].body.messages.slice(0, prev.length), prev, `request ${i + 1} extends request ${i}`);
    }
  });

  test('reset() starts a new session: history gone, store kept', async () => {
    let store;
    const script = (n) => (n === 1 ? call('remember', { content: 'Maya drinks an oat-milk flat white coffee.' }) : say(`answer ${n}`));
    const { adapter, wire: w } = makeAdapter({ script, onStore: (s) => { store = s; } });
    const s = await start(adapter);
    await s.turn('Remember that Maya drinks an oat-milk flat white coffee.');
    await s.reset();
    await s.turn('Hello again.');
    assert.equal(w.calls.at(-1).body.messages.length, 2, 'system + the new user turn only');
    assert.equal((await store.list({ limit: 10 })).length, 1);
    await adapter.stop();
  });
});

describe('v2-live adapter: switches and failures', () => {
  test('memoryTools: false (the baseline run): no tools on the wire, its own name', async () => {
    const { adapter, wire: w } = makeAdapter({ memoryTools: false });
    assert.equal(adapter.name, 'v2-live-tools-off');
    const s = await start(adapter);
    await s.turn('Hello there.');
    assert.equal(w.calls[0].body.tools, undefined);
    await adapter.stop();
  });

  test('stop() frees everything: store closed, embedder closed, server stopped', async () => {
    const closed = { embedder: 0, server: 0 };
    const w = wire();
    const adapter = createV2LiveAdapter({
      config: CONFIG,
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
