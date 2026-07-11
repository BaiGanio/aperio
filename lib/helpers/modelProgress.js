// lib/helpers/modelProgress.js
//
// Download/load progress watcher for llama.cpp router-mode model swaps.
//
// llama-server loads models lazily on the first /v1/chat/completions request
// that names them — and for an -hf model that isn't cached yet, that first
// request ALSO downloads the weights (an 8–17 GB pull for the bigger models).
// From the app's side all of that hides inside one long-pending fetch, so the
// user stares at a whimsy word for minutes with no clue a download is running.
//
// This watcher makes those minutes legible: while a llamacpp request is in
// flight it polls two ground-truth sources and emits `model_status` events the
// web UI turns into a staged label on the live thinking indicator:
//
//   • the model's HF cache dir — a `blobs/*.downloadInProgress` file growing
//     is an active download; its size is the bytes fetched so far
//   • the router's /models endpoint — reports the per-model status the router
//     itself tracks ("loaded" ⇒ resident, anything else mid-request ⇒ the
//     worker is still spawning/loading weights)
//
// Events (deduped — one per stage/GB change):
//   { type: "model_status", model, status: "downloading", gotGB, totalGB? }
//   { type: "model_status", model, status: "loading" }
//   { type: "model_status", model, status: "ready" }   ← only after a stage fired
//
// A grace period keeps warm-model requests silent: if the first token would
// arrive within ~2 s the watcher never emits anything, so the staged labels
// appear only when there is a real wait to explain.
import { readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { factsForHf } from "../providers/index.js";
import { resolveModelCacheDir } from "./modelCache.js";

const POLL_MS          = 1000;
const LOADING_GRACE_MS = 2000;
const STATUS_TIMEOUT   = 1000;
const GIB = 1024 ** 3;

// "unsloth/Qwen3.6-27B-GGUF:Q4_K_M" → "models--unsloth--Qwen3.6-27B-GGUF"
// (the HF cache dir llama-server downloads into). Returns null for ids that
// aren't hf repo paths (e.g. a bare local GGUF alias) — no dir to watch.
export function cacheDirNameFor(modelId) {
  const repo = String(modelId || "").split(":")[0];
  if (!repo.includes("/")) return null;
  return "models--" + repo.replaceAll("/", "--");
}

// Bytes of any in-flight download for `modelId`: the sum of the cache dir's
// blobs/*.downloadInProgress sizes. 0 when nothing is downloading (including
// "dir doesn't exist yet" — the blob appears within the first poll anyway).
export function downloadInProgressBytes(modelId, cacheRoot = resolveModelCacheDir()) {
  const dirName = cacheDirNameFor(modelId);
  if (!dirName) return 0;
  const blobsDir = join(resolve(cacheRoot), dirName, "blobs");
  try {
    let bytes = 0;
    for (const f of readdirSync(blobsDir)) {
      if (!f.endsWith(".downloadInProgress")) continue;
      try { bytes += statSync(join(blobsDir, f)).size; } catch { /* race: finalised mid-scan */ }
    }
    return bytes;
  } catch { return 0; }
}

// The router's own status for one model — the /models (router, not /v1)
// endpoint reports `status.value` per model ("loaded", "unloaded", …).
// Returns null when the router can't be asked (down, busy, timeout).
async function routerModelStatus(modelId, routerBaseURL) {
  try {
    const r = await fetch(`${routerBaseURL}/models`, { signal: AbortSignal.timeout(STATUS_TIMEOUT) });
    if (!r.ok) return null;
    const data = await r.json();
    return (data?.data ?? []).find(m => m.id === modelId)?.status?.value ?? null;
  } catch { return null; }
}

/**
 * Start watching `model` while a request is in flight, emitting `model_status`
 * events on `emitter`. Returns a stop() — call it once the request resolves
 * (or fails); it cancels polling and, if any stage was shown, emits a final
 * "ready" so the UI can fall back to its normal thinking label.
 *
 * `_status` is injectable for tests (default: the real router probe), as are
 * `pollMs`/`graceMs` (tests shrink them; production callers omit them).
 */
export function startModelProgressWatcher({ model, emitter, routerBaseURL, cacheRoot, pollMs = POLL_MS, graceMs = LOADING_GRACE_MS }, _status = routerModelStatus) {
  const totalGB = factsForHf(model)?.sizeGB ?? null;
  const started = Date.now();
  let stopped   = false;
  let sawStage  = false;
  let lastSig   = null;
  let timer     = null;

  const emit = (payload) => {
    const sig = JSON.stringify(payload);
    if (sig === lastSig) return; // dedupe — also keeps stop() from re-sending "ready"
    lastSig = sig;
    if (payload.status !== "ready") sawStage = true;
    try { emitter.send({ type: "model_status", model, ...payload }); } catch { /* socket gone */ }
  };

  const tick = async () => {
    if (stopped) return;
    const bytes = downloadInProgressBytes(model, cacheRoot);
    if (bytes > 0) {
      const gotGB = Math.round((bytes / GIB) * 10) / 10;
      emit(totalGB ? { status: "downloading", gotGB, totalGB } : { status: "downloading", gotGB });
    } else {
      const status = await _status(model, routerBaseURL);
      if (stopped) return; // request resolved while we awaited the probe
      if (status === "loaded") {
        // Resident — either it was warm all along (no stage shown, stay silent)
        // or a download/load just finished (flip the label back).
        if (sawStage) emit({ status: "ready" });
        stopped = true;
        return;
      }
      // Not resident and not downloading ⇒ the worker is loading weights.
      // The grace period keeps fast warm-ups from flashing a label.
      if (Date.now() - started > graceMs) emit({ status: "loading" });
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };
  timer = setTimeout(tick, pollMs);

  return function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (sawStage) emit({ status: "ready" });
  };
}
