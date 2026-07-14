import os from "os";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "../helpers/logger.js";
import { CONFIG } from "../config.js";
import { configSourceLabel } from "../config-resolver.js";
import { LLAMACPP_MAIN_ALIAS } from "../helpers/llamacppAliases.js";
import { inspectCachedModel } from "../helpers/ggufModelFacts.js";
import { resolveModelCacheDir } from "../helpers/modelCache.js";

// APERIO_LOCAL_PERF_PROFILE (llamacpp.md Phase 4) — the hardware/perf preset
// for the local llama.cpp engine. "balanced" is the default and reproduces
// pre-Phase-4 sizing/model-pick behavior exactly; the other three trade
// speed/context/model-size against each other for a user who knows their
// hardware constraint.
export const PERF_PROFILES = ["balanced", "fast-low-vram", "long-context", "quality"];

export const MODEL_TIER_KEYS = [
  "LLAMACPP_MODEL_TIER_8",
  "LLAMACPP_MODEL_TIER_16",
  "LLAMACPP_MODEL_TIER_24",
  "LLAMACPP_MODEL_TIER_32",
];
export const MODEL_TIER_DEFAULTS = Object.freeze(Object.fromEntries(
  MODEL_TIER_KEYS.map(key => [key, CONFIG.find(entry => entry.key === key)?.default || ""]),
));

// Validates APERIO_LOCAL_PERF_PROFILE against the known set; an unrecognized
// value (typo, stale config) degrades to "balanced" with a warning rather than
// silently picking the wrong preset.
export function resolvePerfProfile(env = process.env) {
  const raw = (env.APERIO_LOCAL_PERF_PROFILE || "balanced").trim().toLowerCase();
  if (PERF_PROFILES.includes(raw)) return raw;
  logger.warn(`[providers] Unrecognized APERIO_LOCAL_PERF_PROFILE="${raw}" — falling back to "balanced". Valid values: ${PERF_PROFILES.join(", ")}.`);
  return "balanced";
}

// Pick the configured local model for the machine's RAM tier. The values are
// llama-server-compatible HF repo[:quant] strings, so a product shipper can
// change the ladder without editing source.
// RAM thresholds are the base heuristic for every profile; `profile` only shifts
// which rung of the ladder wins:
//   • balanced (default) / long-context — unchanged pre-Phase-4 ladder. Neither
//     profile is about *which* model runs (long-context only changes the served
//     context window), so both keep exactly the original thresholds.
//   • fast-low-vram — MoE-preferred: llama.cpp's --n-cpu-moe expert-offload
//     trick (see buildModelsPreset) makes the MoE model's *active* compute
//     footprint (3B) the thing that matters for speed, not its total weight
//     size (30B) — so it's worth preferring well below the balanced ladder's
//     48GB rung, which sizes for holding everything in fast memory, not
//     offloading experts to CPU.
//   • quality — bigger model pick where RAM allows, accepting slower tok/s:
//     same ladder, each rung reaches one step further down.
// A RAM read of 0 (totalmem unavailable) falls through to the safe small model
// on every profile. `hardware.totalRamGB` overrides the real machine RAM read
// for tests; omit it to size against the actual host.
export function getRecommendedModel(profile = resolvePerfProfile(), hardware = {}, env = process.env) {
  const gb = hardware.totalRamGB ?? os.totalmem() / 1024 ** 3;
  const key = gb > 24 ? "LLAMACPP_MODEL_TIER_32"
    : gb > 16 ? "LLAMACPP_MODEL_TIER_24"
      : gb > 8 ? "LLAMACPP_MODEL_TIER_16" : "LLAMACPP_MODEL_TIER_8";
  return String(env[key] || MODEL_TIER_DEFAULTS[key]);
}

