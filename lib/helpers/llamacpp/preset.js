// lib/helpers/llamacpp/preset.js — models.ini preset text builder + default model selection.

import { MODEL_FACTS, factsForHf, resolvePerfProfile, resolveKvCachePolicy, defaultLocalModel } from "../../providers/index.js";
import { LLAMACPP_MAIN_ALIAS, LLAMACPP_VLM_ALIAS } from "../llamacppAliases.js";
import { isVisionModel } from "../imageBridge.js";
import { serveCtxFor } from "./sizing.js";
import { mainPlusVlmFit, VLM_BRIDGE_CTX_CEILING } from "./vlm.js";

// Curated defaults sourced from the shared MODEL_FACTS table (Phase 3) — the
// same table the setup wizard's disk-space check and getRecommendedModel()
// read, so there's exactly one place that maps a curated model to its hf id.
export const DEFAULT_VLM_MODEL = MODEL_FACTS["qwen2.5vl:7b"].hf;
// GENERIC_MODEL_FACTS (conservative facts for a model not in MODEL_FACTS) now
// lives in lib/providers/index.js, shared with machineCapacityPct so the sizer
// and the navbar capacity readout never disagree about an unknown model.

// Default main model when LLAMACPP_MODEL isn't set. "balanced" and
// "long-context" keep the fixed curated small model unchanged — neither
// profile is about *which* model runs (RAM-tiered selection normally happens
// once, at wizard time, via getRecommendedModel(), which then writes
// LLAMACPP_MODEL into .env). "fast-low-vram" and "quality" are explicitly
// about model choice (MoE-preferred / bigger-where-RAM-allows, respectively),
// so for those two this fallback re-picks via the same profile-aware ladder
// the wizard uses, in case the preset is built without ever going through it.
export function defaultMainModelHf(env, hardware, profile) {
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
