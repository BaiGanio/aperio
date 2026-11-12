// T2.14 - the socket edge and the session object (spec S2.14 §2.3-2.4, §3).
// Origin + ping-sweep cases are cut from v1 tests/integration/server/ws.test.js.
// A fake runner stands in for the model; the real runner has its own test.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server/app-server.js';
import { TEST_CONFIG, connect, fakeRunner, quietLog, rawUpgrade, waitFor } from './socket-helpers.js';

let server;
let runner;
let log;
let port;
const clients = [];

async function start(overrides = {}) {
  runner = overrides.runner ?? fakeRunner();
  log = quietLog();
  server = createServer({ config: { ...TEST_CONFIG, ...overrides.config }, runner, log, pingIntervalMs: overrides.pingIntervalMs });
  ({ port } = await server.listen());
}
async function client() {
  const c = await connect(port);
  clients.push(c);
  return c;
}
const isType = (type, turnId) => (f) => f.type === type && (turnId === undefined || f.turnId === turnId);
const turnCompletes = (c, turnId) => c.frames.filter(isType('turn_complete', turnId));

beforeEach(() => { clients.length = 0; });
afterEach(async () => {
  for (const c of clients) c.close();
  await server?.close();
  server = null;
});

describe('origin check (v1 ws.test.js, cut to v2)', () => {
  beforeEach(() => start());

  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://LOCALHOST:3000']) {
    test(`allowed: ${origin}`, async () => {
      const { status, socket } = await rawUpgrade(port, { Origin: origin });
      socket?.destroy();
      assert.equal(status, 101);
    });
  }

  test('no Origin header (a non-browser client) is allowed', async () => {
    const { status, socket } = await rawUpgrade(port);
    socket?.destroy();
    assert.equal(status, 101);
  });

  test('another host is rejected with 403 (DNS rebinding)', async () => {
    assert.equal((await rawUpgrade(port, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await rawUpgrade(port, { Origin: 'http://127.0.0.1.evil.example' })).status, 403);
  });

  test('a malformed Origin is rejected with 400', async () => {
    assert.equal((await rawUpgrade(port, { Origin: 'not a url' })).status, 400);
  });
});

describe('frames are checked once at the edge (AP8)', () => {
  beforeEach(() => start());

  test('bad JSON, unknown type and an extra field each get one error frame; the socket stays usable', async () => {
    const c = await client();
    c.send('not json');
    await c.next((f) => f.type === 'error' && f.code === 'bad_json', 'bad_json');
    c.send({ type: 'nope' });
    await c.next((f) => f.type === 'error' && f.code === 'unknown_type', 'unknown_type');
    c.send({ type: 'chat', turnId: 't0', text: 'x', extra: 1 });
    await c.next((f) => f.type === 'error' && f.code === 'extra_field', 'extra_field');
    assert.equal(runner.calls.length, 0, 'a bad frame never reaches the runner');
    c.send({ type: 'chat', turnId: 't1', text: 'hello' });
    await c.next(isType('turn_complete', 't1'));
    assert.equal(c.frames.filter((f) => f.type === 'error').length, 3);
  });

  test('a frame over WS_MAX_FRAME_BYTES closes the socket with 1009', async () => {
    const c = await client();
    c.send({ type: 'chat', turnId: 'big', text: 'x'.repeat(5000) });
    assert.equal((await c.closed).code, 1009);
    assert.equal(runner.calls.length, 0);
  });

  test('memory messages answer not_ready until S3.4', async () => {
    const c = await client();
    c.send({ type: 'memories_list' });
    await c.next((f) => f.type === 'error' && f.code === 'not_ready', 'not_ready');
  });
});

