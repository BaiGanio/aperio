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
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gradePhase, insertedRealRows } from "./grading.mjs";
import { resolveLadder } from "./provenance-ladder.mjs";
import { buildExpectations } from "../fixtures/household-gen/harness-gate.mjs";

const execFileAsync = promisify(execFile);
const REPLAY = resolve(import.meta.dirname, "replay-grading.mjs");

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

  // The per-turn ceiling is still computed from the argument, but since
  // 2026-08-14 it is reported rather than gating: a blown per-turn time must
  // not fail a run on its own.
  const cappedPerTurn = gradePhase({
    phase: "provenance",
    results,
    ladderName: "mechanism",
    wallClockPerTurnCeilingMs: 60_000,
    wallClockTotalCeilingMs: 10_000_000,
    log: silent,
  });
  assert.equal(cappedPerTurn.checks.withinPerTurnWallClockCeiling, false);
  assert.equal(cappedPerTurn.checks.maxTurnWallMs, 300_000);
  assert.equal(cappedPerTurn.status, "pass");
  assert.ok(!cappedPerTurn.failures.some(f => f.includes("per-turn")));

  // The TOTAL ceiling is still a real gate — a run that never terminates is a
  // genuine failure.
  const cappedTotal = gradePhase({
    phase: "provenance",
    results,
    ladderName: "mechanism",
    wallClockPerTurnCeilingMs: 60_000,
    wallClockTotalCeilingMs: 120_000,
    log: silent,
  });
  assert.equal(cappedTotal.status, "fail");
  assert.ok(cappedTotal.failures.some(f => f.includes("exceeds the 120000ms")));
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
      oraclePath: resolve(import.meta.dirname, "../fixtures/household-gen/ground-truth.json"),
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

// --- Foreign-currency row categorisation (added 2026-08-13) -----------------
//
// Grades the EUR side, which nothing did before: the oracle declares
// other_currency_totals.EUR = 196.40 over three documents it categorises as
// Travel, and rounds 5/11/12 all wrote that total into a single row labelled
// `Uncategorized` (or `Travel-Other`) with no check to notice.

async function realExpectations() {
  const { buildExpectations } = await import("../../../../tests/fixtures/household-gen/harness-gate.mjs");
  const oracle = JSON.parse(await readFile(resolve("tests/fixtures/household-gen/ground-truth.json"), "utf8"));
  return buildExpectations(oracle, "2026-06", { corpusRoot: "/tmp/corpus-root" });
}

function resultsWithQueriedRows(rows) {
  const results = passingProvenanceResults();
  results[1].toolCalls[0].detail = JSON.stringify({ rowCount: rows.length, rows });
  return results;
}

test("buildExpectations derives the foreign-currency side from the oracle", async () => {
  const expectations = await realExpectations();
  assert.deepEqual(expectations.otherCurrencies, {
    EUR: { total: 196.4, documents: 3, categories: ["Travel"] },
  });
});

test("provenance: an Uncategorized EUR row is now a named failure", async () => {
  const expectations = await realExpectations();
  const grading = gradePhase({
    phase: "provenance",
    results: resultsWithQueriedRows([
      { category: "Fuel", currency_iso: "BGN", total_spent: 215.6 },
      { category: "Uncategorized", currency_iso: "EUR", total_spent: 196.4 },
    ]),
    expectations,
    ladderName: "mechanism",
    log: silent,
  });
  assert.equal(grading.checks.foreignCurrencyRowsCategorized, false);
  const failure = grading.failures.find(f => f.startsWith("foreign-currency category:"));
  assert.ok(failure, "the failure names the check");
  assert.ok(failure.includes("Uncategorized") && failure.includes("Travel"), failure);
});

test("provenance: a EUR row naming the corpus category clears the check", async () => {
  const expectations = await realExpectations();
  const grading = gradePhase({
    phase: "provenance",
    results: resultsWithQueriedRows([
      { category: "Fuel", currency_iso: "BGN", total_spent: 215.6 },
      { category: "Travel-Other", currency_iso: "EUR", total_spent: 196.4 },
    ]),
    expectations,
    ladderName: "mechanism",
    log: silent,
  });
  assert.equal(grading.checks.foreignCurrencyRowsCategorized, true);
  assert.equal(grading.failures.some(f => f.startsWith("foreign-currency category:")), false);
});

