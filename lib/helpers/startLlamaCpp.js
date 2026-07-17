// lib/helpers/startLlamaCpp.js
//
// llama.cpp equivalent of startOllama.js. llama-server's router mode
// (--models-preset) replaces Ollama's one-model-per-process model: both the
// main chat model and the VLM bridge model are entries in a single preset,
// loaded/swapped by the router as requests name them.
import { spawn, execFileSync } from "child_process";
import os from "os";
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, readdirSync, readSync, appendFileSync } from "fs";
import { resolve, join, basename } from "path";
import { createHash } from "crypto";
import logger from "./logger.js";
import { recommendContextLength, MODEL_FACTS, factsForHf, resolvePerfProfile, resolveKvCachePolicy, defaultLocalModel, resolveModelFacts, residentFootprintGB, RAM_FIT_DEFAULTS } from "../providers/index.js";
import { resolveModelCacheDir } from "./modelCache.js";
import { LLAMACPP_MAIN_ALIAS, LLAMACPP_VLM_ALIAS } from "./llamacppAliases.js";
import { inspectCachedModel } from "./ggufModelFacts.js";
import { isVisionModel } from "./imageBridge.js";

const LLAMACPP_PORT     = process.env.LLAMACPP_PORT || "8080";
const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL ?? `http://127.0.0.1:${LLAMACPP_PORT}`;
const MAX_WAIT_MS       = 30_000; // GGUF weight-loading can outrun Ollama's 15 s
const KILL_TIMEOUT_MS   = 5_000;
const STATE_FILE        = "./var/llamacpp/state.json";
const POLL_MS           = 500;
const PRESET_DIR        = "./var/llamacpp";
const PRESET_PATH       = `${PRESET_DIR}/models.ini`;
const SERVER_LOG_PATH   = `${PRESET_DIR}/server.log`;

// Curated defaults sourced from the shared MODEL_FACTS table (Phase 3) — the
// same table the setup wizard's disk-space check and getRecommendedModel()
// read, so there's exactly one place that maps a curated model to its hf id.
const DEFAULT_VLM_MODEL  = MODEL_FACTS["qwen2.5vl:7b"].hf;
// GENERIC_MODEL_FACTS (conservative facts for a model not in MODEL_FACTS) now
// lives in lib/providers/index.js, shared with machineCapacityPct so the sizer
// and the navbar capacity readout never disagree about an unknown model.

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

// Per-profile ctx-sizing overrides layered onto recommendContextLength's own
// defaults (ceiling 131072, fitFraction 0.82) — "balanced" and "quality" pass
// no overrides (their sizing behavior is the pre-Phase-4 default; quality's
// payoff is a bigger *model* pick — see defaultMainModelHf below — not a
// bigger window).
const PROFILE_CTX_OPTS = {
  balanced:        {},
  quality:         {},
  "fast-low-vram": { ceiling: 16384 },
  "long-context":  { ceiling: 262144, fitFraction: 0.90 },
};

function serveCtxFor(modelKey, env, hardware, profile, extraOpts = {}) {
  // LLAMACPP_SERVE_CTX is the MAIN model's window (and ensureLlamaCpp self-sets
  // it before building the preset), so an explicit per-call ceiling must still
  // clamp it. Without the clamp the VLM bridge inherited the main model's full
  // window (131072 observed in a live preset) — defeating VLM_BRIDGE_CTX_CEILING,
  // re-opening the Metal OOM it exists to prevent, and inflating the RAM-fit
  // check into swap mode (models-max = 1), where every describe_image call
  // evicts the main model and forces a full conversation re-prefill.
  if (env.LLAMACPP_SERVE_CTX) {
    const n = parseInt(env.LLAMACPP_SERVE_CTX, 10);
    return extraOpts.ceiling ? Math.min(n, extraOpts.ceiling) : n;
  }
  const facts = hardware.modelCacheDir
    ? resolveModelFacts(modelKey, { ...env, LLAMA_CACHE: hardware.modelCacheDir })
    : resolveModelFacts(modelKey, env);
  const cacheScale = resolveKvCachePolicy(profile).sizingScale;
  return recommendContextLength({
    modelMaxContext: facts.maxContext,
    weightsGB: facts.sizeGB,
    fixedKvGB: (facts.kvFixedGB ?? 0) * cacheScale,
    bytesPerToken: facts.kvBytesPerToken * cacheScale,
    totalRamGB: hardware.totalRamGB,
  }, { ...(facts.source === "gguf" ? { reserveGB: 4, reserveFraction: 0.15 } : {}), ...(PROFILE_CTX_OPTS[profile] ?? {}), ...extraOpts });
}

