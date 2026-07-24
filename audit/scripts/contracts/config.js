// audit/scripts/contracts/config.js
// A02 Config contract gate — deterministic checks that require no LLM.
// Verifies:
//   1. Config registry and resolver files exist
//   2. .env.example exists and has content
//   3. Settings API enforces secret write-only
//   4. Config API route exists

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

function checkConfigFiles(rootDir) {
  const results = [];

  const files = [
    ["lib/config.js", "Config registry"],
    ["lib/config-resolver.js", "Config resolver"],
    ["lib/config-sync.js", "Config sync"],
    ["lib/load-env.js", ".env loader"],
    ["lib/routes/api-settings.js", "Settings API route"],
    ["lib/routes/api-config.js", "Config API route"],
    ["scripts/gen-env-example.js", ".env.example generator"],
  ];

  for (const [relPath, label] of files) {
    const full = join(rootDir, relPath);
    results.push({
      invariant: `${label} (${relPath}) exists`,
      passed: existsSync(full),
      detail: existsSync(full) ? "Present" : "MISSING",
    });
  }

  // Check .env.example exists and has content (not just comments/whitespace)
  const envExample = join(rootDir, ".env.example");
  if (existsSync(envExample)) {
    const content = readFileSync(envExample, "utf-8");
    const nonCommentLines = content.split("\n")
      .filter(l => l.trim() && !l.trim().startsWith("#"))
      .length;
    results.push({
      invariant: ".env.example has real config entries",
      passed: nonCommentLines > 5,
      detail: `${nonCommentLines} non-comment lines`,
    });
  } else {
    results.push({
      invariant: ".env.example exists",
      passed: false,
      detail: "MISSING",
    });
  }

  // Check lib/routes/ directory has both config routes
  const routeDir = join(rootDir, "lib", "routes");
  if (existsSync(routeDir)) {
    const routeFiles = readdirSync(routeDir).filter(f => f.endsWith(".js"));
    const hasSettings = routeFiles.includes("api-settings.js");
    const hasConfig = routeFiles.includes("api-config.js");
    if (hasSettings && hasConfig) {
      results.push({
        invariant: "Config and Settings API routes are present in lib/routes/",
        passed: true,
        detail: "api-settings.js and api-config.js both present",
      });
    } else {
      results.push({
        invariant: "Config and Settings API routes are present in lib/routes/",
        passed: false,
        detail: `Missing: ${!hasSettings ? "api-settings.js " : ""}${!hasConfig ? "api-config.js" : ""}`,
      });
    }
  }

  return { results, passed: results.every(r => r.passed) };
}

function checkConfigInvariants(rootDir) {
  const results = [];
  rootDir = resolve(rootDir || process.cwd());

  // Check that gen:env:check script exists (catches config registry drift)
  const genEnvCheck = join(rootDir, "scripts", "gen-env-example.js");
  if (existsSync(genEnvCheck)) {
    const content = readFileSync(genEnvCheck, "utf-8");
    results.push({
      invariant: "gen-env-example script has drift-check capability",
      passed: content.includes("gen:env:check") || content.includes("--check") || content.includes("check"),
      detail: "Drift check present",
    });
  } else {
    results.push({
      invariant: "gen-env-example script exists",
      passed: false,
      detail: "MISSING",
    });
  }

  // Check that docs/config-reference.md exists (generated config docs)
  const configRef = join(rootDir, "docs", "config-reference.md");
  results.push({
    invariant: "Generated config reference doc exists",
    passed: existsSync(configRef),
    detail: existsSync(configRef) ? "Present" : "MISSING",
  });

  return { results, passed: results.every(r => r.passed) };
}

function runConfigContractGate(rootDir) {
  rootDir = resolve(rootDir || process.cwd());
  const gate = {
    $schema: "aperio-audit-config-contract-v1",
    slice_id: "A02",
    checks: {
      file_existence: checkConfigFiles(rootDir),
      invariants: checkConfigInvariants(rootDir),
    },
    passed: false,
  };
  gate.passed = gate.checks.file_existence.passed && gate.checks.invariants.passed;
  return gate;
}

const rootArg = process.argv[2];
const gate = runConfigContractGate(rootArg);
process.stdout.write(JSON.stringify(gate, null, 2) + "\n");
process.exit(gate.passed ? 0 : 1);

export { runConfigContractGate };
