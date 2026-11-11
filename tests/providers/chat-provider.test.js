// T2.5 - the chat provider: one streamed model call (spec S2.5, adapter 1-8).
//
// Ported in spirit from v1 (archive/v1-final) tests/unit/providers/llamacpp.test.js
// groups "empty-completion retry", "tool-call leakage", "system-prompt echo",
// "corrupted tool name", "returns error when API returns non-200", and
// llamacpp-thinking-timeout.test.js. Changed on purpose:
// - The retry nudge goes in a trailing USER message; the system message and
//   the tools bytes never change (A2, L-M04). v1 appended it to the system
//   prompt, which cost Ornith the whole KV cache (measured 0.4 % reuse).
// - Bad tool JSON is reported per call (`bad_tool_json`), never `{}`.
// - The multi-step tool loop, repeat breaker and step cap are S2.8 (decision 2).
// Not ported: health preflight, VLM bridge, wiki guidance, router alias
// retry, tool popping (`fitToolsToContext`) - all dropped by the spec.

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChatProvider, EMPTY_FALLBACK, LEAK_FALLBACK } from '../../src/providers/chat-provider.js';

const { Response, ReadableStream } = globalThis; // Node globals the lint config does not list

const sse = (json) => `data: ${JSON.stringify(json)}\n\n`;
const content = (text) => sse({ choices: [{ delta: { content: text } }] });
const toolCall = (tc) => sse({ choices: [{ delta: { tool_calls: [tc] } }] });
const DONE = 'data: [DONE]\n\n';
const ok = (...lines) => () => new Response([...lines, DONE].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const TOOLS = [
  { name: 'remember', description: 'Save a memory.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'recall', description: 'Search memories.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'update', description: 'Update a memory.', parameters: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'forget', description: 'Delete a memory.', parameters: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'list', description: 'List memories.', parameters: { type: 'object', properties: {} } },
];
const SYSTEM = 'You are Aperio, a small local assistant that remembers. Be brief and honest.';

/** A fetch that answers each call with the next responder, and records every request. */
function scriptedFetch(...responders) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body), raw: init.body });
    const next = responders[Math.min(calls.length - 1, responders.length - 1)];
    return next(init);
  };
  return { fetch: fn, calls };
}

const quietLog = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });

function make(fetchImpl, over = {}) {
  return createChatProvider({ baseURL: 'http://127.0.0.1:18432', tools: TOOLS, capabilities: { tools: true, thinking: true }, fetch: fetchImpl, log: quietLog(), ...over });
}

function collect() {
  const events = [];
  return { events, emit: (e) => events.push(e), types: () => events.map((e) => e.type) };
}

const user = (text) => ({ role: 'user', content: text });