function modelFactsFor(modelKey, hardware) {
  return hardware.modelCacheDir
    ? resolveModelFacts(modelKey, { LLAMA_CACHE: hardware.modelCacheDir })
    : resolveModelFacts(modelKey);
}

// The fit check is intentionally based on the contexts the preset will serve,
// not on each model's maximum trained context. This answers the operational
// question: can the two entries coexist at the windows we are actually going
// to allocate?
export function mainPlusVlmFit(mainModel, vlmModel, env = process.env, hardware = {}, profile = resolvePerfProfile(env)) {
  const totalRamGB = hardware.totalRamGB ?? os.totalmem() / 1024 ** 3;
  if (!(totalRamGB > 0)) return false;
  const cacheScale = resolveKvCachePolicy(profile).sizingScale;
  const mainFacts = modelFactsFor(mainModel, hardware);
  const vlmFacts = modelFactsFor(vlmModel, hardware);
  const mainCtx = serveCtxFor(mainModel, env, hardware, profile);
  const vlmCtx = serveCtxFor(vlmModel, env, hardware, profile, { ceiling: VLM_BRIDGE_CTX_CEILING });
  const mainFootprint = residentFootprintGB({
    ...mainFacts,
    kvBytesPerToken: mainFacts.kvBytesPerToken * cacheScale,
    kvFixedGB: (mainFacts.kvFixedGB ?? 0) * cacheScale,
  }, mainCtx, {
    overheadGB: RAM_FIT_DEFAULTS.overheadGB,
  });
  const vlmFootprint = residentFootprintGB({
    ...vlmFacts,
    kvBytesPerToken: vlmFacts.kvBytesPerToken * cacheScale,
    kvFixedGB: (vlmFacts.kvFixedGB ?? 0) * cacheScale,
  }, vlmCtx, { overheadGB: RAM_FIT_DEFAULTS.overheadGB });
  const breathing = Math.max(RAM_FIT_DEFAULTS.reserveGB, totalRamGB * RAM_FIT_DEFAULTS.reserveFraction);
  return mainFootprint + vlmFootprint <= totalRamGB - breathing;
}

export function vlmPresetMode(mainModel, vlmModel, env = process.env, hardware = {}, profile = resolvePerfProfile(env)) {
  if (isVisionModel(mainModel)) return "omitted (main has native vision)";
  if (!mainPlusVlmFit(mainModel, vlmModel, env, hardware, profile)) return "swap mode (main+VLM exceed RAM)";
  return "co-resident";
}

// describe_image's VLM call is a single stateless request — one image + a
// short prompt, no conversation history carried between calls (mcp/tools/
// image.js sends exactly one message per call). Left to serveCtxFor's normal
// RAM-fit math, the VLM alias climbs toward its GGUF's own trained window
// (often 131k-262k) as if it had the whole machine to itself — on a 32GB
// Apple Silicon box running a large main model alongside it, this measured
// out to the VLM alone wanting ~24GB (18GB of that just KV cache at 131072
// ctx), and llama-server's Metal backend hard-OOM'd mid-decode ("Compute
// error.") the moment a describe_image call actually ran.
// 24576 tokens covers a realistic ceiling of ~10-20 document/page images in
// one exchange (~1024 vision tokens/image at the 896x896 preprocessing size
// in mcp/tools/image.js, plus per-image prompt/response headroom) while
// cutting the VLM's own footprint roughly in half again vs. even 32768.
// This is a ceiling, not a flat value — still routed through the same
// RAM-fit math as the main model, so a genuinely tight machine still shrinks
// below it; it just stops climbing past what the bridge role ever needs.
const VLM_BRIDGE_CTX_CEILING = 24576;

// Default main model when LLAMACPP_MODEL isn't set. "balanced" and
// "long-context" keep the fixed curated small model unchanged — neither
// profile is about *which* model runs (RAM-tiered selection normally happens
// once, at wizard time, via getRecommendedModel(), which then writes
// LLAMACPP_MODEL into .env). "fast-low-vram" and "quality" are explicitly
// about model choice (MoE-preferred / bigger-where-RAM-allows, respectively),
// so for those two this fallback re-picks via the same profile-aware ladder
// the wizard uses, in case the preset is built without ever going through it.
function defaultMainModelHf(env, hardware, profile) {
  return defaultLocalModel(profile, hardware, env);
}

