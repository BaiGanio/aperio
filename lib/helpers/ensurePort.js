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

const MAX_WAIT_MS = 8_000;
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
      console.log(`⚡ Killed PID ${pid} occupying port`);
    } catch (e) {
      // Process may have already exited — not an error worth surfacing.
      console.warn(`⚠️  Could not kill PID ${pid}: ${e.message}`);
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
 */
export async function ensurePort(port) {
  port = Number(port);

  if (await isPortFree(port)) {
    console.log(`✅ Port ${port} is free`);
    return;
  }

  console.log(`⚠️  Port ${port} is in use — looking for the occupying process…`);

  const pids = pidsOnPort(port);
  if (pids.length) {
    console.log(`🔪 Killing PID(s): ${pids.join(", ")}`);
    killPids(pids);
  } else {
    console.warn("⚠️  Could not identify occupying PID — waiting for port to free on its own…");
  }

  // Poll until the port is free or we hit the deadline.
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    if (await isPortFree(port)) {
      console.log(`✅ Port ${port} is now free`);
      return;
    }
  }

  throw new Error(
    `Port ${port} is still occupied after ${MAX_WAIT_MS / 1000} s. ` +
    "Free it manually and restart."
  );
}