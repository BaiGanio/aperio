#!/usr/bin/env node
// scripts/generate-integration-dashboard.js
// Converts the integration test reporter output into docs/dashboards/integration-data.js.
// Usage: node scripts/generate-integration-dashboard.js
//   npm run integration:dashboard

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const inputPath = resolve(ROOT, option("--input", "integration-results.json"));
const outputPath = resolve(ROOT, option("--output", "docs/dashboards/integration-data.js"));

async function run() {
  let data;
  try {
    const parsed = JSON.parse(await readFile(inputPath, "utf8"));
    data = parsed.integration || parsed;
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

  // Add test file list from the filesystem, grouped by subdirectory
  try {
    const integrationDir = resolve(ROOT, "tests/integration");
    const groups = {};

    function scanDir(dir, prefix) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }

      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.name.endsWith(".test.js")) {
          const group = prefix || "root";
          if (!groups[group]) groups[group] = [];
          groups[group].push({
            name: entry.name,
            size: statSync(fullPath).size,
            path: relative(integrationDir, fullPath),
          });
        }
      }
    }

    scanDir(integrationDir, "");
    data.groups_detail = groups;
  } catch {
    // filesystem list is optional
  }

  // Write data file
  await writeFile(
    outputPath,
    `window.APERIO_INTEGRATION = ${JSON.stringify(data)};\n`,
    "utf8"
  );

  const status = data.failed === 0 ? "✅ ALL PASSED" : `❌ ${data.failed} FAILED`;
  console.log(`\n${status}`);
  console.log(`Generated ${outputPath} from ${data.total} tests across ${data.groups.length} groups`);
  console.log(`  Passed: ${data.passed}  Failed: ${data.failed}  Skipped: ${data.skipped}`);
  console.log(`  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
  if (data.groups) {
    console.log(`  Groups: ${data.groups.map(g => `${g.group}(${g.testCount})`).join(", ")}`);
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

run().catch((err) => {
  console.error("integration dashboard generation failed:", err.message);
  process.exit(1);
});
