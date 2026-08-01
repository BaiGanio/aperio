// lib/helpers/selfRestart.js
//
// Restart the Aperio process from within the running app, so a non-coder can
// apply a config change (e.g. switching the model) by clicking a button instead
// of touching a terminal. Config edits are injected into process.env once at
// boot (see lib/config-resolver.js), so only a full process restart applies them.
//
// Two cases, decided by isSupervised():
//   • Supervised (Docker `restart: unless-stopped`, systemd, PM2, k8s): just
//     exit cleanly — the supervisor relaunches us.
//   • Unsupervised (a bare `node server.js` / `npm start` in a terminal): nothing
//     would bring us back, so we first spawn a detached replacement that outlives
//     this process, then exit. The child boots with APERIO_RESTART=1, which makes
//     ensurePort() wait for this process to release the port instead of killing it.
//
// Either way the actual teardown is the existing graceful shutdown (the SIGTERM
// handler in server.js bootApp()).

import { spawn } from "child_process";
import { existsSync } from "fs";
import logger from "./logger.js";

/**
 * Best-effort detection of an external supervisor that will relaunch us on exit.
 * Set APERIO_SUPERVISED=0 to force self-respawn, or =1 to force exit-only.
 */
export function isSupervised() {
  if (process.env.APERIO_SUPERVISED === "0") return false;
  if (process.env.APERIO_SUPERVISED === "1") return true;
  return (
    existsSync("/.dockerenv") ||                       // Docker
    !!process.env.KUBERNETES_SERVICE_HOST ||           // Kubernetes
    !!process.env.pm_id ||                             // PM2
    process.env.INVOCATION_ID != null                  // systemd
  );
}

/**
 * Spawn a detached copy of this process that survives our exit. The child
 * re-runs the same `node <argv>` with APERIO_RESTART=1 set.
 */
function spawnReplacement() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, APERIO_RESTART: "1" },
    detached: true,           // new session/process group → survives our exit
    stdio: "inherit",         // keep logging to the same terminal for continuity
  });
  child.unref();
  logger.warn(`↻ Spawned replacement process (pid ${child.pid}) — waiting for handoff…`);
}

/**
 * Trigger a restart. Returns synchronously with the chosen strategy so the HTTP
 * handler can respond before teardown begins; the work runs on a short delay so
 * the response flushes first.
 *
 * @returns {{ supervised: boolean }}
 */
export function restartServer() {
  const supervised = isSupervised();
  setTimeout(() => {
    if (!supervised) {
      try { spawnReplacement(); }
      catch (err) { logger.error("Self-respawn failed — exiting without a replacement:", err); }
    }
    logger.warn(`↻ Restarting Aperio (${supervised ? "supervised — relaunched by supervisor" : "self-respawn"})…`);
    process.kill(process.pid, "SIGTERM");   // → graceful shutdown handler
  }, 200);
  return { supervised };
}
