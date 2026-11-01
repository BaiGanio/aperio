// lib/providers/model-capabilities.js — measure a model's vision and
// tool-calling capability from the model itself, instead of matching its name
// against a hand-kept list.
//
// Local (llama.cpp) models: a GGUF repo can see images iff its cache snapshot
// holds a companion mmproj*.gguf vision projector, and can accept tool calls
// iff its own chat template renders a tools block. Cloud vision is normally a
// provider-API fact; DeepSeek is a provider-level blind (its standard API
// models — flash and pro — are text-only and 400 on image content, and it
// exposes no capability-discovery endpoint to check for anything else).
//
// Two entry points:
//   modelCapabilitiesSync — cache/provider only, never touches the network.
//     Safe to call on every turn (agent/index.js, the llamacpp provider loop,
//     tool-profiles.js). Returns source:"unknown" (blind, safe default) for a
//     local model that hasn't been resolved yet.
//   modelCapabilities     — the full resolution, including one bounded HF Hub
//     lookup for a repo not yet in the local cache. Only ever called at
//     boot/preset-build time (buildModelsPreset, ensureLlamaCpp,
//     ensureVisionEngine) — ADR resolved in #509/W1.2: firing here only
//     duplicates the exposure of the multi-GB weights download about to
//     happen for the same repo anyway, and populates the shared cache so
//     every mid-turn call afterwards is the synchronous, network-free path.
import logger from "../helpers/logger.js";
import { resolveModelCacheDir } from "../helpers/modelCache.js";
import { findCachedGguf, hasCachedMmproj, hasToolCallingTemplate } from "../helpers/ggufModelFacts.js";

// Provider-API facts shared by every model exposed through that provider.
// codex/claude-code pass image content through as of
// provider-native-capabilities (2026-07-24). DeepSeek is resolved separately
// below because its API exposes one explicitly named vision model alongside
// text-only models and no capability-discovery endpoint.
const PROVIDER_VISION = Object.freeze({
  anthropic: true,
  gemini: true,
  codex: true,
  "claude-code": true,
  deepseek: false,
});

const HUB_FETCH_TIMEOUT_MS = 3000;
const MMPROJ_ENTRY_RE = /^mmproj.*\.gguf$/i;

const capabilitiesCache = new Map();

function providerCapabilities(provider) {
  const name = String(provider).toLowerCase();
  return { vision: PROVIDER_VISION[name] ?? false, tools: true, source: "provider" };
}

function cacheOnlyCapabilities(model, env) {
  if (!model) return { vision: false, tools: true, source: "unknown" };
  const cacheRoot = resolveModelCacheDir(env);
  const cacheKey = `${cacheRoot}\0${String(model)}`;
  const existing = capabilitiesCache.get(cacheKey);
  // Fully settled — never re-probed — only once BOTH fields were measured
  // from the real weights file: that requires source:"cache" (disk-derived),
  // not merely vision:true. A "hub" result (the Hub API's file-tree listing,
  // matched before download) can say vision:true just from seeing an
  // mmproj*.gguf filename listed upstream, but its tools:true is always a
  // permissive, unmeasured guess (see hubVisionLookup/modelCapabilities
  // below) — re-deriving BOTH fields from the real GGUF once it lands is what
  // actually measures tools for such a model, e.g. a vision model whose real
  // chat template turns out not to render a tools block. A disk-derived
  // ("cache") vision:false is ALSO not settled the same way: llama.cpp's -hf
  // downloader fetches a repo's main GGUF and its mmproj companion
  // independently, so "weights are cached, no projector yet" is a snapshot,
  // not a fact — keep re-checking disk (a cheap directory listing) on every
  // call until the projector actually lands or the repo turns out to have
  // none. Without this, a model whose vision download finishes moments after
  // this snapshot stays wrongly blind (routed to a preset alias that no
  // longer matches what the router actually serves) for the rest of the
  // process lifetime.
  if (existing && existing.source === "cache" && existing.vision) return { cacheKey, cached: existing };

  const weightsPath = findCachedGguf(model, cacheRoot);
  if (!weightsPath) return { cacheKey, cached: existing ?? null };
  const vision = !!hasCachedMmproj(model, cacheRoot);
  // Reuse a prior disk-derived "tools" value rather than reparsing the GGUF
  // header on every call while vision stays false — but only when it was
  // ACTUALLY measured against this file (source:"cache"); a "hub" guess's
  // tools:true was never real, so it still needs a genuine first read.
  const tools = existing?.source === "cache" ? existing.tools : hasToolCallingTemplate(weightsPath);
  const result = Object.freeze({ vision, tools, source: "cache" });
  capabilitiesCache.set(cacheKey, result);
  return { cacheKey, cached: result };
}

/**
 * Cache/provider-only capability lookup — never touches the network. Use this
 * from any per-turn call site. Returns a blind, safe-default
 * `{ vision: false, tools: true, source: "unknown" }` for a local model not
 * yet resolved (never downloaded, or downloaded after this process's cache
 * warmed) — the bridge is the safe fallback for vision; tools default open
 * per hasToolCallingTemplate's own permissive default.
 *
 * @param {string} model
 * @param {object} [env]
 * @param {{ provider?: string }} [opts] - pass provider name for a cloud model
 */
export function modelCapabilitiesSync(model, env = process.env, { provider } = {}) {
  if (provider) return providerCapabilities(provider);
  const { cached } = cacheOnlyCapabilities(model, env);
  return cached ?? { vision: false, tools: true, source: "unknown" };
}

async function hubVisionLookup(repo) {
  try {
    const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`, {
      signal: AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false };
    const entries = await r.json();
    const vision = Array.isArray(entries) && entries.some(e => MMPROJ_ENTRY_RE.test(e?.path ?? e?.rfilename ?? ""));
    return { ok: true, vision };
  } catch (err) {
    logger.warn(`[providers] model-capabilities: HF tree lookup failed for "${repo}" — assuming no vision until it downloads. ${err.message}`);
    return { ok: false };
  }
}

/**
 * Full capability resolution: cache, then (only for a repo not yet cached)
 * one bounded HF Hub lookup. Boot/preset-build call sites only — see header.
 *
 * @param {string} model
 * @param {object} [env]
 * @param {{ provider?: string }} [opts] - pass provider name for a cloud model
 * @returns {Promise<{ vision: boolean, tools: boolean, source: "provider"|"cache"|"hub"|"unknown" }>}
 */
export async function modelCapabilities(model, env = process.env, { provider } = {}) {
  if (provider) return providerCapabilities(provider);
  if (!model) return { vision: false, tools: true, source: "unknown" };

  const { cacheKey, cached } = cacheOnlyCapabilities(model, env);
  if (cached) return cached;

  const repo = String(model).split(":")[0];
  if (!repo.includes("/")) {
    const result = { vision: false, tools: true, source: "unknown" };
    return result; // alias, not a repo — never cached, never worth a Hub call
  }
  const { ok, vision } = await hubVisionLookup(repo);
  const result = Object.freeze(
    ok ? { vision, tools: true, source: "hub" } : { vision: false, tools: true, source: "unknown" },
  );
  if (ok) capabilitiesCache.set(cacheKey, result); // don't pin a transient failure
  return result;
}
