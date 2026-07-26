// lib/helpers/minimalismBench.js — WS2 of epic #285 (ponytail-borrow-ws2.md)
//
// Pure, unit-testable primitives for the code-minimalism before/after eval:
// sandbox construction (arm A = skill present, arm B = skill absent), the
// three metric collectors (LOC delta, net tokens, correctness), and the
// pre-registered verdict function. Process orchestration (spawning the
// agent loop, writing the ledger file, --dry-run replay) lives in
// scripts/minimalism-bench.js, which imports these.

import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, mkdirSync, cpSync, copyFileSync, rmSync,
  readFileSync, readdirSync, appendFileSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Only these three files feed createAgent's CACHED_PROMPT (lib/agent/index.js:145-146);
// copying just them keeps the sandbox from dragging in id/agent-rules, id/audit, etc.
// that this eval has no use for.
const IDENTITY_FILES = ["whoami.md", "capabilities.md", "self-nature.md"];

/**
 * Build one mkdtemp sandbox root: id/ (identity files only) + a skills/ copy
 * (full for arm A, minus code-minimalism/ for arm B) + an empty workspace/.
 * Everything lives under the mkdtemp — nothing touches the repo tree.
 */
export function buildSandbox({ arm, repoRoot = REPO_ROOT } = {}) {
  if (arm !== "A" && arm !== "B") throw new Error(`buildSandbox: arm must be "A" or "B", got ${JSON.stringify(arm)}`);
  const root = mkdtempSync(join(tmpdir(), "aperio-minimalism-"));
  const idDir = join(root, "id");
  mkdirSync(idDir, { recursive: true });
  for (const file of IDENTITY_FILES) {
    copyFileSync(join(repoRoot, "id", file), join(idDir, file));
  }
  const skillsDir = join(root, "skills");
  cpSync(join(repoRoot, "skills"), skillsDir, { recursive: true });
  if (arm === "B") {
    rmSync(join(skillsDir, "code-minimalism"), { recursive: true, force: true });
  }
  const workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  return {
    root,
    skillsDir,
    workspaceDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** sha256 of a file's contents, for the ledger's skill_sha column. */
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ── LOC counting ─────────────────────────────────────────────────────────
//
// Line-oriented classifier: strips string-literal contents (so a `//` inside
// a URL string is not mistaken for a line comment) and tracks block-comment
// state across lines. Does not track a string literal spanning multiple
// lines (an unterminated template literal) — no fixture in this eval needs
// that, and getting it wrong only affects LOC-counting fixtures, never
// correctness scoring.
export function countSourceLoc(text) {
  let count = 0;
  let inBlockComment = false;
  for (const rawLine of String(text ?? "").split(/\r\n|\r|\n/)) {
    let i = 0;
    let hasCode = false;
    while (i < rawLine.length) {
      if (inBlockComment) {
        const end = rawLine.indexOf("*/", i);
        if (end === -1) { i = rawLine.length; break; }
        inBlockComment = false;
        i = end + 2;
        continue;
      }
      const ch = rawLine[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        let j = i + 1;
        while (j < rawLine.length) {
          if (rawLine[j] === "\\") { j += 2; continue; }
          if (rawLine[j] === quote) { j++; break; }
          j++;
        }
        hasCode = true;
        i = j;
        continue;
      }
      if (ch === "/" && rawLine[i + 1] === "/") { i = rawLine.length; break; }
      if (ch === "/" && rawLine[i + 1] === "*") {
        const end = rawLine.indexOf("*/", i + 2);
        if (end === -1) { inBlockComment = true; i = rawLine.length; break; }
        i = end + 2;
        continue;
      }
      if (!/\s/.test(ch)) hasCode = true;
      i++;
    }
    if (hasCode) count++;
  }
  return count;
}

/** Recursive snapshot of a directory's text files: relPath -> content. Missing dir -> empty map. */
export function snapshotDir(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const walk = (d, prefix) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(dir, "");
  return out;
}

/**
 * LOC delta between two workspace snapshots. A file only in `after`
 * contributes its full LOC; a file only in `before` (deleted by the model)
 * contributes negative its LOC; a file in both contributes after-before.
 */
export function locDelta(before, after) {
  const files = new Set([...before.keys(), ...after.keys()]);
  let total = 0;
  for (const file of files) {
    const b = before.has(file) ? countSourceLoc(before.get(file)) : 0;
    const a = after.has(file) ? countSourceLoc(after.get(file)) : 0;
    total += a - b;
  }
  return total;
}

// ── Token accounting ─────────────────────────────────────────────────────

/** Sum input/output tokens across every stream_end event. Missing/absent usage contributes 0, never NaN. */
export function sumUsage(events) {
  let input = 0, output = 0;
  for (const event of events ?? []) {
    if (event?.type !== "stream_end" || !event.usage) continue;
    input += Number(event.usage.input_tokens) || 0;
    output += Number(event.usage.output_tokens) || 0;
  }
  return { input, output, net: input + output };
}

// ── Correctness ───────────────────────────────────────────────────────────

/**
 * Copy `solutionDir`'s files into a scratch root, copy `testsDir` alongside
 * as tests/, and run `node --test tests` from that root — so a fixture's
 * reference tests can import "../foo.js" regardless of whether the solution
 * came from a fixture's reference/, anti-solution/, or a live workspace/.
 * Never throws: a bad solution, a missing file, or a hung test all resolve
 * to `false` rather than propagating.
 */
export function runFixtureTests({ testsDir, solutionDir, timeoutMs = 30_000 }) {
  const scratch = mkdtempSync(join(tmpdir(), "aperio-minimalism-tests-"));
  try {
    if (existsSync(solutionDir)) cpSync(solutionDir, scratch, { recursive: true });
    cpSync(testsDir, join(scratch, "tests"), { recursive: true });
    // Fixture solutions use ESM (import/export); a bare scratch dir has no
    // package.json, so Node would default to CommonJS and fail every file on
    // a syntax error before a single test runs.
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ type: "module" }));
    // A directory path ("tests" or "tests/") does not reliably auto-discover
    // *.test.js in this Node version — only an explicit glob does.
    //
    // NODE_TEST_CONTEXT is set by Node's own test runner on every file it
    // executes (e.g. "child-v8"). When this function itself runs inside
    // `node --test` (as it does from tests/unit/helpers/minimalism-bench.test.js),
    // that var leaks into this spawned child via inherited env and makes the
    // nested `node --test` behave as a reporting worker instead of a normal
    // run — it exits 0 regardless of whether its own tests failed. Strip it
    // (and the IPC channel fd, for the same reason) so the nested run reports
    // its real exit status.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_CHANNEL_FD;
    const result = spawnSync(process.execPath, ["--test", "tests/*.test.js"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env: childEnv,
    });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── Ledger ────────────────────────────────────────────────────────────────

export const LEDGER_COLUMNS = [
  "ts", "task", "arm", "repeat", "loc", "input_tokens", "output_tokens",
  "net_tokens", "correct", "wall_ms", "model", "skill_sha",
];

export function formatLedgerRow(row) {
  return LEDGER_COLUMNS.map(col => {
    const v = row[col];
    if (col === "correct") return v ? "1" : "0";
    return String(v ?? "");
  }).join("\t");
}

/** Append one row to the ledger, writing the header line only when the file doesn't exist yet. */
export function appendLedgerRow(ledgerPath, row) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const isNew = !existsSync(ledgerPath) || statSync(ledgerPath).size === 0;
  const lines = [];
  if (isNew) lines.push(LEDGER_COLUMNS.join("\t"));
  lines.push(formatLedgerRow(row));
  appendFileSync(ledgerPath, lines.join("\n") + "\n", "utf8");
}

