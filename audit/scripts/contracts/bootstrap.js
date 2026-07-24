// audit/scripts/contracts/bootstrap.js
// A01 Bootstrap and shutdown contract gate — deterministic checks.
// Verifies:
//   1. Production entrypoint and bootstrap files exist
//   2. Composition root and shutdown exist
//   3. Boot-time helpers exist (crash breaker, .env loader, hydrate)
//   4. Companion tests exist

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

function checkBootFiles(rootDir) {
  const results = [];

  const files = [
    ["server.js", "Production entrypoint"],
    ["bootstrap.js", "First-run bootstrap"],
    ["lib/server.js", "Composition root (createApp)"],
    ["lib/server/shutdown.js", "Graceful shutdown"],
    ["lib/load-env.js", ".env loader"],
    ["lib/server/hydrateRuntime.js", "Runtime hydration"],
    ["lib/helpers/crashBreaker.js", "Crash breaker"],
    ["lib/config-resolver.js", "Boot-time config resolution"],
  ];

  for (const [relPath, label] of files) {
    const full = join(rootDir, relPath);
    results.push({
      invariant: `${label} (${relPath}) exists`,
      passed: existsSync(full),
      detail: existsSync(full) ? "Present" : "MISSING",
    });
  }

  return { results, passed: results.every(r => r.passed) };
}

function checkBootTests(rootDir) {
  const results = [];

  const testFiles = [
    "tests/e2e/bootstrap/bootstrap.test.js",
    "tests/e2e/real-app/real-app-lifecycle.test.js",
    "tests/integration/server/server.test.js",
    "tests/unit/lib/server.shutdown.test.js",
  ];

  let missing = 0;
  for (const t of testFiles) {
    const full = join(rootDir, t);
    const exists = existsSync(full);
    if (!exists) missing++;
    results.push({
      invariant: `Test file ${t} exists`,
      passed: exists,
      detail: exists ? "Present" : "MISSING",
    });
  }

  return { results, passed: missing === 0 };
}

function runBootContractGate(rootDir) {
  rootDir = resolve(rootDir || process.cwd());
  const gate = {
    $schema: "aperio-audit-bootstrap-contract-v1",
    slice_id: "A01",
    checks: {
      boot_files: checkBootFiles(rootDir),
      boot_tests: checkBootTests(rootDir),
    },
    passed: false,
  };
  gate.passed = gate.checks.boot_files.passed && gate.checks.boot_tests.passed;
  return gate;
}

const rootArg = process.argv[2];
const gate = runBootContractGate(rootArg);
process.stdout.write(JSON.stringify(gate, null, 2) + "\n");
process.exit(gate.passed ? 0 : 1);

export { runBootContractGate };