// Keep config-source discovery separate from preset rendering so additional
// opt-in llama.cpp consumers can be added here without coupling the builder to
// their call sites.
export function collectExtraLlamaCppModels(env = process.env) {
  const raw = env.WIKI_REFRESH_PROVIDER;
  if (typeof raw !== "string") return [];
  const [provider, ...modelParts] = raw.trim().split(":");
  const model = modelParts.join(":").trim();
  return provider?.toLowerCase() === "llamacpp" && model ? [model] : [];
}

// Pure preset builder — unit-tests without a live server (same doctrine as
// recommendContextLength). `hardware.totalRamGB` overrides the real machine
// RAM read for tests; omit it to size against the actual host. Profile is
// read from `env.APERIO_LOCAL_PERF_PROFILE` via resolvePerfProfile.
export function buildModelsPreset(env = process.env, hardware = {}) {
  const profile   = resolvePerfProfile(env);
  const cachePolicy = resolveKvCachePolicy(profile);
  const mainModel = env.LLAMACPP_MODEL || defaultMainModelHf(env, hardware, profile);
  const vlmModel  = env.LLAMACPP_VLM_MODEL || DEFAULT_VLM_MODEL;
  const extraModels = collectExtraLlamaCppModels(env);
  const omitVlm = isVisionModel(mainModel);
  const swapVlm = !omitVlm && !mainPlusVlmFit(mainModel, vlmModel, env, hardware, profile);

  // Aperio issues one inference request at a time per managed model. llama.cpp
  // otherwise defaults to four slots, multiplying the configured context's
  // working set; on 32 GB Apple Silicon that turned a fitting hybrid Qwen KV
  // cache into a Metal OOM. Qwen3.6 MTP's own launch guidance also requires 1.
  const lines = ["[*]", "jinja = true", "parallel = 1"];
  if (profile === "fast-low-vram" || swapVlm) {
    // The video's 3→17 tok/s trick, other half: capping resident models to 1
    // frees RAM/VRAM that would otherwise sit idle in a second loaded model,
    // handing it instead to a bigger MoE model or context window. Extra batch
    // models intentionally do not raise this cap: swap cost is preferable to
    // defeating the low-VRAM profile. flash-attn is a global compute-backend
    // flag, not a per-model one.
    lines.push("models-max = 1");
  }
  if (cachePolicy.forceFlashAttention) {
    lines.push("flash-attn = true");
  }
  lines.push("");

  const emit = (alias, name, extra = {}) => {
    lines.push(`[${alias}]`);
    lines.push(`hf-repo = ${name}`);
    lines.push(`ctx-size = ${serveCtxFor(name, env, hardware, profile, extra.ctxOpts)}`);
    if (extra.mmproj) lines.push(`mmproj = ${extra.mmproj}`);
    if (cachePolicy.cacheTypeK !== "f16" || cachePolicy.cacheTypeV !== "f16") {
      // Quantized KV cache roughly halves per-token memory. llama.cpp requires
      // Flash Attention when the V cache is quantized, including on Gemma 4.
      lines.push(`cache-type-k = ${cachePolicy.cacheTypeK}`);
      lines.push(`cache-type-v = ${cachePolicy.cacheTypeV}`);
      if (profile === "fast-low-vram" && factsForHf(name)?.architecture === "moe") {
        // 999 is a deliberate "more than any real model has" sentinel:
        // llama.cpp clamps --n-cpu-moe to the model's actual MoE layer count,
        // so this offloads every expert to CPU without needing to introspect
        // the GGUF's layer count here.
        lines.push("n-cpu-moe = 999");
      }
    }
    lines.push("");
  };
  const emittedModels = new Set();
  const emitOnce = (alias, name, extra) => {
    if (emittedModels.has(name)) return;
    emittedModels.add(name);
    emit(alias, name, extra);
  };
  emitOnce(LLAMACPP_MAIN_ALIAS, mainModel);
  // Undocumented escape hatch (matches APERIO_CTX_FIT_FRACTION-style advanced
  // knobs elsewhere): llama-server auto-downloads the companion mmproj for
  // known vision GGUFs (confirmed in the Phase 0 spike), so this is optional.
  // env override wins; otherwise fall back to a curated model's own mmproj
  // fact (MODEL_FACTS[...].mmproj), if one is declared.
  if (!omitVlm) {
    emitOnce(LLAMACPP_VLM_ALIAS, vlmModel, {
      mmproj: env.LLAMACPP_VLM_MMPROJ || factsForHf(vlmModel)?.mmproj,
      // See VLM_BRIDGE_CTX_CEILING above — the bridge role never needs (and on
      // this machine, cannot safely have) the full RAM-fit window the main
      // model gets. A model pointed at by LLAMACPP_MODEL instead of
      // LLAMACPP_VLM_MODEL (i.e. used AS the main chat model) is unaffected —
      // it goes through the plain `emit(LLAMACPP_MAIN_ALIAS, ...)` call above.
      ctxOpts: { ceiling: VLM_BRIDGE_CTX_CEILING },
    });
  }
  for (const model of extraModels) emitOnce(model, model);

  return lines.join("\n") + "\n";
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

// ── Session-scoped server log tee ──────────────────────────────────────────
// Each chat session gets its own live copy of the shared server.log so a
// single session can be debugged in isolation — while it runs, not after:
//
//   createSession    → beginSessionLog(id) creates var/llamacpp/{id}.log
//                      immediately and enrolls it in the tee
//   (every second)   → pumpServerLogTee() appends the bytes server.log grew
//                      by to every active session's log
//   finaliseSession  → endSessionLog(id) drains and unenrolls; an empty log
//                      (session never touched llama-server) is removed
//   deleteSessionLog → delete var/llamacpp/{id}.log (explicit session delete)
//   pruneServerLogs  → daily sweep; these files are debugging aids with no
//                      lasting value, kept LLAMACPP_LOG_RETENTION_DAYS (1 by
//                      default), independent of the session's own retention
//
// Written live (not copied at finalisation) deliberately: a crash of the app
// or of llama-server itself is exactly what these logs exist to diagnose, and
// a write-at-end scheme loses the log in every crash. Concurrent sessions
// each receive the full server output for their lifetime — llama-server is
// one shared process, so its log can't be attributed to a single session.

const TEE_INTERVAL_MS = 1000;
const activeSessionLogs = new Set(); // session ids currently enrolled
let teePos = 0;                      // how far into server.log we've copied
let teeTimer = null;

function sessionLogPath(id) {
  return join(PRESET_DIR, `${id}.log`);
}

// Drop NUL bytes from a log chunk. llama-server output is plain text, so any
// 0x00 is corruption — most often the zero-fill left when a file is truncated
// (openSync "w") out from under a stale child fd that then writes at its old
// offset. Stripping here guarantees a human-readable session log no matter how
// the shared server.log got holed; the unlink-before-recreate at spawn stops
// the hole forming in the first place, this is the belt to that suspenders.
function stripNuls(buf) {
  if (!buf.includes(0)) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) { const b = buf[i]; if (b !== 0) out[n++] = b; }
  return out.subarray(0, n);
}