// ── Per-model context sizing ─────────────────────────────────────────────────
// A model's trained max context (e.g. Gemma's 256K) is almost never what you
// want to *serve*: the KV cache grows linearly with the window and shares RAM
// with the model weights and the rest of the system. recommendContextLength
// picks the largest window that still leaves the machine room to breathe, so we
// can pass it as options.num_ctx on the native /api/chat call — per request, no
// server restart. Pure + injectable so it unit-tests without a live server.
const GIB = 1024 ** 3;

// Keep every RAM decision on the same side of the safety line. These values
// are shared by context sizing and the llama.cpp two-model residency check.
export const RAM_FIT_DEFAULTS = Object.freeze({
  reserveGB: 10,
  reserveFraction: 0.30,
  overheadGB: 1,
});

// KV cost per token when we can't read enough from model_info — deliberately
// roomy so we under-shoot the window rather than oversubscribe RAM.
const DEFAULT_KV_BYTES_PER_TOKEN = 144 * 1024;

// Best-effort KV-cache cost per token (bytes) from a GGUF model_info block.
//   layers × kv_heads × (key_dim + value_dim) × 2 bytes   (f16 cache)
// Fields are namespaced by architecture (gemma4.*, qwen3vl.*); some are often
// missing — kv_heads falls back to the full head count (worst case, safe), the
// head dims to embedding/head_count. Returns null when we can't read enough, so
// the caller substitutes a conservative default instead of a bogus number.
// Caveat: ignores GQA quirks (Gemma's sliding-window cache) and KV-cache
// quantization, so it can over-estimate — i.e. err toward a smaller window.
export function estimateKvBytesPerToken(modelInfo = {}) {
  const arch = modelInfo["general.architecture"];
  if (!arch) return null;
  const g = (suffix) => modelInfo[`${arch}.${suffix}`];
  const layers = g("block_count");
  const heads = g("attention.head_count");
  const kvHeads = g("attention.head_count_kv") ?? heads;
  const embed = g("embedding_length");
  const keyDim = g("attention.key_length") ?? (embed && heads ? embed / heads : null);
  const valDim = g("attention.value_length") ?? keyDim;
  if (!layers || !kvHeads || !keyDim || !valDim) return null;
  return layers * kvHeads * (keyDim + valDim) * 2;
}

// Tokens the machine's RAM can physically hold for the KV cache, after reserving
// room for the OS/other apps and the model weights. The raw fit *before* any
// policy cap (fit-fraction / ceiling) — shared by the sizer below and the
// capacity readout (machineCapacityPct) so both agree on "what the machine can
// hold". Returns 0 when there's no room to breathe.
function ramFitTokens(
  { weightsGB = 0, fixedKvGB = 0, bytesPerToken, totalRamGB = os.totalmem() / GIB } = {},
  { reserveGB = RAM_FIT_DEFAULTS.reserveGB, reserveFraction = RAM_FIT_DEFAULTS.reserveFraction, overheadGB = RAM_FIT_DEFAULTS.overheadGB } = {},
) {
  const perToken = bytesPerToken > 0 ? bytesPerToken : DEFAULT_KV_BYTES_PER_TOKEN;
  const breathing = Math.max(reserveGB, totalRamGB * reserveFraction);
  const kvBudgetGB = totalRamGB - breathing - weightsGB - overheadGB - fixedKvGB;
  if (kvBudgetGB <= 0) return 0;
  return (kvBudgetGB * GIB) / perToken;
}

// Estimate the resident RAM footprint of one loaded model at a served context
// window. This deliberately uses the same conservative accounting as
// ramFitTokens: weights + fixed KV + growing KV + llama.cpp overhead.
export function residentFootprintGB(
  { sizeGB = 0, kvFixedGB, fixedKvGB, kvBytesPerToken = DEFAULT_KV_BYTES_PER_TOKEN } = {},
  servedCtxTokens = 0,
  { overheadGB = RAM_FIT_DEFAULTS.overheadGB } = {},
) {
  const perToken = kvBytesPerToken > 0 ? kvBytesPerToken : DEFAULT_KV_BYTES_PER_TOKEN;
  const fixed = kvFixedGB ?? fixedKvGB ?? 0;
  return sizeGB + fixed + (Math.max(0, servedCtxTokens) * perToken / GIB) + overheadGB;
}