describe('the request', () => {
  test('one streamed POST to /v1/chat/completions with system first, then history', async () => {
    const f = scriptedFetch(ok(content('Hi')));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('hello')], emit: () => {} });
    assert.equal(r.text, 'Hi');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'http://127.0.0.1:18432/v1/chat/completions');
    assert.equal(f.calls[0].init.method, 'POST');
    assert.equal(f.calls[0].body.stream, true);
    assert.deepEqual(f.calls[0].body.stream_options, { include_usage: true });
    assert.deepEqual(f.calls[0].body.messages, [{ role: 'system', content: SYSTEM }, user('hello')]);
  });

  test('tools are serialized once, OpenAI function shape, and sent as those exact bytes', async () => {
    const f = scriptedFetch(ok(content('a')));
    const p = make(f.fetch);
    assert.equal(typeof p.toolsJson, 'string');
    assert.deepEqual(JSON.parse(p.toolsJson), TOOLS.map((t) => ({ type: 'function', function: t })));
    await p.streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.ok(f.calls[0].raw.includes(`"tools":${p.toolsJson}`), 'the body carries the cached tools string byte for byte');
  });

  test('the tools snapshot is taken at creation: changing the caller array later changes nothing', async () => {
    const tools = TOOLS.map((t) => ({ ...t }));
    const f = scriptedFetch(ok(content('a')));
    const p = make(f.fetch, { tools });
    const before = p.toolsJson;
    tools.pop();
    tools[0].description = 'changed';
    await p.streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(p.toolsJson, before);
    assert.ok(f.calls[0].raw.includes(before));
  });

  test('prefixHash = sha1(toolsJson + system) and is identical across turns (A1 item 4)', async () => {
    const f = scriptedFetch(ok(content('a')));
    const p = make(f.fetch);
    const r1 = await p.streamChat({ system: SYSTEM, messages: [user('one')], emit: () => {} });
    const r2 = await p.streamChat({ system: SYSTEM, messages: [user('one'), { role: 'assistant', content: 'a' }, user('two')], emit: () => {} });
    const expected = createHash('sha1').update(p.toolsJson + SYSTEM).digest('hex');
    assert.equal(r1.prefixHash, expected);
    assert.equal(r2.prefixHash, expected);
  });

  test('teeth: a different system text gives a different prefixHash', async () => {
    const f = scriptedFetch(ok(content('a')));
    const p = make(f.fetch);
    const r1 = await p.streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    const r2 = await p.streamChat({ system: SYSTEM + ' Recall: Pixel.', messages: [user('x')], emit: () => {} });
    assert.notEqual(r1.prefixHash, r2.prefixHash);
  });

  test('no chat_template_kwargs on a normal request; thinking:false turns thinking off', async () => {
    const f = scriptedFetch(ok(content('a')));
    const p = make(f.fetch);
    await p.streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    await p.streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {}, thinking: false });
    assert.equal('chat_template_kwargs' in f.calls[0].body, false);
    assert.deepEqual(f.calls[1].body.chat_template_kwargs, { enable_thinking: false });
  });

  test('emits stream_start first and stream_end last, with the final text', async () => {
    const c = collect();
    const f = scriptedFetch(ok(content('Hel'), content('lo')));
    await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: c.emit });
    assert.equal(c.types()[0], 'stream_start');
    assert.equal(c.types().at(-1), 'stream_end');
    assert.equal(c.events.at(-1).text, 'Hello');
  });
});

describe('tool calls', () => {
  test('a native call with valid JSON comes back parsed', async () => {
    const f = scriptedFetch(ok(toolCall({ index: 0, id: 'c1', function: { name: 'recall', arguments: '{"query":"Pixel"}' } })));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('dog?')], emit: () => {} });
    assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'recall', args: { query: 'Pixel' } }]);
  });

  test('empty arguments are {} (a call with no arguments is valid)', async () => {
    const f = scriptedFetch(ok(toolCall({ index: 0, id: 'c1', function: { name: 'list', arguments: '' } })));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('list')], emit: () => {} });
    assert.deepEqual(r.toolCalls[0].args, {});
  });

  test('bad tool JSON is reported (event + call error), never turned into {}', async () => {
    const c = collect();
    const f = scriptedFetch(ok(toolCall({ index: 0, id: 'c1', function: { name: 'remember', arguments: '{"content": "Pix' } })));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('save')], emit: c.emit });
    const call = r.toolCalls[0];
    assert.equal(call.name, 'remember');
    assert.equal(call.error, 'bad_tool_json');
    assert.equal(call.raw, '{"content": "Pix');
    assert.equal(call.args, undefined, 'no args object, so nothing can run with {}');
    const ev = c.events.find((e) => e.type === 'tool_args_invalid');
    assert.ok(ev, 'a tool_args_invalid event is sent');
    assert.equal(ev.name, 'remember');
    assert.equal(f.calls.length, 1, 'no retry here: S2.8 returns the error to the model as the tool result');
  });

  test('two calls in one reply stay apart', async () => {
    const f = scriptedFetch(ok(
      toolCall({ index: 0, id: 'a', function: { name: 'recall', arguments: '{"query":"x"}' } }),
      toolCall({ index: 1, id: 'b', function: { name: 'list', arguments: '{}' } }),
    ));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.deepEqual(r.toolCalls.map((t) => t.name), ['recall', 'list']);
  });

  test('a recoverable corrupt native name is fixed (gemma channel markup)', async () => {
    const f = scriptedFetch(ok(toolCall({ index: 0, id: 'a', function: { name: '<|channel>thought<|tool_call>call:recall', arguments: '{"query":"x"}' } })));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(r.toolCalls[0].name, 'recall');
    assert.equal(f.calls.length, 1);
  });

  test('an unrecoverable name: retract, one retry, then an honest error (ported)', async () => {
    const c = collect();
    const bad = ok(toolCall({ index: 0, id: 'a', function: { name: 'call:made_up', arguments: '{}' } }));
    const f = scriptedFetch(bad, bad);
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: c.emit });
    assert.equal(f.calls.length, 2);
    assert.ok(c.types().includes('retract'));
    assert.equal(r.error?.kind, 'corrupt_tool_name');
    assert.equal(r.text, LEAK_FALLBACK);
    assert.deepEqual(r.toolCalls, []);
  });

  test('a leaked gemma pipe call for a known tool is recovered as a call, without a retry', async () => {
    const f = scriptedFetch(ok(content('<|tool_call>call:recall{query:<|"|>Pixel<|"|>}<tool_call|>')));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(f.calls.length, 1);
    assert.equal(r.toolCalls[0].name, 'recall');
    assert.deepEqual(r.toolCalls[0].args, { query: 'Pixel' });
    assert.ok(!r.text.includes('tool_call'), 'the leaked markup is not the answer');
  });

  test('a leaked Ornith angle call for a known tool is recovered as a call', async () => {
    const f = scriptedFetch(ok(content('<tool_call> <function=recall> <parameter=query> Pixel </parameter> </function> </tool_call>')));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(r.toolCalls[0].name, 'recall');
    assert.deepEqual(r.toolCalls[0].args, { query: 'Pixel' });
  });
});

