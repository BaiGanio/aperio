// @ts-check
// public/services/socket-service.js - the one socket of the page (spec S3.0 §2.3).
// Sets store `connection` = connecting | open | closed. On close it reconnects
// with backoff (0.5 s, x2, max 10 s, reset on open). Every inbound frame is
// checked with the shared schema (AP8); a good one becomes `lastFrame`.
// It never touches the DOM. "Closed" is a normal state, not an error.

import { encodeClientFrame, parseServerFrame } from '../shared/ws-schema.js';

const BACKOFF_FIRST_MS = 500;
const BACKOFF_MAX_MS = 10_000;

/** @typedef {import('../state/store.js').Store} Store */
/** @typedef {{ send(data: string): void, close(code?: number): void, readyState: number,
 *   addEventListener(type: string, fn: (e: any) => void): void,
 *   removeEventListener(type: string, fn: (e: any) => void): void }} SocketLike */

/**
 * @param {{ store: Store, url: string, WebSocket: new (url: string) => SocketLike }} deps
 * @returns {{ send(msg: Record<string, unknown>): boolean, dispose(): void }}
 */
export function createSocketService(deps) {
  const { store, url, WebSocket: Socket } = deps;
  /** @type {SocketLike | null} */
  let ws = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let wait = BACKOFF_FIRST_MS;
  let disposed = false;
  let isOpen = false;

  function connect() {
    timer = null;
    if (disposed) return;
    store.set('connection', 'connecting');
    const socket = new Socket(url);
    ws = socket;
    isOpen = false;

    const onOpen = () => {
      if (ws !== socket) return;
      isOpen = true;
      wait = BACKOFF_FIRST_MS;
      store.set('connection', 'open');
    };
    /** @param {{ data: unknown }} e */
    const onMessage = (e) => {
      if (ws !== socket) return;
      const r = parseServerFrame(e.data);
      if (r.ok) {
        store.set('lastFrame', r.msg);
        return;
      }
      console.warn(`[socket] dropped a server frame: ${r.error.code}: ${r.error.message}`);
      store.set('lastError', r.error);
    };
    const onClose = () => {
      if (ws !== socket) return; // a second close for an old socket schedules nothing
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      ws = null;
      isOpen = false;
      if (disposed) return;
      store.set('connection', 'closed');
      timer = setTimeout(connect, wait);
      wait = Math.min(wait * 2, BACKOFF_MAX_MS);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
  }

  connect();

  return {
    /** Send one client message. False while not open; a bad message throws (a client bug). */
    send(msg) {
      if (!ws || !isOpen || disposed) return false;
      ws.send(encodeClientFrame(msg));
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const socket = ws;
      ws = null;
      isOpen = false;
      socket?.close(1000);
    },
  };
}
