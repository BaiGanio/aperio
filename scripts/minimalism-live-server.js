#!/usr/bin/env node
// Evaluator-owned llama-server bootstrap. The parent process supplies a
// temporary cwd and the dedicated port; this process owns startup and stop.
import { ensureLlamaCpp, stopLlamaCpp } from "../lib/helpers/startLlamaCpp.js";

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  try { await stopLlamaCpp(); } finally { process.exit(signal === "SIGINT" ? 130 : 0); }
}

process.on("SIGINT", () => { void stop("SIGINT"); });
process.on("SIGTERM", () => { void stop("SIGTERM"); });

try {
  await ensureLlamaCpp();
  // Keep the owner alive so the parent can tear down the exact lifecycle it
  // started. ensureLlamaCpp's server child is detached + unref'd (correct for
  // the main app, which has its own HTTP server keeping the event loop alive
  // regardless) — with nothing else pending here, a bare `await new
  // Promise(() => {})` is not a real handle, and Node exits with code 13
  // ("Unfinished Top-Level Await") as soon as that child is spawned. An
  // interval is an actual active handle.
  setInterval(() => {}, 60_000);
} catch (error) {
  console.error(error?.stack || error);
  process.exit(1);
}
