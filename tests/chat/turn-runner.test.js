// T2.14 - the turn runner: the per-turn code moved out of the eval adapter
// (spec S2.14 §2.1, §3 item 1). The eval and the server share it, so the bytes
// on the wire must not change: a golden captured from the S2.13 adapter
// (commit 987cc818) is the bar.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/store/open-store.js';
import { reindex } from '../../src/embeddings/embed-reindex.js';
import { createChatProvider } from '../../src/providers/chat-provider.js';
import { MEMORY_TOOLS } from '../../src/tools/memory-tools.js';
import { buildSystem } from '../../src/context/system-prompt.js';
import { createTurnRunner } from '../../src/chat/turn-runner.js';
import {
  SCENARIO_CONFIG, SEED_ROWS, TURNS, fakeEmbedder, quiet, scriptedFetch, normalize, readGolden, runThroughAdapter,
} from './turn-wire-scenario.js';

const { Response, ReadableStream, DOMException } = globalThis; // Node globals the lint config does not list

async function makeRunner({ fetch, config = SCENARIO_CONFIG } = {}) {
  const store = await openStore({ path: ':memory:', dims: 4, log: quiet() });
  const embedder = fakeEmbedder();
  for (const row of SEED_ROWS) await store.insert(row);
  await reindex(store, embedder, { log: quiet() });
  const provider = createChatProvider({ baseURL: 'http://127.0.0.1:1', tools: MEMORY_TOOLS, capabilities: { tools: true, thinking: false }, fetch, log: quiet() });
  const runner = createTurnRunner({
    store, embedder, provider, system: buildSystem(), tools: MEMORY_TOOLS, config, nCtx: config.LLAMACPP_SERVE_CTX, log: quiet(),
  });
  return { runner, store };
}

describe('turn runner: same bytes as the S2.13 adapter (golden)', () => {
  test('the eval adapter still sends the golden bytes (it now calls the runner)', async () => {
    const golden = await readGolden();
    const r = await runThroughAdapter();
    assert.equal(r.requests.length, golden.requests.length);
    r.requests.forEach((body, i) => assert.equal(body, golden.requests[i], `request ${i + 1} changed`));
    assert.deepEqual(r.events, golden.events);
  });

  test('the runner on its own sends the golden bytes and emits the golden events', async () => {
    const golden = await readGolden();
    const w = scriptedFetch();
    const { runner, store } = await makeRunner({ fetch: w.fetch });
    const conv = runner.newConversation();
    const events = [];
    for (const text of TURNS) {
      const types = [];
      const r = await runner.runTurn(conv, text, { emit: (e) => types.push(e.type) });
      assert.equal(r.status, 'completed');
      events.push(types.filter((t) => t !== 'token' && t !== 'reasoning_token'));
    }
    await store.close();
    assert.equal(w.raw.length, golden.requests.length);
    w.raw.map(normalize).forEach((body, i) => assert.equal(body, golden.requests[i], `request ${i + 1} differs`));
    assert.deepEqual(events, golden.events);
  });

  test('the golden really covers a tool call and a trim', async () => {
    const golden = await readGolden();
    assert.ok(golden.events.flat().includes('tool_start'));
    assert.ok(golden.events.flat().includes('context_trimmed'));
  });
});

describe('turn runner: one turn_complete, stop aborts', () => {
  test('every turn ends in exactly one turn_complete, with the returned status', async () => {
    const { runner, store } = await makeRunner({ fetch: scriptedFetch().fetch });
    const conv = runner.newConversation();
    const done = [];
    const r = await runner.runTurn(conv, 'hello', { emit: (e) => { if (e.type === 'turn_complete') done.push(e.status); } });
    await store.close();
    assert.deepEqual(done, [r.status]);
  });

  test('an aborted signal reaches the provider; the turn ends aborted', async () => {
    const seen = [];
    // A stream that never ends by itself: only the abort stops it.
    const fetch = async (_url, init) => {
      seen.push(init.signal);
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`));
          init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const { runner, store } = await makeRunner({ fetch });
    const conv = runner.newConversation();
    const ac = new AbortController();
    const done = [];
    const turn = runner.runTurn(conv, 'hello', {
      signal: ac.signal,
      emit: (e) => {
        if (e.type === 'token') ac.abort();
        if (e.type === 'turn_complete') done.push(e.status);
      },
    });
    const r = await turn;
    await store.close();
    assert.ok(seen[0], 'the signal is passed to fetch');
    assert.equal(seen[0].aborted, true);
    assert.equal(r.status, 'aborted');
    assert.deepEqual(done, ['aborted']);
  });

  test('a conversation keeps its own history; two conversations do not share it', async () => {
    const w = scriptedFetch();
    const { runner, store } = await makeRunner({ fetch: w.fetch, config: { ...SCENARIO_CONFIG, LLAMACPP_SERVE_CTX: 65536 } });
    const a = runner.newConversation();
    const b = runner.newConversation();
    await runner.runTurn(a, 'first in a', { emit: () => {} });
    await runner.runTurn(b, 'first in b', { emit: () => {} });
    await store.close();
    const last = JSON.parse(w.raw.at(-1)).messages;
    assert.ok(!JSON.stringify(last).includes('first in a'), 'conversation b never sees a');
    assert.ok(a.history.length > 0 && b.history.length > 0);
  });
});
