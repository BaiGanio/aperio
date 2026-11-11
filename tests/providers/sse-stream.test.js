// T2.5 - the SSE stream reader (spec S2.5, adapter behaviour 3).
//
// Ported from v1 (archive/v1-final) tests/unit/streaming/llamacppHandler.test.js
// and llamacppHandler-settings.test.js. Kept: SSE parsing, split lines, tool-call
// deltas, reasoning, usage/timings, streamed errors, the idle timeout and every
// thinking-timeout edge case (each one is a found v1 bug). Changed on purpose:
// - v2 reads with one function, `readSseStream(response, opts)`, not a class
//   with a reasoning-adapter; the result shape replaces the handler's fields.
// - The reader emits only `token` and `reasoning_token`. v2 has no
//   reasoning_start/done frame, so v1's "close the frame on cutoff" case has
//   nothing to pair and is not ported.
// - Inline `<think>` tags in content (L-M07, qwen-style) are split into
//   reasoning by the reader itself, including a tag split across deltas.
// Not ported: constructor/adapter-mock tests (the adapter is gone).
//
// The timer tests use `t.mock.timers` on setTimeout + Date, so the reader must
// time with setTimeout and Date.now (not performance.now).

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readSseStream, STREAM_IDLE_TIMEOUT_MS, THINKING_TIMEOUT_MS } from '../../src/providers/sse-stream.js';

const sse = (json) => `data: ${JSON.stringify(json)}\n`;
const deltaContent = (text) => sse({ choices: [{ delta: { content: text } }] });
const deltaReasoning = (text) => sse({ choices: [{ delta: { reasoning_content: text } }] });
const deltaToolCall = (tc) => sse({ choices: [{ delta: { tool_calls: [tc] } }] });
const DONE = 'data: [DONE]\n';

/** A response whose reader hands out `chunks` one per read. `onRead` runs after each read. */
function mockResponse(chunks, { onRead = () => {}, cancel } = {}) {
  let idx = 0;
  const reader = {
    async read() {
      if (idx >= chunks.length) return { done: true, value: undefined };
      const raw = typeof chunks[idx] === 'string' ? new TextEncoder().encode(chunks[idx]) : chunks[idx];
      idx++;
      onRead(idx);
      return { done: false, value: raw };
    },
    cancel: cancel ?? mock.fn(async () => {}),
  };
  return { response: { body: { getReader: () => reader } }, reads: () => idx, reader };
}

function collect() {
  const events = [];
  return { events, emit: (e) => events.push(e), tokens: () => events.filter((e) => e.type === 'token').map((e) => e.text) };
}

describe('SSE parsing', () => {
  test('streams content tokens and returns the joined text', async () => {
    const c = collect();
    const { response } = mockResponse([deltaContent('Hel'), deltaContent('lo '), deltaContent('world'), DONE]);
    const r = await readSseStream(response, { emit: c.emit });
    assert.equal(r.text, 'Hello world');
    assert.deepEqual(c.tokens(), ['Hel', 'lo ', 'world']);
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.reasoning, null);
    assert.equal(r.streamError, null);
  });

  test('handles several data lines in one chunk', async () => {
    const { response } = mockResponse([deltaContent('a') + deltaContent('b') + deltaContent('c'), DONE]);
    assert.equal((await readSseStream(response)).text, 'abc');
  });

  test('does NOT drop a token when its SSE line is split across chunks (ported)', async () => {
    const full = deltaContent('hi');
    const cut = full.length - 4;
    const { response } = mockResponse([full.slice(0, cut), full.slice(cut), DONE]);
    assert.equal((await readSseStream(response)).text, 'hi');
  });

  test('reassembles a line split across three chunks (ported)', async () => {
    const full = deltaContent('hello');
    const { response } = mockResponse([full.slice(0, 5), full.slice(5, 20), full.slice(20), DONE]);
    assert.equal((await readSseStream(response)).text, 'hello');
  });

  test('a final line without a trailing newline is still read', async () => {
    const { response } = mockResponse([deltaContent('x'), deltaContent('y').trimEnd()]);
    assert.equal((await readSseStream(response)).text, 'xy');
  });

  test('skips keep-alive comments, non-data lines and invalid JSON', async () => {
    const { response } = mockResponse([': \n\n', 'event: ping\n', 'data: {not json\n', deltaContent('ok'), DONE]);
    const r = await readSseStream(response);
    assert.equal(r.text, 'ok');
    assert.equal(r.streamError, null);
  });

  test('a chunk with no choices[0].delta is ignored', async () => {
    const { response } = mockResponse([sse({ choices: [] }), sse({ id: 'x' }), deltaContent('z'), DONE]);
    assert.equal((await readSseStream(response)).text, 'z');
  });

  test('reads usage (prompt, completion, reasoning tokens) and keeps the last value', async () => {
    const { response } = mockResponse([
      sse({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      sse({ usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } } }),
      DONE,
    ]);
    const r = await readSseStream(response);
    assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 50, thinking_tokens: 20 });
  });

  test('usage defaults to zeros when the stream sends none', async () => {
    const { response } = mockResponse([deltaContent('a'), DONE]);
    assert.deepEqual((await readSseStream(response)).usage, { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
  });

  test('keeps the llama-server timings block (cache_n feeds the KV-reuse number)', async () => {
    const timings = { prompt_n: 33, cache_n: 1533, prompt_ms: 80, predicted_per_second: 43.1 };
    const { response } = mockResponse([deltaContent('a'), sse({ choices: [{ delta: {} }], timings }), DONE]);
    assert.deepEqual((await readSseStream(response)).timings, timings);
  });

  test('timings is null when the stream never sends one', async () => {
    const { response } = mockResponse([deltaContent('a'), DONE]);
    assert.equal((await readSseStream(response)).timings, null);
  });
});