// Pick a num_ctx that fits in RAM with headroom. Pure: pass the model facts
// (max context, weight size, per-token KV cost) and total RAM; everything else
// is a tunable knob. Returns a tidy token count, never below `floor`.
export function recommendContextLength(
  { modelMaxContext = 32768, weightsGB = 0, fixedKvGB = 0, bytesPerToken, totalRamGB = os.totalmem() / GIB } = {},
  opts = {},
) {
  const {
    fitFraction = 0.82,     // on a capable machine, target this share of the RAM
                            //   fit (keep ~20% headroom below the physical limit)
    minFitRamGB = 24,       // …but only at/above this RAM; smaller machines are
                            //   already RAM-starved, so use their full fit rather
                            //   than shaving an already-tight window
    ceiling = 131072,       // hard cap — latency/degradation backstop
    floor = 2048,           // smallest still-useful window
    round = 1024,           // snap down to a tidy multiple
  } = opts;

  // No room for even the floor → return the floor and let the server decide
  // whether to spill. A small honest window beats a big silently-truncated one.
  const fitTokens = ramFitTokens({ weightsGB, fixedKvGB, bytesPerToken, totalRamGB }, opts);
  if (fitTokens <= 0) return floor;

  // Capable machines (≥ minFitRamGB) lean into the window but keep headroom below
  // the RAM fit; small machines already sit far below any cap, so use their full
  // fit rather than shaving an already-tight window.
  const fitCap = totalRamGB >= minFitRamGB ? fitTokens * fitFraction : fitTokens;
  const target = Math.floor(Math.min(modelMaxContext, fitCap, ceiling) / round) * round;
  return Math.max(floor, target);
}

