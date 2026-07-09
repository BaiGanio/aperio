// lib/helpers/startLlamaCpp.js
//
// llama.cpp equivalent of startOllama.js. llama-server's router mode
// (--models-preset) replaces Ollama's one-model-per-process model: both the
// main chat model and the VLM bridge model are entries in a single preset,
// loaded/swapped by the router as requests name them.
import { spawn } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import logger from "./logger.js";
import { recommendContextLength } from "../providers/index.js";

const LLAMACPP_PORT     = process.env.LLAMACPP_PORT || "8080";
const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL ?? `http://127.0.0.1:${LLAMACPP_PORT}`;
const MAX_WAIT_MS       = 30_000; // GGUF weight-loading can outrun Ollama's 15 s
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
export async function ensureLlamaCpp(_spawn = spawn) {
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
    logger.info("🦙 llama-server already running");
    return;
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
      return;
    }
  }
  throw new Error("llama-server did not start within 30 s — is it installed?");
}
