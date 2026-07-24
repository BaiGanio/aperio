// lib/helpers/llamacpp/vlm.js — main-model/VLM-bridge RAM-fit and preset-mode decisions.

import os from "os";
import { resolvePerfProfile, resolveKvCachePolicy, residentFootprintGB, RAM_FIT_DEFAULTS } from "../../providers/index.js";
import { isVisionModel } from "../imageBridge.js";
import { serveCtxFor, modelFactsFor } from "./sizing.js";

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
export const VLM_BRIDGE_CTX_CEILING = 24576;

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
