import os from "os";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "../helpers/logger.js";
import { configSourceLabel } from "../config-resolver.js";

// Pick the most capable local model that comfortably fits the machine's RAM, so
// a non-technical user never has to guess. Tags below are real Ollama pulls — a
// wrong tag means a failed download, which is exactly the frustration we avoid.
//   • qwen2.5:3b — low budget / unknown specs: runs almost anywhere.
//   • gemma4:e4b — most capable model that still fits low hardware.
//   • gemma4:12b / qwen3:30b-a3b — for boxes with real headroom.
// A RAM read of 0 (totalmem unavailable) falls through to the safe small model.
export function getRecommendedModel() {
  const gb = os.totalmem() / 1024 ** 3;
  if (gb >= 48) return "qwen3:30b-a3b";
  if (gb >= 24) return "gemma4:12b";
  if (gb >= 8)  return "gemma4:e4b";
  return "qwen2.5:3b";
}

// ── Per-model context sizing ─────────────────────────────────────────────────
// A model's trained max context (e.g. Gemma's 256K) is almost never what you
// want to *serve*: the KV cache grows linearly with the window and shares RAM
// with the model weights and the rest of the system. recommendContextLength
// picks the largest window that still leaves the machine room to breathe, so we
// can pass it as options.num_ctx on the native /api/chat call — per request, no
// server restart. Pure + injectable so it unit-tests without a live Ollama.
const GIB = 1024 ** 3;

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

// Pick a num_ctx that fits in RAM with headroom. Pure: pass the model facts
// (max context, weight size, per-token KV cost) and total RAM; everything else
// is a tunable knob. Returns a tidy token count, never below `floor`.
export function recommendContextLength(
  { modelMaxContext = 32768, weightsGB = 0, bytesPerToken, totalRamGB = os.totalmem() / GIB } = {},
  opts = {},
) {
  const {
    reserveGB = 10,         // OS + browser + node floor the model must not touch
    reserveFraction = 0.30, // …or this share of RAM, whichever is larger
    overheadGB = 1,         // compute graph / activation slop on top of weights
    ceiling = 65536,        // latency + long-context degradation cap; tune up to use more
    floor = 2048,           // smallest still-useful window
    round = 1024,           // snap down to a tidy multiple
  } = opts;

  const perToken = bytesPerToken > 0 ? bytesPerToken : DEFAULT_KV_BYTES_PER_TOKEN;
  const breathing = Math.max(reserveGB, totalRamGB * reserveFraction);
  const kvBudgetGB = totalRamGB - breathing - weightsGB - overheadGB;

  // No room for even the floor → return the floor and let Ollama decide whether
  // to spill. A small honest window beats a big silently-truncated one.
  if (kvBudgetGB <= 0) return floor;

  const fitTokens = (kvBudgetGB * GIB) / perToken;
  const target = Math.floor(Math.min(modelMaxContext, fitTokens, ceiling) / round) * round;
  return Math.max(floor, target);
}

// Static facts for the models getRecommendedModel() emits — the only ones Aperio
// pulls for a non-technical user. We size the server's KV cache *before* Ollama
// is up (so /api/show can't be queried yet), and weights/maxContext also feed the
// setup wizard's disk-space check.
//   • sizeGB          — rounded download size (GB), also the weight budget
//   • maxContext      — model's trained window (tokens)
//   • kvBytesPerToken — measured KV-cache cost/token; required because the
//     conservative default badly under-estimates dense-cache models like Gemma
//     (gemma4:12b is ~1.5 MB/token — sizing it from the default would pick a
//     window whose cache dwarfs RAM and spills to CPU). gemma4:12b's value is a
//     safe over-estimate (its GGUF omits head_count_kv); see estimateKvBytesPerToken.
export const MODEL_FACTS = {
  "qwen3:30b-a3b": { sizeGB: 18,  maxContext: 262144, kvBytesPerToken: 98304 },
  "gemma4:12b":    { sizeGB: 8,   maxContext: 262144, kvBytesPerToken: 1572864 },
  "gemma4:e4b":    { sizeGB: 4.5, maxContext: 131072, kvBytesPerToken: 172032 },
  "qwen2.5:3b":    { sizeGB: 1.9, maxContext: 32768,  kvBytesPerToken: 36864 },
};

