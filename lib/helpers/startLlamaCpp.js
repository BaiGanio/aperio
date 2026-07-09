// lib/helpers/startLlamaCpp.js
//
// llama.cpp equivalent of startOllama.js. llama-server's router mode
// (--models-preset) replaces Ollama's one-model-per-process model: both the
// main chat model and the VLM bridge model are entries in a single preset,
// loaded/swapped by the router as requests name them.
import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import logger from "./logger.js";
import { recommendContextLength } from "../providers/index.js";

const LLAMACPP_PORT     = process.env.LLAMACPP_PORT || "8080";
const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL ?? `http://127.0.0.1:${LLAMACPP_PORT}`;
const MAX_WAIT_MS       = 30_000; // GGUF weight-loading can outrun Ollama's 15 s
const KILL_TIMEOUT_MS   = 5_000;
const STATE_FILE        = "./var/llamacpp/state.json";
const POLL_MS           = 500;
const PRESET_DIR        = "./var/llamacpp";
const PRESET_PATH       = `${PRESET_DIR}/models.ini`;

const DEFAULT_MAIN_MODEL = "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M";
const DEFAULT_VLM_MODEL  = "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF";

// Sizing facts for the two curated defaults above, in the same shape as
// providers/index.js's MODEL_FACTS (sizeGB/maxContext/kvBytesPerToken), so
// recommendContextLength sizes the KV cache the same way the Ollama path did.
// Phase 3 extends the shared MODEL_FACTS table with hf-repo mappings for the
// full model set and this local table goes away; until then, a model pointed
// at via LLAMACPP_MODEL/LLAMACPP_VLM_MODEL that isn't one of these two falls
// back to the same conservative generic facts recommendServeContextLength used.
const LLAMACPP_MODEL_FACTS = {
  [DEFAULT_MAIN_MODEL]: { sizeGB: 1.9, maxContext: 32768, kvBytesPerToken: 36864 },
  [DEFAULT_VLM_MODEL]:  { sizeGB: 6,   maxContext: 32768, kvBytesPerToken: 172032 },
};
const GENERIC_MODEL_FACTS = { sizeGB: 8, maxContext: 131072 };

async function isLlamaCppUp() {
  try {
    const r = await fetch(`${LLAMACPP_BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

// Best-effort loaded-model introspection for diagnostics (Phase 4/5) — we own
// the child PID for lifecycle/shutdown, so unlike Ollama's /api/ps this is
// never needed for "is it safe to stop", only for reporting.
export async function getLoadedModels() {
  try {
    const r = await fetch(`${LLAMACPP_BASE_URL}/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function serveCtxFor(modelKey, env, hardware) {
  if (env.LLAMACPP_SERVE_CTX) return parseInt(env.LLAMACPP_SERVE_CTX, 10);
  const facts = LLAMACPP_MODEL_FACTS[modelKey] ?? GENERIC_MODEL_FACTS;
  return recommendContextLength({
    modelMaxContext: facts.maxContext,
    weightsGB: facts.sizeGB,
    bytesPerToken: facts.kvBytesPerToken,
    totalRamGB: hardware.totalRamGB,
  });
}

// Pure preset builder — unit-tests without a live server (same doctrine as
// recommendContextLength). `hardware.totalRamGB` overrides the real machine
// RAM read for tests; omit it to size against the actual host.
export function buildModelsPreset(env = process.env, hardware = {}) {
  const mainModel = env.LLAMACPP_MODEL || DEFAULT_MAIN_MODEL;
  const vlmModel  = env.LLAMACPP_VLM_MODEL || DEFAULT_VLM_MODEL;

  const lines = ["[*]", "jinja = true", ""];
  const emit = (name, extra = {}) => {
    lines.push(`[${name}]`);
    lines.push(`hf-repo = ${name}`);
    lines.push(`ctx-size = ${serveCtxFor(name, env, hardware)}`);
    if (extra.mmproj) lines.push(`mmproj = ${extra.mmproj}`);
    lines.push("");
  };
  emit(mainModel);
  // Undocumented escape hatch (matches APERIO_CTX_FIT_FRACTION-style advanced
  // knobs elsewhere): llama-server auto-downloads the companion mmproj for
  // known vision GGUFs (confirmed in the Phase 0 spike), so this is optional.
  emit(vlmModel, { mmproj: env.LLAMACPP_VLM_MMPROJ });

  return lines.join("\n") + "\n";
}

let llamaCppProc = null;

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

// Attempt to kill a process by PID, with a brief grace period. Returns true if
// the process is confirmed gone.
async function killByPid(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, "SIGTERM"); } catch { return false; }
  // Wait up to KILL_TIMEOUT_MS for the process to exit
  const deadline = Date.now() + KILL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; } // ESRCH → gone
    await new Promise(r => setTimeout(r, 200));
  }
  // SIGKILL as last resort
  try { process.kill(pid, "SIGKILL"); } catch { return true; }
  await new Promise(r => setTimeout(r, 500));
  try { process.kill(pid, 0); return false; } catch { return true; }
}

