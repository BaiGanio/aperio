import os from "os";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "../helpers/logger.js";
import { CONFIG } from "../config.js";
import { configSourceLabel } from "../config-resolver.js";
import { LLAMACPP_MAIN_ALIAS } from "../helpers/llamacppAliases.js";
import {
  GENERIC_MODEL_FACTS,
  factsForHf,
  modelDisplayName,
  resolveModelFacts,
} from "./model-facts.js";

export {
  GENERIC_MODEL_FACTS,
  factsForHf,
  modelDisplayName,
  resolveModelFacts,
};

// APERIO_LOCAL_PERF_PROFILE (llamacpp.md Phase 4) — the hardware/perf preset
// for the local llama.cpp engine. "balanced" is the default and reproduces
// pre-Phase-4 sizing/model-pick behavior exactly; the other three trade
// speed/context/model-size against each other for a user who knows their
// hardware constraint.
export const PERF_PROFILES = ["balanced", "fast-low-vram", "long-context", "quality"];

// Validates APERIO_LOCAL_PERF_PROFILE against the known set; an unrecognized
// value (typo, stale config) degrades to "balanced" with a warning rather than
// silently picking the wrong preset.
export function resolvePerfProfile(env = process.env) {
  const raw = (env.APERIO_LOCAL_PERF_PROFILE || "balanced").trim().toLowerCase();
  if (PERF_PROFILES.includes(raw)) return raw;
  logger.warn(`[providers] Unrecognized APERIO_LOCAL_PERF_PROFILE="${raw}" — falling back to "balanced". Valid values: ${PERF_PROFILES.join(", ")}.`);
  return "balanced";
}

const KV_CACHE_TYPES = Object.freeze({
  f16: Object.freeze({ cacheTypeK: "f16", cacheTypeV: "f16", forceFlashAttention: false, sizingScale: 1 }),
  q8_0: Object.freeze({ cacheTypeK: "q8_0", cacheTypeV: "q8_0", forceFlashAttention: true, sizingScale: 0.5 }),
});

export function kvCacheScale(cacheType) {
  const policy = KV_CACHE_TYPES[cacheType];
  if (!policy) throw new RangeError(`Unsupported KV cache type: ${String(cacheType)}`);
  return policy.sizingScale;
}

// Keep emitted cache types, Flash Attention requirements, and RAM sizing on
// one profile policy. Accepting either an env object or a normalized/raw
// profile string lets preset code reuse its already-resolved profile without
// giving tests a second normalization contract to maintain.
export function resolveKvCachePolicy(profileOrEnv = process.env) {
  const env = typeof profileOrEnv === "string"
    ? { APERIO_LOCAL_PERF_PROFILE: profileOrEnv }
    : profileOrEnv;
  const profile = resolvePerfProfile(env);
  const cacheType = profile === "fast-low-vram" ? "q8_0" : "f16";
  const selected = KV_CACHE_TYPES[cacheType];
  return {
    cacheTypeK: selected.cacheTypeK,
    cacheTypeV: selected.cacheTypeV,
    forceFlashAttention: selected.forceFlashAttention,
    sizingScale: kvCacheScale(cacheType),
  };
}

// The single curated local model, used whenever LLAMACPP_MODEL isn't set. We
// no longer size the pick to the machine's RAM — one small model everyone can
// run, offered for download; a user who already has other models cached picks
// from those instead (setup wizard's "installed models" dropdown, driven by
// specs.cachedModels).
export const DEFAULT_LOCAL_MODEL = CONFIG.find(entry => entry.key === "LLAMACPP_MODEL")?.default || "";

export function getRecommendedModel(env = process.env) {
  return String(env.LLAMACPP_MODEL || DEFAULT_LOCAL_MODEL);
}

