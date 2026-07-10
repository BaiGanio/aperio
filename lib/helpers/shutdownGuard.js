// lib/helpers/shutdownGuard.js
//
// Dead-man's switch. When no heartbeat arrives for IDLE_TIMEOUT_MS:
//   1. Close WebSocket connections and HTTP server
//   2. Stop llama-server — but only the instance THIS process spawned
//   3. Exit Node
//
// The frontend pings /api/heartbeat every 10 s. Pings stop naturally
// when every tab is closed — no reliance on beforeunload or sendBeacon.
//
// Ollama's watchdog had to ask "/api/ps — is anyone else using this?" because
// `ollama serve` is a shared system daemon Aperio doesn't own. llama-server is
// spawned and owned by this process (see startLlamaCpp.js), so the safety
// question collapses to "do we hold its PID?" — no PID means either nothing is
// running or we attached to an instance we didn't start, and either way we
// leave it alone.

import logger from "./logger.js";

const IDLE_TIMEOUT_MS = (Number(process.env.IDLE_TIMEOUT_SECONDS) || 180) * 1000;

function killPid(pid) {
  // Signal the whole process GROUP (negative PID): llama-server's router forks
  // a child worker per model that holds the weights resident, and it shares the
  // router's group (we spawn the router detached). Killing only the router PID
  // orphans those workers. Fall back to the lone PID if group signaling fails.
  // server.js injects startLlamaCpp's killByPid for the full SIGTERM→SIGKILL
  // escalation; this default is the standalone safety net.
  try {
    process.kill(-pid, "SIGTERM");
  } catch (e) {
    if (e.code === "ESRCH") return; // group already gone
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

/**
 * Create and start the watchdog.
 *
 * @param {object} opts
 * @param {boolean}     [opts.enabled=true]
 * @param {() => number|null} [opts.getPid] - Returns the llama-server child PID
 *   this process spawned, or null/undefined if we don't own one.
 * @param {number}      [opts.timeoutMs]   - Idle timeout in ms (default 180 s)
 * @param {import('http').Server} opts.httpServer - Node HTTP server to close cleanly
 * @param {import('ws').WebSocketServer}  opts.wss - WS server to close cleanly
 * @returns {{ heartbeat: () => void, stop: () => void, quit: () => Promise<void> }}
 */
export function createWatchdog({
  enabled = true,
  getPid = () => null,
  timeoutMs = IDLE_TIMEOUT_MS,
  httpServer,
  wss,
  _killPid = killPid,
  // Preferred stop path: an owner-aware, preset-guarded async that decides for
  // itself whether it's safe to stop (server.js injects startLlamaCpp's
  // stopLlamaCpp). When absent we fall back to the raw group-kill of getPid().
  _stopLlama = null,
  _exit = () => process.kill(process.pid, "SIGTERM"),
} = {}) {
  let timer = null;

  async function onIdle(reason = `No heartbeat for ${timeoutMs / 1000} s`) {
    logger.warn(`\n💤 ${reason} — shutting down…`);

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

    // 3. Stop llama-server. Prefer the owner-aware, preset-guarded stop; fall
    //    back to a raw group-kill of the PID we hold.
    if (_stopLlama) {
      await _stopLlama();
    } else {
      const pid = getPid();
      if (pid) {
        logger.info("🦙 Stopping llama-server…");
        await _killPid(pid);
        logger.warn("✅ llama-server stopped.");
      }
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

  function heartbeat() { if (enabled) arm(); }
  function stop()      { clearTimeout(timer); timer = null; }
  // Explicit "Quit Aperio": run the same teardown as an idle timeout right now
  // (stops llama-server if we own it, then exits) instead of waiting out the
  // timer. Available even when the idle guard is disabled.
  function quit()      { clearTimeout(timer); return onIdle("Quit requested"); }

  // Don't arm at startup. A server launched without a browser tab (a terminal
  // run, or one still grinding through the initial codegraph/docgraph index)
  // would otherwise be killed before anything ever connected. The dead-man's
  // switch only becomes active once it has seen the first heartbeat — i.e. a
  // browser tab actually connected — and from then on fires when heartbeats stop.
  if (enabled) {
    logger.warn(`💤 Idle shutdown armed on first connection (timeout: ${timeoutMs / 1000} s after the browser tab closes)`);
  }

  return { heartbeat, stop, quit };
}
