// lib/helpers/ensurePort.js
//
// Checks whether `port` is already bound. If it is, the occupying process is
// killed (SIGKILL) and we wait up to MAX_WAIT_MS for the port to free before
// throwing. This mirrors the pattern used by ensureOllama() so it can be
// called the same way in server.js:
//
//   await ensurePort(PORT);
//
import { createServer } from "net";
import { execSync }     from "child_process";
import logger from "./logger.js";

const MAX_WAIT_MS = 8_000;
// A self-restart respawn (APERIO_RESTART=1) waits for its still-draining parent
// to release the port instead of killing it, so it needs a longer grace window:
// the parent's graceful shutdown has a 10 s force-exit safety net.
const RESTART_WAIT_MS = 15_000;
const POLL_MS     = 300;

/**
 * Resolve the PID(s) listening on `port` (cross-platform best-effort).
 * Returns an empty array when nothing is found or the command isn't available.
 */
function pidsOnPort(port) {
  try {
    if (process.platform === "win32") {
      // netstat -ano lists  LISTENING lines with PID in the last column
      const out = execSync(
        `netstat -ano | findstr /R ":${port}.*LISTENING"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
      );
      return [...new Set(
        out.trim().split(/\r?\n/)
          .map(l => l.trim().split(/\s+/).pop())
          .filter(Boolean)
      )];
    } else {
      // lsof is available on macOS and most Linux distros; fuser is the
      // fallback for minimal images.
      try {
        const out = execSync(
          `lsof -ti tcp:${port}`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
        );
        return [...new Set(out.trim().split(/\s+/).filter(Boolean))];
      } catch {
        const out = execSync(
          `fuser ${port}/tcp 2>/dev/null || true`,
          { encoding: "utf8", shell: true }
        );
        return [...new Set(out.trim().split(/\s+/).filter(Boolean))];
      }
    }
  } catch {
    return [];
  }
}

/**
 * Kill every PID in the list. On POSIX we use SIGKILL directly; on Windows
 * we call `taskkill /F`.
 */
function killPids(pids) {
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      } else {
        process.kill(Number(pid), "SIGKILL");
      }
      logger.warn(`⚡ Killed PID ${pid} occupying port`);
    } catch (e) {
      // Process may have already exited — not an error worth surfacing.
      logger.warn(`⚠️  Could not kill PID ${pid}: ${e.message}`);
    }
  }
}

/**
 * Quick probe: attempt to bind `port` on localhost.
 * Resolves `true` when the port is free, `false` when it's taken.
 */
function isPortFree(port) {
  return new Promise(resolve => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Ensure `port` is available before the HTTP server tries to bind it.
 *
 * @param {number|string} port
 * @param {object}  [opts]
 * @param {boolean} [opts.wait=false]  When true, never kill the occupant — just
 *   poll until it releases the port. Used by a self-restart respawn so the new
 *   process waits for its draining parent instead of SIGKILLing it.
 */
export async function ensurePort(port, { wait = false } = {}) {
  port = Number(port);

  if (await isPortFree(port)) {
    logger.info(`✅ Port ${port} is free`);
    return;
  }

  // Restart respawn: the parent is gracefully draining and will free the port
  // shortly. Wait it out rather than killing — killing would abort the parent's
  // cleanup (ONNX teardown, DB close) mid-flight.
  if (wait) {
    logger.info(`⏳ Port ${port} still held by the previous process — waiting for it to drain…`);
    const deadline = Date.now() + RESTART_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (await isPortFree(port)) {
        logger.info(`✅ Port ${port} is now free`);
        return;
      }
    }
    throw new Error(
      `Port ${port} still occupied ${RESTART_WAIT_MS / 1000} s after restart — ` +
      "previous process did not exit cleanly."
    );
  }

  logger.warn(`⚠️  Port ${port} is in use — looking for the occupying process…`);

  const pids = pidsOnPort(port);
  if (pids.length) {
    logger.warn(`🔪 Killing PID(s): ${pids.join(", ")}`);
    killPids(pids);
  } else {
    logger.warn("⚠️  Could not identify occupying PID — waiting for port to free on its own…");
  }

  // Poll until the port is free or we hit the deadline.
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    if (await isPortFree(port)) {
      logger.info(`✅ Port ${port} is now free`);
      return;
    }
  }

  throw new Error(
    `Port ${port} is still occupied after ${MAX_WAIT_MS / 1000} s. ` +
    "Free it manually and restart."
  );
}