describe('streamed errors', () => {
  test('a mid-stream error object ends the stream and is reported (ported)', async () => {
    const { response } = mockResponse([
      deltaContent('partial'),
      sse({ error: { code: 500, message: 'Compute error.', type: 'server_error' } }),
      deltaContent('never reached'),
      DONE,
    ]);
    const r = await readSseStream(response);
    assert.equal(r.streamError, 'Compute error.');
    assert.equal(r.text, 'partial');
  });

  test('falls back to the error type when the error has no message (ported)', async () => {
    const { response } = mockResponse([sse({ error: { type: 'server_error' } }), DONE]);
    assert.equal((await readSseStream(response)).streamError, 'server_error');
  });
});

describe('tool-call deltas', () => {
  test('accumulates one tool call: id, name and argument fragments as a raw string', async () => {
    const { response } = mockResponse([
      deltaToolCall({ index: 0, id: 'tc1', function: { name: 'recall', arguments: '{"query":"' } }),
      deltaToolCall({ index: 0, function: { arguments: 'Pixel"}' } }),
      DONE,
    ]);
    const r = await readSseStream(response);
    assert.deepEqual(r.toolCalls, [{ index: 0, id: 'tc1', name: 'recall', args: '{"query":"Pixel"}' }]);
  });

  test('keeps several tool calls apart by index (ported)', async () => {
    const { response } = mockResponse([
      deltaToolCall({ index: 0, id: 'a', function: { name: 'recall', arguments: '{}' } }),
      deltaToolCall({ index: 1, id: 'b', function: { name: 'list', arguments: '{"limit":3}' } }),
      DONE,
    ]);
    const r = await readSseStream(response);
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.toolCalls[1].name, 'list');
    assert.equal(r.toolCalls[1].args, '{"limit":3}');
  });

  test('a tool call with no index is index 0', async () => {
    const { response } = mockResponse([deltaToolCall({ id: 'a', function: { name: 'list', arguments: '' } }), DONE]);
    assert.equal((await readSseStream(response)).toolCalls[0].name, 'list');
  });

  test('content after a tool-call delta is kept in text but not streamed as tokens (ported)', async () => {
    const c = collect();
    const { response } = mockResponse([
      deltaContent('Let me check. '),
      deltaToolCall({ index: 0, id: 'a', function: { name: 'recall', arguments: '{}' } }),
      deltaContent('<leaked syntax>'),
      DONE,
    ]);
    const r = await readSseStream(response, { emit: c.emit });
    assert.deepEqual(c.tokens(), ['Let me check. ']);
    assert.equal(r.text, 'Let me check. <leaked syntax>');
  });
});

