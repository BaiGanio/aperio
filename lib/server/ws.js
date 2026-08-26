// lib/server/ws.js — WebSocket server creation, origin/auth verification, the
// liveness ping/pong sweep, and the broadcast helper used by the background
// scheduler's job-done notifications.

import { WebSocketServer, WebSocket } from "ws";
import { isAuthorized } from "../helpers/authGuard.js";

// How often the server pings every open socket to check it is still there.
// Kept well under IDLE_TIMEOUT_SECONDS by the caller: a socket orphaned by
// laptop sleep needs two sweeps to be reaped, so the reaping must finish
// inside one idle window or a dead tab would hold the server up forever.
const DEFAULT_PING_INTERVAL_MS = 30_000;

export function createWsServer({
  httpServer,
  allowedHosts,
  makeWsHandler,
  agent,
  roundtable,
  store,
  isShuttingDown,
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
}) {
  const verifyClient = ({ origin, req }, cb) => {
    if (origin) {
      try {
        const { hostname } = new URL(origin);
        if (!allowedHosts.has(hostname.toLowerCase())) return cb(false, 403, "Forbidden");
      } catch {
        return cb(false, 400, "Bad Request");
      }
    }
    if (!isAuthorized(req)) return cb(false, 401, "Unauthorized");
    cb(true);
  };

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient,
  });

  // ── Liveness (issue #454) ──────────────────────────────────────────────────
  // The browser's /api/heartbeat ping is a page timer, and Chrome throttles
  // background timers to roughly once a minute before freezing them outright —
  // with the 60 s/180 s defaults a single missed ping killed a backgrounded but
  // perfectly alive tab. A WebSocket ping is answered by the browser's network
  // stack, not by page JS, so it survives throttling and freezing. That makes
  // the open socket the honest "someone is still here" signal.
  //
  // The sweep is also what keeps that signal from lying in the other direction:
  // a socket orphaned by laptop sleep or a dropped network stays "open" forever
  // and would pin the server up. Two sweeps without a pong and it is reaped.
  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
  });

  const pingSweep = () => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  };

  const pingTimer = setInterval(pingSweep, pingIntervalMs);
  // Never let the sweep alone hold the process open — an unref'd interval also
  // keeps `node --test` from hanging on a stray timer.
  pingTimer.unref?.();
  wss.on("close", () => clearInterval(pingTimer));

  /** Sockets that are genuinely open right now. Feeds the idle watchdog. */
  const liveClientCount = () => {
    let n = 0;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) n++;
    }
    return n;
  };

  wss.on("connection", makeWsHandler({
    agent, roundtable,
    store, isShuttingDown,
  }));

  const broadcastToClients = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(data); } catch { /* dead socket */ }
      }
    }
  };

  return {
    wss,
    broadcastToClients,
    liveClientCount,
    _verifyClient: verifyClient,
    _pingSweep: pingSweep,
    _pingTimer: pingTimer,
  };
}
