// scripts/local-bench.js
//
// Short + medium fixed-prompt benchmark against the local llama.cpp engine
// (llamacpp.md Phase 5 / issue #222). Ensures the vendored llama-server is
// running, sends two fixed prompts, and reports tok/s + a #222-style
// recommendation string. Not a full test — a quick manual sanity check to run
// after switching APERIO_LOCAL_PERF_PROFILE or hardware.
//
//   npm run local:bench
//
// All benchmarking logic lives in lib/helpers/localBench.js (pure, unit
// tested with a mocked fetch); this script only does I/O.

import { ensureLlamaCpp } from "../lib/helpers/startLlamaCpp.js";
import { resolveProvider, resolvePerfProfile } from "../lib/providers/index.js";
import { runBenchmark, formatReport } from "../lib/helpers/localBench.js";

async function main() {
  console.log("Starting/confirming the local llama.cpp engine…");
  await ensureLlamaCpp();

  const provider = resolveProvider({ name: "llamacpp" });
  const profile = resolvePerfProfile();
  // Router mode serves Aperio's stable alias, not the raw HF repo id. Keep
  // the configured model in the heading, but send requests to the alias.
  const requestModel = provider.requestModel || provider.model;
  // Read AFTER ensureLlamaCpp() — it resolves and publishes LLAMACPP_SERVE_CTX
  // when the .env doesn't pin one, so this reflects the value actually served.
  const servedCtx = process.env.LLAMACPP_SERVE_CTX ? parseInt(process.env.LLAMACPP_SERVE_CTX, 10) : null;

  console.log(`Benchmarking ${provider.model} (profile=${profile})…\n`);
  const result = await runBenchmark({
    baseURL: provider.baseURL,
    model: requestModel,
    profile,
    servedCtx,
  });

  console.log(formatReport(result));
}

main().catch((err) => {
  console.error(`\nlocal:bench failed: ${err.message}`);
  process.exit(1);
});
