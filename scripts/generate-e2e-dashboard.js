#!/usr/bin/env node
// scripts/generate-e2e-dashboard.js
// Runs e2e tests with the JSON reporter and generates docs/e2e-data.js
// Usage: node scripts/generate-e2e-dashboard.js
//         npm run e2e:dashboard

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

async function run() {
  console.log("Running e2e tests with JSON reporter...");

  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--test",
        "--test-reporter", "./tests/reporters/e2e-json.js",
        "tests/e2e/**/*.test.js",
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "test" },
        timeout: 120_000,
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        // 1 means some tests failed — that's fine for the dashboard
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`e2e runner exited with code ${code}\n${stderr.slice(-500)}`));
      }
    });
    child.on("error", reject);
  });

  // Parse the JSON from stdout
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `Failed to parse reporter JSON:\n${err.message}\n\nstdout: ${result.stdout.slice(-300)}\nstderr: ${result.stderr.slice(-300)}`
    );
  }

  // Add git context
  try {
    const { execSync } = await import("node:child_process");
    const branch = execSync("git branch --show-current", { cwd: ROOT }).toString().trim();
    const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
    data.branch = branch;
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
      .filter((f) => f.endsWith(".test.js"))
      .map((f) => ({
        name: f,
        size: statSync(resolve(e2eDir, f)).size,
      }));
    data.files = files;
  } catch {
    data.files = [];
  }

  // Write data file
  const outputPath = resolve(ROOT, "docs/e2e-data.js");
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

run().catch((err) => {
  console.error("e2e dashboard generation failed:", err.message);
  process.exit(1);
});
