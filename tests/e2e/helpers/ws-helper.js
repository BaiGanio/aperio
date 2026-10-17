// tests/e2e/helpers/ws-helper.js
// Shared WebSocket test helpers — buffers handshake messages before the `open`
// event resolves, eliminating the race between connection establishment and
// listener attachment. Also detects EPERM/EACCES bind failures distinctly from
// protocol timeouts.
//
// Both streaming.test.js and websocket-lifecycle.test.js import from here.

import { spawn } from "node:child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "..", "fixtures", "server.js");

/** Spawn the fixture WebSocket server child process. */
export function startFixture() {
  return spawn(process.execPath, [FIXTURE], { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Read the OS-assigned port from the fixture stdout.
 * Also monitors stderr so EPERM/EACCES bind failures are reported distinctly
 * from a generic "No PORT" timeout.
 */
export function readPort(server, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("No PORT")), timeout);
    let buf = "";

    server.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/PORT:(\d+)/);
      if (m) {
        clearTimeout(tid);
        resolve(Number(m[1]));
      }
    });

    // Detect bind permission failures before the generic timeout
    server.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (/EPERM|EACCES|permission denied/i.test(text)) {
        clearTimeout(tid);
        reject(
          new Error(
            "BIND_FAILURE: server could not bind to localhost (EPERM/EACCES)",
          ),
        );
      }
    });

    server.on("exit", (code) => {
      clearTimeout(tid);
      reject(new Error(`exited ${code}`));
    });
  });
}

/**
 * Connect to the fixture WebSocket server with a pre-connected message buffer.
 *
 * The `message` listener is attached *before* the `open` event fires, so
 * handshake messages (status, provider, session_created) are captured without
 * racing between connection setup and listener registration — the primary cause
 * of test flakiness under concurrent CI runners.
 *
 * Returns `{ ws, buffer, waitForType(type), collect(ms), collectUntil(endType), close() }`.
 */
export async function connectBuffered(port, timeout = 5_000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const buffer = [];
  const pending = new Map(); // type → resolve function

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    buffer.push(msg);
    const resolvePending = pending.get(msg.type);
    if (resolvePending) {
      pending.delete(msg.type);
      resolvePending(msg);
    }
  });

  // Wait for the WebSocket to open
  await new Promise((resolve, reject) => {
    const tid = setTimeout(
      () => reject(new Error("WS timeout")),
      timeout,
    );
    ws.once("open", () => {
      clearTimeout(tid);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(tid);
      reject(err);
    });
  });

  // After open, wait for the full handshake to arrive in the buffer.
  // The server sends status / provider / session_created synchronously after
  // accepting the connection, but TCP framing and the event loop mean they
  // may arrive as separate message events. We wait for all three so the
  // caller can always read the complete handshake via buffer or waitForType.
  while (buffer.length < 3) {
    await new Promise((resolve) => {
      ws.once("message", () => resolve());
    });
  }

  const api = {
    ws,
    /** Raw message buffer — inspectable for order-sensitive tests. */
    buffer,

    /**
     * Wait for a specific message type.
     * Checks the buffer first (messages that arrived before the caller was
     * ready), then falls back to a listener for messages that haven't arrived
     * yet. This is the core hardening against the open→listener race.
     */
    waitForType(type, msTimeout = 5_000) {
      const idx = buffer.findIndex((m) => m.type === type);
      if (idx >= 0) {
        return Promise.resolve(buffer.splice(idx, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const tid = setTimeout(
          () => reject(new Error(`No ${type} within timeout`)),
          msTimeout,
        );
        pending.set(type, (msg) => {
          clearTimeout(tid);
          resolve(msg);
        });
      });
    },

    /**
     * Collect all messages during a fixed time window.
     * Kept for backward compatibility; prefer `collectUntil` when the
     * terminating message type is known.
     */
    collect(msTimeout = 300) {
      const existing = buffer.splice(0, buffer.length);
      const msgs = [...existing];
      return new Promise((resolve) => {
        const handler = (raw) => msgs.push(JSON.parse(raw.toString()));
        ws.on("message", handler);
        setTimeout(() => {
          ws.removeListener("message", handler);
          resolve(msgs);
        }, msTimeout);
      });
    },

    /**
     * Collect messages until a specific terminal type arrives.
     * Event-driven — waits for the actual terminating message rather than a
     * fixed sleep window. Use this whenever the test expects a known terminal
     * message (stream_end, error, provider, etc.).
     */
    collectUntil(endType, timeout = 5_000) {
      const existing = buffer.splice(0, buffer.length);
      const msgs = [...existing];
      return new Promise((resolve, reject) => {
        const tid = setTimeout(
          () => reject(new Error(`No ${endType} within timeout`)),
          timeout,
        );
        const handler = (raw) => {
          const msg = JSON.parse(raw.toString());
          msgs.push(msg);
          if (msg.type === endType) {
            clearTimeout(tid);
            ws.removeListener("message", handler);
            resolve(msgs);
          }
        };
        ws.on("message", handler);
      });
    },

    /** Close the WebSocket connection. */
    close() {
      ws.close();
    },
  };

  return api;
}
