// T2.14 - one fixed 3-turn chat (a tool call, then a trim), shared by the
// golden capture and the tests. The golden file holds the exact request bytes
// the S2.13 eval adapter sent BEFORE the turn code moved to src/chat/
// (spec S2.14 §3, §4.6). The turn runner must send the same bytes.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mock } from 'node:test';
import { openStore } from '../../src/store/open-store.js';
import { createV2LiveAdapter } from '../../src/eval/v2-live-adapter.js';

const { Response } = globalThis; // Node global the lint config does not list

export const GOLDEN_PATH = path.join(import.meta.dirname, '..', 'fixtures', 'turn-wire-golden.json');

/** n_ctx = prefix (~1385) + reserve 2048 + ~400 usable, so turn 3 trims. */
export const SCENARIO_CONFIG = Object.freeze({
  RECALL_TOP_K: 5, REMEMBER_DUP_SCORE: 80, RECALL_TOKEN_BUDGET: 800, RECALL_MIN_SCORE: 50,
  LLAMACPP_SERVE_CTX: 3833, CONTEXT_OUTPUT_RESERVE: 2048, CONTEXT_TRIM_AT_PCT: 85, CONTEXT_TRIM_TO_PCT: 60, CONTEXT_TOOL_RESULT_PCT: 25,
});

export const SEED_ROWS = Object.freeze([
  { type: 'preference', title: 'Oat-milk flat white', content: 'Maya drinks an oat-milk flat white coffee.', createdAt: '2026-10-01T09:00:00.000Z' },
  { type: 'decision', title: 'Nimbus SLO', content: 'Nimbus answers under 50ms p99.', createdAt: '2026-10-02T09:00:00.000Z' },
]);

const pad = (s) => `${s} ${'and some more words to fill the window '.repeat(7)}`.trim();
export const TURNS = Object.freeze([
  pad('Remember that the beacon project ships on Friday.'),
  pad('What coffee does Maya drink?'),
  pad('Tell me about the Nimbus latency target.'),
]);

const AXES = { coffee: [1, 0, 0, 0], nimbus: [0, 1, 0, 0], beacon: [0, 0, 1, 0] };
const embed = async (text) => {
  const t = String(text).toLowerCase();
  for (const [word, v] of Object.entries(AXES)) if (t.includes(word)) return Float32Array.from(v);
  return Float32Array.from([0, 0, 0, 1]);
};
export const fakeEmbedder = () => ({ sig: 'fake|4|test', dims: 4, embed, embedQuery: embed, close: async () => {} });
export const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });

const sse = (...chunks) => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } });
const say = (text) => sse({ choices: [{ delta: { content: text } }] });
const call = (name, args) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });

/** Request 1 calls remember; every other request answers with a long text. */
export function scriptedFetch() {
  const raw = [];
  const fetch = async (_url, init) => {
    raw.push(init.body);
    return raw.length === 1 ? call('remember', { content: 'The beacon project ships on Friday.' }) : say(pad(`Answer ${raw.length}.`));
  };
  return { fetch, raw };
}

/** Random ids and today's date are the only bytes that change between runs. */
export function normalize(body) {
  const today = new Date().toISOString().slice(0, 10);
  return body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replaceAll(today, '<today>');
}

export async function readGolden() {
  return JSON.parse(await readFile(GOLDEN_PATH, 'utf8'));
}

/** Run the scenario through the eval adapter. Returns the normalized request bodies and the events. */
export async function runThroughAdapter() {
  const w = scriptedFetch();
  const adapter = createV2LiveAdapter({
    config: SCENARIO_CONFIG,
    deps: {
      openStore: (opts) => openStore({ ...opts, path: ':memory:', log: quiet() }),
      createEmbedder: async () => fakeEmbedder(),
      startLlama: async () => ({ baseURL: 'http://127.0.0.1:1', capabilities: { tools: true, thinking: false }, stop: async () => {} }),
      fetch: w.fetch, dims: 4, log: quiet(),
    },
  });
  const session = await adapter.start({ sandbox: { dbPath: ':memory:', port: 1, releasePort: async () => {} }, settings: {}, model: { id: 'fake-model' } });
  const events = [];
  try {
    await session.seedMemories(SEED_ROWS);
    for (const text of TURNS) events.push((await session.turn(text)).events.map((e) => e.type));
  } finally {
    await adapter.stop();
  }
  return { requests: w.raw.map(normalize), events };
}
