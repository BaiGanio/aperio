// lib/helpers/startLlamaCpp.js
//
// llama.cpp equivalent of startOllama.js. llama-server's router mode
// (--models-preset) replaces Ollama's one-model-per-process model: both the
// main chat model and the VLM bridge model are entries in a single preset,
// loaded/swapped by the router as requests name them.
import { spawn, execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, readdirSync, readSync, appendFileSync } from "fs";
import { resolve, join, basename } from "path";
import { createHash } from "crypto";
import logger from "./logger.js";
import { recommendContextLength, MODEL_FACTS, GENERIC_MODEL_FACTS, factsForHf, resolvePerfProfile, getRecommendedModel } from "../providers/index.js";
import { resolveModelCacheDir } from "./modelCache.js";
import { LLAMACPP_MAIN_ALIAS, LLAMACPP_VLM_ALIAS } from "./llamacppAliases.js";
import { inspectCachedModel } from "./ggufModelFacts.js";

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
const DEFAULT_MAIN_MODEL = MODEL_FACTS["qwen2.5:3b"].hf;
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
  if (env.LLAMACPP_SERVE_CTX) return parseInt(env.LLAMACPP_SERVE_CTX, 10);
  const inspected = hardware.modelCacheDir ? inspectCachedModel(modelKey, hardware.modelCacheDir) : null;
  const facts = inspected ?? factsForHf(modelKey) ?? GENERIC_MODEL_FACTS;
  const cacheScale = profile === "fast-low-vram" ? 0.5 : 1;
  return recommendContextLength({
    modelMaxContext: facts.maxContext,
    weightsGB: facts.sizeGB,
    fixedKvGB: facts.kvFixedGB ?? 0,
    bytesPerToken: facts.kvBytesPerToken * cacheScale,
    totalRamGB: hardware.totalRamGB,
  }, { ...(inspected ? { reserveGB: 4, reserveFraction: 0.15 } : {}), ...(PROFILE_CTX_OPTS[profile] ?? {}), ...extraOpts });
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
function defaultMainModelHf(hardware, profile) {
  if (profile !== "fast-low-vram" && profile !== "quality") return DEFAULT_MAIN_MODEL;
  const key = getRecommendedModel(profile, hardware);
  return MODEL_FACTS[key]?.hf ?? DEFAULT_MAIN_MODEL;
}