/**
 * Copy whatever server.log grew by since the last pump to every active
 * session log. Runs on a 1s timer between beginSessionLog/endSessionLog;
 * exported for tests. A shrunken server.log means a server restart truncated
 * it (spawn opens it with "w") — restart from 0 so active sessions capture
 * the new server's boot output too.
 */
export function pumpServerLogTee() {
  let size = 0;
  try { size = statSync(SERVER_LOG_PATH).size; } catch { size = 0; }
  if (size < teePos) teePos = 0;
  if (size === teePos) return;
  if (activeSessionLogs.size === 0) { teePos = size; return; }
  let chunk;
  try {
    const fd = openSync(SERVER_LOG_PATH, "r");
    try {
      const buf = Buffer.allocUnsafe(size - teePos);
      // readSync can return fewer bytes than requested; slice to what was
      // actually read so allocUnsafe's uninitialized tail never leaks into a log.
      const bytesRead = readSync(fd, buf, 0, buf.length, teePos);
      chunk = buf.subarray(0, bytesRead);
      teePos += bytesRead;
    } finally { closeSync(fd); }
  } catch { return; /* retry from the same position next pump */ }
  chunk = stripNuls(chunk);
  if (chunk.length === 0) return;
  for (const id of activeSessionLogs) {
    try { appendFileSync(sessionLogPath(id), chunk); } catch { /* best-effort */ }
  }
}