// Static facts for the models getRecommendedModel() emits — the only ones Aperio
// pulls for a non-technical user. We size the server's KV cache *before*
// llama-server is up (so it can't be queried yet), and weights/maxContext also
// feed the setup wizard's disk-space check.
//   • sizeGB          — rounded download size (GB), also the weight budget
//   • maxContext      — model's trained window (tokens)
//   • kvBytesPerToken — measured KV-cache cost/token; required because the
//     conservative default badly under-estimates dense-cache models like Gemma
//     (gemma4:12b is ~1.5 MB/token — sizing it from the default would pick a
//     window whose cache dwarfs RAM and spills to CPU). gemma4:12b's value is a
//     safe over-estimate (its GGUF omits head_count_kv); see estimateKvBytesPerToken.
//   • hf              — llama.cpp download target: "org/repo[:quant]", the exact
//     string `llama-server -hf` accepts and the same string sent as the `model`
//     field on /v1/chat/completions (llamacpp.md Phase 0 spike + Phase 3 model
//     mapping).
//   • mmproj          — optional companion mmproj GGUF override for a vision
//     model; omit it when llama-server auto-resolves the mmproj itself (the
//     common case — confirmed in the Phase 0 spike for every VLM tested).
//   • architecture    — "dense" | "moe". Only "moe" models benefit from
//     llama.cpp's --n-cpu-moe expert-offload flag (Phase 4).
//   • activeParams    — billions of *active* params per token for MoE models
//     (e.g. Qwen3 "A3B" = 3B active of 30B total); omitted for dense models.
export const MODEL_FACTS = {
  "qwen3:30b-a3b": { sizeGB: 18,  maxContext: 262144, kvBytesPerToken: 98304,
    hf: "Qwen/Qwen3-30B-A3B-GGUF:Q4_K_M", architecture: "moe", activeParams: 3 },
  "gemma4:12b":    { sizeGB: 8,   maxContext: 262144, kvBytesPerToken: 1572864,
    hf: "ggml-org/gemma-4-12B-it-GGUF:Q4_K_M", architecture: "dense" },
  "gemma4:e4b":    { sizeGB: 4.5, maxContext: 131072, kvBytesPerToken: 172032,
    hf: "ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M", architecture: "dense" },
  // QAT variant of gemma4:e4b (unsloth repo). Same architecture — KV cost read
  // straight from this GGUF's own header (42 layers × 2 kv_heads × (512+512) × 2).
  // Without this entry the repo missed factsForHf and fell to the conservative
  // generic facts (512 KB/token, 8 GB weights), quartering the served window.
  "gemma4:e4b-qat": { sizeGB: 3.9, maxContext: 131072, kvBytesPerToken: 172032,
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL", architecture: "dense" },
  "qwen2.5:3b":    { sizeGB: 1.9, maxContext: 32768,  kvBytesPerToken: 36864,
    hf: "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M", architecture: "dense" },
  // Qwen3.5 is hybrid: only every fourth layer is full attention. Counting all
  // 32 layers as KV-backed inflated its cache estimate 16× (512 KB/token).
  // Real F16 KV: 8 full-attn layers × 4 KV heads × (256 K + 256 V) × 2 bytes.
  "qwen3.5:9b":    { sizeGB: 5.3, maxContext: 262144, kvBytesPerToken: 32768,
    hf: "unsloth/Qwen3.5-9B-GGUF:Q4_K_M", architecture: "dense" },
  "Qwen3.5:9b":    { sizeGB: 5.3, maxContext: 262144, kvBytesPerToken: 32768,
    hf: "unsloth/Qwen3.5-9B-GGUF:Q4_K_M", architecture: "dense" },
  // Its MTP GGUF reports 41 blocks and a full-attention interval of 4, hence
  // 11 KV-backed layers: 11 × 2 KV heads × (256 K + 256 V) × 2 = 22 KB/token.
  // sizeGB is the local UD-Q4_K_XL GGUF size (22,853,663,008 bytes).
  "qwen3.6:35b-a3b-mtp": { sizeGB: 21.3, maxContext: 262144, kvBytesPerToken: 22528,
    hf: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", architecture: "moe", activeParams: 3 },
  "gemma4:26b-a4b": { sizeGB: 15.8, maxContext: 262144, kvBytesPerToken: 49152,
    hf: "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL", architecture: "moe", activeParams: 4 },
  "qwen3.5:4b":    { sizeGB: 3.4, maxContext: 262144, kvBytesPerToken: 524288,
    hf: "unsloth/Qwen3.5-4B-GGUF:Q4_K_M", architecture: "dense" },
  "Qwen3.5:4b":    { sizeGB: 3.4, maxContext: 262144, kvBytesPerToken: 524288,
    hf: "unsloth/Qwen3.5-4B-GGUF:Q4_K_M", architecture: "dense" },
  // Ornith 1.0 9B — a qwen3.5-architecture reasoning model (see lib/workers/
  // reasoning.js and lib/tools/executor.js for its inline-think + bbcode
  // tool-call adapters). Not RAM-tiered by getRecommendedModel(); users opt in
  // via LLAMACPP_MODEL. KV cost mirrors its qwen3.5:9b sibling (same arch) — a
  // safe over-estimate. Without these facts, sizing fell to the generic default
  // and picked a 76800-token window whose real KV cache (~40 GB) OOM'd Metal.
  "ornith-1.0:9b": { sizeGB: 5.3, maxContext: 262144, kvBytesPerToken: 524288,
    hf: "deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M", architecture: "dense" },
  // Vision bridge model — not RAM-tiered by getRecommendedModel() (a fixed
  // curated default, same role LLAMACPP_VLM_MODEL plays), but it needs the
  // same facts shape so the wizard/sizer can treat it uniformly.
  "qwen2.5vl:7b":  { sizeGB: 6,   maxContext: 32768,  kvBytesPerToken: 172032,
    hf: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", architecture: "dense" },
};

// Conservative facts for a model not in MODEL_FACTS (a custom LLAMACPP_MODEL).
// kvBytesPerToken is deliberately pessimistic rather than
// recommendContextLength's optimistic 144 KB default: an uninspectable model is
// far likelier to have a large KV cache than a tiny one, and over-sizing the
// window OOMs the GPU at inference (a bare "Compute error."). A smaller honest
// window beats a crash — a curated model in MODEL_FACTS overrides this anyway.
// Shared by the preset sizer (startLlamaCpp.js) and machineCapacityPct below so
// the served window and the capacity readout are computed from the SAME facts —
// they used to diverge (144 KB vs 512 KB fallbacks), making the navbar claim
// "23% of capacity" for a window the sizer itself considered 82% full. Cached
// GGUFs bypass this fallback entirely via ggufModelFacts.js.
export const GENERIC_MODEL_FACTS = { sizeGB: 8, maxContext: 131072, kvBytesPerToken: 524288 };

// Reverse lookup: MODEL_FACTS entry whose `hf` matches a llama-server model
// identifier (LLAMACPP_MODEL/LLAMACPP_VLM_MODEL are hf repo[:quant] strings,
// not the tag-style keys MODEL_FACTS is keyed by). Returns null for a custom
// model the user pointed at directly — callers fall back to generic facts.
export function factsForHf(hfRepo) {
  // Match on the repo path, ignoring any :quant suffix on either side. Users
  // often set LLAMACPP_MODEL without a quant (llama-server auto-picks a default
  // GGUF), so an exact-string match would miss a curated model and silently
  // fall back to generic sizing — which over-sizes the context and OOMs at
  // inference. No two entries share a repo, so stripping the quant is unambiguous.
  const repo = String(hfRepo ?? "").split(":")[0];
  if (!repo) return null;
  return Object.values(MODEL_FACTS).find(f => f.hf.split(":")[0] === repo) ?? null;
}

const MODEL_FACTS_CACHE = new Map();

// Resolve facts in runtime order: exact local GGUF metadata, curated
// pre-download catalog, then conservative generic sizing. The cache is keyed
// by both model and cache root because tests and multi-instance deployments can
// point at different Hugging Face stores.
export function resolveModelFacts(model, env = process.env) {
  const cacheRoot = resolveModelCacheDir(env);
  const cacheKey = `${cacheRoot}\u0000${String(model ?? "")}`;
  if (MODEL_FACTS_CACHE.has(cacheKey)) return MODEL_FACTS_CACHE.get(cacheKey);
  const inspected = inspectCachedModel(model, cacheRoot);
  const facts = inspected ?? factsForHf(model) ?? MODEL_FACTS[model] ?? GENERIC_MODEL_FACTS;
  // Do not cache a miss/generic result: a model may be downloaded after the
  // first sizing call, and the next call must be able to discover its GGUF.
  // A parsed GGUF is immutable for the lifetime of this process, so caching
  // successful inspection avoids repeatedly scanning its header.
  if (inspected) MODEL_FACTS_CACHE.set(cacheKey, inspected);
  return facts;
}

export function modelDisplayName(hfRepo) {
  const repo = String(hfRepo ?? "").split(":")[0];
  const catalogEntry = Object.entries(MODEL_FACTS).find(([, facts]) => facts.hf.split(":")[0] === repo);
  if (catalogEntry) return catalogEntry[0];
  return repo.split("/").pop() || repo;
}

// Estimated RAM occupied by model weights + fixed/sliding KV + configured
// growing KV + llama.cpp overhead, as a percentage of total machine RAM. The
// UI labels this "% RAM", so the numerator must include weights rather than
// comparing context tokens with a theoretical token-fit budget. Callers gate
// on isLocalProvider(provider.name) and pass the live
// model (an hf repo[:quant] string or a MODEL_FACTS key). Returns null when it
// can't be computed (unknown RAM fit or no served window).
export function machineCapacityPct(model, env = process.env) {
  const facts = resolveModelFacts(model, env);
  const cacheScale = resolvePerfProfile(env) === "fast-low-vram" ? 0.5 : 1;
  const served = parseInt(env.LLAMACPP_SERVE_CTX || "0", 10);
  if (!served) return null;
  const totalRamGB = os.totalmem() / GIB;
  if (!(totalRamGB > 0)) return null;
  const kvGB = ((facts.kvFixedGB ?? 0) * cacheScale)
    + (served * facts.kvBytesPerToken * cacheScale / GIB);
  const footprintGB = facts.sizeGB + kvGB + 1;
  return Math.round((footprintGB / totalRamGB) * 100);
}

// The app talks to llama.cpp over its OpenAI-compatible /v1 endpoint, which
// has no way to set the server's context window per request — so the
// "assumed" var (LLAMACPP_CTX) is only the app's internal assumption for
// trim/cap math, NOT a window pushed onto the server. If it exceeds the
// server's real serving window, capToolResults over-keeps and the prompt is
// silently truncated server-side, leaving the model to answer blind. Clamp to
// the server's own real-window var (LLAMACPP_SERVE_CTX) whenever it's visible
// to the app, so we never assume more context than the server actually
// provides. Setting that var on the server (the real fix) then aligns both
// sides automatically.
//
// genericCtxStatus/genericContextWindow hold the shared rule; llamacppCtxStatus/
// llamacppContextWindow are a thin, named wrapper so callers keep reading a
// provider-specific function. `real` of 0 means the server window is unknown
// → no clamp.
function genericCtxStatus({ assumedKey, realKey }, env = process.env) {
  const assumed = parseInt(env[assumedKey] || "32768", 10);
  const real = parseInt(env[realKey] || "0", 10);
  const mismatch = real > 0 && assumed > real;
  return { assumed, real, mismatch, effective: mismatch ? real : assumed };
}

function genericContextWindow(cfg, env = process.env) {
  const { assumedKey, realKey } = cfg;
  const { assumed, real, mismatch, effective } = genericCtxStatus(cfg, env);
  if (mismatch) {
    // Label each value's source (DB vs .env vs default) so the user knows which
    // layer to edit — the core fix for issue #182's "opaque warning".
    const lbl = (k) => { const s = configSourceLabel(k); return s ? ` (${s})` : ""; };
    logger.warn(
      `[provider] ${assumedKey}=${assumed}${lbl(assumedKey)} exceeds the server's ` +
      `${realKey}=${real}${lbl(realKey)}; clamping the app's ` +
      `context window to ${real} (the server's real window) to prevent silent prompt ` +
      `truncation. Fix: raise ${realKey} or lower ${assumedKey}.`
    );
  }
  return effective;
}

const LLAMACPP_CTX_KEYS = { assumedKey: "LLAMACPP_CTX", realKey: "LLAMACPP_SERVE_CTX" };

export function llamacppCtxStatus(env = process.env) {
  return genericCtxStatus(LLAMACPP_CTX_KEYS, env);
}

export function llamacppContextWindow(env = process.env) {
  return genericContextWindow(LLAMACPP_CTX_KEYS, env);
}

/**
 * Resolve a provider config.
 *
 * Default: read everything from process.env (preserves prior behaviour).
 * Round-table: pass `{ name, model }` to force a specific provider+model while
 * still pulling credentials/base URLs from env. This is how server.js boots
 * two agents from a single ROUNDTABLE_AGENTS env var.
 *
 * @param {{ name?: string, model?: string }} [overrides]
 */
export function resolveProvider(overrides = {}) {
  const PROVIDER = (overrides.name ?? process.env.AI_PROVIDER)?.toLowerCase() || "anthropic";
  const ANTHROPIC_MODEL = overrides.model || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  if (PROVIDER === "llamacpp") {
    const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL || "http://127.0.0.1:8080";
    const llamacppModel = overrides.model || process.env.LLAMACPP_MODEL || "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M";
    return { name: "llamacpp", model: llamacppModel, requestModel: LLAMACPP_MAIN_ALIAS, baseURL: `${LLAMACPP_BASE_URL}/v1`, llamacppBaseURL: LLAMACPP_BASE_URL, contextWindow: llamacppContextWindow() };
  }
  // deepseek-v4-pro accepts native image_url content (only in user messages);
  // flash and older models are text-only and fall back to the local VLM bridge.
  if (PROVIDER === "deepseek") { const model = overrides.model || process.env.DEEPSEEK_MODEL; return { name: "deepseek", model, baseURL: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY, vision: /deepseek-v4-pro/i.test(model || ""), contextWindow: 128000 }; }
  if (PROVIDER === "gemini") { const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); return { name: "gemini", model: overrides.model || process.env.GEMINI_MODEL || "gemini-2.0-flash", client, vision: true, contextWindow: 1000000 }; }
  if (PROVIDER === "claude-code") return { name: "claude-code", model: ANTHROPIC_MODEL, client: null, contextWindow: 200000 };
  if (PROVIDER === "codex") return { name: "codex", model: overrides.model || process.env.CODEX_MODEL || "gpt-5.5", client: null, contextWindow: 200000 };
  return { name: "anthropic", model: ANTHROPIC_MODEL, client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), contextWindow: 200000 };
}

// ── Local performance diagnostics (llamacpp.md Phase 5 / issue #222) ────────
// Generation speed below this is "unacceptable" regardless of model size —
// sourced from the #222 video's own before/after numbers (3 tok/s judged
// unusable, 17 tok/s judged fine after applying the fast-low-vram-style
// flags); 5 sits between the two as a conservative floor. Shared by the
// runtime slow-turn diagnostic and `npm run local:bench` so both surfaces
// agree on what "slow" means and emit the same recommendation text.
export const SLOW_GEN_TPS = 5;

// Pure recommendation function — no I/O, so both the live per-turn diagnostic
// (lib/agent/index.js) and the standalone benchmark script can call it with
// whatever signal they have on hand. Returns null when there's no timings
// signal to judge (caller should stay silent, not warn on missing data).
//
// Mirrors issue #222's four recommendation strings where they still apply to
// a llama.cpp backend; "keep-alive may help" doesn't (Aperio already keeps
// llama-server resident for the whole session via ensureLlamaCpp() + the
// shutdown watchdog — there's no per-request keep-alive knob to tune), so
// that case is replaced with a model-size hint instead.
export function recommendPerfFix({ genTps, profile = "balanced", servedCtx = null } = {}) {
  if (genTps == null || !Number.isFinite(genTps)) return null;
  if (genTps >= SLOW_GEN_TPS) return "Throughput is acceptable.";
  if (profile !== "fast-low-vram") return "Try the fast-low-vram profile.";
  if (servedCtx != null && servedCtx > 32768) return "Your context window is likely too high — try lowering LLAMACPP_SERVE_CTX / LLAMACPP_CTX.";
  return "Generation is still slow on fast-low-vram at a modest context — this model may be too large for this machine; consider a smaller one.";
}

const LOCAL_PROVIDERS = new Set(["llamacpp"]);

/**
 * True only for the fully-local provider (llama.cpp). Cloud providers
 * (Anthropic, DeepSeek, Gemini, Claude Code, Codex, etc.) return false.
 * Single source of truth for privacy gating — import this everywhere instead of
 * ad-hoc `provider === "llamacpp"` checks; flipping a provider's membership here
 * carries every privacy check (self-memory, secret redaction, shell defaults, …).
 */
export function isLocalProvider(providerName) {
  return LOCAL_PROVIDERS.has(String(providerName ?? "").toLowerCase());
}

/** Inverse of isLocalProvider. True for any non-local provider. */
export function isCloudProvider(providerName) {
  return !isLocalProvider(providerName);
}