// Pure preset builder — unit-tests without a live server (same doctrine as
// recommendContextLength). `hardware.totalRamGB` overrides the real machine
// RAM read for tests; omit it to size against the actual host. Profile is
// read from `env.APERIO_LOCAL_PERF_PROFILE` via resolvePerfProfile.
export function buildModelsPreset(env = process.env, hardware = {}) {
  const profile   = resolvePerfProfile(env);
  const mainModel = env.LLAMACPP_MODEL || defaultMainModelHf(hardware, profile);
  const vlmModel  = env.LLAMACPP_VLM_MODEL || DEFAULT_VLM_MODEL;

  // Aperio issues one inference request at a time per managed model. llama.cpp
  // otherwise defaults to four slots, multiplying the configured context's
  // working set; on 32 GB Apple Silicon that turned a fitting hybrid Qwen KV
  // cache into a Metal OOM. Qwen3.6 MTP's own launch guidance also requires 1.
  const lines = ["[*]", "jinja = true", "parallel = 1"];
  if (profile === "fast-low-vram") {
    // The video's 3→17 tok/s trick, other half: capping resident models to 1
    // frees RAM/VRAM that would otherwise sit idle in a second loaded model,
    // handing it instead to a bigger MoE model or context window. flash-attn
    // is a global compute-backend flag, not a per-model one.
    lines.push("models-max = 1");
    lines.push("flash-attn = true");
  }
  lines.push("");

  const emit = (alias, name, extra = {}) => {
    lines.push(`[${alias}]`);
    lines.push(`hf-repo = ${name}`);
    lines.push(`ctx-size = ${serveCtxFor(name, env, hardware, profile, extra.ctxOpts)}`);
    if (extra.mmproj) lines.push(`mmproj = ${extra.mmproj}`);
    if (profile === "fast-low-vram") {
      // Quantized KV cache roughly halves per-token memory — the video's
      // trick's first half, paired with n-cpu-moe below on MoE models.
      lines.push("cache-type-k = q8_0");
      lines.push("cache-type-v = q8_0");
      if (factsForHf(name)?.architecture === "moe") {
        // 999 is a deliberate "more than any real model has" sentinel:
        // llama.cpp clamps --n-cpu-moe to the model's actual MoE layer count,
        // so this offloads every expert to CPU without needing to introspect
        // the GGUF's layer count here.
        lines.push("n-cpu-moe = 999");
      }
    }
    lines.push("");
  };
  emit(LLAMACPP_MAIN_ALIAS, mainModel);
  // Undocumented escape hatch (matches APERIO_CTX_FIT_FRACTION-style advanced
  // knobs elsewhere): llama-server auto-downloads the companion mmproj for
  // known vision GGUFs (confirmed in the Phase 0 spike), so this is optional.
  // env override wins; otherwise fall back to a curated model's own mmproj
  // fact (MODEL_FACTS[...].mmproj), if one is declared.
  emit(LLAMACPP_VLM_ALIAS, vlmModel, {
    mmproj: env.LLAMACPP_VLM_MMPROJ || factsForHf(vlmModel)?.mmproj,
    // See VLM_BRIDGE_CTX_CEILING above — the bridge role never needs (and on
    // this machine, cannot safely have) the full RAM-fit window the main
    // model gets. A model pointed at by LLAMACPP_MODEL instead of
    // LLAMACPP_VLM_MODEL (i.e. used AS the main chat model) is unaffected —
    // it goes through the plain `emit(LLAMACPP_MAIN_ALIAS, ...)` call above.
    ctxOpts: { ceiling: VLM_BRIDGE_CTX_CEILING },
  });

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
// available. Returns false only when the target is already gone.
function signalGroup(pid, sig) {
  try { process.kill(-pid, sig); return true; }
  catch (e) {
    if (e.code === "ESRCH") return false; // whole group already gone
    // EPERM / EINVAL / not-a-group-leader → best-effort single-PID signal.
    try { process.kill(pid, sig); return true; }
    catch (e2) { return e2.code !== "ESRCH"; }
  }
}

// Kill the process group led by `pid` (router + its model workers), with a
// brief grace period. Returns true if the leader is confirmed gone.
export async function killByPid(pid) {
  if (!pid || pid <= 0) return false;
  if (!signalGroup(pid, "SIGTERM")) return false; // already gone
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

// The models actually RESIDENT right now: the router forks one
// `llama-server --host … --hf-repo <id>` (or `--alias <id>`) worker child per
// loaded model, so the worker children of `routerPid` are ground truth for
// "what's in RAM" (unlike /v1/models, which also lists merely-cached models the
// router auto-discovered but never loaded). Returns [] when nothing is resident
// and null when we can't introspect (non-POSIX, or `ps` unavailable) — the
// caller treats null as "unknown".
function loadedWorkerModels(routerPid) {
  if (process.platform === "win32") return null; // detached-group model differs; caller decides
  try {
    const out = execSync("ps -Ao pid=,ppid=,args=", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const models = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      if (Number(m[2]) !== routerPid) continue;         // not a child of our router
      const args = m[3];
      if (!/llama-server/.test(args) || !/--host\b/.test(args)) continue; // not a model worker
      const id = args.match(/--hf-repo\s+(\S+)/) || args.match(/--alias\s+(\S+)/) || args.match(/-hf\s+(\S+)/);
      if (id) models.push(id[1]);
    }
    return models;
  } catch { return null; }
}

// Stop the llama-server WE spawned this session — but only when it's safe:
//   1. We own it. getLlamaCppPid() is null when we attached to a server we
//      didn't start (another session/user, or a warm server left by a prior
//      boot), in which case we leave it alone.
//   2. Every resident model belongs to THIS session's preset. The router is
//      shared and can't be torn down per-model, so if any worker is serving a
//      model the current preset didn't declare (e.g. a round-table / wiki
//      provider loaded an extra one), we leave the whole server running rather
//      than yank a model another client may still be using.
// When worker introspection is unavailable (null), we still stop it — the
// process group is entirely ours, so the group-kill can't touch anything else.
// Returns true if it stopped the server, false if it left it running.
export async function stopLlamaCpp(_kill = killByPid) {
  const pid = getLlamaCppPid();
  if (!pid) return false; // we didn't start it → not ours to stop

  const loaded = loadedWorkerModels(pid);
  if (loaded && loaded.length) {
    const ours = presetModelIds(buildModelsPreset(process.env, {}));
    const foreign = loaded.filter(m => !ours.has(m));
    if (foreign.length) {
      logger.warn(`🦙 Leaving llama-server running on exit — non-preset model(s) still loaded: ${foreign.join(", ")}. Stop it manually if you're done: kill -TERM -${pid}`);
      return false;
    }
  }

  logger.info("🦙 Stopping the llama-server we started…");
  await _kill(pid);
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
export async function ensureLlamaCpp(_spawn = spawn, _kill = killByPid) {
  // Mirror startOllama's dual-env-publish: LLAMACPP_SERVE_CTX is the server's
  // real KV-cache window for the MAIN model (what actually gets baked into the
  // preset's ctx-size); LLAMACPP_CTX is the app's trim/cap math assumption —
  // ~92% of the served window, reserving at least 512 tokens for generation so
  // a full-window prompt still leaves the model room to answer. Compute this
  // BEFORE the "already running" early-return: when Aperio spawned llama-server
  // on a prior boot and is now restarting against it, we don't respawn but
  // still must set LLAMACPP_CTX for the trim math.
  const profile   = resolvePerfProfile(process.env);
  const mainModel = process.env.LLAMACPP_MODEL || defaultMainModelHf({}, profile);
  const runtimeHardware = { modelCacheDir: resolveModelCacheDir() };
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
      writeState(llamaCppProc.pid, preset);
      return;
    }
  }
  throw new Error("llama-server did not start within 30 s — is it installed?");
}
