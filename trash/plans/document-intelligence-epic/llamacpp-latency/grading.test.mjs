// Tests for the extracted grader and the replay path.
//
//   node --test trash/plans/document-intelligence-epic/llamacpp-latency/grading.test.mjs
//
// The point of the replay tests is the property the epic kept wanting and did
// not have: a recorded run can be graded again, by a later grader, without
// booting anything. If these pass, `replay-grading.mjs <artifact>` is a real
// operation and grader fixes can be validated against saved transcripts instead
// of argued from a redacted stdout dump.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gradePhase, insertedRealRows } from "./grading.mjs";
import { resolveLadder } from "./provenance-ladder.mjs";

const execFileAsync = promisify(execFile);
const REPLAY = resolve("trash/plans/document-intelligence-epic/llamacpp-latency/replay-grading.mjs");

const silent = () => {};

function turn(overrides = {}) {
  return {
    prompt: "p",
    wallMs: 1_000,
    toolSequence: [],
    toolCalls: [],
    interruptApproved: false,
    approvedCount: 0,
    answerRaw: "",
    usage: null,
    status: "completed",
    ...overrides,
  };
}

// A minimal transcript that clears every mechanical provenance check: a
// confirmed INSERT that affected rows, then a db_query that came back with
// rows and an answer narrating a total and citing where it came from.
function passingProvenanceResults() {
  return [
    turn({
      toolSequence: ["db_execute"],
      toolCalls: [{
        name: "db_execute",
        arguments: { sql: "INSERT INTO spending VALUES (?,?)" },
        summary: "db_execute",
        detail: "Pending your confirmation",
      }],
      interruptApproved: true,
      answerRaw: "✅ Executed on extraction — {\"rowsAffected\": 6, \"lastInsertRowid\": 6}",
    }),
    turn({
      toolSequence: ["db_query"],
      toolCalls: [{
        name: "db_query",
        arguments: { sql: "SELECT category, SUM(amount_normalized) FROM spending GROUP BY category" },
        summary: "db_query",
        detail: "{\"rowCount\": 6, \"rows\": [{\"category\": \"Fuel\"}]}",
      }],
      answerRaw: "**Total in BGN:** 696.84 — pulled from the `spending` table.",
    }),
  ];
}

test("provenance: a clean transcript passes every mechanical check", () => {
  const grading = gradePhase({
    phase: "provenance",
    results: passingProvenanceResults(),
    ladderName: "mechanism",
    ladderEntries: [{ tier: "opening" }, { tier: "named-mechanism" }],
    log: silent,
  });
  assert.equal(grading.status, "pass");
  assert.deepEqual(grading.failures, []);
  assert.equal(grading.checks.insertedRealRows, true);
  assert.equal(grading.checks.dbQueryReturnedRealRows, true);
  assert.equal(grading.checks.followUpCitesSql, true);
  assert.equal(grading.checks.followUpNarratesDecimalTotal, true);
  assert.equal(grading.checks.successTurn, 1);
  assert.equal(grading.checks.capabilityClaim, "realistic-usage");
});

test("provenance: wall-clock ceilings come from the arguments, not from env", () => {
  const results = passingProvenanceResults();
  results[0].wallMs = 300_000;
  const uncapped = gradePhase({ phase: "provenance", results, ladderName: "mechanism", log: silent });
  assert.equal(uncapped.checks.withinPerTurnWallClockCeiling, true);

  const capped = gradePhase({
    phase: "provenance",
    results,
    ladderName: "mechanism",
    wallClockPerTurnCeilingMs: 60_000,
    wallClockTotalCeilingMs: 120_000,
    log: silent,
  });
  assert.equal(capped.checks.withinPerTurnWallClockCeiling, false);
  assert.equal(capped.status, "fail");
  assert.ok(capped.failures.some(f => f.includes("exceeding the 60000ms")));
});

test("provenance: an empty-turn cascade is graded on the last turn with content", () => {
  const results = [...passingProvenanceResults(), turn({ wallMs: 4_000 }), turn({ wallMs: 4_000 })];
  const grading = gradePhase({ phase: "provenance", results, ladderName: "mechanism", log: silent });
  assert.equal(grading.checks.calledDbQueryAfterConfirm, true);
  assert.equal(grading.checks.dbQueryReturnedRealRows, true);
});

