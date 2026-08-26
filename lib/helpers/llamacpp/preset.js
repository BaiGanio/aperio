// lib/helpers/llamacpp/preset.js — models.ini preset text builder + default model selection.

import { factsForHf, resolvePerfProfile, resolveKvCachePolicy, defaultLocalModel, DEFAULT_LOCAL_MODEL } from "../../providers/index.js";
import { modelCapabilities } from "../../providers/model-capabilities.js";
import { hasCachedMmproj } from "../ggufModelFacts.js";
import { resolveModelCacheDir } from "../modelCache.js";
import { LLAMACPP_MAIN_ALIAS, LLAMACPP_VLM_ALIAS } from "../llamacppAliases.js";
import { serveCtxFor } from "./sizing.js";
import { mainPlusVlmFit, VLM_BRIDGE_CTX_CEILING } from "./vlm.js";
// GENERIC_MODEL_FACTS (conservative facts for a model absent from model_facts) now
// lives in lib/providers/index.js, shared with machineCapacityPct so the sizer
// and the navbar capacity readout never disagree about an unknown model.

// Default main model when LLAMACPP_MODEL isn't set: the one curated small
// model, same for every perf profile and every machine. `hardware`/`profile`
// params are kept so call sites don't need to change shape, but no longer
// affect which model is picked.
export function defaultMainModelHf(env, _hardware, _profile) {
  return defaultLocalModel(env);
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

// Boot/preset-build call site — the one place modelCapabilities() is allowed
// to reach the network (a single bounded HF Hub lookup, only for a repo not
// yet cached; see model-capabilities.js's header). Unit-tests without a live
// server (same doctrine as recommendContextLength). `hardware.totalRamGB`
// overrides the real machine RAM read for tests; omit it to size against the
// actual host. Profile is read from `env.APERIO_LOCAL_PERF_PROFILE` via
// resolvePerfProfile.
export async function buildModelsPreset(env = process.env, hardware = {}) {
  const profile   = resolvePerfProfile(env);
  const cachePolicy = resolveKvCachePolicy(profile);
  const mainModel = env.LLAMACPP_MODEL || defaultMainModelHf(env, hardware, profile);
  // The bridge model is always the curated default (DEFAULT_LOCAL_MODEL), NOT
  // defaultLocalModel(env) — that helper echoes back env.LLAMACPP_MODEL when
  // it's set, which for a blind configured main model (e.g. Ornith) would
  // point the bridge at that SAME blind model, defeating its purpose. The
  // bridge must stay gemma-4-E4B regardless of what the main model is.
  const vlmModel  = DEFAULT_LOCAL_MODEL;
  const extraModels = collectExtraLlamaCppModels(env);
  // Respect the injectable hardware.modelCacheDir test override the same way
  // sizing.js's serveCtxFor/modelFactsFor do — without this, a test that
  // points hardware.modelCacheDir at a fixture root would still have
  // modelCapabilities resolve against the real env-wide cache location.
  const capsEnv = hardware.modelCacheDir ? { ...env, LLAMA_CACHE: hardware.modelCacheDir } : env;
  const mainCaps = await modelCapabilities(mainModel, capsEnv);
  const omitVlm = mainCaps.vision;
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

  const emit = (alias, name, extra = {}) => emitModelSection(lines, cachePolicy, env, hardware, profile, alias, name, extra);
  const emittedModels = new Set();
  const emitOnce = (alias, name, extra) => {
    if (emittedModels.has(name)) return;
    emittedModels.add(name);
    emit(alias, name, extra);
  };
  emitOnce(LLAMACPP_MAIN_ALIAS, mainModel);
  // A blind main model needs the bridge model as a second preset entry, with
  // its measured mmproj path so llama-server's router loads it as a vision
  // model rather than auto-discovering (or failing to discover) one itself.
  if (!omitVlm) {
    // Always its own section — never routed through emitOnce's name-based
    // dedup. That dedup exists to skip a genuinely redundant THIRD alias for
    // the extraModels loop below (see collectExtraLlamaCppModels), but the
    // bridge role's OWN alias must exist whenever `!omitVlm`, even when
    // vlmModel happens to equal mainModel — e.g. the configured main model IS
    // the curated default, its weights are cached but its mmproj hasn't
    // landed yet, so it measures blind (omitVlm false) with an identical repo
    // string. Deduping away this section left only [aperio-main] in the
    // preset while resolveDescribeModel() (mcp/tools/image.js) still routed
    // every image request to the now-nonexistent aperio-vlm alias.
    emittedModels.add(vlmModel); // still dedupe a later extraModels entry against this repo
    emit(LLAMACPP_VLM_ALIAS, vlmModel, {
      mmproj: hasCachedMmproj(vlmModel, hardware.modelCacheDir ?? resolveModelCacheDir(env)) || undefined,
      // See VLM_BRIDGE_CTX_CEILING above — the bridge role never needs (and on
      // this machine, cannot safely have) the full RAM-fit window the main
      // model gets. A model used directly as the main chat model (the omitVlm
      // branch above) is unaffected — it goes through the plain
      // `emit(LLAMACPP_MAIN_ALIAS, ...)` call above with no ceiling.
      ctxOpts: { ceiling: VLM_BRIDGE_CTX_CEILING },
    });
  }
  for (const model of extraModels) emitOnce(model, model);

  return lines.join("\n") + "\n";
}

// Renders one [alias] model section (hf-repo, ctx-size, mmproj, KV-cache-type
// overrides) into `lines`. Shared by buildModelsPreset above and
// buildVisionOnlyPreset below so the two never drift on cache-type/
// flash-attn/n-cpu-moe handling.
function emitModelSection(lines, cachePolicy, env, hardware, profile, alias, name, extra = {}) {
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
}

// WS4: a vision-only preset for on-demand boot when a cloud text-only
// provider needs the local vision bridge (ensureVisionEngine in
// startLlamaCpp.js). Just the bridge model, no main model, so a cloud
// install's first image upload starts the smallest thing that can look.
export function buildVisionOnlyPreset(env = process.env, hardware = {}) {
  const profile = resolvePerfProfile(env);
  const cachePolicy = resolveKvCachePolicy(profile);
  const vlmModel = DEFAULT_LOCAL_MODEL; // always the curated default — see buildModelsPreset's comment
  const lines = ["[*]", "jinja = true", "parallel = 1", ""];
  emitModelSection(lines, cachePolicy, env, hardware, profile, LLAMACPP_VLM_ALIAS, vlmModel, {
    mmproj: hasCachedMmproj(vlmModel, hardware.modelCacheDir ?? resolveModelCacheDir(env)) || undefined,
    ctxOpts: { ceiling: VLM_BRIDGE_CTX_CEILING },
  });
  return lines.join("\n") + "\n";
}
