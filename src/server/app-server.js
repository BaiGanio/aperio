// src/server/app-server.js - the web app: one HTTP server that serves public/
// (http-app.js) and carries the one WebSocket (ws-edge.js) (spec S2.14 §2).
//
// The server knows the turn runner only, never the store or the provider.
// No module state: every createServer() owns its own sockets, sessions and timer.
// L-C14 / AP9: this is the only server file; its name says what it is.

import http from 'node:http';
import { createHttpHandler, CSP_HEADER } from './http-app.js';
import { createWsEdge } from './ws-edge.js';

export { CSP_HEADER };

/**
 * @param {{ config: Record<string, any>, runner: { newConversation: Function, runTurn: Function },
 *   log: { error: Function, warn: Function, info: Function }, publicDir?: string, pingIntervalMs?: number }} opts
 * @returns {{ listen(): Promise<{ port: number }>, close(): Promise<void>, sessionCount(): number }}
 */
export function createServer({ config, runner, log, publicDir, pingIntervalMs }) {
  const server = http.createServer(createHttpHandler({ publicDir, log }));
  const edge = createWsEdge({ server, config, runner, log, pingIntervalMs });
  let closing = null;

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.PORT, config.HOST, () => {
        server.off('error', reject);
        server.on('error', (err) => log.error(`[http] server error: ${err.message}`));
        const addr = server.address();
        resolve({ port: typeof addr === 'object' && addr ? addr.port : config.PORT });
      });
    });
  }

  /** Sockets first (aborts the turn), then the HTTP server. Safe to call twice. */
  function close() {
    closing ??= (async () => {
      await edge.close();
      if (!server.listening) return;
      const done = new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      server.closeAllConnections();
      await done;
    })();
    return closing;
  }

  return { listen, close, sessionCount: edge.sessionCount };
}
