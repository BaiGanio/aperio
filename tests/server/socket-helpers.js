// T2.14 helpers: a fake turn runner, a socket client that collects frames, and
// a raw HTTP upgrade (to send any Origin and to never answer a ping).

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mock } from 'node:test';

const { WebSocket } = globalThis;

export const quietLog = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });

export const TEST_CONFIG = Object.freeze({ HOST: '127.0.0.1', PORT: 0, WS_MAX_FRAME_BYTES: 1024, WS_MAX_CLIENTS: 2 });

/**
 * A runner that streams a little and ends. Text 'hang' waits until aborted;
 * text 'boom' throws. Every call keeps its signal for the test.
 */
export function fakeRunner() {
  const calls = [];
  return {
    calls,
    newConversation: () => ({ history: [] }),
    async runTurn(_conv, text, { emit, signal }) {
      calls.push({ text, signal });
      if (text === 'boom') throw new Error('provider exploded');
      emit({ type: 'stream_start' });
      emit({ type: 'token', text: 'hi' });
      if (text === 'hang') {
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', resolve, { once: true });
        });
      }
      const status = signal.aborted ? 'aborted' : 'completed';
      emit({ type: 'stream_end', text: 'hi', aborted: signal.aborted });
      emit({ type: 'turn_complete', status });
      return { text: 'hi', status };
    },
  };
}

/** Poll until fn() is true, or fail after ms. */
export async function waitFor(fn, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A real WebSocket client that keeps every frame it gets. */
export async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames = [];
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code })));
  ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('socket did not open')), { once: true });
  });
  return {
    ws, frames, closed,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next: async (pred, what = 'frame') => {
      await waitFor(() => frames.some(pred), 2000, what);
      return frames.find(pred);
    },
    close: () => ws.close(),
  };
}

/** A raw upgrade request. Resolves { status, socket } (socket only on 101). */
export function rawUpgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers,
      },
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, socket: null }); });
    req.on('error', reject);
    req.end();
  });
}

/** A raw GET with the path sent exactly as given (no URL normalizing). */
export function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
