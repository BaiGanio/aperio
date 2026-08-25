#!/usr/bin/env node
// scripts/npm-audit-gate.js — DEP-02's audit gate.
//
// Replaces a bare `npm audit --omit=dev --audit-level=high`. Same verdict for
// everything except a short, dated list of advisories that have NO upstream
// fix: npm's own `fixAvailable` for those points at a major *downgrade* of a
// dependency we actually use, which trades a denial-of-service risk for a
// functional regression and a different set of advisories.
//
// The allowlist cannot rot silently. Each entry carries a `reviewBy` date, and
// once that date passes the entry stops suppressing anything — the gate goes
// red again and names the entry, forcing a fresh look rather than an
// indefinite exemption. An entry whose advisory no longer appears in the audit
// output also fails the gate, so a suppression outlives its cause by at most
// one CI run.

import { execFileSync } from "node:child_process";

// Advisories accepted for now, with the reason and the date the acceptance
// expires. Keep this list short and each entry justified — anything with a
// real upstream fix belongs in a dependency bump, not here.
const ALLOWLIST = [
  {
    id: "GHSA-w3rx-r6r6-pgpr",
    package: "image-size",
    reviewBy: "2026-11-25",
    reason:
      "ICNS parser infinite loop. Every published image-size version is affected "
      + "(last release 2.0.2, 2025-04-02) and it reaches us only through pptxgenjs, "
      + "which the pptx skill needs. npm's only 'fix' is pptxgenjs@1.1.5, three "
      + "majors back. Denial of service on a crafted image in a single-user "
      + "self-hosted deck build.",
  },
  {
    id: "GHSA-5p2g-fcmc-qvqq",
    package: "image-size",
    reviewBy: "2026-11-25",
    reason:
      "JXL/HEIF parser infinite loops in image-size. Same package, same absent "
      + "upstream fix, same pptxgenjs-only reach as GHSA-w3rx-r6r6-pgpr.",
  },
];

const BLOCKING = new Set(["high", "critical"]);

// How to start npm without depending on the platform's executable resolution.
//
// On Windows npm is not a native executable — it is `npm.cmd`, a launcher
// script. execFileSync spawns directly, with no shell and no PATHEXT lookup, so
// execFileSync("npm", …) fails there with ENOENT and this gate cannot run at
// all. `shell: true` would paper over it and put every argument through cmd.exe
// quoting, so the launcher is bypassed instead.
//
// Under `npm run audit:gate` npm exports npm_execpath pointing at its own
// npm-cli.js. Running that file with the Node binary already executing this one
// is the identical program on every platform. The name is matched strictly:
// another package manager invoked through the same script sets npm_execpath to
// *its* CLI, and pnpm/yarn `audit` emit a different JSON shape that the parsing
// below would misread as a clean report.
//
// The CI step runs `node scripts/npm-audit-gate.js` directly and exports no such
// variable, so the fallback is npm by name — with the `.cmd` launcher spelled
// out on Windows, which is what makes the bare-node path work there too.
function npmInvocation(args) {
  const execpath = process.env.npm_execpath;
  if (execpath && /(^|[\\/])npm-cli\.[cm]?js$/i.test(execpath)) {
    return { file: process.execPath, args: [execpath, ...args] };
  }
  return { file: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function runAudit() {
  const { file, args } = npmInvocation(["audit", "--omit=dev", "--json"]);
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // npm audit exits non-zero whenever it finds anything at or above the
    // audit level — the JSON on stdout is still the report we want.
    if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout;
    throw err;
  }
}

// A report npm could not actually produce is not a clean bill of health.
//
// When the registry is unreachable, or the lockfile is missing, npm prints
// `{"error": {code, summary, detail}}` on stdout and can still exit zero. That
// parses fine and carries no `vulnerabilities`, so treating it as a report
// would mean every advisory silently disappears — a green gate produced by a
// network blip. Refuse anything that is not a real audit report, and say why.
function assertRealReport(report) {
  if (report?.error) {
    const { code, summary, detail } = report.error;
    throw new Error(
      `npm audit could not produce a report${code ? ` (${code})` : ""}: `
      + `${summary ?? "no summary"}${detail ? `\n${detail}` : ""}`
    );
  }
  if (!report || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    throw new Error(
      "npm audit returned JSON with no `vulnerabilities` object — refusing to treat it as a clean audit."
    );
  }
}

// Flattens the report into one row per (advisory, package) pair. `via` entries
// are either an advisory object (the package is directly affected) or a string
// naming another package it inherits from — only the former carries an id.
function blockingAdvisories(report) {
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || !via.url) continue;
      if (!BLOCKING.has(via.severity)) continue;
      const id = via.url.split("/").pop();
      found.set(id, { id, package: via.name, title: via.title, severity: via.severity });
    }
  }
  return found;
}

let report;
try {
  report = JSON.parse(runAudit());
  assertRealReport(report);
} catch (err) {
  console.error(`\nnpm audit gate failed — the audit itself did not run:\n\n  ✖ ${err.message}\n`);
  process.exit(1);
}

const found = blockingAdvisories(report);
const today = new Date().toISOString().slice(0, 10);

const problems = [];
const suppressed = [];

for (const entry of ALLOWLIST) {
  if (entry.reviewBy < today) {
    problems.push(
      `Allowlist entry ${entry.id} (${entry.package}) expired on ${entry.reviewBy}. `
      + `Re-check for an upstream fix, then either drop the entry or extend reviewBy with a reason.`
    );
    continue;
  }
  if (!found.has(entry.id)) {
    problems.push(
      `Allowlist entry ${entry.id} (${entry.package}) no longer appears in the audit — remove it from ${import.meta.filename}.`
    );
    continue;
  }
  suppressed.push(entry);
  found.delete(entry.id);
}

for (const adv of found.values()) {
  problems.push(`${adv.severity.toUpperCase()} ${adv.id} — ${adv.package}: ${adv.title}`);
}

for (const entry of suppressed) {
  console.log(`· accepted until ${entry.reviewBy}: ${entry.id} (${entry.package}) — ${entry.reason}`);
}

if (problems.length) {
  console.error(`\nnpm audit gate failed (${problems.length}):\n`);
  for (const p of problems) console.error(`  ✖ ${p}`);
  process.exit(1);
}

console.log(`\nnpm audit gate passed — no unaccepted high or critical advisories.`);
