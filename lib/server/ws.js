// lib/server/ws.js — WebSocket server creation, origin/auth verification, and
// the broadcast helper used by the background scheduler's job-done notifications.

import { WebSocketServer, WebSocket } from "ws";
import { isAuthorized } from "../helpers/authGuard.js";

export function createWsServer({
  httpServer,
  allowedHosts,
  makeWsHandler,
  agent,
  primaryRoundtable,
  verifier,
  roundtableAvailable,
  roundtableUnavailableReason,
  store,
  isShuttingDown,
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
  wss.on("connection", makeWsHandler({
    agent, primaryRoundtable, verifier,
    roundtableAvailable, roundtableUnavailableReason,
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

  return { wss, broadcastToClients, _verifyClient: verifyClient };
}