/**
 * Start a session's server log: create var/llamacpp/{id}.log (empty, so it is
 * visible and tail-able from the moment the session starts) and enroll it in
 * the tee. Called at session creation.
 */
export function beginSessionLog(id) {
  if (!id) return;
  // Tests must not write to the real filesystem. Allow the test runner to
  // suppress the per-session llama debug log with an env guard so mock-heavy
  // test files (wsHandler, etc.) never touch var/llamacpp/ on disk.
  if (process.env.APERIO_NO_LLAMA_LOG) return;
  try {
    mkdirSync(PRESET_DIR, { recursive: true });
    // Catch the tee up BEFORE enrolling, so output that predates this session
    // never leaks into its log.
    pumpServerLogTee();
    writeFileSync(sessionLogPath(id), "");
    activeSessionLogs.add(id);
    if (!teeTimer) {
      teeTimer = setInterval(pumpServerLogTee, TEE_INTERVAL_MS);
      teeTimer.unref?.();
    }
  } catch { /* best-effort */ }
}

/**
 * Finish a session's server log: drain any pending output, unenroll it, and
 * remove the file if the session never produced server output (e.g. it ran on
 * a cloud provider). Called at session finalisation — including for trivial
 * sessions that get discarded, whose debug log is deliberately KEPT for the
 * pruner's retention window.
 *
 * Returns true if a NON-EMPTY log was kept — the caller uses that to pair
 * session-keeping with "did this session actually exercise llama-server", so a
 * session that produced a debug log is never deleted out from under its log.
 */
export function endSessionLog(id) {
  if (!id) return false;
  try {
    pumpServerLogTee();
    activeSessionLogs.delete(id);
    if (activeSessionLogs.size === 0 && teeTimer) {
      clearInterval(teeTimer);
      teeTimer = null;
    }
    const p = sessionLogPath(id);
    if (statSync(p).size === 0) { unlinkSync(p); return false; }
    return true;
  } catch { return false; /* log already gone — nothing to clean */ }
}

/**
 * Append an Aperio-side llama.cpp diagnostic to the active session log.
 * llama-server errors normally arrive through server.log, but streamed API
 * errors (for example a mid-stream `Compute error.`) are observed by the
 * provider in this process instead of the child process. Keep those lines in
 * the same session file so it remains the useful diagnostic entry point.
 */
export function appendSessionLog(id, message) {
  if (!id || !activeSessionLogs.has(id) || !message) return;
  try {
    appendFileSync(sessionLogPath(id), `${new Date().toISOString()} [aperio] ${message}\n`);
  } catch { /* best-effort */ }
}

// Session log files are named {uuid}.log — never matches server.log,
// models.ini, or state.json, which live in the same directory.
const SESSION_LOG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/i;

/**
 * Delete session log files older than `retentionDays` (by mtime). Runs from
 * the daily llamacpp-log-prune worker; also catches logs orphaned by sessions
 * that were never finalised. Returns the number of files removed.
 */
export function pruneServerLogs(retentionDays = 1) {
  const days = Math.max(1, Number(retentionDays) || 1);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const f of readdirSync(PRESET_DIR)) {
      if (!SESSION_LOG_RE.test(f)) continue;
      const p = join(PRESET_DIR, f);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
      } catch { /* raced with deletion — skip */ }
    }
  } catch { /* dir doesn't exist yet */ }
  return removed;
}

/**
 * Delete var/llamacpp/{id}.log. Called by deleteSessionLog during session
 * deletion and retention pruning. No-op when id is missing or file absent.
 */
export function deleteServerLog(id) {
  if (!id) return;
  try {
    const p = join(PRESET_DIR, `${id}.log`);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* best-effort */ }
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

// A worker may expose either its stable section alias or its underlying
// hf-repo in `ps` (and frequently has both flags). Both identify a model owned
// by this preset and are therefore safe to stop during an Aperio restart.
export function presetModelIds(preset) {
  const ids = new Set(presetsModels(preset));
  for (const match of preset.matchAll(/^hf-repo\s*=\s*(\S+)/gm)) ids.add(match[1]);
  return ids;
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
