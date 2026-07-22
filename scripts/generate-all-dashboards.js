#!/usr/bin/env node
// scripts/generate-all-dashboards.js
// Runs all four dashboard generators from existing test results / coverage data.
// Use when you've already run tests and just need to regenerate the dashboard
// data files — then refresh the browser to see updated results.
// Usage: node scripts/generate-all-dashboards.js
//   npm run dashboards

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const generators = [
  {
    name: "Coverage",
    script: "scripts/generate-coverage-dashboard.js",
    defaultInput: "coverage/lcov.info",
    description: "code coverage from LCOV data",
  },
  {
    name: "Unit",
    script: "scripts/generate-unit-dashboard.js",
    defaultInput: "tests/results/unit-results.json",
    description: "unit test results",
  },
  {
    name: "Integration",
    script: "scripts/generate-integration-dashboard.js",
    defaultInput: "tests/results/integration-results.json",
    description: "integration test results",
  },
  {
    name: "E2E",
    script: "scripts/generate-e2e-dashboard.js",
    defaultInput: "tests/results/e2e-results.json",
    description: "end-to-end test results",
  },
];

let allPassed = true;

for (const gen of generators) {
  const scriptPath = resolve(ROOT, gen.script);
  const inputPath = resolve(ROOT, gen.defaultInput);

  console.log(`\n━━━ ${gen.name} — ${gen.description} ━━━`);
  console.log(`  Input: ${gen.defaultInput}`);

  try {
    execFileSync("node", [scriptPath], {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      encoding: "utf8",
    });
    console.log(`  ✓ ${gen.name} dashboard generated`);
  } catch (err) {
    allPassed = false;
    console.error(`  ✗ ${gen.name} dashboard FAILED: ${err.message}`);
  }
}

console.log(`\n${"=".repeat(50)}`);
if (allPassed) {
  console.log("✅ All four dashboards generated successfully.");
  console.log("   Refresh the dashboards in your browser to see updated results.");
  console.log(`   Location: docs/dashboards/`);
} else {
  console.log("❌ Some dashboards failed to generate (see errors above).");
  console.log("   Common causes:");
  console.log("   • Test results file doesn't exist — run the appropriate test suite first");
  console.log("   • LCOV data missing — run `npm run test:ci` or `c8` first");
  console.log("   • Use --input to point at a custom results file");
  process.exitCode = 1;
}