describe('reasoning', () => {
  test('reasoning_content and reasoning both collect into reasoning, never into text', async () => {
    const c = collect();
    const { response } = mockResponse([
      deltaReasoning('step 1. '),
      sse({ choices: [{ delta: { reasoning: 'step 2.' } }] }),
      deltaContent('Answer'),
      DONE,
    ]);
    const r = await readSseStream(response, { emit: c.emit });
    assert.equal(r.reasoning, 'step 1. step 2.');
    assert.equal(r.text, 'Answer');
    assert.deepEqual(c.events.filter((e) => e.type === 'reasoning_token').map((e) => e.text), ['step 1. ', 'step 2.']);
  });

  test('inline <think> in content goes to reasoning, not to the answer (L-M07)', async () => {
    const c = collect();
    const { response } = mockResponse([deltaContent('<think>plan it</think>'), deltaContent('Hi there'), DONE]);
    const r = await readSseStream(response, { emit: c.emit });
    assert.equal(r.text, 'Hi there');
    assert.equal(r.reasoning, 'plan it');
    assert.ok(!c.tokens().join('').includes('think'), 'no think tag or thought may reach a token event');
  });

  test('an inline <think> tag split across deltas is still recognised', async () => {
    const c = collect();
    const { response } = mockResponse([deltaContent('<thi'), deltaContent('nk>plan</th'), deltaContent('ink>Hi'), DONE]);
    const r = await readSseStream(response, { emit: c.emit });
    assert.equal(r.text, 'Hi');
    assert.equal(r.reasoning, 'plan');
    assert.equal(c.tokens().join(''), 'Hi');
  });
});

describe('idle timeout', () => {
  test('a stalled read ends the stream as an error and cancels the reader (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cancel = mock.fn(async () => {});
    const response = { body: { getReader: () => ({ read: () => new Promise(() => {}), cancel }) } };
    const pending = readSseStream(response);
    t.mock.timers.tick(STREAM_IDLE_TIMEOUT_MS);
    const r = await pending;
    assert.match(r.streamError, /stalled/);
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(r.text, '');
  });

  test('keep-alive pings during a long prefill do not trip the idle timeout (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { response } = mockResponse([': \n\n', ': \n\n', ': \n\n', deltaContent('done'), DONE], { onRead: () => t.mock.timers.tick(30_000) });
    const r = await readSseStream(response);
    assert.equal(r.streamError, null);
    assert.equal(r.text, 'done');
  });

  test('a bad idleTimeoutMs falls back to the default instead of spinning (ported settings case)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const bad of [NaN, 0, -5, 'abc']) {
      const cancel = mock.fn(async () => {});
      const response = { body: { getReader: () => ({ read: () => new Promise(() => {}), cancel }) } };
      const pending = readSseStream(response, { idleTimeoutMs: /** @type {any} */ (bad) });
      t.mock.timers.tick(STREAM_IDLE_TIMEOUT_MS);
      const r = await pending;
      assert.match(r.streamError, /stalled/, `idleTimeoutMs=${String(bad)}`);
    }
  });
});

