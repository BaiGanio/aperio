// T2.7 - capture stays out of the stable prefix (spec S2.7 §2 "How capture
// stays out of the stable prefix"; L-M03, L-M04, L-M22).
//
// The v2-live adapter with the REAL chat provider and a scripted fetch, like
// tests/context/assemble-turn.test.js. No server.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/store/open-store.js';
import { RECALL_HEADER } from '../../src/context/recall-block.js';
import { stablePrefix } from '../../src/context/assemble-turn.js';
import { createV2LiveAdapter } from '../../src/eval/v2-live-adapter.js';

const { Response } = globalThis;
const SIG = 'fake|4|test';
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });
const vectorFor = (t) => Float32Array.from(/coffee/i.test(t) ? [1, 0, 0, 0] : /port/i.test(t) ? [0, 1, 0, 0] : [0, 0, 0, 1]);
const embed = async (t) => vectorFor(t);
const CONFIG = Object.freeze({ RECALL_TOP_K: 5, RECALL_TOKEN_BUDGET: 1200, RECALL_MIN_SCORE: 50, CAPTURE_MODE: 'on', CAPTURE_DUP_SCORE: 85, CAPTURE_MAX_PER_TURN: 3 });
const TOOLS = [{ name: 'remember', description: 'Save a memory.', parameters: { type: 'object', properties: { content: { type: 'string' } } } }];

async function run(texts, { capture = true, reply = (n) => `answer ${n}` } = {}) {
  const calls = [];
  const fetch = async (_url, init) => {
    calls.push({ body: JSON.parse(init.body), raw: init.body });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: reply(calls.length) } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  let store;
  const adapter = createV2LiveAdapter({
    config: CONFIG, recall: true, capture, tools: TOOLS,
    deps: {
      openStore: async (opts) => (store = await openStore({ ...opts, path: ':memory:', log: quiet() })),
      createEmbedder: async () => ({ sig: SIG, dims: 4, embed, embedQuery: embed, close: async () => {} }),
      startLlama: async () => ({ baseURL: 'http://127.0.0.1:1', capabilities: { tools: true, thinking: false }, stop: async () => {} }),
      fetch, dims: 4, log: quiet(),
    },
  });
  const s = await adapter.start({ sandbox: { dbPath: ':memory:', port: 1, releasePort: async () => {} }, settings: {}, model: { id: 'fake' } });
  const results = [];
  for (const t of texts) results.push(await s.turn(t));
  const rows = await store.list({ limit: 50 });
  await adapter.stop();
  return { results, calls, rows };
}

const TURNS = ['Remember that Maya drinks an oat-milk flat white coffee.', 'What coffee should I get Maya?', 'Thanks, that is all.'];

test('capture on turn 1: prefix byte-identical on all 3 turns; the memory reaches the model only via recall in turn 2', async () => {
  const { results, calls, rows } = await run(TURNS);
  assert.equal(rows.length, 1, 'turn 1 saved one memory');
  assert.equal(new Set(results.map((r) => stablePrefix(r.assembled))).size, 1, 'one stable prefix');
  assert.equal(new Set(results.map((r) => r.prefixHash)).size, 1, 'one prefixHash');
  assert.equal(new Set(calls.map((c) => c.body.messages[0].content)).size, 1, 'the system message never changes');
  assert.equal(new Set(calls.map((c) => JSON.stringify(c.body.tools))).size, 1, 'the tool bytes never change');
  assert.ok(!results[0].assembled.userTurn.startsWith(RECALL_HEADER), 'turn 1: saved after the turn, so no block yet');
  assert.ok(results[1].assembled.userTurn.startsWith(RECALL_HEADER), 'turn 2: the saved memory comes in through recall');
  assert.ok(results[1].assembled.userTurn.includes('oat-milk flat white'));
  assert.equal(calls.length, 3, 'capture made no model call of its own');
});

test('client prefix: every request starts with the previous request\'s messages, exactly', async () => {
  const { calls } = await run(TURNS);
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1].body.messages;
    assert.deepEqual(calls[i].body.messages.slice(0, prev.length), prev, `request ${i + 1} extends request ${i}`);
  }
});

test('capture runs after turn_complete, in the same turn\'s events', async () => {
  const { results } = await run(TURNS.slice(0, 1));
  const t = results[0].events.map((e) => e.type);
  assert.ok(t.indexOf('turn_complete') >= 0 && t.indexOf('capture_done') > t.indexOf('turn_complete'), t.join(','));
});

test('assistant text is never captured', async () => {
  const { rows } = await run(['Hello there.'], { reply: () => 'Remember that the staging port is 8443.' });
  assert.equal(rows.length, 0);
});

test('capture: false (the default) saves nothing', async () => {
  const { rows, results } = await run(TURNS.slice(0, 1), { capture: false });
  assert.equal(rows.length, 0);
  assert.ok(!results[0].events.some((e) => e.type.startsWith('capture_')));
});
