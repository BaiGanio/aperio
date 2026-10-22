// lib/helpers/extractorPool.js
// Runs an indexer's extraction step on a worker thread.
//
// Why: extraction is pure CPU over a string or a Buffer — a tree-sitter parse
// plus a full tree traversal for code, a document parse for docs. It cannot be
// sliced: `parser.parse(source)` is one atomic WASM call, measured at ~204 ms
// for an 0.8 MB single-line file and growing linearly with size. While it runs
// the main thread answers nothing (issue S2.1). A worker thread removes that
// time from the request path entirely and needs no yield points.
//
// Design notes:
//   • One worker per pool, not a pool of N. Extraction is already serialized
//     per file by the indexer's `for await` loop, and the code extractor shares
//     one tree-sitter parser per grammar whose documented invariant is that no
//     two extractions interleave on it. A worker processes one message at a
//     time, so that invariant survives the move unchanged.
//   • The worker owns a closed registry of extractor keys. The main thread
//     sends a key, never a module path — nothing here can be talked into
//     importing an arbitrary file.
//   • Every failure mode degrades to in-process extraction rather than losing
//     a file: the caller gets `{ fallback: true }` and runs the original
//     function itself. An error *from* the extractor is not a fallback — the
//     file is genuinely unparseable and retrying on the main thread would only
//     burn the time twice.
//   • The worker is spawned on first use and terminated after an idle period,
//     so an install that never indexes anything never pays for a thread. It is
//     `unref`'d while idle so it cannot hold the process open (idle shutdown,
//     CLI one-shots), and `ref`'d while work is in flight so the process cannot
//     exit from under an extraction.

import { Worker } from 'node:worker_threads';
import logger, { logError } from './logger.js';

// Terminate an idle worker after this long. Long enough to span a watcher's
// debounce and a burst of saves, short enough that a one-shot index does not
// leave a thread parked for the life of the process.
export const IDLE_TERMINATE_MS = 30_000;

// After this many consecutive spawn/crash failures, stop trying and extract
// in-process forever. Without a ceiling a platform where worker threads do not
// work would respawn once per file.
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * @param {object} opts
 * @param {URL|string} opts.workerUrl  module to run as the worker
 * @param {string} opts.label          log prefix, e.g. 'codegraph'
 * @param {number} [opts.idleMs]
 * @param {typeof Worker} [opts.WorkerImpl] injectable for tests
 */
export function createExtractorPool({
  workerUrl,
  label,
  idleMs = IDLE_TERMINATE_MS,
  WorkerImpl = Worker,
} = {}) {
  let worker = null;
  let idleTimer = null;
  let seq = 0;
  let failures = 0;
  let disabled = false;
  let warnedDisabled = false;
  const inflight = new Map(); // id → { resolve }

  function clearIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (!worker || inflight.size) return;
    // The timer itself must not hold the loop open either.
    idleTimer = setTimeout(() => { idleTimer = null; terminate(); }, idleMs);
    idleTimer.unref?.();
  }

  function terminate() {
    clearIdleTimer();
    const w = worker;
    worker = null;
    if (!w) return;
    // Anything still in flight when we tear down falls back rather than hangs.
    settleAll({ fallback: true, reason: 'worker terminated' });
    w.terminate().catch(() => {});
  }

  function settleAll(outcome) {
    for (const { resolve } of inflight.values()) resolve(outcome);
    inflight.clear();
  }

  function onExit(code) {
    // Reaching here with work in flight means the worker died mid-extraction:
    // an OOM in the WASM heap, a hard crash. Count it, drop the handle, and let
    // the callers fall back. The next call respawns unless the ceiling is hit.
    const lost = inflight.size;
    worker = null;
    clearIdleTimer();
    if (lost) {
      failures++;
      logger.warn(`[${label}] extraction worker exited (code ${code}) with ${lost} in flight — extracting in-process`);
      settleAll({ fallback: true, reason: `worker exit ${code}` });
      if (failures >= MAX_CONSECUTIVE_FAILURES) disable('repeated worker crashes');
    }
  }

  function disable(reason) {
    disabled = true;
    if (!warnedDisabled) {
      warnedDisabled = true;
      logger.warn(`[${label}] extraction worker disabled (${reason}) — indexing will extract on the main thread`);
    }
  }

  function ensureWorker() {
    if (worker || disabled) return worker;
    try {
      const w = new WorkerImpl(workerUrl);
      w.on('message', (msg) => {
        const entry = inflight.get(msg?.id);
        if (!entry) return;
        inflight.delete(msg.id);
        if (!inflight.size) { w.unref?.(); armIdleTimer(); }
        failures = 0;
        entry.resolve(msg.ok
          ? { ok: true, result: msg.result }
          : { ok: false, error: msg.error });
      });
      w.on('error', (err) => {
        logError(`[${label}] extraction worker error`, err);
        failures++;
        worker = null;
        settleAll({ fallback: true, reason: err.message });
        if (failures >= MAX_CONSECUTIVE_FAILURES) disable('repeated worker errors');
        w.terminate().catch(() => {});
      });
      w.on('exit', onExit);
      worker = w;
      logger.info(`[${label}] extraction worker started`);
    } catch (err) {
      failures++;
      logError(`[${label}] extraction worker failed to start`, err);
      if (failures >= MAX_CONSECUTIVE_FAILURES) disable('worker threads unavailable');
      return null;
    }
    return worker;
  }

  return {
    /**
     * Extract on the worker.
     * @returns {Promise<{ok:true,result:any}|{ok:false,error:{message:string,code?:string}}|{fallback:true,reason:string}>}
     *   `fallback` means "the worker could not do this" — run the in-process
     *   extractor. `ok:false` means the extractor itself threw; do not retry.
     */
    async run(key, source, relPath) {
      if (disabled) return { fallback: true, reason: 'disabled' };
      const w = ensureWorker();
      if (!w) return { fallback: true, reason: 'no worker' };

      const id = ++seq;
      clearIdleTimer();
      w.ref?.();
      const answer = new Promise((resolve) => { inflight.set(id, { resolve }); });
      try {
        w.postMessage({ id, key, source, relPath });
      } catch (err) {
        // A payload structured-clone can fail. Not the worker's fault and not
        // worth killing it over — this one file goes in-process.
        inflight.delete(id);
        if (!inflight.size) { w.unref?.(); armIdleTimer(); }
        return { fallback: true, reason: `postMessage: ${err.message}` };
      }
      return answer;
    },

    /** Terminate now. Idempotent. Called on shutdown. */
    shutdown() { terminate(); },

    /** Diagnostics / tests. */
    get started() { return worker !== null; },
    get disabled() { return disabled; },
  };
}

/**
 * Wrap an in-process extractor so it runs on `pool` and silently falls back.
 * The returned function keeps the extractor's own `(source, relPath)` contract,
 * which is what lets the indexers swap it in without the backends changing.
 *
 * @param {object} pool      from createExtractorPool
 * @param {string} key       registry key the worker understands
 * @param {Function} inProcess  the original extractor
 */
export function viaWorker(pool, key, inProcess) {
  return async function extractViaWorker(source, relPath) {
    const outcome = await pool.run(key, source, relPath);
    if (outcome.ok) return outcome.result;
    if (outcome.fallback) return inProcess(source, relPath);
    // The extractor ran and threw. Rebuild a real Error for the caller's
    // per-file try/catch, which logs it and counts the file as skipped.
    const err = new Error(outcome.error?.message || 'extraction failed');
    if (outcome.error?.code) err.code = outcome.error.code;
    throw err;
  };
}
