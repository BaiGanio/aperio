// lib/helpers/startLlamaCpp.js
//
// llama.cpp equivalent of startOllama.js. llama-server's router mode
// (--models-preset) replaces Ollama's one-model-per-process model: both the
// main chat model and the VLM bridge model are entries in a single preset,
// loaded/swapped by the router as requests name them.
//
// This is the orchestration entry point (ensureLlamaCpp) plus the process/PID/
// state-file lifecycle it depends on. The pure preset/sizing/VLM-fit logic and
// the per-session log tee live in lib/helpers/llamacpp/*; this file re-exports
// their public surface so existing imports of "./helpers/startLlamaCpp.js"
// keep working unchanged.
import { spawn, execFileSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from "fs";
import { resolve, basename } from "path";
import { createHash } from "crypto";
import logger from "./logger.js";
import { resolvePerfProfile, factsForHf } from "../providers/index.js";
import { resolveModelCacheDir } from "./modelCache.js";
import { inspectCachedModel } from "./ggufModelFacts.js";
import { LLAMACPP_PORT, LLAMACPP_BASE_URL, MAX_WAIT_MS, KILL_TIMEOUT_MS, STATE_FILE, POLL_MS, PRESET_DIR, PRESET_PATH, SERVER_LOG_PATH } from "./llamacpp/constants.js";
import { serveCtxFor } from "./llamacpp/sizing.js";
import { buildModelsPreset, defaultMainModelHf, DEFAULT_VLM_MODEL } from "./llamacpp/preset.js";
import { vlmPresetMode } from "./llamacpp/vlm.js";
import { fetchServerModels, presetsModels, shouldStartOffline } from "./llamacpp/models.js";

export {
  getLoadedModels,
  presetModelIds,
  shouldStartOffline,
} from "./llamacpp/models.js";
export {
  buildModelsPreset,
  collectExtraLlamaCppModels,
} from "./llamacpp/preset.js";
export {
  mainPlusVlmFit,
  vlmPresetMode,
} from "./llamacpp/vlm.js";
export {
  beginSessionLog,
  endSessionLog,
  appendSessionLog,
  pumpServerLogTee,
  pruneServerLogs,
  deleteServerLog,
} from "./llamacpp/sessionLog.js";

async function isLlamaCppUp() {
  try {
    const r = await fetch(`${LLAMACPP_BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

let llamaCppProc = null;

// Aperio's configured llama.cpp port is dedicated to its local engine. If a
// previous Aperio process died before writing/clearing state.json, recover the
// listener so the next boot can reconcile and own it instead of silently
// attaching to a stale model/cache configuration.
function findLlamaCppPidOnPort() {
  if (process.env.NODE_ENV === "test") return null;
  if (process.platform === "win32") {
    try {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      const port = `:${LLAMACPP_PORT}`;
      for (const line of out.split("\n")) {
        if (!line.includes(port) || !/LISTENING/i.test(line)) continue;
        const pid = Number(line.trim().split(/\s+/).at(-1));
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
    } catch { /* netstat unavailable */ }
    return null;
  }
  try {
    const out = execFileSync("lsof", ["-tiTCP:" + LLAMACPP_PORT, "-sTCP:LISTEN"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

// PID of the llama-server child THIS process spawned, or null if we haven't
// spawned one (either not started yet, or we attached to one already running
// that we don't own — see the "already running" branch below).
export function getLlamaCppPid() {
  return llamaCppProc?.pid ?? null;
}

// `_spawn` is injectable (default: the real child_process.spawn) so tests never
// risk launching a real llama-server — unlike startOllama.js's ensureOllama(),
// which gets away with mock.method() because Ollama usually isn't installed on
// CI/dev machines, llama-server IS (it's the whole point of this module), so a
// missed mock would silently spawn a real background server during `npm test`.

// ── State helpers ──────────────────────────────────────────────────────────
// Track the spawned PID and last-known preset hash on disk so ensureLlamaCpp
// can reconcile a stale running server (model changed in .env) without asking
// the user to manually kill processes.

function hashPreset(preset) {
  return createHash("sha256").update(preset).digest("hex");
}

function readState() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = readFileSync(STATE_FILE, "utf-8");
    const s = JSON.parse(raw);
    // pid is either a real PID we spawned, or null (server is up but not
    // ours to manage — see the "already running" branch in ensureLlamaCpp).
    if ((typeof s?.pid === "number" || s?.pid === null) && typeof s?.hash === "string" && s.hash.length === 64) return s;
    return null;
  } catch { return null; }
}

function writeState(pid, preset) {
  try {
    mkdirSync(PRESET_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ pid, hash: hashPreset(preset), at: Date.now() }));
  } catch { /* best-effort */ }
}

function clearState() {
  try { if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}"); } catch { /* best-effort */ }
}

// Signal an ENTIRE process group (negative PID) rather than a lone PID.
//
// llama-server in --models-preset (router) mode is a supervisor: it binds our
// port but spawns a separate child worker process per served model (on its own
// random port) that actually loads the weights and holds them resident — 3+ GB
// for a small model, ~7 GB for the VLM. We spawn the router `detached`, so it's
// a process-group leader (PGID == its PID) and the worker(s) it forks share
// that group. Signaling only the router PID orphans those workers — each keeps
// its model in RAM — so across model-change restarts they accumulate, exhaust
// memory, and push the machine into swap, which is exactly the "every restart
// gets slower" symptom. A group signal reaches the router and every worker at
// once (the PGID persists even after the leader dies, so a lingering worker is
// still reachable). Falls back to the single PID when group signaling isn't
// available. An already-gone target is a successful teardown.
function signalGroup(pid, sig) {
  try { process.kill(-pid, sig); return true; }
  catch (e) {
    if (e.code === "ESRCH") return true; // whole group already gone
    // EPERM / EINVAL / not-a-group-leader → best-effort single-PID signal.
    try { process.kill(pid, sig); return true; }
    catch (e2) { return e2.code !== "ESRCH"; }
  }
}

// Kill the process group led by `pid` (router + its model workers), with a
// brief grace period. Returns true if the leader is confirmed gone.
export async function killByPid(pid) {
  if (!pid || pid <= 0) return false;
  if (!signalGroup(pid, "SIGTERM")) return false; // signal failed
  // Wait up to KILL_TIMEOUT_MS for the leader to exit
  const deadline = Date.now() + KILL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { break; } // ESRCH → leader gone
    await new Promise(r => setTimeout(r, 200));
  }
  // Final SIGKILL sweep of the whole group — catches a leader still hung on
  // SIGTERM AND any worker that outlived it.
  signalGroup(pid, "SIGKILL");
  await new Promise(r => setTimeout(r, 500));
  try { process.kill(pid, 0); return false; } catch { return true; }
}

// Stop the llama-server dedicated to Aperio's configured local-engine port.
// The PID is either the child we spawned or a listener adopted after a prior
// process lost state.json. killByPid tears down the complete process group so
// router workers cannot remain resident after the parent exits.
function isLlamaServerPid(pid) {
  if (!pid || pid <= 0) return false;
  if (process.env.NODE_ENV === "test") return true;
  if (process.platform === "win32") {
    // ps/-o command= don't exist on Windows; the Unix branch would always throw
    // and reject a genuine llama-server, leaving a rediscovered listener treated
    // as unmanaged. tasklist reports the image name (llama-server.exe) as the
    // first CSV field for the queried PID.
    try {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      // "llama-server.exe","1234","Console","1","123,456 K"
      const image = out.split("\n")[0]?.match(/^"([^"]*)"/)?.[1] ?? "";
      return /(?:^|[\\/])?llama-server(?:\.exe)?$/i.test(image);
    } catch { return false; }
  }
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/(?:^|[\\/\s])llama-server(?:$|[\s])/i.test(command)) return true;
  } catch { /* macOS privacy controls can deny ps for another process */ }

  // On macOS, `ps` may be denied even when the process is the listener we
  // need to reconcile. lsof still exposes the executable path for the port
  // owner, so use that as a read-only ownership fallback.
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/)
      .filter(line => line.startsWith("n"))
      .some(line => /(?:^|[\\/])llama-server(?:$|\.exe$)/i.test(line.slice(1)));
  } catch { return false; }
}

export async function stopLlamaCpp(_kill = killByPid, _findPid = findLlamaCppPidOnPort) {
  const pid = getLlamaCppPid() ?? _findPid();
  if (!pid) return false; // we didn't start it → not ours to stop
  logger.info(`🦙 Stopping llama-server on port ${LLAMACPP_PORT} (PID ${pid})…`);
  const killed = await _kill(pid);
  if (!killed) {
    // Never report a leak as a clean stop. A router (or a worker in its group)
    // that outlived the kill keeps its multi-GB model resident; masking that as
    // success is exactly how leaked engines piled up across restarts and pushed
    // the machine into swap. Keep ownership + state so a later stop/reconcile
    // can retry this PID instead of forgetting it.
    logger.error(`🦙 Failed to stop llama-server (PID ${pid}); its model worker group may still be resident. Kill it manually: kill -9 -${pid}`);
    return false;
  }
  clearState();
  llamaCppProc = null;
  // The shared server.log is a runtime-only sink (llama-server is one process
  // feeding every session's tee'd log); once the server we own is down, it has
  // no reason to linger in var/llamacpp next to the per-session logs. Remove it
  // so a stopped Aperio leaves only the per-session files behind.
  try { if (existsSync(SERVER_LOG_PATH)) unlinkSync(SERVER_LOG_PATH); } catch { /* best-effort */ }
  logger.warn("✅ llama-server stopped.");
  return true;
}

// ── Public ─────────────────────────────────────────────────────────────────
export async function ensureLlamaCpp(_spawn = spawn, _kill = killByPid, _findPid = findLlamaCppPidOnPort, _isOwnedPid = isLlamaServerPid) {
  // Mirror startOllama's dual-env-publish: LLAMACPP_SERVE_CTX is the server's
  // real KV-cache window for the MAIN model (what actually gets baked into the
  // preset's ctx-size); LLAMACPP_CTX is the app's trim/cap math assumption —
  // ~92% of the served window, reserving at least 512 tokens for generation so
  // a full-window prompt still leaves the model room to answer. Compute this
  // BEFORE the "already running" early-return: when Aperio spawned llama-server
  // on a prior boot and is now restarting against it, we don't respawn but
  // still must set LLAMACPP_CTX for the trim math.
  const profile   = resolvePerfProfile(process.env);
  const runtimeHardware = { modelCacheDir: resolveModelCacheDir() };
  // Size against the SAME model the preset will serve: read the live env (so
  // custom LLAMACPP_MODEL_TIER_* values win) and the same runtimeHardware
  // buildModelsPreset() uses below. Passing an empty env / mis-ordered args here
  // sized LLAMACPP_SERVE_CTX for the default tier while the preset loaded the
  // configured one.
  const mainModel = process.env.LLAMACPP_MODEL || defaultMainModelHf(process.env, runtimeHardware, profile);
  if (!process.env.LLAMACPP_SERVE_CTX) {
    const inspected = inspectCachedModel(mainModel, runtimeHardware.modelCacheDir);
    process.env.LLAMACPP_SERVE_CTX = String(serveCtxFor(mainModel, process.env, runtimeHardware, profile));
    if (inspected) logger.info(`🦙 Context sizing source=gguf model=${mainModel} file=${basename(inspected.path)} weights=${inspected.sizeGB.toFixed(2)}GiB kv=${inspected.kvBytesPerToken}B/token kv_layers=${inspected.kvLayers} ctx=${process.env.LLAMACPP_SERVE_CTX}`);
    else logger.warn(`🦙 Context sizing source=${factsForHf(mainModel) ? "curated" : "fallback"} model=${mainModel} ctx=${process.env.LLAMACPP_SERVE_CTX}${factsForHf(mainModel) ? "" : " — GGUF is not cached or could not be inspected; sizing remains conservative until the next managed restart"}`);
  }
  if (!process.env.LLAMACPP_CTX) {
    const n = parseInt(process.env.LLAMACPP_SERVE_CTX, 10);
    process.env.LLAMACPP_CTX = String(Math.max(1, Math.min(Math.floor(n * 0.92), n - 512)));
  }

  const preset = buildModelsPreset(process.env, runtimeHardware);
  const vlmModel = process.env.LLAMACPP_VLM_MODEL || DEFAULT_VLM_MODEL;
  logger.info(`🦙 VLM: ${vlmPresetMode(mainModel, vlmModel, process.env, runtimeHardware, profile)}`);
  mkdirSync(PRESET_DIR, { recursive: true });
  writeFileSync(PRESET_PATH, preset);

  if (await isLlamaCppUp()) {
    const stored  = readState();
    // state.json can outlive the router (or its PID can be recycled). When the
    // port is live, ask the OS for its current listener before trusting the
    // persisted PID. Otherwise a stale, unrelated PID can prevent us from
    // reconciling the actual llama-server that is holding the port.
    const portPid = _findPid();
    const statePidMismatch = Boolean(stored?.pid && portPid && portPid !== stored.pid);
    const discoveredPid = llamaCppProc?.pid ?? portPid ?? stored?.pid;
    if (portPid && portPid !== stored?.pid && _isOwnedPid(portPid)) {
      // Repair stale state immediately when the live listener is demonstrably
      // llama-server. This also makes the matching-preset fast path durable.
      llamaCppProc = { pid: portPid };
      writeState(portPid, preset);
    }
    if (!stored?.pid && discoveredPid && _isOwnedPid(discoveredPid)) {
      // Adopt the listener so Ctrl+C/browser-idle shutdown can clean up the
      // exact process we reconciled, including its router worker group — but
      // ONLY after confirming it really is an llama-server. Adopting a
      // port-discovered PID unconditionally would make it equal llamaCppProc.pid,
      // and the `killPid === llamaCppProc?.pid` clause below would then bypass
      // the ownership check and group-kill a non-Aperio process that merely
      // happens to hold the port.
      llamaCppProc = { pid: discoveredPid };
    }
    const currentHash = hashPreset(preset);

    // Fast path: same preset AND our tracked PID is still running.
    if (stored && stored.hash === currentHash && !statePidMismatch) {
      // stored.pid is null when the server is known-unmanaged (see below) —
      // nothing to probe in that case; process.kill(null, 0) would throw a
      // TypeError, and pid 0 has special "whole process group" semantics on
      // POSIX that we never want to invoke here.
      if (stored.pid) {
        try { process.kill(stored.pid, 0); } // ESRCH if dead — fall through
        catch { /* PID gone but server up — some other process, reconcile below */ }
      }
      if (stored.hash === currentHash) {
        // Double-check the server actually has the models it should.
        // A server started from cache (not our preset) may have a different
        // model set even when the file hash matches.
        const serverModels = await fetchServerModels();
        const expectedModels = presetsModels(preset);
        const missing = expectedModels.filter(m => !serverModels?.includes(m));
        if (missing.length === 0) {
          logger.info("🦙 llama-server already running with matching preset — nothing to do");
          return;
        }
        logger.warn(`🦙 llama-server has a stale model set — preset expects ${missing.join(", ")} but the running server doesn't know them. Restarting…`);
      }
    }

    // Preset changed OR server is from a stale session. Attempt to kill the
    // old process so we can restart with the correct model set.
    const killPid = llamaCppProc?.pid ?? portPid ?? stored?.pid ?? discoveredPid;
    const serverUp = await isLlamaCppUp();
    if (killPid) {
      if (!(_isOwnedPid(killPid) || killPid === llamaCppProc?.pid)) {
        logger.error(`🦙 Refusing to kill PID ${killPid}: state.json does not identify it as llama-server. Stop it manually if needed.`);
        return false;
      }
      const killed = await _kill(killPid);
      if (killed) {
        logger.info("🦙 Stopped stale llama-server, restarting with updated preset…");
        clearState();
        // Double-check the port is free before spawning
        if (await isLlamaCppUp()) {
          logger.warn("🦙 Port still in use after kill — another server may be holding the port. Waiting…");
          await new Promise(r => setTimeout(r, 2000));
        }
      } else {
        // Do not let the application continue against a stale engine. It would
        // boot successfully and only fail on the first request with a vague
        // streamed "Compute error." (or silently use the wrong model).
        const message = `llama-server is running with a stale preset but could not be killed (PID ${killPid}). Stop it manually and restart Aperio: kill ${killPid}`;
        logger.error(`🦙 ${message}`);
        return false;
      }
    } else if (serverUp) {
      // Server is up but we don't own it (no stored PID, not our spawn).
      // Can't kill it, can't start a new one (port conflict). Fail closed:
      // continuing would defer the failure until the first inference request.
      const expectedModels = presetsModels(preset);
      const message = `A llama-server is already running on port ${LLAMACPP_PORT} but Aperio cannot manage it (no stored PID, likely from another user or session). Expected model(s): ${expectedModels.join(", ")}. Stop the existing server manually and restart Aperio.`;
      logger.error(`🦙 ${message}`);
      writeState(null, preset); // record the hash (pid: null = known-unmanaged) so we don't re-log every call
      return false;
    }
  }

  // LLAMA_CACHE controls where -hf downloads land. Default it to the standard
  // HF hub cache (never a project-local dir) so llama-server reuses models the
  // user already has — shared with llama-cli and every other HF tool — instead
  // of hoarding a duplicate copy inside the repo. Set it here (rather than in
  // every launcher/script) so the wizard's presence check and the long-lived
  // server always agree on the same location.
  process.env.LLAMA_CACHE ??= resolve(resolveModelCacheDir());
  mkdirSync(process.env.LLAMA_CACHE, { recursive: true });

  // Route the server's stdout/stderr to a log file rather than the old
  // `stdio: "ignore"`. llama-server prints the true reason for a failed turn
  // there (weight-load OOM, Metal "Compute error.", ctx-size alloc failures) —
  // silencing it meant every runtime failure surfaced only as a blank "no
  // response" in the app, with nothing to diagnose from.
  //
  // UNLINK before creating, rather than opening the same path with "w": the old
  // llama-server's router+worker children can outlive our SIGTERM by a moment
  // and keep writing through the stdout fd they inherited. If we merely truncate
  // the existing file (O_TRUNC), one of those late writes lands at the child's
  // stale offset and the filesystem zero-fills everything before it — a
  // multi-KB NUL hole that makes the log (and every session log the tee copies
  // it into) unreadable. Unlinking detaches those stale fds onto the old,
  // now-anonymous inode (harmless, reclaimed when they exit) so our fresh file
  // is a brand-new inode nothing else is holding. The tee's shrink-detection
  // resets its read offset when the recreated file starts at size 0.
  let logFd = null;
  let stdio = "ignore";
  try {
    try { if (existsSync(SERVER_LOG_PATH)) unlinkSync(SERVER_LOG_PATH); } catch { /* first boot / already gone */ }
    logFd = openSync(SERVER_LOG_PATH, "w");
    stdio = ["ignore", logFd, logFd];
  } catch (e) { logger.warn(`🦙 Could not open llama-server log at ${SERVER_LOG_PATH} (${e.message}) — server output will be discarded`); }
  // Cached-everything ⇒ start offline: no per-load HF revalidation, so an
  // upstream re-upload can never ambush the first message with a multi-GB
  // re-download. Any model missing from cache ⇒ stay online so it can be
  // fetched on first load (and progress surfaced via modelProgress).
  const offline = shouldStartOffline(preset, process.env.LLAMA_CACHE);
  if (offline) logger.info("🦙 All preset models cached — starting llama-server offline (no update checks; set LLAMACPP_CHECK_UPDATES=on to pull upstream re-uploads)");
  logger.info(`🦙 Starting llama-server in background… (preset=${PRESET_PATH}, log=${logFd !== null ? SERVER_LOG_PATH : "discarded"}, LLAMACPP_SERVE_CTX=${process.env.LLAMACPP_SERVE_CTX}, LLAMACPP_CTX=${process.env.LLAMACPP_CTX})`);
  // A PID still recorded in state.json here (the reconcile block above clears it
  // whenever it kills, so this only survives the "server was down" path) belongs
  // to a previous engine that never got reaped — e.g. a router that lost its
  // listener but not its resident worker group. writeState is about to overwrite
  // that PID below, which would orphan those workers permanently. Group-kill it
  // first so the record we replace is never a live, forgotten process.
  const priorStatePid = readState()?.pid;
  llamaCppProc = _spawn("llama-server", [
    "--models-preset", PRESET_PATH,
    "--jinja",
    "--host", "127.0.0.1",
    "--port", LLAMACPP_PORT,
    ...(offline ? ["--offline"] : []),
  ], {
    detached: true,
    stdio,
  });
  // The child dup'd the log fd; close our copy so we don't leak one per restart.
  if (logFd !== null) { try { closeSync(logFd); } catch { /* best-effort */ } }
  llamaCppProc.on("error", () => {}); // suppress ENOENT / other spawn errors; poll will time out naturally
  llamaCppProc.unref(); // don't keep Node alive for it

  // Poll until ready or timeout
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    if (await isLlamaCppUp()) {
      logger.info("✅ llama-server ready");
      if (priorStatePid && priorStatePid !== llamaCppProc.pid) {
        if (_isOwnedPid(priorStatePid)) {
          const reaped = await _kill(priorStatePid);
          if (reaped) logger.warn(`🦙 Reaped a stale llama-server process group (PID ${priorStatePid}) that state.json still referenced, before recording the new engine.`);
        } else {
          logger.warn(`🦙 Did not reap stale PID ${priorStatePid}: state.json no longer identifies it as llama-server.`);
        }
      }
      writeState(llamaCppProc.pid, preset);
      return;
    }
  }
  throw new Error("llama-server did not start within 30 s — is it installed?");
}