test("routing: the private corpus root is read from the argument", () => {
  const results = [turn({
    toolSequence: ["doc_batch"],
    toolCalls: [{ name: "doc_batch", arguments: { candidates: [{ score: 1 }, { score: 2 }] } }],
    answerRaw: "You paid Utilities: 260.50 BGN, per /Users/someone/household/june.",
  })];
  const clean = gradePhase({ phase: "routing", results, household: "/nowhere", log: silent });
  assert.equal(clean.checks.noHardcodedFolderPath, true);
  assert.equal(clean.status, "pass");

  const leaked = gradePhase({ phase: "routing", results, household: "/Users/someone/household", log: silent });
  assert.equal(leaked.checks.noHardcodedFolderPath, false);
  assert.ok(leaked.failures.some(f => f.includes("leaked the private corpus path")));

  // Every string contains "" — an unknown root must not report a leak on every
  // answer. Found by replaying a real pre-gradingInputs artifact.
  const unknownRoot = gradePhase({ phase: "routing", results, household: "", log: silent });
  assert.equal(unknownRoot.checks.noHardcodedFolderPath, true);
});

test("insertedRealRows needs an INSERT proposal and a non-zero rowsAffected somewhere", () => {
  const createOnly = [{ name: "db_execute", arguments: { sql: "CREATE TABLE t (a)" }, detail: "{\"rowsAffected\": 0}" }];
  assert.equal(insertedRealRows(createOnly, []), false);
  const insert = [{ name: "db_execute", arguments: { sql: " insert into t values (1)" }, detail: "Pending your confirmation" }];
  assert.equal(insertedRealRows(insert, []), false);
  // The confirmed execution arrives as answer text on a later turn, and a
  // CREATE TABLE's own rowsAffected:0 ack precedes it.
  assert.equal(insertedRealRows(insert, ["{\"rowsAffected\": 0}", "{\"rowsAffected\": 6}"]), true);
});

// --- replay ---------------------------------------------------------------

async function writeArtifact(dir, artifact) {
  const path = join(dir, "provenance-run.json");
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return path;
}

async function replay(path, { cwd = resolve("."), archiveDir } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [REPLAY, path], {
      cwd,
      env: { ...process.env, ...(archiveDir ? { DOCINT_RUN_ARCHIVE_DIR: archiveDir } : {}) },
    });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    // Exit code 2 is a graded-as-fail replay, not a crash — its stdout is the report.
    if (error.code === 2 && error.stdout) return { code: 2, report: JSON.parse(error.stdout) };
    throw error;
  }
}

test("replay re-grades a saved transcript without booting anything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docint-replay-"));
  const results = passingProvenanceResults();
  // Grade it the way the harness does — with the resolved ladder — so the
  // recorded grading is what a real run would have written.
  const recorded = gradePhase({
    phase: "provenance",
    results,
    ladderName: "mechanism",
    ladderEntries: resolveLadder("mechanism").entries,
    wallClockPerTurnCeilingMs: 60_000,
    log: silent,
  });
  const path = await writeArtifact(dir, {
    harness: "document-intelligence-skill-harness",
    runId: "test-run",
    phase: "provenance",
    provider: "llamacpp",
    model: "test-model",
    period: null,
    timeoutMs: 600_000,
    provenanceLadder: "mechanism",
    gradingInputs: {
      household: "/nowhere",
      oraclePath: resolve("tests/fixtures/household-gen/ground-truth.json"),
      wallClockTotalCeilingMs: null,
      wallClockPerTurnCeilingMs: 60_000,
    },
    results,
    grading: recorded,
  });

  const { code, report } = await replay(path);
  assert.equal(code, 0);
  assert.equal(report.status, "pass");
  assert.equal(report.turns, 2);
  assert.equal(report.model, "test-model");
  // Same grader, same transcript, same recorded ceilings → nothing moved.
  assert.equal(report.diff.comparable, true);
  assert.equal(report.diff.statusChanged, false);
  assert.deepEqual(report.diff.changedChecks, {});
  assert.deepEqual(report.diff.failuresResolved, []);
  assert.deepEqual(report.diff.failuresIntroduced, []);
});