test("provenance: the check stays out of the way when no expectations are supplied", () => {
  const grading = gradePhase({
    phase: "provenance",
    results: resultsWithQueriedRows([{ category: "Uncategorized", currency_iso: "EUR", total_spent: 196.4 }]),
    ladderName: "mechanism",
    log: silent,
  });
  assert.equal(grading.status, "pass");
  assert.equal("foreignCurrencyRowsCategorized" in grading.checks, false);
});

// --- gate attribution -----------------------------------------------------
//
// The provenance flow exercises three separate claims at once (T-G2.3
// sql-provenance, T-G2.4 no-fx-honesty, T-L4 wall clock) and the grader ORs
// them into one `status`. These tests pin the finer view: a T-G2.4 or T-L4
// failure must not read as a provenance failure, and vice versa.

function gradeWithOracle(results, extra = {}) {
  const oracle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/household-gen/ground-truth.json"), "utf8"));
  return gradePhase({
    phase: "provenance",
    results,
    expectations: buildExpectations(oracle, "2026-06", { corpusRoot: "/nowhere" }),
    household: "/nowhere",
    ladderName: "mechanism",
    ladderEntries: resolveLadder("mechanism").entries,
    log: silent,
    ...extra,
  });
}

test("gates: a clean transcript passes T-G2.3 and T-L4; T-G2.4 needs an oracle", () => {
  const grading = gradePhase({
    phase: "provenance",
    results: passingProvenanceResults(),
    ladderName: "mechanism",
    ladderEntries: resolveLadder("mechanism").entries,
    log: silent,
  });
  assert.equal(grading.gates["T-G2.3"].status, "pass");
  assert.equal(grading.gates["T-L4"].status, "pass");
  // No expectations supplied — an absent oracle is not evidence of currency
  // honesty, so the gate must not claim a pass it never tested.
  assert.equal(grading.gates["T-G2.4"].status, "not-evaluated");
  assert.deepEqual(grading.gates["T-G2.3"].checks, {
    calledDbExecute: true, interruptApproved: true, insertedRealRows: true,
    calledDbQueryAfterConfirm: true, dbQueryReturnedRealRows: true,
    followUpCitesSql: true, followUpNarratesDecimalTotal: true,
    // Evaluated with no oracle supplied: the phantom-write check falls back to
    // the currencies the run itself wrote, so T-G2.3 stays a real verdict here
    // rather than degrading to "not-evaluated" the way T-G2.4 must.
    noPhantomWriteClaims: true,
  });
  assert.equal(grading.gates["T-G2.3"].context.capabilityClaim, "realistic-usage");
});

test("gates: round 10's currency blend fails T-G2.4 with provenance intact", () => {
  const results = passingProvenanceResults();
  // Round 10's verbatim closing line. 696.84 BGN + 196.40 EUR = 893.24: Lev
  // added to Euro, stated as one untagged figure.
  results[1].answerRaw =
    "Pulled from the `spending` table. This query resulted in 6 distinct groups, "
    + "summing to a grand total of **893.24** across BGN and EUR.";
  const grading = gradeWithOracle(results);

  assert.equal(grading.status, "fail");
  assert.equal(grading.gates["T-G2.4"].status, "fail");
  // The whole point: the model wrote real rows, queried them back and cited the
  // source. That claim held. It failed a different gate.
  assert.equal(grading.gates["T-G2.3"].status, "pass");
  assert.equal(grading.gates["T-L4"].status, "pass");
  assert.ok(grading.gates["T-G2.4"].failures.every(f => f.startsWith("full-month gate:")));
  assert.deepEqual(grading.gates["T-G2.3"].failures, []);
});

