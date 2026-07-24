// lib/helpers/llamacpp/sizing.js — per-model context-window sizing (leaf module:
// no dependency on vlm.js/preset.js, so both can depend on this without a cycle).

import { recommendContextLength, resolveKvCachePolicy, resolveModelFacts } from "../../providers/index.js";

// Per-profile ctx-sizing overrides layered onto recommendContextLength's own
// defaults (ceiling 131072, fitFraction 0.82) — "balanced" and "quality" pass
// no overrides (their sizing behavior is the pre-Phase-4 default; quality's
// payoff is a bigger *model* pick — see defaultMainModelHf in preset.js — not a
// bigger window).
const PROFILE_CTX_OPTS = {
  balanced:        {},
  quality:         {},
  "fast-low-vram": { ceiling: 16384 },
  "long-context":  { ceiling: 262144, fitFraction: 0.90 },
};

export function serveCtxFor(modelKey, env, hardware, profile, extraOpts = {}) {
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

export function modelFactsFor(modelKey, hardware) {
  return hardware.modelCacheDir
    ? resolveModelFacts(modelKey, { LLAMA_CACHE: hardware.modelCacheDir })
    : resolveModelFacts(modelKey);
}