// Choose the OLLAMA_CONTEXT_LENGTH to spawn `ollama serve` with. An explicit
// OLLAMA_CONTEXT_LENGTH (user pinned the server window) or OLLAMA_NUM_CTX (the
// app's assumed window) always wins; otherwise size from the selected model's
// static facts + RAM. Returns a string, matching the spawn env it feeds.
export function recommendServeContextLength(env = process.env) {
  if (env.OLLAMA_CONTEXT_LENGTH) return String(env.OLLAMA_CONTEXT_LENGTH);
  if (env.OLLAMA_NUM_CTX) return String(env.OLLAMA_NUM_CTX);
  const model = env.OLLAMA_MODEL || getRecommendedModel();
  const facts = MODEL_FACTS[model] ?? {};
  return String(recommendContextLength({
    modelMaxContext: facts.maxContext ?? 131072,
    weightsGB: facts.sizeGB ?? 8,
    bytesPerToken: facts.kvBytesPerToken,
  }));
}

// The app talks to Ollama over the OpenAI-compatible /v1 endpoint, which (unlike
// the native /api/chat) has no way to set num_ctx — so OLLAMA_NUM_CTX is only the
// app's internal assumption for trim/cap math, NOT a window pushed onto the
// server. If it exceeds Ollama's real serving window, capToolResults over-keeps
// and the prompt is silently truncated server-side, leaving the model to answer
// blind. Clamp to Ollama's own OLLAMA_CONTEXT_LENGTH (the server's real window)
// whenever that var is visible to the app, so we never assume more context than
// Ollama actually provides. Setting OLLAMA_CONTEXT_LENGTH on the server (the real
// fix) then aligns both sides automatically.
// Compare the app's assumed context window (OLLAMA_NUM_CTX) against Ollama's
// real serving window (OLLAMA_CONTEXT_LENGTH). Shared by ollamaContextWindow
// (which clamps) and the config diagnostics (which only report), so the rule
// lives in one place. `real` of 0 means the server window is unknown → no clamp.
export function ollamaCtxStatus(env = process.env) {
  const assumed = parseInt(env.OLLAMA_NUM_CTX || "32768", 10);
  const real = parseInt(env.OLLAMA_CONTEXT_LENGTH || "0", 10);
  const mismatch = real > 0 && assumed > real;
  return { assumed, real, mismatch, effective: mismatch ? real : assumed };
}

export function ollamaContextWindow(env = process.env) {
  const { assumed, real, mismatch, effective } = ollamaCtxStatus(env);
  if (mismatch) {
    // Label each value's source (DB vs .env vs default) so the user knows which
    // layer to edit — the core fix for issue #182's "opaque warning".
    const lbl = (k) => { const s = configSourceLabel(k); return s ? ` (from ${s})` : ""; };
    logger.warn(
      `[provider] OLLAMA_NUM_CTX=${assumed}${lbl("OLLAMA_NUM_CTX")} exceeds Ollama's ` +
      `OLLAMA_CONTEXT_LENGTH=${real}${lbl("OLLAMA_CONTEXT_LENGTH")}; clamping the app's ` +
      `context window to ${real} (the server's real window) to prevent silent prompt ` +
      `truncation. Fix: raise OLLAMA_CONTEXT_LENGTH or lower OLLAMA_NUM_CTX.`
    );
  }
  return effective;
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
  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const selectedModel = overrides.model || process.env.OLLAMA_MODEL || "llama3.1";
  if (PROVIDER === "ollama") return { name: "ollama", model: selectedModel, baseURL: `${OLLAMA_BASE_URL}/v1`, ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: ollamaContextWindow() };
  // deepseek-v4-pro accepts native image_url content (only in user messages);
  // flash and older models are text-only and fall back to the local VLM bridge.
  if (PROVIDER === "deepseek") { const model = overrides.model || process.env.DEEPSEEK_MODEL; return { name: "deepseek", model, baseURL: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY, ollamaBaseURL: null, vision: /deepseek-v4-pro/i.test(model || ""), contextWindow: 128000 }; }
  if (PROVIDER === "gemini") { const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); return { name: "gemini", model: overrides.model || process.env.GEMINI_MODEL || "gemini-2.0-flash", client, ollamaBaseURL: null, vision: true, contextWindow: 1000000 }; }
  if (PROVIDER === "claude-code") return { name: "claude-code", model: ANTHROPIC_MODEL, client: null, ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: 200000 };
  return { name: "anthropic", model: ANTHROPIC_MODEL, client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: 200000 };
}