// Fetch the running server's model list. Returns null on any failure.
async function fetchServerModels() {
  try {
    const r = await fetch(`${LLAMACPP_BASE_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const data = await r.json();
    return (data?.data ?? []).map(m => m.id);
  } catch { return null; }
}

// The models the current preset defines: section headers minus the global
// [*] entry, each appearing as "[model-id]\n".
function presetsModels(preset) {
  const re = /^\[([^\]]+)\]/gm;
  const models = [];
  let m;
  while ((m = re.exec(preset)) !== null) {
    if (m[1] !== "*") models.push(m[1]);
  }
  return models;
}

// ── Public ─────────────────────────────────────────────────────────────────
export async function ensureLlamaCpp(_spawn = spawn, _kill = killByPid) {
  // Mirror startOllama's dual-env-publish: LLAMACPP_SERVE_CTX is the server's
  // real KV-cache window for the MAIN model (what actually gets baked into the
  // preset's ctx-size); LLAMACPP_CTX is the app's trim/cap math assumption —
  // ~92% of the served window, reserving at least 512 tokens for generation so
  // a full-window prompt still leaves the model room to answer. Compute this
  // BEFORE the "already running" early-return: when Aperio spawned llama-server
  // on a prior boot and is now restarting against it, we don't respawn but
  // still must set LLAMACPP_CTX for the trim math.
  const mainModel = process.env.LLAMACPP_MODEL || DEFAULT_MAIN_MODEL;
  if (!process.env.LLAMACPP_SERVE_CTX) {
    process.env.LLAMACPP_SERVE_CTX = String(serveCtxFor(mainModel, process.env, {}));
  }
  if (!process.env.LLAMACPP_CTX) {
    const n = parseInt(process.env.LLAMACPP_SERVE_CTX, 10);
    process.env.LLAMACPP_CTX = String(Math.max(1, Math.min(Math.floor(n * 0.92), n - 512)));
  }

  const preset = buildModelsPreset(process.env, {});
  mkdirSync(PRESET_DIR, { recursive: true });
  writeFileSync(PRESET_PATH, preset);

  if (await isLlamaCppUp()) {
    const stored  = readState();
    const currentHash = hashPreset(preset);

    // Fast path: same preset AND our tracked PID is still running.
    if (stored && stored.hash === currentHash) {
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
    const killPid = stored?.pid ?? llamaCppProc?.pid;
    const serverUp = await isLlamaCppUp();
    if (killPid) {
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
        // Can't kill — different user likely. Log and return; the server will
        // return "model not found" for any missing model, which is a clear
        // error the user can act on.
        logger.error(`🦙 llama-server is running with a stale preset but could not be killed (PID ${killPid}). New model(s) from the current preset will not be available. To fix, stop the existing llama-server manually: kill ${killPid}`);
        return;
      }
    } else if (serverUp) {
      // Server is up but we don't own it (no stored PID, not our spawn).
      // Can't kill it, can't start a new one (port conflict). Surface it.
      const expectedModels = presetsModels(preset);
      logger.error(`🦙 A llama-server is already running on port ${LLAMACPP_PORT} but Aperio cannot manage it (no stored PID, likely from another user or session). Expected model(s): ${expectedModels.join(", ")}. To fix, stop the existing server manually and restart Aperio.`);
      writeState(null, preset); // record the hash (pid: null = known-unmanaged) so we don't re-log every call
      return;
    }
  }

  logger.info(`🦙 Starting llama-server in background… (preset=${PRESET_PATH}, LLAMACPP_SERVE_CTX=${process.env.LLAMACPP_SERVE_CTX}, LLAMACPP_CTX=${process.env.LLAMACPP_CTX})`);
  llamaCppProc = _spawn("llama-server", [
    "--models-preset", PRESET_PATH,
    "--jinja",
    "--host", "127.0.0.1",
    "--port", LLAMACPP_PORT,
  ], {
    detached: true,
    stdio: "ignore", // fully silent
  });
  llamaCppProc.on("error", () => {}); // suppress ENOENT / other spawn errors; poll will time out naturally
  llamaCppProc.unref(); // don't keep Node alive for it

  // Poll until ready or timeout
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    if (await isLlamaCppUp()) {
      logger.info("✅ llama-server ready");
      writeState(llamaCppProc.pid, preset);
      return;
    }
  }
  throw new Error("llama-server did not start within 30 s — is it installed?");
}