test("replay reports which checks a grader change would flip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docint-replay-"));
  const results = passingProvenanceResults();
  // Stand in for a stale grading recorded by an older, buggier grader — the
  // exact situation every grader fix in this epic wanted to re-run.
  const stale = {
    status: "fail",
    checks: { followUpNarratesDecimalTotal: false, insertedRealRows: true },
    failures: ["follow-up answer does not narrate an actual decimal total backed by a genuine query result"],
  };
  const path = await writeArtifact(dir, {
    phase: "provenance",
    provenanceLadder: "mechanism",
    gradingInputs: { household: "/nowhere", wallClockTotalCeilingMs: null, wallClockPerTurnCeilingMs: null },
    results,
    grading: stale,
  });

  const { report } = await replay(path);
  assert.equal(report.diff.statusBefore, "fail");
  assert.equal(report.diff.statusAfter, "pass");
  assert.equal(report.diff.statusChanged, true);
  assert.deepEqual(report.diff.changedChecks.followUpNarratesDecimalTotal, { before: false, after: true });
  assert.deepEqual(report.diff.failuresResolved, stale.failures);
  assert.deepEqual(report.diff.failuresIntroduced, []);
});

test("replay warns when an artifact predates the recorded grading inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docint-replay-"));
  const path = await writeArtifact(dir, {
    phase: "provenance",
    results: passingProvenanceResults(),
  });
  const { report } = await replay(path);
  assert.ok(report.warnings.some(w => w.includes("predates gradingInputs")));
  assert.ok(report.warnings.some(w => w.includes("no ladder name")));
  assert.equal(report.diff.comparable, false);
});

test("replay --list enumerates archived runs newest first", async () => {
  const archive = await mkdtemp(join(tmpdir(), "docint-archive-"));
  await mkdir(archive, { recursive: true });
  for (const [name, model] of [
    ["provenance-2026-08-13T10-00-00-000Z-1.json", "older"],
    ["provenance-2026-08-13T20-00-00-000Z-2.json", "newer"],
  ]) {
    await writeFile(join(archive, name), JSON.stringify({
      phase: "provenance", model, results: passingProvenanceResults(), grading: { status: "pass" },
    }));
  }
  const { stdout } = await execFileAsync(process.execPath, [REPLAY, "--list"], {
    cwd: resolve("."),
    env: { ...process.env, DOCINT_RUN_ARCHIVE_DIR: archive },
  });
  // Match the label line, not the bare word: macOS tmp paths live under
  // /var/folders/, which contains "older".
  assert.ok(
    stdout.indexOf("provenance newer") < stdout.indexOf("provenance older"),
    "newest run must be listed first",
  );
  assert.ok(stdout.includes("turns=2"));
  assert.ok(stdout.includes("recorded=pass"));
});

test("replay with no path takes the newest archived run", async () => {
  const archive = await mkdtemp(join(tmpdir(), "docint-archive-"));
  const results = passingProvenanceResults();
  for (const [name, model] of [
    ["provenance-2026-08-13T10-00-00-000Z-1.json", "older"],
    ["provenance-2026-08-13T20-00-00-000Z-2.json", "newer"],
  ]) {
    await writeFile(join(archive, name), JSON.stringify({
      phase: "provenance", model, provenanceLadder: "mechanism",
      gradingInputs: { household: "/nowhere" }, results,
    }));
  }
  const { stdout } = await execFileAsync(process.execPath, [REPLAY], {
    cwd: resolve("."),
    env: { ...process.env, DOCINT_RUN_ARCHIVE_DIR: archive },
  });
  assert.equal(JSON.parse(stdout).model, "newer");
});

test("the archived transcript keeps the figures the stdout dump redacts", async () => {
  // Guards the reason the archive exists: the harness prints answers with every
  // numeral replaced by [number], so a saved run must not go through that path.
  const source = await readFile(
    resolve("trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs"),
    "utf8",
  );
  const redaction = source.indexOf("[number]");
  const archiveWrite = source.indexOf("RUN_ARCHIVE_DIR, `${PHASE}-${RUN_ID}.json`");
  assert.ok(redaction > 0, "the stdout redaction should still be in place");
  assert.ok(archiveWrite > 0, "the harness should archive a per-run transcript");
  assert.ok(
    /await writeFile\(join\(RUN_ARCHIVE_DIR[^)]*\), payload\)/.test(source),
    "the archive must be written from the same un-redacted payload as ANSWERS_PATH",
  );
});
