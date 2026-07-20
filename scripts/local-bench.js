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

import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

// A standalone script, not the server.js entrypoint — .env isn't loaded by
// anything else in the process. Modules like startLlamaCpp.js read env vars
// (LLAMACPP_PORT, etc.) at module-load time, so dotenv must run before they're
// imported — a *static* import here would be hoisted ahead of this call
// regardless of source order, so the local helpers are loaded dynamically
// after config() instead.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) dotenv.config({ path: envPath });

async function main() {
  const { ensureLlamaCpp } = await import("../lib/helpers/startLlamaCpp.js");
  const { resolveProvider, resolvePerfProfile } = await import("../lib/providers/index.js");
  const { runBenchmark, formatReport } = await import("../lib/helpers/localBench.js");

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
    // runBenchmark appends /v1/chat/completions itself — provider.baseURL
    // already carries the /v1 suffix agent providers expect (an SDK client
    // base), which doubled up into a 404. llamacppBaseURL is the bare origin.
    baseURL: provider.llamacppBaseURL,
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
