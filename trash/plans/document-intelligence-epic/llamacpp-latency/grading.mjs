// The T-G2 gate's grader, extracted from document-intelligence-skill-harness.mjs
// (round 9) for the same reason grading-predicates.mjs was: the harness module
// runs a top-level `try` that boots a server, a scratch DB and (for llamacpp) a
// whole llama-server, so nothing could reach the grading logic without paying
// for a full live run. Every grader fix in this epic so far has been written
// from one run's transcript and hand-validated against it, because re-grading a
// recorded run was not a thing the rig could do — see tech-debt.md, "the
// harness's stdout dump cannot be re-graded".
//
// With the grader here and the transcript written to a per-run artifact, a
// saved run can be replayed through a changed grader in a second, with no model
// and no server: `node replay-grading.mjs <artifact.json>`.
//
// This is a pure function of its arguments — no module-level env reads, no
// process state. Callers pass the same values the harness resolves from env, so
// a replay grades under the recorded run's ceilings rather than the current
// shell's.

import { evaluateAnswer, parseCategoryClaims } from "../../../../tests/fixtures/household-gen/harness-gate.mjs";
import { computeProvenanceSuccess } from "./provenance-ladder.mjs";
import {
  hasNarratedDecimalTotal,
  dbQueryReturnedRows,
  citesQueryProvenance,
} from "./grading-predicates.mjs";

/**
 * @param {object} input
 * @param {"routing"|"coverage"|"provenance"} input.phase
 * @param {Array<object>} input.results          per-turn transcript entries
 * @param {object|null} [input.expectations]     buildExpectations() output, or null
 * @param {string} [input.household]             private corpus root (leak check)
 * @param {number} [input.timeoutMs]             per-turn stuck-turn abort, for the message text
 * @param {string} [input.ladderName]            provenance ladder in force
 * @param {Array<object>} [input.ladderEntries]  its rungs, for tier attribution
 * @param {number} [input.wallClockTotalCeilingMs]
 * @param {number} [input.wallClockPerTurnCeilingMs]
 * @param {(msg: string) => void} [input.log]    where the capability-claim line goes
 * @returns {{status: "pass"|"fail", checks: object, failures: string[]}}
 */
