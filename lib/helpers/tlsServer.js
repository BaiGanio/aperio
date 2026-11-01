// lib/helpers/tlsServer.js
// NET-01 — opt-in TLS. When APERIO_TLS_CERT and APERIO_TLS_KEY both point at
// readable PEM files we serve HTTPS; otherwise we fall back to plain HTTP (the
// default local-only posture). Certs are user-provided — Aperio does not
// generate them — so this is ready for a hosted deployment without forcing
// browser warnings on local users.

import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { readFileSync } from "fs";

// Returns { server, secure }. `server` is an http(s).Server with `app` mounted;
// the WebSocket server attaches to it the same way for either protocol.
export function createAppServer(app, env = process.env) {
  const certPath = env.APERIO_TLS_CERT;
  const keyPath  = env.APERIO_TLS_KEY;

  if (certPath && keyPath) {
    // Let read errors throw — a misconfigured cert should fail loudly at boot
    // rather than silently downgrading to HTTP.
    const cert = readFileSync(certPath);
    const key  = readFileSync(keyPath);
    return { server: createHttpsServer({ cert, key }, app), secure: true };
  }

  if (certPath || keyPath) {
    throw new Error("NET-01: set BOTH APERIO_TLS_CERT and APERIO_TLS_KEY to enable TLS, or neither.");
  }

  return { server: createHttpServer(app), secure: false };
}
