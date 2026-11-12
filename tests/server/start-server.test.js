// T2.14 - boot: open in order, close in reverse, and a failed start closes
// what it opened (spec S2.14 §2.5, §3; v1 tests/integration/server/shutdown.test.js,
// close order only). All parts are fakes; no model, no real DB file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../../src/config/read-config.js';
import { openStore } from '../../src/store/open-store.js';
import { startServer } from '../../src/boot/start-server.js';
import { quietLog, rawGet } from './socket-helpers.js';
import { fakeEmbedder } from '../chat/turn-wire-scenario.js';

const config = () => readConfig({ env: { PORT: '0', HOST: '127.0.0.1', SQLITE_PATH: ':memory:' } }).values;

function parts({ llamaFails = false } = {}) {
  const order = [];
  const deps = {
    log: quietLog(),
    openStore: async (opts) => {
      order.push('open:store');
      const store = await openStore({ ...opts, path: ':memory:', log: quietLog() });
      return { ...store, close: async () => { order.push('close:store'); await store.close(); } };
    },
    createEmbedder: async () => {
      order.push('open:embedder');
      return { ...fakeEmbedder(), close: async () => { order.push('close:embedder'); } };
    },
    startLlama: async () => {
      if (llamaFails) throw new Error('llama-server did not start');
      order.push('open:llama');
      return { baseURL: 'http://127.0.0.1:1', servedCtx: 8192, capabilities: { tools: true, thinking: false }, stop: async () => { order.push('close:llama'); } };
    },
    fetch: async () => { throw new Error('no model in this test'); },
  };
  return { order, deps };
}

test('startServer opens embedder → store → llama → server, and stop() closes in reverse', async () => {
  const { order, deps } = parts();
  const app = await startServer({ config: config(), deps });
  assert.ok(app.port > 0);
  const r = await rawGet(app.port, '/shared/ws-schema.js');
  assert.equal(r.status, 200);
  await app.stop();
  assert.deepEqual(order, ['open:embedder', 'open:store', 'open:llama', 'close:llama', 'close:store', 'close:embedder']);
});

test('a failed llama start closes the embedder and the store, then rethrows', async () => {
  const { order, deps } = parts({ llamaFails: true });
  await assert.rejects(startServer({ config: config(), deps }), /llama-server did not start/);
  assert.deepEqual(order, ['open:embedder', 'open:store', 'close:store', 'close:embedder']);
});

test('stop() twice is safe', async () => {
  const { deps } = parts();
  const app = await startServer({ config: config(), deps });
  await app.stop();
  await app.stop();
});