export function gradePhase({
  phase,
  results,
  expectations = null,
  household = "",
  timeoutMs = 0,
  ladderName = null,
  ladderEntries = [],
  wallClockTotalCeilingMs = Infinity,
  wallClockPerTurnCeilingMs = Infinity,
  log = msg => console.error(msg),
} = {}) {
  const failures = [];
  const checks = {};
  // `answer.includes("")` is true for every string, so an unknown corpus root
  // would report a path leak on every single run. Treat "no root supplied" as
  // "nothing to leak": the harness always supplies one, so this only bites a
  // replay of an artifact written before the root was recorded.
  const leaksCorpusPath = answer => Boolean(household) && String(answer ?? "").includes(household);

  if (phase === "routing") {
    const r = results[0];
    const claims = parseCategoryClaims(r.answerRaw);
    const utilities = claims.get("Utilities") ?? [];
    // The auto doc_manifest→doc_batch preflight (WS0-R) resolves the manifest
    // step server-side and feeds its bounded, scored candidate list straight
    // into doc_batch's own arguments — it does not necessarily appear as a
    // second, separately-visible tool_start. A manifest-shaped candidate list
    // (selection_reason/score per entry, more than one document, no single
    // hardcoded path) is equally strong evidence that discovery preceded
    // reading; see the 2026-08-01/08-02 T-R5 evidence log, which records this
    // exact toolSequence:[doc_batch] shape as the passing pattern.
    const batchCall = r.toolCalls.find(c => c.name === "doc_batch");
    const candidates = batchCall?.arguments?.candidates ?? [];
    const manifestShaped = candidates.length > 0 && candidates.every(c => "selection_reason" in c || "score" in c);
    checks.usedManifestThenBatch =
      r.toolSequence.includes("doc_batch") &&
      (r.toolSequence.indexOf("doc_manifest") === -1
        ? manifestShaped
        : r.toolSequence.indexOf("doc_manifest") < r.toolSequence.indexOf("doc_batch"));
    checks.noPerFileLoop = r.toolSequence.filter(t => t === "doc_batch").length <= 1;
    checks.utilitiesExact = utilities.some(v => Math.abs(v - 260.5) < 0.005);
    checks.noHardcodedFolderPath = !leaksCorpusPath(r.answerRaw);
    checks.completed = r.status === "completed";
    if (!checks.usedManifestThenBatch) failures.push("did not route through a bounded manifest before doc_batch");
    if (!checks.noPerFileLoop) failures.push("doc_batch was called more than once (per-file loop)");
    if (!checks.utilitiesExact) failures.push(`Utilities not exact — found ${utilities.join("/") || "nothing"}`);
    if (!checks.noHardcodedFolderPath) failures.push("answer leaked the private corpus path");
    if (!checks.completed) failures.push(`turn did not complete (status=${r.status})`);
  }

  if (phase === "coverage") {
    const r = results[0];
    checks.completedOrBounded = r.status === "completed" || r.status === "timeout";
    // See the routing-phase comment: the auto-preflight may resolve the
    // manifest step server-side and surface only doc_batch, with the bounded
    // candidate list visible in its own arguments.
    const batchCall = r.toolCalls.find(c => c.name === "doc_batch");
    const candidates = batchCall?.arguments?.candidates ?? [];
    const manifestShaped = candidates.length > 0 && candidates.every(c => "selection_reason" in c || "score" in c);
    checks.enumeratedBeforeReading =
      r.toolSequence.includes("doc_manifest") || r.toolSequence.includes("doc_repos") ||
      (r.toolSequence.includes("doc_batch") && manifestShaped);
    // With 200+ documents against a 48-candidate bound, an honest answer must
    // disclose that it did not cover everything — either explicit coverage
    // counts (found/read/skipped) or plain language admitting a partial scope.
    checks.disclosesCoverageOrBound = /\b\d+\s*(of|out of)\s*\d+|found|read|skipped|covered|not all|partial|limited to|only (checked|read)/i.test(r.answerRaw);
    checks.noOracleExposure = !/ground[- ]truth|oracle|answer key/i.test(r.answerRaw);
    checks.noHardcodedFolderPath = !leaksCorpusPath(r.answerRaw);
    if (r.status === "timeout") failures.push(`timed out at ${timeoutMs}ms without reporting a bound before the cutoff`);
    if (!checks.enumeratedBeforeReading) failures.push("did not build a manifest before batch-reading");
    if (!checks.disclosesCoverageOrBound) failures.push("answer does not disclose coverage or an explicit bound over the oversized corpus");
    if (!checks.noOracleExposure) failures.push("the answer references the oracle");
    if (!checks.noHardcodedFolderPath) failures.push("answer leaked the private corpus path");
  }

  if (phase === "provenance") {
    // The last turn that actually did something — not the literal last turn.
    // `.at(-1)` is right while the ladder stops on a satisfied turn (then the
    // last turn IS the answering turn), but a per-turn hard timeout keeps the
    // ladder escalating into the known empty-turn cascade (~4,000ms turns, no
    // tools, no answer, 0 tokens). Grading those graded nothing: on the
    // 2026-08-13 forced-skill run it reported calledDbQueryAfterConfirm and
    // dbQueryReturnedRealRows as false while turn 3 had genuinely called
    // db_query after the confirm and got 8 rows back — and both prose checks
    // are gated on dbQueryReturnedRealRows, so they failed with it. Same class
    // as the insertedRealRows grader bug fixed earlier in this epic: a check
    // reading the wrong slice of the transcript. Identical behavior on a
    // clean run (the last turn has content, so it is still the one picked);
    // falls back to the literal last turn when nothing has content at all,
    // so the checks stay false rather than throwing.
    const followUpTurn = [...results].reverse().find(
      r => (r.toolSequence?.length ?? 0) > 0 || String(r.answerRaw ?? "").trim() !== "",
    ) ?? results.at(-1);
    const allToolNames = results.flatMap(r => r.toolSequence);
    const allToolCalls = results.flatMap(r => r.toolCalls);
    checks.calledDbExecute = allToolNames.includes("db_execute");
    checks.interruptApproved = results.some(r => r.interruptApproved);
    // Mechanical, not prose-based: a CREATE TABLE with rowsAffected:0 and no
    // INSERT ever attempted (the 2026-08-02 gemma4 failure) must not count as
    // "the writable-destination path exercised" just because db_execute was
    // called at all — something in this conversation must have actually
    // affected a row via an INSERT statement.
    checks.insertedRealRows = insertedRealRows(allToolCalls, results.map(r => String(r.answerRaw ?? "")));
    checks.calledDbQueryAfterConfirm = followUpTurn?.toolSequence.includes("db_query") ?? false;
    // Same reasoning as followUpSatisfied in the harness: db_query being
    // *called* proves nothing about what it returned. Gate the two prose checks
    // below on the follow-up turn's own db_query having actually come back with
    // rows — otherwise an honest "the query returned no results, so from
    // memory..." admission (which mentions "query" and still states a decimal
    // figure) sails through both checks unfixed, exactly as it did on gemma4.
    checks.dbQueryReturnedRealRows = dbQueryReturnedRows(followUpTurn?.toolCalls);
    checks.followUpCitesSql = checks.dbQueryReturnedRealRows && citesQueryProvenance(followUpTurn?.answerRaw);
    checks.followUpNarratesDecimalTotal = checks.dbQueryReturnedRealRows && hasNarratedDecimalTotal(followUpTurn?.answerRaw);
    // Which turn actually satisfied the escalation loop (mirrors
    // followUpSatisfied's own stop condition — see provenance-ladder.mjs)
    // and what tier of prompt got it there. A pass earned only once the
    // ladder reached a "dictated-sql" rung is a much weaker claim than one
    // earned on an early or natural-language rung; grading.status alone
    // doesn't distinguish them, so this is recorded explicitly rather than
    // left for a human to re-derive from the transcript every time.
    const provenanceSuccess = computeProvenanceSuccess({
      results,
      ladderEntries,
      dbQueryReturnedRows,
      hasNarratedDecimalTotal,
    });
    checks.provenanceLadder = ladderName;
    checks.successTurn = provenanceSuccess.successTurn;
    checks.successPromptTier = provenanceSuccess.successPromptTier;
    checks.capabilityClaim = provenanceSuccess.capabilityClaim;
    if (checks.capabilityClaim === "mechanism-conformance") {
      log(`HARNESS provenance success turn=${checks.successTurn} tier=${checks.successPromptTier} — mechanism-conformance, not realistic-usage`);
    } else if (checks.capabilityClaim === "realistic-usage") {
      log(`HARNESS provenance success turn=${checks.successTurn} tier=${checks.successPromptTier} — realistic-usage`);
    }
    checks.completed = results.every(r => r.status === "completed");
    const totalWallMs = results.reduce((sum, r) => sum + r.wallMs, 0);
    const maxTurnWallMs = Math.max(...results.map(r => r.wallMs));
    checks.withinTotalWallClockCeiling = totalWallMs <= wallClockTotalCeilingMs;
    checks.withinPerTurnWallClockCeiling = maxTurnWallMs <= wallClockPerTurnCeilingMs;
    if (!checks.withinTotalWallClockCeiling) failures.push(`total wall time ${totalWallMs}ms exceeds the ${wallClockTotalCeilingMs}ms T-L4 ceiling`);
    if (!checks.withinPerTurnWallClockCeiling) failures.push(`a single turn took ${maxTurnWallMs}ms, exceeding the ${wallClockPerTurnCeilingMs}ms T-L4 per-turn ceiling`);
    if (!checks.calledDbExecute) failures.push("db_execute was never proposed — no writable-destination path exercised");
    if (checks.calledDbExecute && !checks.interruptApproved) failures.push("db_execute was proposed but the confirm interrupt was never observed/approved");
    if (!checks.insertedRealRows) failures.push("no confirmed db_execute INSERT with rowsAffected>0 was ever observed — rows were never actually written, regardless of what the answer claims");
    if (!checks.calledDbQueryAfterConfirm) failures.push("follow-up turn did not call db_query for the SQL-derived total");
    if (checks.calledDbQueryAfterConfirm && !checks.dbQueryReturnedRealRows) failures.push("follow-up turn's db_query returned zero rows — any total in the answer is not sourced from the database");
    if (!checks.followUpCitesSql) failures.push("follow-up answer does not cite a genuine (non-empty) SQL query result as the source of the figure");
    if (!checks.followUpNarratesDecimalTotal) failures.push("follow-up answer does not narrate an actual decimal total backed by a genuine query result");
    if (!checks.completed) failures.push("one or more turns did not complete");

    if (expectations) {
      const combinedAnswer = results.map(r => r.answerRaw).join("\n---\n");
      const evaluation = evaluateAnswer({
        answer: combinedAnswer,
        toolSequence: allToolNames,
        toolCalls: allToolCalls,
        expectations,
      });
      checks.fullMonthGate = evaluation.status === "pass";
      checks.noFxBlend = evaluation.gate.noExcludedLeak;
      if (!checks.fullMonthGate) failures.push(...evaluation.failures.map(f => `full-month gate: ${f}`));
    }
  }

  return { status: failures.length === 0 ? "pass" : "fail", checks, failures };
}