describe('a chat turn', () => {
  beforeEach(() => start());

  test('frames come in order, all carry the turnId, and exactly one turn_complete ends the turn', async () => {
    const c = await client();
    c.send({ type: 'chat', turnId: 'a1', text: 'hello' });
    const done = await c.next(isType('turn_complete', 'a1'));
    assert.equal(done.status, 'completed');
    const types = c.frames.map((f) => f.type);
    assert.deepEqual(types, ['stream_start', 'token', 'stream_end', 'turn_complete']);
    assert.ok(c.frames.every((f) => f.turnId === 'a1'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(turnCompletes(c, 'a1').length, 1);
    assert.equal(runner.calls[0].text, 'hello');
  });

  test('a runner that throws → one error frame and one turn_complete{error}; the next chat works', async () => {
    const c = await client();
    c.send({ type: 'chat', turnId: 'b1', text: 'boom' });
    const done = await c.next(isType('turn_complete', 'b1'));
    assert.equal(done.status, 'error');
    assert.ok(c.frames.some((f) => f.type === 'error' && f.turnId === 'b1'));
    assert.equal(turnCompletes(c, 'b1').length, 1);
    assert.ok(log.error.mock.callCount() >= 1, 'the error is logged (AP5)');
    c.send({ type: 'chat', turnId: 'b2', text: 'hello' });
    assert.equal((await c.next(isType('turn_complete', 'b2'))).status, 'completed');
  });

  test('stop aborts the running turn → turn_complete{aborted}', async () => {
    const c = await client();
    c.send({ type: 'chat', turnId: 's1', text: 'hang' });
    await c.next(isType('stream_start', 's1'));
    c.send({ type: 'stop', turnId: 's1' });
    assert.equal((await c.next(isType('turn_complete', 's1'))).status, 'aborted');
    assert.equal(runner.calls[0].signal.aborted, true);
  });

  test('stop with no running turn is harmless', async () => {
    const c = await client();
    c.send({ type: 'stop' });
    c.send({ type: 'chat', turnId: 'x1', text: 'hello' });
    assert.equal((await c.next(isType('turn_complete', 'x1'))).status, 'completed');
  });
});

describe('one turn at a time, server-wide', () => {
  beforeEach(() => start());

  test('a second chat on the same socket while busy → busy error + turn_complete{error}', async () => {
    const c = await client();
    c.send({ type: 'chat', turnId: 'm1', text: 'hang' });
    await c.next(isType('stream_start', 'm1'));
    c.send({ type: 'chat', turnId: 'm2', text: 'hello' });
    const err = await c.next((f) => f.type === 'error' && f.turnId === 'm2');
    assert.equal(err.code, 'busy');
    assert.equal((await c.next(isType('turn_complete', 'm2'))).status, 'error');
    assert.equal(runner.calls.length, 1, 'the busy chat never reaches the runner');
    c.send({ type: 'stop', turnId: 'm1' });
    await c.next(isType('turn_complete', 'm1'));
  });

  test('a chat from another socket while busy → busy; after the turn ends it runs', async () => {
    const a = await client();
    const b = await client();
    a.send({ type: 'chat', turnId: 'a1', text: 'hang' });
    await a.next(isType('stream_start', 'a1'));
    b.send({ type: 'chat', turnId: 'b1', text: 'hello' });
    assert.equal((await b.next((f) => f.type === 'error' && f.turnId === 'b1')).code, 'busy');
    assert.equal(a.frames.filter((f) => f.turnId === 'b1').length, 0, 'frames never cross sockets');
    a.send({ type: 'stop', turnId: 'a1' });
    await a.next(isType('turn_complete', 'a1'));
    b.send({ type: 'chat', turnId: 'b2', text: 'hello' });
    assert.equal((await b.next(isType('turn_complete', 'b2'))).status, 'completed');
  });
});

describe('the session lives and dies with its socket', () => {
  test('close mid-turn: the runner sees the abort, the session is gone, the server is free again', async () => {
    await start();
    const a = await client();
    assert.equal(server.sessionCount(), 1);
    a.send({ type: 'chat', turnId: 'c1', text: 'hang' });
    await a.next(isType('stream_start', 'c1'));
    a.close();
    await waitFor(() => runner.calls[0].signal.aborted, 2000, 'abort');
    await waitFor(() => server.sessionCount() === 0, 2000, 'session freed');
    const b = await client();
    b.send({ type: 'chat', turnId: 'c2', text: 'hello' });
    assert.equal((await b.next(isType('turn_complete', 'c2'))).status, 'completed');
  });

  test('each socket gets its own conversation', async () => {
    const convs = [];
    const base = fakeRunner();
    await start({ runner: { ...base, newConversation: () => { const c = { history: [] }; convs.push(c); return c; } } });
    await client();
    await client();
    assert.equal(convs.length, 2);
    assert.notEqual(convs[0], convs[1]);
  });

  test('client WS_MAX_CLIENTS + 1 is refused with 503', async () => {
    await start();
    await client();
    await client();
    const { status, socket } = await rawUpgrade(port);
    socket?.destroy();
    assert.equal(status, 503);
    assert.equal(server.sessionCount(), 2);
  });

  test('a socket that never answers a ping is reaped by the sweep (v1 ws.test.js)', async () => {
    await start({ pingIntervalMs: 30 });
    const { status, socket } = await rawUpgrade(port); // a raw socket never sends a pong
    assert.equal(status, 101);
    await waitFor(() => server.sessionCount() === 1, 1000, 'session open');
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.resume();
    await closed;
    await waitFor(() => server.sessionCount() === 0, 1000, 'session reaped');
  });

  test('a live client answers pings and is kept', async () => {
    await start({ pingIntervalMs: 30 });
    const c = await client();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(server.sessionCount(), 1);
    assert.equal(c.ws.readyState, c.ws.OPEN);
  });

  test('close() ends every socket, aborts the running turn and leaves no session', async () => {
    await start();
    const a = await client();
    a.send({ type: 'chat', turnId: 'd1', text: 'hang' });
    await a.next(isType('stream_start', 'd1'));
    await server.close();
    server = null;
    await a.closed;
    assert.equal(runner.calls[0].signal.aborted, true);
  });
});
