// lib/helpers/modelPreload.js
//
// Boot-time main-model preload + app-wide model_status bus.
//
// llama-server's router loads a model lazily, on the first request that names
// it — so on a cold cache the user's FIRST MESSAGE used to pay the whole
// download+load (minutes of it), with progress visible only inside that
// request's thinking indicator. This module moves that cost to server boot:
//
//   • preloadMainModel() fires the existing prompt-cache warm-up (WS2) right
//     after llama-server is up, which makes the router download+load the main
//     model — and prefill the real system prompt — before anyone types.
//   • While that runs, a modelProgress watcher publishes model_status events
//     on a process-wide bus instead of a single session's socket. wsHandler
//     subscribes every connection to the bus and replays the latest status on
//     connect, so a browser opened mid-download immediately shows the
//     "downloading X — N of M GB" banner rather than a ready-looking chat.
//
// The per-request watcher in providers/llamacpp.js stays: it covers loads
// triggered later in a session (VLM bridge first use, router swap-mode).
import { EventEmitter } from "events";
import { isModelLoaded, startModelProgressWatcher, downloadInProgressBytes } from "./modelProgress.js";
import { resolveModelCacheDir } from "./modelCache.js";
import logger from "./logger.js";

const RETRY_DELAY_MS   = 5000;
const DEFAULT_MAX_MS   = 2 * 60 * 60 * 1000; // give a slow line 2 h before giving up

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open websocket — unbounded by design

let lastStatus = null; // latest non-ready model_status payload; null when idle

/**
 * Subscribe to app-wide model_status events. Returns an unsubscribe function —
 * callers (one per websocket) MUST call it on socket close.
 */
export function onModelStatus(fn) {
  bus.on("status", fn);
  return () => bus.off("status", fn);
}

/**
 * The latest in-flight model_status payload, or null when no boot preload is
 * active. New connections replay this so a mid-download page load starts with
 * the banner already correct.
 */
export function currentModelStatus() {
  return lastStatus;
}

/**
 * Ensure the main model is resident, downloading it now if needed, and keep
 * the bus fed with progress while that happens. `warm` is the actual load
 * trigger — agent.warmCache with force, so the request that pulls the weights
 * is the same one that prefills the stable system-prompt prefix (WS2).
 *
 * warmCache never throws and the provider fetch has its own timeout
 * (LLAMACPP_FETCH_TIMEOUT_MS, default 5 min) — a download longer than that
 * times the warm request out while llama-server keeps downloading server-side.
 * Hence the loop: re-check residency after each warm attempt and keep waiting
 * as long as bytes are still arriving in the cache.
 *
 * Fire-and-forget from boot; resolves "loaded" | "already-loaded" | "failed" |
 * "timeout" (returned for tests/logging, ignored by the boot caller).
 */
export async function preloadMainModel({ model, routerModelId, baseURL, cacheRoot = resolveModelCacheDir(), warm, maxMs = DEFAULT_MAX_MS, retryDelayMs = RETRY_DELAY_MS },
  _deps = { isModelLoaded, startModelProgressWatcher, downloadInProgressBytes }) {
  if (await _deps.isModelLoaded(routerModelId, baseURL)) return "already-loaded";
  const emitter = {
    send(payload) {
      lastStatus = payload.status === "ready" ? null : payload;
      bus.emit("status", payload);
    },
  };
  const stop = _deps.startModelProgressWatcher({ model, routerModelId, emitter, routerBaseURL: baseURL, cacheRoot });
  try {
    logger.info(`[modelPreload] ensuring ${model} is loaded before first message…`);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await warm();
      if (await _deps.isModelLoaded(routerModelId, baseURL)) {
        logger.info(`[modelPreload] ${model} resident and prompt cache warmed`);
        return "loaded";
      }
      // Bytes still landing in the cache ⇒ the warm request merely timed out
      // under a long download — wait and warm again. No bytes and not loaded
      // ⇒ the load actually failed (or the server is gone); stop retrying so
      // a broken engine doesn't get hammered forever.
      if (_deps.downloadInProgressBytes(model, cacheRoot) === 0) {
        logger.warn(`[modelPreload] ${model} did not load and no download is running — giving up (first message will retry the load)`);
        return "failed";
      }
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
    logger.warn(`[modelPreload] ${model} still not loaded after ${Math.round(maxMs / 60000)} min — giving up`);
    return "timeout";
  } finally {
    stop();
    lastStatus = null;
  }
}
