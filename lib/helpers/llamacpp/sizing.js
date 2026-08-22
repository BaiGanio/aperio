// lib/helpers/llamacpp/sizing.js — per-model context-window sizing (leaf module:
// no dependency on vlm.js/preset.js, so both can depend on this without a cycle).

import os from "os";
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
  const totalRamGB = hardware.totalRamGB ?? os.totalmem() / 1024 ** 3;
  const configuredAgentFloor = parseInt(env.LLAMACPP_MIN_AGENT_CTX || "8192", 10);
  // The normal Aperio identity + memory pointer + minimum tool schema is larger
  // than a 4K window. An 8 GiB-class machine running the curated default (E4B)
  // has room for an 8K KV cache; smaller machines retain conservative RAM-fit
  // sizing. Auxiliary/VLM calls carry an explicit ceiling and must not inherit
  // the main-agent floor.
  const isDefaultAgentModel = /\/gemma-4-E4B-it-qat-GGUF(?::|$)/i.test(String(modelKey));
  const agentFloor = isDefaultAgentModel && !extraOpts.ceiling && totalRamGB >= 7.5 && configuredAgentFloor > 0
    ? configuredAgentFloor
    : undefined;
  return recommendContextLength({
    modelMaxContext: facts.maxContext,
    weightsGB: facts.sizeGB,
    fixedKvGB: (facts.kvFixedGB ?? 0) * cacheScale,
    bytesPerToken: facts.kvBytesPerToken * cacheScale,
    totalRamGB,
  }, {
    ...(facts.source === "gguf" ? { reserveGB: 4, reserveFraction: 0.15 } : {}),
    ...(PROFILE_CTX_OPTS[profile] ?? {}),
    ...(agentFloor ? { floor: agentFloor } : {}),
    ...extraOpts,
  });
}

export function modelFactsFor(modelKey, hardware) {
  return hardware.modelCacheDir
    ? resolveModelFacts(modelKey, { LLAMA_CACHE: hardware.modelCacheDir })
    : resolveModelFacts(modelKey);
}
