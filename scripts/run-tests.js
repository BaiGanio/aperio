#!/usr/bin/env node
// Cross-platform node:test launcher.
//
// The package.json test scripts used to build their file list with
// `$(find <dir> -name '*.test.js' -print)` and set NODE_ENV via a
// `VAR=value cmd` prefix. Both are bash syntax. npm's default Windows
// script-shell is cmd.exe, which does not expand `$(...)` or parse that
// prefix — it passes them through as literal, non-existent arguments, so
// `node --test` matched zero files and exited 0. CI then reported the
// whole suite green while running nothing (see A2D.md "CI / testing",
// 2026-08-14). This script resolves the file list and sets NODE_ENV in
// JS instead, so the behavior is identical on every platform, and it
// refuses to report success when no test files were found.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

function findTestFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function parseArgs(argv) {
  const dirs = [];
  const reporterArgs = [];
  let concurrency = null;
  let timeout = null;
  let minFiles = 1;
  let agentQuiet = false;

  for (const arg of argv) {
    if (arg === "--agent-quiet") {
      agentQuiet = true;
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = arg.slice("--concurrency=".length);
    } else if (arg.startsWith("--timeout=")) {
      timeout = arg.slice("--timeout=".length);
    } else if (arg.startsWith("--min-files=")) {
      minFiles = Number(arg.slice("--min-files=".length));
    } else if (arg.startsWith("--reporter=")) {
      const spec = arg.slice("--reporter=".length);
      const sep = spec.indexOf(":");
      if (sep === -1) {
        throw new Error(`run-tests.js: --reporter must be NAME:DEST, got "${spec}"`);
      }
      const name = spec.slice(0, sep);
      const dest = spec.slice(sep + 1);
      const resolvedName = name === "AGENT"
        ? (process.env.APERIO_AGENT_RUN ? "./tests/reporters/quiet.js" : "spec")
        : name;
      reporterArgs.push(`--test-reporter=${resolvedName}`, `--test-reporter-destination=${dest}`);
    } else if (arg.startsWith("--")) {
      throw new Error(`run-tests.js: unknown flag ${arg}`);
    } else {
      dirs.push(arg);
    }
  }

  return { dirs, reporterArgs, concurrency, timeout, minFiles, agentQuiet };
}

const { dirs, reporterArgs, concurrency, timeout, minFiles, agentQuiet } = parseArgs(process.argv.slice(2));

if (dirs.length === 0) {
  console.error("run-tests.js: at least one test directory is required");
  process.exit(1);
}

const files = dirs.flatMap(findTestFiles).sort();

if (files.length < minFiles) {
  console.error(
    `run-tests.js: found ${files.length} test file(s) under [${dirs.join(", ")}], expected at least ${minFiles}. ` +
    "Refusing to report a green run for zero exercised tests."
  );
  process.exit(1);
}

const nodeArgs = ["--test"];
if (concurrency) nodeArgs.push(`--test-concurrency=${concurrency}`);
if (timeout) nodeArgs.push(`--test-timeout=${timeout}`);
if (agentQuiet && process.env.APERIO_AGENT_RUN) {
  nodeArgs.push("--test-reporter=./tests/reporters/quiet.js", "--test-reporter-destination=stdout");
}
nodeArgs.push(...reporterArgs, ...files);

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test" },
});

if (result.error) {
  console.error(`run-tests.js: failed to spawn node: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
