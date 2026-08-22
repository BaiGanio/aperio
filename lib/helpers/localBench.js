// lib/helpers/localBench.js
//
// Pure benchmarking logic for `npm run local:bench` (llamacpp.md Phase 5 /
// issue #222). Kept separate from scripts/local-bench.js so it unit-tests
// with a mocked fetch — no live llama-server needed. The script itself only
// does I/O: ensure the engine is running, call runBenchmark(), print
// formatReport()'s output.

import { resolvePerfProfile, recommendPerfFix } from "../providers/index.js";

const SHORT_PROMPT = "Say hello in one short sentence.";

// Exercises prompt-processing at a nontrivial size without a static text blob
// checked into the repo — repeats a filler sentence to roughly the target
// word count. Word count, not an exact token count: llama.cpp's own tokenizer
// isn't loaded here, and an exact size isn't the point — revealing context-
// scaling behavior at "medium" size is.
export function buildMediumPrompt(targetWords = 600) {
  const filler = "The quick brown fox jumps over the lazy dog near the riverbank at dawn. ";
  const words = filler.trim().split(/\s+/).length;
  const repeats = Math.ceil(targetWords / words);
  return filler.repeat(repeats).trim() + " Summarize the above in one sentence.";
}

// Wall-clock time minus what the server's own `timings` block accounts for.
// llama-server's router mode lazy-loads model weights on the first real
// request (confirmed live in the Phase 0/1 spikes: /health goes green before
// any model loads), so the first request's wall time includes a one-time load
// cost that prompt_ms/predicted_ms don't report. Never negative — a warm
// request where the server accounted for ~all the wall time correctly should
// read ~0, not a small negative number from timer jitter.
export function computeLoadMs(wallMs, timings) {
  const accounted = (timings?.prompt_ms ?? 0) + (timings?.predicted_ms ?? 0);
  return Math.max(0, Math.round(wallMs - accounted));
}

async function timedRequest(fetchImpl, baseURL, model, prompt, maxTokens) {
  const start = performance.now();
  const res = await fetchImpl(`${baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, stream: false }),
  });
  const wallMs = performance.now() - start;
  if (!res.ok) throw new Error(`llama-server returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { wallMs, usage: data.usage ?? null, timings: data.timings ?? null };
}

// Runs the fixed short + medium prompts against a live (already-running)
// llama-server and returns a structured result. `fetchImpl` is injectable so
// tests never touch the network. The first (short-prompt) request is treated
// as the cold one for load-time purposes — a real setup only pays that cost
// once per boot, so re-measuring it with the same prompt as `short` below
// would double-count it as "slow generation" rather than "one-time load".
export async function runBenchmark({ fetchImpl = fetch, baseURL, model, profile = resolvePerfProfile(), servedCtx = null } = {}) {
  if (!baseURL) throw new Error("runBenchmark requires baseURL");
  if (!model) throw new Error("runBenchmark requires model");

  const cold = await timedRequest(fetchImpl, baseURL, model, SHORT_PROMPT, 32);
  const loadMs = computeLoadMs(cold.wallMs, cold.timings);

  const short = await timedRequest(fetchImpl, baseURL, model, SHORT_PROMPT, 64);
  const medium = await timedRequest(fetchImpl, baseURL, model, buildMediumPrompt(), 128);

  const genTps = medium.timings?.predicted_per_second ?? short.timings?.predicted_per_second ?? null;
  const recommendation = recommendPerfFix({ genTps, profile, servedCtx });

  return { model, profile, servedCtx, loadMs, short, medium, genTps, recommendation };
}

// Human-readable report — the CLI script's actual console output, factored
// out so tests can assert on its shape without capturing stdout.
export function formatReport(result) {
  const { model, profile, servedCtx, loadMs, short, medium, genTps, recommendation } = result;
  const fmtTps = (t) => (typeof t === "number" ? t.toFixed(1) : "?");
  return [
    "llama.cpp local benchmark",
    `  model:          ${model}`,
    `  profile:        ${profile}`,
    `  ctx (served):   ${servedCtx ?? "unknown"}`,
    `  load overhead:  ${loadMs} ms (first-request cost above prompt/gen processing)`,
    `  short prompt:   ${short.usage?.prompt_tokens ?? "?"} in / ${short.usage?.completion_tokens ?? "?"} out`
      + ` — ${fmtTps(short.timings?.prompt_per_second)} prompt tok/s, ${fmtTps(short.timings?.predicted_per_second)} gen tok/s`,
    `  medium prompt:  ${medium.usage?.prompt_tokens ?? "?"} in / ${medium.usage?.completion_tokens ?? "?"} out`
      + ` — ${fmtTps(medium.timings?.prompt_per_second)} prompt tok/s, ${fmtTps(medium.timings?.predicted_per_second)} gen tok/s`,
    `  gen tok/s:      ${fmtTps(genTps)}`,
    `  recommendation: ${recommendation ?? "no timings reported by the server — recommendation unavailable"}`,
  ].join("\n");
}
