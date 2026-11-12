// src/server/chat-session.js - one session per socket (spec S2.14 §2.4).
//
// All per-socket state lives in the one object made here: { id, conv, active,
// turnId }. v1 spread it over ~15 `let`s in a 769-line closure. close() frees it.
// One turn at a time server-wide (llama has one slot, §4.3): the shared `gate`
// says who holds it; a second chat gets `busy`. No supersede queue (dropped).

import { randomUUID } from 'node:crypto';

/** Memory messages are S3.4. Until then they answer not_ready. */
const NOT_READY = new Set(['memories_list', 'memory_update', 'memory_delete']);
/** ws-schema caps error.message at 2000 chars; a longer one would make encodeServerFrame throw. */
const MESSAGE_MAX = 2000;

/** @typedef {{ holder: object | null, done: Promise<void> | null }} TurnGate */

/** @returns {TurnGate} */
export function createTurnGate() {
  return { holder: null, done: null };
}

/**
 * @param {{ runner: { newConversation: () => any, runTurn: Function }, gate: TurnGate,
 *   send: (msg: Record<string, unknown>) => void, log: { error: Function, info?: Function } }} opts
 */
export function createChatSession({ runner, gate, send, log }) {
  const session = {
    id: randomUUID(),
    conv: runner.newConversation(),
    /** @type {AbortController | null} */
    active: null,
    /** @type {string | null} */
    turnId: null,
    closed: false,
  };

  /** @param {Record<string, unknown>} msg  a frame already checked by parseClientFrame */
  function handle(msg) {
    if (session.closed) return;
    if (msg.type === 'chat') return void chat(/** @type {string} */ (msg.turnId), /** @type {string} */ (msg.text));
    if (msg.type === 'stop') return stop(/** @type {string | undefined} */ (msg.turnId));
    if (NOT_READY.has(/** @type {string} */ (msg.type))) {
      return send({ type: 'error', code: 'not_ready', message: `${msg.type} is not available yet` });
    }
    log.error(`[session] no handler for ${msg.type}`);
  }

  async function chat(turnId, text) {
    if (gate.holder) {
      send({ type: 'error', turnId, code: 'busy', message: 'Another turn is running. Wait for it, or stop it.' });
      send({ type: 'turn_complete', turnId, status: 'error' });
      return;
    }
    const ac = new AbortController();
    let release;
    gate.holder = session;
    gate.done = new Promise((resolve) => { release = resolve; });
    session.active = ac;
    session.turnId = turnId;
    let completed = false;
    const emit = (e) => {
      if (e.type === 'turn_complete') completed = true;
      send({ ...e, turnId });
    };
    try {
      await runner.runTurn(session.conv, text, { emit, signal: ac.signal });
    } catch (err) {
      log.error(`[session ${session.id}] turn ${turnId} failed: ${err.message}`);
      send({ type: 'error', turnId, code: 'turn_failed', message: clip(err.message) });
      if (!completed) send({ type: 'turn_complete', turnId, status: 'error' });
    } finally {
      session.active = null;
      session.turnId = null;
      gate.holder = null;
      gate.done = null;
      release();
    }
  }

  /** A stop for another turn id is ignored; a stop with no id stops the running turn. */
  function stop(turnId) {
    if (!session.active) return;
    if (turnId !== undefined && turnId !== session.turnId) return;
    session.active.abort();
  }

  /** Socket closed: abort the turn, keep nothing. */
  function close() {
    if (session.closed) return;
    session.closed = true;
    session.active?.abort();
    session.conv.history.length = 0;
    session.conv.recallSession?.reset();
  }

  return { id: session.id, handle, close, isBusy: () => session.active !== null };
}

/** @param {unknown} message */
export function clip(message) {
  const s = String(message ?? '');
  return s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX - 1)}…` : s;
}