describe('retries keep the prefix', () => {
  test('empty completion: one retry, thinking off, nudge as a trailing user message; system + tools unchanged', async () => {
    const f = scriptedFetch(ok(), ok(content('Pixel is 3.')));
    const c = collect();
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('dog?')], emit: c.emit });
    assert.equal(r.text, 'Pixel is 3.');
    assert.equal(f.calls.length, 2);
    const [first, second] = f.calls;
    assert.deepEqual(second.body.messages[0], first.body.messages[0], 'system message unchanged');
    assert.deepEqual(second.body.messages.slice(0, first.body.messages.length), first.body.messages, 'history unchanged');
    const nudge = second.body.messages.at(-1);
    assert.equal(second.body.messages.length, first.body.messages.length + 1);
    assert.equal(nudge.role, 'user', 'a late system message breaks Qwen/Gemma templates');
    assert.deepEqual(second.body.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual(second.body.tools, first.body.tools);
    assert.equal(r.retries.empty, 1);
  });

  test('empty twice: the fallback text, no third request (ported)', async () => {
    const f = scriptedFetch(ok(), ok(), ok(content('never')));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(f.calls.length, 2);
    assert.equal(r.text, EMPTY_FALLBACK);
  });

  test('a thinking cutoff counts as empty and retries with thinking off (ported wiring)', async () => {
    let n = 0;
    const thinkingForever = () => {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async pull(ctrl) {
          await new Promise((r) => setTimeout(r, 15));
          ctrl.enqueue(enc.encode(sse({ choices: [{ delta: { reasoning_content: `t${n++} ` } }] })));
        },
      });
      return new Response(body, { status: 200 });
    };
    const f = scriptedFetch(thinkingForever, ok(content('done')));
    const r = await make(f.fetch, { thinkingTimeoutMs: 40 }).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(r.text, 'done');
  });

  test('an unparseable leak: retract, one retry with a nudge, then the real answer (ported)', async () => {
    const c = collect();
    const f = scriptedFetch(ok(content('call(recall, query="dog")')), ok(content('Your dog is Pixel.')));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('dog?')], emit: c.emit });
    assert.ok(c.types().includes('retract'));
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].body.messages[0].content, SYSTEM);
    assert.equal(f.calls[1].body.messages.at(-1).role, 'user');
    assert.equal(r.text, 'Your dog is Pixel.');
    assert.equal(r.retries.leak, 1);
  });

  test('a leak that persists: an honest error, not a fake answer (ported)', async () => {
    const leak = ok(content('call(recall, query="dog")'));
    const f = scriptedFetch(leak, leak);
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('dog?')], emit: () => {} });
    assert.equal(f.calls.length, 2);
    assert.equal(r.error?.kind, 'tool_call_leak');
    assert.equal(r.text, LEAK_FALLBACK);
  });

  test('a system-prompt echo: retract, one retry, then the real answer (ported)', async () => {
    const c = collect();
    const longSystem = Array.from({ length: 12 }, (_, i) => `Rule ${i}: Aperio keeps memories local and answers briefly and honestly every time.`).join('\n');
    const f = scriptedFetch(ok(content(longSystem)), ok(content('Pixel.')));
    const r = await make(f.fetch).streamChat({ system: longSystem, messages: [user('dog?')], emit: c.emit });
    assert.ok(c.types().includes('retract'));
    assert.equal(r.text, 'Pixel.');
    assert.equal(f.calls[1].body.messages[0].content, longSystem);
  });

  test('every retry keeps prefixHash the same', async () => {
    const f = scriptedFetch(ok(), ok(content('ok')));
    const p = make(f.fetch);
    const r = await p.streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(r.prefixHash, createHash('sha1').update(p.toolsJson + SYSTEM).digest('hex'));
  });
});

