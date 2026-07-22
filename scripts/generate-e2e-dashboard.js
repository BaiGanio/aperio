#!/usr/bin/env node
// scripts/generate-e2e-dashboard.js
// Converts the E2E reporter output into docs/dashboards/e2e-data.js.
// Test execution is deliberately separate so CI can collect coverage and E2E
// dashboard results from the same Node.js test run.
// Usage: node scripts/generate-e2e-dashboard.js [--input e2e-results.json]
//         npm run e2e:dashboard

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const inputPath = resolve(ROOT, option("--input", "e2e-results.json"));
const outputPath = resolve(ROOT, option("--output", "docs/dashboards/e2e-data.js"));
const excludeRealApp = process.argv.includes("--exclude-real-app");

async function run() {
  let data;
  try {
    data = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to read reporter JSON from ${inputPath}: ${err.message}`
    );
  }

  // Add git context
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: ROOT }).toString().trim();
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
    data.branch = branch || process.env.GITHUB_REF_NAME || "unknown";
    data.commit = commit;
  } catch {
    data.branch = "unknown";
    data.commit = "unknown";
  }

  // Add test file list from the filesystem
  try {
    const { readdirSync, statSync } = await import("node:fs");
    const e2eDir = resolve(ROOT, "tests/e2e");
    const files = readdirSync(e2eDir)
      .filter((f) => f.endsWith(".test.js") && (!excludeRealApp || !f.startsWith("real-app-")))
      .map((f) => ({
        name: f,
        size: statSync(resolve(e2eDir, f)).size,
      }));
    data.files = files;
  } catch {
    data.files = [];
  }

  // Write data file
  await writeFile(
    outputPath,
    `window.APERIO_E2E = ${JSON.stringify(data)};\n`,
    "utf8"
  );

  const status = data.failed === 0 ? "✅ ALL PASSED" : `❌ ${data.failed} FAILED`;
  console.log(`\n${status}`);
  console.log(`Generated ${outputPath} from ${data.total} tests across ${data.suites.length} suites`);
  console.log(`  Passed: ${data.passed}  Failed: ${data.failed}  Skipped: ${data.skipped}`);
  console.log(`  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
  if (data.files) {
    console.log(`  Test files: ${data.files.length}`);
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

run().catch((err) => {
  console.error("e2e dashboard generation failed:", err.message);
  process.exit(1);
});