test("gates: a blown per-turn ceiling is reported, and fails nothing", () => {
  // Ornith run 1 in the flesh: both substantive gates passed and the only
  // `failures[]` entry was a 589,813ms turn 0, measured against a ceiling set
  // before anyone had watched a turn finish on this corpus. The time is still
  // recorded — as T-L4 context — but it no longer converts a pass into a fail.
  const results = passingProvenanceResults();
  results[0].wallMs = 900_000;
  const grading = gradePhase({
    phase: "provenance", results, ladderName: "mechanism",
    wallClockPerTurnCeilingMs: 550_000, wallClockTotalCeilingMs: 2_400_000, log: silent,
  });
  assert.equal(grading.status, "pass");
  assert.equal(grading.gates["T-L4"].status, "pass");
  assert.equal(grading.gates["T-G2.3"].status, "pass");
  assert.deepEqual(grading.gates["T-L4"].failures, []);
  // Reported, not gating: present in context, absent from the gating checks.
  assert.equal(grading.gates["T-L4"].context.withinPerTurnWallClockCeiling, false);
  assert.equal(grading.gates["T-L4"].context.maxTurnWallMs, 900_000);
  assert.ok(!("withinPerTurnWallClockCeiling" in grading.gates["T-L4"].checks));
});

test("gates: the total ceiling is still a gate", () => {
  const results = passingProvenanceResults();
  results[0].wallMs = 900_000;
  const grading = gradePhase({
    phase: "provenance", results, ladderName: "mechanism",
    wallClockPerTurnCeilingMs: 550_000, wallClockTotalCeilingMs: 100_000, log: silent,
  });
  assert.equal(grading.status, "fail");
  assert.equal(grading.gates["T-L4"].status, "fail");
  assert.equal(grading.gates["T-G2.3"].status, "pass");
  assert.ok(grading.gates["T-L4"].failures.some(f => f.includes("exceeds the 100000ms")));
});

test("gates: round 12's missing INSERT is a genuine T-G2.3 failure", () => {
  const results = passingProvenanceResults();
  // CREATE TABLE proposed and approved, but nothing ever written — the failure
  // mode the gate exists to catch.
  results[0].toolCalls[0].arguments.sql = "CREATE TABLE spending (category TEXT, amount REAL)";
  results[0].answerRaw = "✅ Executed on extraction — {\"rowsAffected\": 0}";
  const grading = gradePhase({ phase: "provenance", results, ladderName: "mechanism", log: silent });
  assert.equal(grading.gates["T-G2.3"].status, "fail");
  assert.equal(grading.gates["T-G2.3"].checks.insertedRealRows, false);
  assert.ok(grading.gates["T-G2.3"].failures.some(f => f.includes("rows were never actually written")));
  assert.equal(grading.gates["T-L4"].status, "pass");
});

test("gates: an incomplete turn is attributed to T-L4, not to provenance", () => {
  // Round 12's runaway-reasoning shape: the answering turn is fine, a later
  // turn burns its budget and emits nothing.
  const results = [...passingProvenanceResults(), turn({ wallMs: 900_004, status: "timeout" })];
  const grading = gradePhase({ phase: "provenance", results, ladderName: "mechanism", log: silent });
  assert.equal(grading.checks.completed, false);
  assert.equal(grading.gates["T-L4"].status, "fail");
  assert.ok(grading.gates["T-L4"].failures.some(f => f.includes("did not complete")));
  assert.equal(grading.gates["T-G2.3"].status, "pass");
});

test("gates: the split leaves status and failures byte-identical", () => {
  // Replay diffs compare `status` and `failures`; the gate view is additive and
  // must not renumber, reorder or reword either of them.
  const results = passingProvenanceResults();
  results[0].wallMs = 900_000;
  results[1].answerRaw = "Pulled from the `spending` table. Grand total **893.24** across BGN and EUR.";
  const grading = gradeWithOracle(results, {
    wallClockPerTurnCeilingMs: 550_000,
    wallClockTotalCeilingMs: 100_000,
  });
  assert.equal(grading.status, "fail");
  // Wall-clock failures are pushed first, then provenance, then the gate ones —
  // the original order, regardless of which gate owns each.
  assert.ok(grading.failures[0].includes("T-L4 ceiling"));
  assert.ok(grading.failures.at(-1).startsWith("full-month gate:"));
  // Every failure lands in exactly one gate, and no failure is lost.
  const fromGates = Object.values(grading.gates).flatMap(g => g.failures);
  assert.equal(fromGates.length, grading.failures.length);
  assert.deepEqual([...fromGates].sort(), [...grading.failures].sort());
});

test("gates: non-provenance phases report no gate split", () => {
  const grading = gradePhase({
    phase: "routing",
    results: [turn({ toolSequence: ["doc_batch"], answerRaw: "Utilities: 260.50" })],
    log: silent,
  });
  assert.equal(grading.gates, undefined);
});