// The single fallback model used when LLAMACPP_MODEL is unset. resolveProvider()
// (provider metadata / capability detection / alias routing) and the llama.cpp
// preset builder MUST resolve the SAME model here — otherwise the app reports
// one model while the server loads another. Mirrors defaultMainModelHf() in
// startLlamaCpp.js, which delegates to this.
export function defaultLocalModel(env = process.env) {
  return getRecommendedModel(env) || DEFAULT_LOCAL_MODEL;
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

// Estimated RAM occupied by model weights + fixed/sliding KV + configured
// growing KV + llama.cpp overhead, as a percentage of total machine RAM. The
// UI labels this "% RAM", so the numerator must include weights rather than
// comparing context tokens with a theoretical token-fit budget. Callers gate
// on isLocalProvider(provider.name) and pass the live
// model (an hf repo[:quant] string or a model_facts alias). Returns null when it
// can't be computed (unknown RAM fit or no served window).
export function machineCapacityPct(model, env = process.env) {
  const facts = resolveModelFacts(model, env);
  const cacheScale = resolveKvCachePolicy(env).sizingScale;
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

const KNOWN_PROVIDERS = new Set(["anthropic", "deepseek", "gemini", "llamacpp", "claude-code", "codex"]);

// Once per boot, not per turn — resolveProvider runs on every agent
// construction and provider switch.
let _notConfiguredWarned = false;
function warnProviderNotConfigured(raw) {
  if (_notConfiguredWarned) return;
  _notConfiguredWarned = true;
  const what = raw ? `unknown value "${raw}"` : "empty";
  logger.warn(
    `[providers] AI_PROVIDER is not configured (${what}). Chat is disabled until a provider is chosen — ` +
    `open Settings → Provider & Models in the web UI, or set AI_PROVIDER in .env and restart. ` +
    `AI_PROVIDER=llamacpp runs free and local, no key needed.`);
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
  const PROVIDER = String(overrides.name ?? process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  // Deterministic loop-regression harness only (tests/harness/). Gated here,
  // at the single resolution chokepoint, rather than deeper in the dispatch
  // ladder — so a "mock" AI_PROVIDER can never resolve, let alone run a turn,
  // outside a test process.
  if (PROVIDER === "mock") {
    if (process.env.NODE_ENV !== "test") {
      throw new Error('The "mock" provider is test-only (tests/harness/) and cannot be resolved outside NODE_ENV=test.');
    }
    return { name: "mock", model: "mock", script: Array.isArray(overrides.script) ? overrides.script : [], contextWindow: 128000 };
  }
  // No silent cloud fallback (#252): an empty or unknown provider is an explicit
  // not-configured state — loud in the log, surfaced to the UI — never a
  // key-less anthropic boot.
  if (!KNOWN_PROVIDERS.has(PROVIDER)) {
    warnProviderNotConfigured(PROVIDER);
    return { name: "not-configured", notConfigured: true, model: "", client: null, contextWindow: 0 };
  }
  const ANTHROPIC_MODEL = overrides.model || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  if (PROVIDER === "llamacpp") {
    // Must derive the same default port lib/helpers/llamacpp/constants.js uses
    // to actually START llama-server — a hardcoded "8080" here silently talks
    // to the wrong port whenever LLAMACPP_PORT alone is set (found live
    // 2026-08-22, id/reference/tech-debt.md).
    const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL || `http://127.0.0.1:${process.env.LLAMACPP_PORT || "8080"}`;
    const llamacppModel = overrides.model || process.env.LLAMACPP_MODEL || defaultLocalModel();
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

const SUBSCRIPTION_PROVIDERS = new Set(["claude-code", "codex"]);

/**
 * True for providers billed via a flat subscription rather than per-token API
 * pricing (Claude Code, Codex). No per-token $ estimate should ever be shown
 * for these — it would be fiction, not a guide.
 */
export function isSubscriptionProvider(providerName) {
  return SUBSCRIPTION_PROVIDERS.has(String(providerName ?? "").toLowerCase());
}

// Deliberately its own set, not a reuse of SUBSCRIPTION_PROVIDERS above — the
// two coincided pre-provider-native-capabilities because both providers built
// their prompt from a single text-only string (subprocess CLI / SDK
// system-prompt), but billing model and multimodal capability are unrelated
// properties. codex (WS-A1) and claude-code (WS-A2) both now pass image
// content blocks through for real, so the set is empty — kept, not deleted,
// for the next provider whose loop genuinely can't carry images.
const IMAGE_DROPPING_PROVIDERS = new Set([]);

/**
 * True for providers whose loop builds its prompt from text only and
 * silently discards any image content block in the user's message
 * (provider-ux-parity WS6/F1). Callers should surface a notice before the
 * turn runs rather than let the attachment vanish without explanation.
 */
export function providerDropsImages(providerName) {
  return IMAGE_DROPPING_PROVIDERS.has(String(providerName ?? "").toLowerCase());
}
