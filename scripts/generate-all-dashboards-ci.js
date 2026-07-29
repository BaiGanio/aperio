#!/usr/bin/env node
// scripts/generate-all-dashboards-ci.js
// Mirrors the exact CI pipeline from .github/workflows/ci.codecov.yml locally.
// Runs unit + integration, E2E, and browser tests, then generates all six
// dashboards using the same input paths that CI uses.
// Use this to verify locally that CI will produce the right dashboard data.
// Usage: node scripts/generate-all-dashboards-ci.js
//   npm run dashboards-ci

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const SEP = `${"=".repeat(56)}`;

let failures = [];

function step(label, cmd, args, opts = {}) {
  console.log(`\n${SEP}`);
  console.log(`${CYAN}▶ ${label}${RESET}`);
  console.log(`${YELLOW}  $ ${cmd} ${args.join(" ")}${RESET}`);
  console.log(`${SEP}`);
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", encoding: "utf8", ...opts });
    console.log(`${GREEN}✓ ${label}${RESET}`);
    return true;
  } catch (err) {
    const msg = err.status
      ? `exited with code ${err.status}`
      : err.message;
    console.error(`${RED}✗ ${label} — ${msg}${RESET}`);
    failures.push({ label, cmd, args, message: msg });
    return false;
  }
}

// ── Phase 1: same as CI's `coverage-tests` job ──
console.log(`\n${CYAN}╔${"═".repeat(54)}╗`);
console.log(`║  Phase 1: Unit + Integration tests with c8 coverage  ║`);
console.log(`╚${"═".repeat(54)}╝${RESET}`);

// Step 1a: Run tests (CI: `npm run test:ci`)
step(
  "Run unit + integration tests with c8 coverage",
  "npm", ["run", "test:ci"],
);

// Step 1b: Generate coverage dashboard (CI: `npm run coverage:dashboard`)
if (existsSync(resolve(ROOT, "coverage/lcov.info"))) {
  step(
    "Generate coverage dashboard from coverage/lcov.info",
    "node", ["scripts/generate-coverage-dashboard.js"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
} else {
  console.warn(`${YELLOW}⚠ coverage/lcov.info not found — skipping coverage dashboard${RESET}`);
}

// Step 1c: Generate unit dashboard from combined CI results (CI: `npm run unit:dashboard -- --input tests/results/test-results.json`)
if (existsSync(resolve(ROOT, "tests/results/test-results.json"))) {
  step(
    "Generate unit dashboard from tests/results/test-results.json",
    "node", ["scripts/generate-unit-dashboard.js", "--input", "tests/results/test-results.json"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
} else {
  console.warn(`${YELLOW}⚠ tests/results/test-results.json not found — skipping unit dashboard${RESET}`);
}

// Step 1d: Generate integration dashboard from combined CI results (CI: `npm run integration:dashboard -- --input tests/results/test-results.json`)
if (existsSync(resolve(ROOT, "tests/results/test-results.json"))) {
  step(
    "Generate integration dashboard from tests/results/test-results.json",
    "node", ["scripts/generate-integration-dashboard.js", "--input", "tests/results/test-results.json"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
} else {
  console.warn(`${YELLOW}⚠ tests/results/test-results.json not found — skipping integration dashboard${RESET}`);
}

// Step 1e: Run the deterministic agent-loop harness and generate its dashboard
// (CI: `npm run test:harness:ci:dashboard`, unconditional in coverage-tests so
// the Pages site always has fresh data even on pushes that don't touch
// lib/agent/**  — the path-filtered ci.agent-harness.yml workflow is the fast
// PR gate, this is the always-on data source for the dashboard).
step(
  "Run the assistant loop behavior checks and generate their dashboard",
  "npm", ["run", "test:harness:ci:dashboard"],
);

// ── Phase 2: same as CI's `e2e-dashboard` job ──
console.log(`\n${CYAN}╔${"═".repeat(54)}╗`);
console.log(`║  Phase 2: E2E tests and dashboard data  ║`);
console.log(`╚${"═".repeat(54)}╝${RESET}`);

step(
  "Run E2E tests and generate dashboard",
  "npm", ["run", "test:e2e:ci:dashboard"],
);

// ── Phase 3: same browser run and dashboard transform used by Browser CI ──
console.log(`\n${CYAN}╔${"═".repeat(54)}╗`);
console.log(`║  Phase 3: Browser tests and dashboard data  ║`);
console.log(`╚${"═".repeat(54)}╝${RESET}`);

step(
  "Run Chromium browser tests and generate dashboard",
  "npm", ["run", "test:browser:ci:dashboard"],
);

// ── Summary ──
console.log(`\n${SEP}`);
console.log(`${CYAN}SUMMARY${RESET}`);
console.log(`${SEP}`);

if (failures.length === 0) {
  console.log(`${GREEN}✅ CI pipeline verified locally — all steps passed.${RESET}`);
  console.log(`   Refresh docs/benchmarks/{code-cov,unit,integration,e2e,browser,harness}/*.html to see the results.`);
} else {
  console.log(`${RED}❌ ${failures.length} step(s) failed:${RESET}`);
  for (const f of failures) {
    console.log(`   ${RED}• ${f.label}: ${f.message}${RESET}`);
  }
  console.log(`\n${YELLOW}This is what CI would see too — fix the issues before pushing.${RESET}`);
  process.exitCode = 1;
}
