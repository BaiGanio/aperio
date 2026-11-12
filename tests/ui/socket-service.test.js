// T3.0 - the socket service (spec S3.0 §2.3, §3 items 3-5). A fake WebSocket
// stands in for the browser's; mock timers drive the backoff. The service never
// touches the DOM; it talks to the store only.
//
// Test choice where the spec is silent: a good inbound frame reaches the store
// as `lastFrame` (the parsed message). Flagged for the developer.

import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWebSocket, importPublic, lastSocket } from './ui-helpers.js';

const { createStore } = await importPublic('state/store.js');
const { createSocketService } = await importPublic('services/socket-service.js');

const URL_ = 'ws://127.0.0.1:3999/';
/** The spec's backoff: 0.5 s, x2, capped at 10 s. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 10000, 10000];

let store;
let service;

function start() {
  store = createStore({ connection: 'connecting', lastError: null, lastFrame: null, theme: 'kept' });
  service = createSocketService({ store, url: URL_, WebSocket: FakeWebSocket });
  return service;
}

beforeEach(() => {
  FakeWebSocket.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
});
afterEach(() => {
  service?.dispose();
  service = null;
  mock.timers.reset();
  mock.restoreAll();
});

describe('connect and the connection state', () => {
  test('creating the service opens one socket to the url; connecting → open', () => {
    start();
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(lastSocket().url, URL_);
    assert.equal(store.get('connection'), 'connecting');
    lastSocket().open();
    assert.equal(store.get('connection'), 'open');
  });

  test('a drop sets closed; the store keeps its other keys', () => {
    start();
    lastSocket().open();
    lastSocket().drop();
    assert.equal(store.get('connection'), 'closed');
    assert.equal(store.get('theme'), 'kept');
  });

  test('a server that is down is not an error: closed, no lastError', () => {
    start();
    lastSocket().drop();
    assert.equal(store.get('connection'), 'closed');
    assert.equal(store.get('lastError'), null);
  });
});

describe('reconnect with backoff', () => {
  test('waits 0.5 s, then doubles up to 10 s while the server stays down', () => {
    start();
    for (const [i, wait] of BACKOFF.entries()) {
      lastSocket().drop();
      const before = FakeWebSocket.instances.length;
      mock.timers.tick(wait - 1);
      assert.equal(FakeWebSocket.instances.length, before, `attempt ${i + 1}: too early at ${wait - 1} ms`);
      mock.timers.tick(1);
      assert.equal(FakeWebSocket.instances.length, before + 1, `attempt ${i + 1}: no reconnect after ${wait} ms`);
      assert.equal(store.get('connection'), 'connecting');
    }
  });

  test('a successful open resets the backoff to 0.5 s', () => {
    start();
    lastSocket().drop();
    mock.timers.tick(500);
    lastSocket().drop();
    mock.timers.tick(1000);
    lastSocket().open();
    lastSocket().drop();
    const before = FakeWebSocket.instances.length;
    mock.timers.tick(500);
    assert.equal(FakeWebSocket.instances.length, before + 1);
  });

  test('after a reconnect the store still holds its state, and the new socket is used', () => {
    start();
    lastSocket().open();
    store.set('theme', 'changed');
    lastSocket().drop();
    mock.timers.tick(500);
    lastSocket().open();
    assert.equal(store.get('connection'), 'open');
    assert.equal(store.get('theme'), 'changed');
    assert.equal(service.send({ type: 'stop' }), true);
    assert.equal(FakeWebSocket.instances[0].sent.length, 0);
    assert.equal(lastSocket().sent.length, 1);
  });

  test('one socket per page: never two sockets open at once', () => {
    start();
    lastSocket().drop();
    lastSocket().fire('close', { code: 1006 }); // a second close event for the same socket must not schedule twice
    mock.timers.tick(10_000);
    assert.equal(FakeWebSocket.instances.length, 2);
  });
});

describe('inbound frames are checked with the shared schema', () => {
  test('a good frame reaches the store as lastFrame', () => {
    start();
    lastSocket().open();
    lastSocket().message({ type: 'turn_complete', turnId: 't1', status: 'completed' });
    assert.deepEqual(store.get('lastFrame'), { type: 'turn_complete', turnId: 't1', status: 'completed' });
  });

  for (const [name, data, code] of [
    ['not JSON', 'not json', 'bad_json'],
    ['an unknown type', { type: 'nope' }, 'unknown_type'],
    ['a client type', { type: 'chat', turnId: 't', text: 'x' }, 'unknown_type'],
    ['an extra field', { type: 'turn_complete', status: 'completed', extra: 1 }, 'extra_field'],
  ]) {
    test(`${name}: dropped with console.warn and lastError; never thrown`, () => {
      const warn = mock.method(console, 'warn', () => {});
      start();
      lastSocket().open();
      assert.doesNotThrow(() => lastSocket().message(data));
      assert.equal(warn.mock.callCount(), 1);
      assert.equal(store.get('lastError')?.code, code);
      assert.equal(store.get('lastFrame'), null, 'a bad frame never reaches the store');
      assert.equal(store.get('connection'), 'open', 'the socket stays open');
    });
  }
});

describe('send', () => {
  test('while open: true, and the wire holds the encoded frame', () => {
    start();
    lastSocket().open();
    assert.equal(service.send({ type: 'chat', turnId: 't1', text: 'hello' }), true);
    assert.deepEqual(JSON.parse(lastSocket().sent[0]), { type: 'chat', turnId: 't1', text: 'hello' });
  });

  test('while connecting or closed: false, nothing sent', () => {
    start();
    assert.equal(service.send({ type: 'stop' }), false);
    lastSocket().drop();
    assert.equal(service.send({ type: 'stop' }), false);
    assert.equal(FakeWebSocket.instances.every((s) => s.sent.length === 0), true);
  });

  test('a message the schema rejects never reaches the wire', () => {
    start();
    lastSocket().open();
    let ok;
    try {
      ok = service.send({ type: 'chat', text: 'no turn id' });
    } catch {
      ok = 'threw'; // a client bug may throw, like encodeServerFrame; it may also return false
    }
    assert.notEqual(ok, true);
    assert.equal(lastSocket().sent.length, 0);
  });
});

describe('dispose', () => {
  test('while open: closes the socket and never reconnects', () => {
    start();
    lastSocket().open();
    service.dispose();
    assert.equal(lastSocket().closeCalls, 1);
    mock.timers.tick(60_000);
    assert.equal(FakeWebSocket.instances.length, 1);
  });

  test('while waiting to reconnect: the timer is cleared, no new socket', () => {
    start();
    lastSocket().drop();
    service.dispose();
    mock.timers.tick(60_000);
    assert.equal(FakeWebSocket.instances.length, 1);
  });

  test('twice is harmless; send after dispose is false', () => {
    start();
    lastSocket().open();
    service.dispose();
    service.dispose();
    assert.equal(service.send({ type: 'stop' }), false);
  });
});