describe('thinking timeout', () => {
  const sixtySecondReads = (t, chunks, cancel) => mockResponse(chunks, { onRead: () => t.mock.timers.tick(60_000), cancel });

  test('cuts off a stream that reasons but never answers, anchored to the first reasoning chunk (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const cancel = mock.fn(async () => {});
    const m = sixtySecondReads(t, ['a', 'b', 'c', 'd', 'e'].map((x) => deltaReasoning(`${x}\n`)), cancel);
    const r = await readSseStream(m.response);
    assert.equal(r.thinkingTimedOut, true);
    assert.equal(r.streamError, null, 'not an error: the caller retries with thinking off');
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(r.text, '');
    assert.equal(m.reads(), 4, 'deadline counts from read 1 (t=60s): 180s later is read 4');
  });

  test('an answer before the deadline is not cut off (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const m = mockResponse([deltaReasoning('x'), deltaContent('here is the answer'), DONE], { onRead: () => t.mock.timers.tick(30_000) });
    const r = await readSseStream(m.response);
    assert.equal(r.thinkingTimedOut, false);
    assert.equal(r.text, 'here is the answer');
  });

  test('a tool call before the deadline is not cut off (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const m = mockResponse([deltaReasoning('x'), deltaToolCall({ index: 0, id: 'a', function: { name: 'recall', arguments: '{}' } }), DONE],
      { onRead: () => t.mock.timers.tick(30_000) });
    const r = await readSseStream(m.response);
    assert.equal(r.thinkingTimedOut, false);
    assert.equal(r.toolCalls.length, 1);
  });

  test('thinkingTimeoutMs 0 disables the guard; a bad value disables it too (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    for (const off of [0, NaN, -1]) {
      const m = sixtySecondReads(t, [...['a', 'b', 'c', 'd'].map((x) => deltaReasoning(x)), deltaContent('finally'), DONE]);
      const r = await readSseStream(m.response, { thinkingTimeoutMs: off });
      assert.equal(r.thinkingTimedOut, false, `thinkingTimeoutMs=${off}`);
      assert.equal(r.text, 'finally');
    }
  });

  test('the default thinking budget is 180 s', () => {
    assert.equal(THINKING_TIMEOUT_MS, 180_000);
    assert.equal(STREAM_IDLE_TIMEOUT_MS, 120_000);
  });

  test('a long prefill does not eat the thinking budget (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const pings = Array(8).fill(': \n\n');
    const m = mockResponse([...pings, deltaReasoning('start'), deltaContent('the answer'), DONE], { onRead: () => t.mock.timers.tick(30_000) });
    const r = await readSseStream(m.response);
    assert.equal(r.thinkingTimedOut, false);
    assert.equal(r.text, 'the answer');
  });

  test('a whitespace-only content delta does not switch the guard off (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const cancel = mock.fn(async () => {});
    const m = sixtySecondReads(t, [deltaReasoning('a'), deltaContent('\n'), ...['b', 'c', 'd', 'e'].map((x) => deltaReasoning(x))], cancel);
    const r = await readSseStream(m.response);
    assert.equal(r.thinkingTimedOut, true);
    assert.equal(cancel.mock.calls.length, 1);
  });

  test('a half-buffered answer line holds the cutoff back (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const cancel = mock.fn(async () => {});
    const answer = deltaContent('here is the answer');
    const m = sixtySecondReads(t, [deltaReasoning('a'), deltaReasoning('b'), deltaReasoning('c'), answer.slice(0, 30), answer.slice(30), DONE], cancel);
    const r = await readSseStream(m.response);
    assert.equal(r.thinkingTimedOut, false);
    assert.equal(cancel.mock.calls.length, 0);
    assert.equal(r.text, 'here is the answer');
  });

  test('the partial-line grace is bounded: reads that always end mid-line cannot starve the guard (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const cancel = mock.fn(async () => {});
    const line = deltaReasoning('thinking...\n');
    const stream = line.repeat(9);
    const step = line.length + 1;
    const chunks = Array.from({ length: Math.ceil(stream.length / step) }, (_, i) => stream.slice(i * step, (i + 1) * step));
    const m = sixtySecondReads(t, chunks, cancel);
    const r = await readSseStream(m.response);
    assert.equal(r.thinkingTimedOut, true);
    assert.equal(cancel.mock.calls.length, 1);
    assert.ok(m.reads() < chunks.length, 'cut off before the stream ends on its own');
  });

  test('the deadline bounds a pending read too: sparse reasoning cannot stretch the budget (ported)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let cancelledAt = null;
    const cancel = mock.fn(async () => { cancelledAt = Date.now(); });
    let idx = 0;
    const response = {
      body: {
        getReader: () => ({
          read: () => new Promise((resolve) => setTimeout(() => {
            if (idx >= 6) return resolve({ done: true, value: undefined });
            resolve({ done: false, value: new TextEncoder().encode(deltaReasoning(`thinking ${idx++}\n`)) });
          }, 110_000)),
          cancel,
        }),
      },
    };
    const pending = readSseStream(response);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 100 && !settled; i++) {
      t.mock.timers.tick(10_000);
      await new Promise((r) => setImmediate(r));
    }
    const r = await pending;
    assert.equal(r.thinkingTimedOut, true);
    assert.equal(cancelledAt, 290_000, 'first reasoning at 110 s + 180 s budget');
  });
});