// ── Verdict ───────────────────────────────────────────────────────────────

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median absolute deviation — the spread measure used for the verdict's
// INCONCLUSIVE gate. A mean-based spread (stdev) is itself dragged around by
// the same single extreme repeat the "medians, not means" rule exists to
// resist (E7: "the verdict is unchanged by one extreme outlier repeat"), so
// the noise reference has to be robust too, not just the effect estimate.
export function medianAbsoluteDeviation(values) {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map(v => Math.abs(v - center)));
}

const LOC_WIN_THRESHOLD = -0.15; // -15%, per the pre-registered rule

function groupBy(rows, arm, task) {
  return rows.filter(r => r.task === task && r.arm === arm);
}

/**
 * Pre-registered verdict rule (ponytail-borrow-ws2.md "Pre-registered verdict
 * rule"), applied to medians across tasks with arm B as the baseline:
 *   KEEP   — correctness pass rate >= baseline on every task, LOC delta <= -15%, net tokens <= 0
 *   TRIM   — correctness ok, LOC delta <= -15%, net tokens positive
 *   DROP   — no LOC win at equal correctness, OR any correctness regression (disqualifying on its own,
 *            per-task pass rate — a partial regression counts even if the baseline itself wasn't flawless)
 *   INCONCLUSIVE — the LOC effect is smaller than the observed inter-repeat spread
 */
export function computeVerdict(rows) {
  const tasks = [...new Set(rows.map(r => r.task))];

  let anyCorrectnessRegression = false;
  const perTaskLocPct = [];
  const perTaskNetDelta = [];
  const pooledRawLocDeltas = [];

  for (const task of tasks) {
    const aRows = groupBy(rows, "A", task);
    const bRows = groupBy(rows, "B", task);
    if (!aRows.length || !bRows.length) continue;

    // Pass RATE, not "every repeat passed" — the latter only ever flags a
    // regression when the baseline itself was flawlessly correct. B passing
    // 2/3 repeats and A passing 0/3 must still count as a regression even
    // though bRows.every(...) is already false.
    const passRate = (repeatRows) => repeatRows.reduce((sum, r) => sum + (r.correct ? 1 : 0), 0) / repeatRows.length;
    const bRate = passRate(bRows);
    const aRate = passRate(aRows);
    if (aRate < bRate) anyCorrectnessRegression = true;

    const aLocMed = median(aRows.map(r => r.loc));
    const bLocMed = median(bRows.map(r => r.loc));
    perTaskLocPct.push(bLocMed === 0 ? 0 : (aLocMed - bLocMed) / bLocMed);

    const aNetMed = median(aRows.map(r => r.net_tokens));
    const bNetMed = median(bRows.map(r => r.net_tokens));
    perTaskNetDelta.push(aNetMed - bNetMed);

    if (aRows.length === bRows.length) {
      for (let i = 0; i < aRows.length; i++) pooledRawLocDeltas.push(aRows[i].loc - bRows[i].loc);
    }
  }

  if (anyCorrectnessRegression) return "DROP";

  const overallLocPct = median(perTaskLocPct);
  const overallNetDelta = median(perTaskNetDelta);
  const spread = medianAbsoluteDeviation(pooledRawLocDeltas);
  const rawEffect = median(pooledRawLocDeltas);

  if (spread > 0 && Math.abs(rawEffect) < spread) return "INCONCLUSIVE";
  if (overallLocPct <= LOC_WIN_THRESHOLD && overallNetDelta <= 0) return "KEEP";
  if (overallLocPct <= LOC_WIN_THRESHOLD && overallNetDelta > 0) return "TRIM";
  return "DROP";
}
