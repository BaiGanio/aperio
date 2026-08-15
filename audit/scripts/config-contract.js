// audit/scripts/config-contract.js
//
// T2.5 — config drift gate for the continuous-audit program (Step 2, T2.5's
// "unregistered env read" case; `npm run gen:env:check` already covers the
// other half of T2.5 — a registry change without a regenerated .env.example —
// so it is not reimplemented here, per Step 2's instruction to reuse existing
// gates instead of duplicating them).
//
// Scope: process.env reads under lib/, mcp/, db/, server.js, and bootstrap.js
// — the runtime config surface. scripts/ and public/ are tooling/frontend,
// not the app's own config contract, and are out of scope for this gate.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../../lib/config.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_DIRS = ["lib", "mcp", "db"];
const SCAN_FILES = ["server.js", "bootstrap.js"];

// Env vars Aperio itself sets to signal between its own parent/child
// processes (restart supervisor, benchmark harness, background jobs) or
// that exist only as test-only override knobs — never user-facing Settings-UI
// config, so they are not expected to appear in the CONFIG registry. Mirrors
// lib/config.js's own documented exclusion of HOME/APPDATA/NODE_ENV/
// APERIO_PROC_ROLE, extended to the same category of internal signal.
export const REVIEWED_EXCEPTIONS = {
  // OS/platform-level, never Aperio's to register.
  HOME: "OS-set", APPDATA: "OS-set", NODE_ENV: "OS/tooling-set",
  USER: "OS-set", USERNAME: "OS-set", PGUSER: "OS/driver-set",
  INVOCATION_ID: "OS-set (systemd)", KUBERNETES_SERVICE_HOST: "OS/platform-set",
  // Aperio-internal process-role/child-signaling — set by the app itself,
  // never edited by a user (same rationale as the already-documented
  // APERIO_PROC_ROLE exclusion in lib/config.js's header comment).
  APERIO_PROC_ROLE: "internal process-role signal",
  APERIO_RESTART: "internal restart-supervisor signal",
  APERIO_RUN_ID: "internal background-job run id",
  APERIO_SESSION_ID: "internal background-job session id",
  APERIO_SUPERVISED: "internal restart-supervisor signal",
  APERIO_REPORT_PORT: "internal restart-supervisor signal",
  APERIO_BENCHMARK_RUN: "internal benchmark-harness signal (scripts/local-bench.js)",
  APERIO_INTERRUPT_TTL_MS: "test-only override, per its own inline comment (mcp/tools/files/interrupt.js)",
};

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function listJsFiles(dir) {
  return execFileSync("git", ["ls-files", dir], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".js"));
}

export function envReadsInSource(source) {
  const clean = stripComments(source);
  const names = new Set();
  const re = /process\.env\.([A-Z_][A-Z0-9_]*)\b|process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g;
  let m;
  while ((m = re.exec(clean))) names.add(m[1] || m[2]);
  return names;
}

export function scanEnvReads({ scanDirs = SCAN_DIRS, scanFiles = SCAN_FILES } = {}) {
  const files = [...scanFiles, ...scanDirs.flatMap(listJsFiles)];
  const byVar = {};
  for (const rel of files) {
    let source;
    try {
      source = readFileSync(`${ROOT}/${rel}`, "utf8");
    } catch {
      continue;
    }
    for (const name of envReadsInSource(source)) {
      (byVar[name] ||= []).push(rel);
    }
  }
  return byVar;
}

export function checkConfigContract({
  registeredKeys = new Set(CONFIG.map((c) => c.key)),
  exceptions = REVIEWED_EXCEPTIONS,
  byVar = scanEnvReads(),
} = {}) {
  const unregistered = Object.keys(byVar)
    .filter((name) => !registeredKeys.has(name) && !(name in exceptions))
    .sort()
    .map((name) => ({ key: name, readIn: byVar[name] }));
  return { ok: unregistered.length === 0, unregistered };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkConfigContract(), null, 2));
}
