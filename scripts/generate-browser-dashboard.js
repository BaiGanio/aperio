#!/usr/bin/env node
// Converts Playwright reporter output into the Browser dashboard data file.

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const inputPath = resolve(ROOT, option("--input", "tests/results/browser-results.json"));
const outputPath = resolve(ROOT, option("--output", "docs/benchmarks/browser/browser-data.js"));

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

  data.files = browserFiles(data.suites);
  await writeFile(outputPath, `window.APERIO_BROWSER = ${JSON.stringify(data)};\n`, "utf8");

  const status = data.failed === 0 ? "✅ ALL PASSED" : `❌ ${data.failed} FAILED`;
  console.log(`\n${status}`);
  console.log(`Generated ${outputPath} from ${data.total} tests across ${data.suites.length} suites`);
  console.log(`  Passed: ${data.passed}  Failed: ${data.failed}  Skipped: ${data.skipped}`);
  console.log(`  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
}

function browserFiles(suites) {
  const browserDir = resolve(ROOT, "tests/browser");
  const testCounts = new Map();
  for (const suite of suites || []) {
    for (const test of suite.tests || []) {
      testCounts.set(test.file, (testCounts.get(test.file) || 0) + 1);
    }
  }
  const files = [];

  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) scan(fullPath);
      else if (entry.name.endsWith(".spec.js")) {
        const name = relative(browserDir, fullPath).replaceAll("\\", "/");
        files.push({ name, size: statSync(fullPath).size, testCount: testCounts.get(name) || 0 });
      }
    }
  }

  scan(browserDir);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

run().catch(err => {
  console.error("browser dashboard generation failed:", err.message);
  process.exit(1);
});
