// Re-grade a SAVED harness transcript. Boots nothing: no server, no scratch DB,
// no llama-server, no model call. Reads a run artifact written by
// document-intelligence-skill-harness.mjs and runs the current grader over it.
//
//   node trash/plans/document-intelligence-epic/llamacpp-latency/replay-grading.mjs
//   node .../replay-grading.mjs var/docint-runs/provenance-2026-08-13T...json
//   node .../replay-grading.mjs --list
//
// With no path it takes the newest archived run. `--list` shows what is
// archived, newest first.
//
// Why this exists: every grader fix in this epic (round 8's markdown-emphasis
// false negative, round 9's SQL-vocabulary one, the fullMonthGate currency
// rule) was written from one run's transcript and validated by hand, because
// the harness printed its answers with every numeral redacted and wrote its one
// un-redacted artifact to a single fixed path that the next run overwrote at
// startup. So "does this fix flip that run?" could not be executed — only
// argued. It can now be executed, and the answer prints as a diff against the
// grading the run itself recorded.
//
// The archive lives under var/ (gitignored) and accumulates one file per run.

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildExpectations } from "../fixtures/household-gen/harness-gate.mjs";
import { resolveLadder } from "./provenance-ladder.mjs";
import { gradePhase } from "./grading.mjs";

const ARCHIVE_DIR = resolve(process.env.DOCINT_RUN_ARCHIVE_DIR ?? "var/docint-runs");
const LATEST_PATH = resolve("trash/plans/document-intelligence-epic/document-intelligence-run-answers.json");
// The harness's own default. Artifacts written before gradingInputs existed
// don't record the corpus root, and an EMPTY root is worse than a wrong one:
// the leak checks ask whether the answer contains it, and every string
// contains "". Falling back to the harness default keeps a pre-gradingInputs
// replay comparable instead of failing every run on a phantom path leak.
const DEFAULT_HOUSEHOLD = "/Users/lk/Projects/household";

async function archivedRuns() {
  try {
    const names = (await readdir(ARCHIVE_DIR)).filter(n => n.endsWith(".json"));
    // The run id embedded in the filename is an ISO timestamp with `:`/`.`
    // replaced, so lexical order is chronological order.
    return names.sort().reverse().map(n => join(ARCHIVE_DIR, n));
  } catch {
    return [];
  }
}

async function resolveArtifactPath(arg) {
  if (arg) return resolve(arg);
  const [newest] = await archivedRuns();
  if (newest) return newest;
  console.error(`no archived runs under ${ARCHIVE_DIR}; falling back to ${LATEST_PATH}`);
  return LATEST_PATH;
}

// Compare the re-graded result against whatever the run recorded, so the
// output answers "what did my grader change?" rather than just "what does the
// grader say?". A check that only exists on one side counts as a difference.
function diffGrading(recorded, replayed) {
  if (!recorded) return { comparable: false, reason: "the artifact records no grading (run failed before grading, or is pre-grading)" };
  const changedChecks = {};
  const names = new Set([...Object.keys(recorded.checks ?? {}), ...Object.keys(replayed.checks ?? {})]);
  for (const name of names) {
    const before = recorded.checks?.[name];
    const after = replayed.checks?.[name];
    if (JSON.stringify(before) !== JSON.stringify(after)) changedChecks[name] = { before, after };
  }
  const recordedFailures = new Set(recorded.failures ?? []);
  const replayedFailures = new Set(replayed.failures ?? []);
  return {
    comparable: true,
    statusBefore: recorded.status,
    statusAfter: replayed.status,
    statusChanged: recorded.status !== replayed.status,
    changedChecks,
    failuresResolved: [...recordedFailures].filter(f => !replayedFailures.has(f)),
    failuresIntroduced: [...replayedFailures].filter(f => !recordedFailures.has(f)),
  };
}

const args = process.argv.slice(2);

if (args.includes("--list")) {
  const runs = await archivedRuns();
  if (!runs.length) console.error(`no archived runs under ${ARCHIVE_DIR}`);
  for (const path of runs) {
    let label = "";
    try {
      const a = JSON.parse(await readFile(path, "utf8"));
      label = `${a.phase} ${a.model ?? "?"} turns=${a.results?.length ?? 0} recorded=${a.grading?.status ?? "none"}`;
    } catch (error) {
      label = `unreadable (${error?.message ?? error})`;
    }
    console.log(`${path}\n    ${label}`);
  }
  process.exit(0);
}

const artifactPath = await resolveArtifactPath(args.find(a => !a.startsWith("--")));
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const results = artifact.results ?? [];
if (!results.length) throw new Error(`${artifactPath} contains no turns to grade`);

const warnings = [];
const inputs = artifact.gradingInputs ?? {};
if (!artifact.gradingInputs) {
  warnings.push("artifact predates gradingInputs — ceilings and corpus root fall back to defaults, so wall-clock checks may not match the live run");
}
if (artifact.phase === "provenance" && !artifact.provenanceLadder) {
  warnings.push("artifact records no ladder name — grading against the default ladder, so successPromptTier may be attributed to the wrong rung");
}

const { name: ladderName, entries: ladderEntries } = resolveLadder(artifact.provenanceLadder);
const household = inputs.household || process.env.HOUSEHOLD_ROOT || DEFAULT_HOUSEHOLD;

// The oracle is read from the tracked fixture, not from the artifact — a
// replay should grade against today's ground truth, and the fixture is
// deterministic. If the oracle has genuinely changed since the run, that is a
// difference worth seeing rather than hiding.
let expectations = null;
if (artifact.period) {
  const oraclePath = resolve(process.env.ORACLE_PATH ?? inputs.oraclePath ?? "tests/fixtures/household-gen/ground-truth.json");
  const oracle = JSON.parse(await readFile(oraclePath, "utf8"));
  expectations = buildExpectations(oracle, artifact.period, { corpusRoot: household });
}

const replayed = gradePhase({
  phase: artifact.phase,
  results,
  expectations,
  household,
  timeoutMs: artifact.timeoutMs ?? 0,
  ladderName,
  ladderEntries,
  wallClockTotalCeilingMs: inputs.wallClockTotalCeilingMs ?? Infinity,
  wallClockPerTurnCeilingMs: inputs.wallClockPerTurnCeilingMs ?? Infinity,
});

console.log(JSON.stringify({
  replayOf: artifactPath,
  runId: artifact.runId ?? null,
  phase: artifact.phase,
  provider: artifact.provider,
  model: artifact.model,
  turns: results.length,
  ...(warnings.length ? { warnings } : {}),
  status: replayed.status,
  ...(replayed.gates ? { gates: replayed.gates } : {}),
  checks: replayed.checks,
  failures: replayed.failures,
  diff: diffGrading(artifact.grading, replayed),
}, null, 2));

if (replayed.status !== "pass") process.exitCode = 2;