describe('errors are reported, never an empty reply (AP5)', () => {
  test('server not running: error event, logged, no retry', async () => {
    const c = collect();
    const log = quietLog();
    const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    const r = await make(fetchImpl, { log }).streamChat({ system: SYSTEM, messages: [user('x')], emit: c.emit });
    assert.equal(r.error?.kind, 'unreachable');
    assert.ok(c.types().includes('error'));
    assert.ok(log.error.mock.calls.length >= 1);
    assert.notEqual(r.text, '');
  });

  test('HTTP 500 with a JSON error body: the server message is reported (ported)', async () => {
    const c = collect();
    const log = quietLog();
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    const r = await make(fetchImpl, { log }).streamChat({ system: SYSTEM, messages: [user('x')], emit: c.emit });
    assert.equal(r.error?.kind, 'http');
    assert.equal(r.error?.status, 500);
    assert.match(r.error?.message, /boom/);
    assert.ok(c.events.some((e) => e.type === 'error' && /boom/.test(e.message)));
    assert.ok(log.error.mock.calls.length >= 1);
  });

  test('model still loading (HTTP 503): reported as loading, not as a crash', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Loading model', code: 503 } }), { status: 503 });
    const r = await make(fetchImpl).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(r.error?.kind, 'loading');
  });

  test('a streamed error is reported verbatim and does not burn a retry', async () => {
    const f = scriptedFetch(ok(sse({ error: { message: 'Compute error.' } })));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {} });
    assert.equal(r.error?.kind, 'stream');
    assert.match(r.error?.message, /Compute error/);
    assert.equal(f.calls.length, 1);
  });
});

describe('abort', () => {
  test('aborting mid-stream cancels the read, sends no retry and frees the stream', async () => {
    const ac = new AbortController();
    let cancelled = false;
    const fetchImpl = async (_url, init) => {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(ctrl) { ctrl.enqueue(enc.encode(content('par'))); },
        cancel() { cancelled = true; },
      });
      init.signal?.addEventListener('abort', () => body.cancel().catch(() => {}));
      return new Response(body, { status: 200 });
    };
    const f = { calls: 0 };
    const counting = async (u, i) => { f.calls++; return fetchImpl(u, i); };
    const pending = make(counting).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const r = await pending;
    assert.equal(r.aborted, true);
    assert.equal(f.calls, 1, 'no retry after an abort');
    assert.equal(cancelled, true, 'the response stream is cancelled');
  });

  test('an already-aborted signal sends nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const f = scriptedFetch(ok(content('x')));
    const r = await make(f.fetch).streamChat({ system: SYSTEM, messages: [user('x')], emit: () => {}, signal: ac.signal });
    assert.equal(r.aborted, true);
    assert.equal(f.calls.length, 0);
  });
});
