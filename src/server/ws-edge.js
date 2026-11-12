// src/server/ws-edge.js - the one WebSocket edge (spec S2.14 §2.3, AP8).
//
// Kept from v1 lib/server/ws.js (archive/v1-final): the Origin allowlist (stops
// DNS rebinding from a web page) and a ping sweep on an unref'd timer.
// Dropped: the opt-in token. New: WS_MAX_CLIENTS (503), and every frame in goes
// through parseClientFrame once, every frame out through encodeServerFrame.
// The session registry is a Map inside createWsEdge: no module state.

import { WebSocketServer } from 'ws';
import { parseClientFrame, encodeServerFrame } from '../shared/ws-schema.js';
import { createChatSession, createTurnGate, clip } from './chat-session.js';

export const PING_INTERVAL_MS = 30_000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const CLOSE_GRACE_MS = 1000;

/**
 * Check the Origin header. No header (a non-browser client) is allowed.
 * @param {string | undefined} origin @param {string} host  config HOST
 * @returns {200 | 400 | 403}
 */
export function checkOrigin(origin, host) {
  if (origin === undefined) return 200;
  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return 400; // not a URL: answered with 400 by the caller
  }
  const allowed = [...LOCAL_HOSTS, String(host ?? '').toLowerCase()];
  return allowed.includes(hostname) ? 200 : 403;
}

/**
 * @param {{ server: import('node:http').Server, config: Record<string, any>, runner: object,
 *   log: { error: Function, warn: Function, info: Function }, pingIntervalMs?: number }} opts
 */
export function createWsEdge({ server, config, runner, log, pingIntervalMs = PING_INTERVAL_MS }) {
  const maxBytes = config.WS_MAX_FRAME_BYTES;
  const maxClients = config.WS_MAX_CLIENTS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBytes });
  const gate = createTurnGate();
  /** @type {Map<string, { ws: import('ws').WebSocket, session: ReturnType<typeof createChatSession>, alive: boolean }>} */
  const sessions = new Map();
  let upgrading = 0;

  server.on('upgrade', (req, socket, head) => {
    const status = checkOrigin(req.headers.origin, config.HOST);
    if (status !== 200) return refuse(socket, status, log);
    if (sessions.size + upgrading >= maxClients) return refuse(socket, 503, log);
    upgrading++;
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgrading--;
      attach(ws);
    });
  });

  function attach(ws) {
    let skipped = false;
    const send = (msg) => {
      if (ws.readyState !== ws.OPEN) {
        if (!skipped) log.info(`[ws] socket closed; skipping ${msg.type} and later frames`);
        skipped = true;
        return;
      }
      try {
        ws.send(encodeServerFrame(msg.type === 'error' ? { ...msg, message: clip(msg.message) } : msg));
      } catch (err) {
        // encodeServerFrame throws on a bad frame: a server bug, logged, never sent.
        log.error(`[ws] dropped a bad server frame: ${err.message}`);
      }
    };
    const session = createChatSession({ runner, gate, send, log });
    const entry = { ws, session, alive: true };
    sessions.set(session.id, entry);

    ws.on('pong', () => { entry.alive = true; });
    ws.on('message', (data, isBinary) => {
      const parsed = parseClientFrame(isBinary ? data : data.toString('utf8'), { maxBytes });
      if (!parsed.ok) return send({ type: 'error', code: parsed.error.code, message: parsed.error.message });
      session.handle(parsed.msg);
    });
    ws.on('error', (err) => log.warn(`[ws] socket error: ${err.message}`));
    ws.on('close', () => {
      session.close();
      sessions.delete(session.id);
    });
  }

  const sweep = setInterval(() => {
    for (const entry of sessions.values()) {
      if (!entry.alive) {
        entry.ws.terminate();
        continue;
      }
      entry.alive = false;
      entry.ws.ping();
    }
  }, pingIntervalMs);
  sweep.unref();

  /** End every socket, abort the running turn, wait (bounded) for it to finish. */
  async function close() {
    clearInterval(sweep);
    const entries = [...sessions.values()];
    const closed = entries.map(({ ws }) => new Promise((resolve) => {
      if (ws.readyState === ws.CLOSED) return resolve();
      ws.once('close', resolve);
    }));
    for (const { ws, session } of entries) {
      session.close();
      ws.close(1001, 'server stopping');
    }
    await waitBounded(Promise.all(closed));
    for (const { ws } of sessions.values()) ws.terminate();
    if (gate.done) await waitBounded(gate.done);
    await new Promise((resolve) => wss.close(() => resolve()));
  }

  return { close, sessionCount: () => sessions.size };
}

/** Wait for p, but never longer than CLOSE_GRACE_MS. */
async function waitBounded(p) {
  let timer;
  const grace = new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_GRACE_MS); });
  await Promise.race([p, grace]);
  clearTimeout(timer);
}

const REASONS = { 400: 'Bad Request', 403: 'Forbidden', 503: 'Service Unavailable' };
function refuse(socket, status, log) {
  socket.on('error', (err) => log.warn(`[ws] refused socket error: ${err.message}`));
  socket.end(`HTTP/1.1 ${status} ${REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
