#!/usr/bin/env node
// scripts/generate-harness-dashboard.js
// Converts the WS0 agent-loop harness reporter output into
// docs/benchmarks/harness/harness-data.js. Mirrors generate-unit-dashboard.js.
// Usage: node scripts/generate-harness-dashboard.js
//   npm run harness:dashboard

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const inputPath = resolve(ROOT, option("--input", "tests/results/harness-results.json"));
const outputPath = resolve(ROOT, option("--output", "docs/benchmarks/harness/harness-data.js"));

async function run() {
  let data;
  try {
    data = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read reporter JSON from ${inputPath}: ${err.message}`);
  }

  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: ROOT }).toString().trim();
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
    data.branch = branch || process.env.GITHUB_REF_NAME || "unknown";
    data.commit = commit;
  } catch {
    data.branch = "unknown";
    data.commit = "unknown";
  }

  try {
    const scenarioDir = resolve(ROOT, "tests/harness/scenarios");
    data.scenarioCount = readdirSync(scenarioDir).filter(f => f.endsWith(".json")).length;
  } catch {
    // scenario count is optional
  }

  await writeFile(outputPath, `window.APERIO_HARNESS = ${JSON.stringify(data)};\n`, "utf8");

  const status = data.failed === 0 ? "✅ ALL PASSED" : `❌ ${data.failed} FAILED`;
  console.log(`\n${status}`);
  console.log(`Generated ${outputPath} from ${data.total} tests`);
  console.log(`  Passed: ${data.passed}  Failed: ${data.failed}  Skipped: ${data.skipped}`);
  console.log(`  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

run().catch((err) => {
  console.error("harness dashboard generation failed:", err.message);
  process.exit(1);
});
