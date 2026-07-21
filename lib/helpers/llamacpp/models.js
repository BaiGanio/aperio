// lib/helpers/llamacpp/models.js — running-server model introspection + offline-start eligibility.

import { basename } from "path";
import { findCachedGguf } from "../ggufModelFacts.js";
import { LLAMACPP_BASE_URL } from "./constants.js";

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

// Fetch the running server's model list. Returns null on any failure.
export async function fetchServerModels() {
  try {
    const r = await fetch(`${LLAMACPP_BASE_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const data = await r.json();
    return (data?.data ?? []).map(m => m.id);
  } catch { return null; }
}

// The models the current preset defines: section headers minus the global
// [*] entry, each appearing as "[model-id]\n".
export function presetsModels(preset) {
  const re = /^\[([^\]]+)\]/gm;
  const models = [];
  let m;
  while ((m = re.exec(preset)) !== null) {
    if (m[1] !== "*") models.push(m[1]);
  }
  return models;
}

// A worker may expose either its stable section alias or its underlying
// hf-repo in `ps` (and frequently has both flags). Both identify a model owned
// by this preset and are therefore safe to stop during an Aperio restart.
export function presetModelIds(preset) {
  const ids = new Set(presetsModels(preset));
  for (const match of preset.matchAll(/^hf-repo\s*=\s*(\S+)/gm)) ids.add(match[1]);
  return ids;
}

// Decide whether llama-server can start with --offline (forces cache use, no
// network). llama-server revalidates every -hf repo against Hugging Face on
// model load; when the upstream repo has a new commit this silently re-pulls
// multi-GB weights the user already had — mid-first-message, with no warning
// (observed live: unsloth re-uploaded gemma-4-E4B and the first chat message
// re-downloaded 3.9 GB). Offline resolution scans the exact same cache layout
// findCachedGguf reads (refs/main → snapshots/<rev>/, quant matched in the
// filename case-insensitively — verified against llama.cpp b9950), so "every
// hf-repo in the preset resolves from cache" is precisely the condition under
// which --offline cannot break a load. Anything missing → stay online so the
// first-load download still works. LLAMACPP_CHECK_UPDATES=on opts back into
// revalidation (i.e. pulling upstream re-uploads) for every start.
export function shouldStartOffline(preset, cacheRoot, env = process.env) {
  if ((env.LLAMACPP_CHECK_UPDATES || "").toLowerCase() === "on") return false;
  const repos = [...preset.matchAll(/^hf-repo\s*=\s*(\S+)/gm)].map(m => m[1]);
  return repos.length > 0 && repos.every(repo => {
    const path = findCachedGguf(repo, cacheRoot);
    if (!path) return false;
    // findCachedGguf falls back to the largest cached GGUF when the requested
    // quant tag matches nothing — right for RAM sizing, wrong here: llama.cpp's
    // offline resolver (find_best_model) requires the tag in the filename
    // followed by "." or "-", case-insensitive, and fails the load otherwise
    // (e.g. the user switched :Q4_K_M → :Q8_0 on an already-cached repo).
    // Mirror the strict rule so offline never blocks a resolvable download.
    const quant = String(repo).split(":")[1];
    return !quant || new RegExp(`${quant}[.-]`, "i").test(basename(path));
  });
}
