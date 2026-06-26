// lib/helpers/ollamaWatchdog.js
//
// Dead-man's switch. When no heartbeat arrives for IDLE_TIMEOUT_MS:
//   1. Close WebSocket connections and HTTP server
//   2. Stop Ollama — but only if no other process is using it
//   3. Exit Node
//
// The frontend pings /api/heartbeat every 10 s. Pings stop naturally
// when every tab is closed — no reliance on beforeunload or sendBeacon.

import { exec } from "child_process";
import logger from "./logger.js";

const OLLAMA_HOST     = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const IDLE_TIMEOUT_MS = (Number(process.env.IDLE_TIMEOUT_SECONDS) || 180) * 1000;

async function getOllamaPs() {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/ps`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function isSafeToStop(models) {
  const ps = await getOllamaPs();

  if (!ps) {
    logger.warn("🦙 Ollama appears to be already stopped.");
    return false;
  }

  const loadedModels = ps.models ?? [];

  if (loadedModels.length === 0) return true;

  const foreign = loadedModels.filter(m => !models.includes(m.name));
  if (foreign.length > 0) {
    logger.warn(
      `⚠️  Ollama is in use by other processes (${foreign.map(m => m.name).join(", ")}) — leaving it running.`
    );
    return false;
  }

  return true;
}

function stopOllama() {
  return new Promise(resolve => {
    const cmd =
      process.platform === "win32"
        ? "taskkill /F /IM ollama.exe"
        : "killall ollama";
    exec(cmd, () => resolve());
  });
}

/**
 * Create and start the watchdog.
 *
 * @param {object} opts
 * @param {boolean}     [opts.enabled=true]
 * @param {string}      [opts.model]       - Ollama model name this server uses
 * @param {number}      [opts.timeoutMs]   - Idle timeout in ms (default 30 s)
 * @param {import('http').Server} opts.httpServer - Node HTTP server to close cleanly
 * @param {import('ws').WebSocketServer}  opts.wss - WS server to close cleanly
 * @returns {{ heartbeat: () => void, stop: () => void }}
 */
export function createWatchdog({
  enabled = true,
  models = [],
  timeoutMs = IDLE_TIMEOUT_MS,
  httpServer,
  wss,
  _stopOllama = stopOllama,
  _exit = () => process.kill(process.pid, "SIGTERM"),
} = {}) {
  if (!enabled) {
    return { heartbeat: () => {}, stop: () => {} };
  }

  let timer = null;

  async function onIdle() {
    logger.warn(`\n💤 No heartbeat for ${timeoutMs / 1000} s — shutting down…`);

    // 1. Terminate WebSocket clients and close the WS server
    await new Promise(resolve => {
      if (!wss) return resolve();
      for (const client of wss.clients) client.terminate();
      wss.close(resolve);
    });

    // 2. Stop accepting HTTP connections and drain existing ones
    await new Promise(resolve => {
      if (!httpServer) return resolve();
      httpServer.closeAllConnections?.(); // Node 18.2+
      httpServer.close(resolve);
    });

    // 3. Stop Ollama only if nothing else is using it
    const safe = await isSafeToStop(models);
    if (safe) {
      logger.info("🦙 Stopping Ollama…");
      await _stopOllama();
      logger.warn("✅ Ollama stopped.");
    }

    logger.warn("👋 Server exiting.");
    // Route through the SIGTERM handler (gracefulShutdown in server.js) so the
    // ONNX thread pool is disposed before C++ global destructors run.
    _exit();
  }

  function arm() {
    clearTimeout(timer);
    timer = setTimeout(onIdle, timeoutMs);
  }

  function heartbeat() { arm(); }
  function stop()      { clearTimeout(timer); timer = null; }

  // Don't arm at startup. A server launched without a browser tab (a terminal
  // run, or one still grinding through the initial codegraph/docgraph index)
  // would otherwise be killed before anything ever connected. The dead-man's
  // switch only becomes active once it has seen the first heartbeat — i.e. a
  // browser tab actually connected — and from then on fires when heartbeats stop.
  logger.warn(`💤 Idle shutdown armed on first connection (timeout: ${timeoutMs / 1000} s after the browser tab closes)`);

  return { heartbeat, stop };
}