// T-G2.3's actual claim is that the model wrote real rows and then read them
// back — prose alone can't prove that (a model that never inserted anything
// can still write a decimal-shaped sentence). This check looks past the
// model's words at the tool evidence itself: did any confirmed db_execute
// INSERT actually affect a row. The 2026-08-02 gemma4 run had a CREATE TABLE
// with rowsAffected:0 and no INSERT ever attempted, then a db_query that
// correctly returned zero rows — this catches exactly that.
// 2026-08-13 T-L4.2 cache-run: this originally scanned only toolCalls[].detail
// for the confirmed rowsAffected — but the propose→confirm flow's SECOND
// phase (the actual execution, after the WS interrupt is approved) is never
// delivered as a paired `tool_result` event for the original db_execute
// tool_start. It arrives as a plain "✅ Executed on <connection>… {rowsAffected:N,…}"
// assistant message, often on a LATER turn than the one that proposed the
// write — so toolCalls[].detail always shows the propose step's own
// "Pending your confirmation" ack, never the real number, regardless of
// whether the INSERT actually landed. This made the check structurally blind
// to a genuine success, not just to the known CREATE-TABLE-only failure mode
// it was written for. Scan every turn's own answer text too.
export function insertedRealRows(toolCalls, allAnswers = []) {
  const hasInsertProposal = toolCalls.some(call =>
    call.name === "db_execute" && /^\s*insert\b/i.test(String(call.arguments?.sql ?? "")));
  if (!hasInsertProposal) return false;
  const evidence = [
    ...toolCalls.map(call => `${call.summary ?? ""} ${call.detail ?? ""}`),
    ...allAnswers,
  ].join(" ");
  // matchAll, not match: a CREATE TABLE's own rowsAffected:0 ack can appear
  // earlier in the concatenated evidence than a later INSERT's rowsAffected>0
  // one — the first match alone would silently prefer the wrong one.
  return [...evidence.matchAll(/"rowsAffected"\s*:\s*(\d+)/g)].some(m => Number(m[1]) > 0);
}
