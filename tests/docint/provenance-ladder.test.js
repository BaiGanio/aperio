// Unit tests for provenance-ladder.mjs — the pure ladder-selection and
// success/capability-grading logic used by document-intelligence-skill-
// harness.mjs's provenance phase (T-G2.3). Run directly, same pattern as
// tests/fixtures/household-gen/harness-gate.test.mjs:
//
//   node --test "trash/plans/document-intelligence-epic/llamacpp-latency/provenance-ladder.test.mjs"
//
// Not part of the main `npm test` glob (tests/unit|integration|e2e|harness
// only) — this harness is a manual/isolated diagnostic on the developer's
// own hardware, not a CI assertion, matching the rest of this directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVENANCE_LADDERS,
  DEFAULT_PROVENANCE_LADDER,
  resolveLadder,
  capabilityClaimForTier,
  computeProvenanceSuccess,
} from "./provenance-ladder.mjs";

test("resolveLadder defaults to mechanism when unset", () => {
  const { name, entries } = resolveLadder(undefined);
  assert.equal(name, "mechanism");
  assert.equal(entries, PROVENANCE_LADDERS.mechanism);
  assert.equal(DEFAULT_PROVENANCE_LADDER, "mechanism");
});

test("resolveLadder accepts natural, case-insensitively", () => {
  const { name, entries } = resolveLadder("Natural");
  assert.equal(name, "natural");
  assert.equal(entries, PROVENANCE_LADDERS.natural);
});

test("resolveLadder throws loudly on an unrecognized value, not a silent fallback", () => {
  assert.throws(() => resolveLadder("mechanisms"), /DOCINT_PROVENANCE_LADDER must be one of/);
});

test("the natural ladder never uses SQL/database vocabulary at any rung", () => {
  const banned = /\bSQL\b|\bquery\b|\bGROUP BY\b|\bSUM\b|\bINSERT\b|\bdatabase\b|\btable\b/i;
  for (const entry of PROVENANCE_LADDERS.natural) {
    assert.doesNotMatch(entry.text, banned, `natural-ladder rung leaked technical vocabulary: "${entry.text}"`);
    assert.equal(entry.tier, "natural");
  }
});

test("the mechanism ladder's later rungs dictate literal SQL; earlier ones don't", () => {
  const tiers = PROVENANCE_LADDERS.mechanism.map(e => e.tier);
  assert.equal(tiers[0], "opening");
  assert.ok(tiers.slice(1, 3).every(t => t === "named-mechanism"));
  assert.ok(tiers.slice(3).every(t => t === "dictated-sql"));
  const firstDictated = PROVENANCE_LADDERS.mechanism.find(e => e.tier === "dictated-sql");
  assert.match(firstDictated.text, /SELECT .* GROUP BY/);
});

test("capabilityClaimForTier: only dictated-sql counts as mechanism-conformance", () => {
  assert.equal(capabilityClaimForTier("dictated-sql"), "mechanism-conformance");
  assert.equal(capabilityClaimForTier("opening"), "realistic-usage");
  assert.equal(capabilityClaimForTier("named-mechanism"), "realistic-usage");
  assert.equal(capabilityClaimForTier("natural"), "realistic-usage");
});

function turn({ status = "completed", toolSequence = [], toolCalls = [], answerRaw = "" } = {}) {
  return { status, toolSequence, toolCalls, answerRaw };
}

const alwaysReturnedRows = () => true;
const alwaysNarratesTotal = () => true;
const neverReturnedRows = () => false;
const neverNarratesTotal = () => false;

test("computeProvenanceSuccess: no success when the last turn never called db_query", () => {
  const results = [turn(), turn({ toolSequence: [] })];
  const out = computeProvenanceSuccess({
    results,
    ladderEntries: PROVENANCE_LADDERS.mechanism,
    dbQueryReturnedRows: alwaysReturnedRows,
    hasNarratedDecimalTotal: alwaysNarratesTotal,
  });
  assert.deepEqual(out, { successTurn: null, successPromptTier: null, capabilityClaim: null });
});

test("computeProvenanceSuccess: no success when db_query returned no rows, even with a decimal-shaped answer", () => {
  const results = [turn({ toolSequence: ["db_query"] })];
  const out = computeProvenanceSuccess({
    results,
    ladderEntries: PROVENANCE_LADDERS.mechanism,
    dbQueryReturnedRows: neverReturnedRows,
    hasNarratedDecimalTotal: alwaysNarratesTotal,
  });
  assert.equal(out.successTurn, null);
});

test("computeProvenanceSuccess: success on turn 0 (opening) reports realistic-usage", () => {
  const results = [turn({ toolSequence: ["db_query"] })];
  const out = computeProvenanceSuccess({
    results,
    ladderEntries: PROVENANCE_LADDERS.mechanism,
    dbQueryReturnedRows: alwaysReturnedRows,
    hasNarratedDecimalTotal: alwaysNarratesTotal,
  });
  assert.deepEqual(out, { successTurn: 0, successPromptTier: "opening", capabilityClaim: "realistic-usage" });
});

test("computeProvenanceSuccess: success on a dictated-sql rung (turn 3) reports mechanism-conformance", () => {
  const results = [turn(), turn(), turn(), turn({ toolSequence: ["db_query"] })];
  const out = computeProvenanceSuccess({
    results,
    ladderEntries: PROVENANCE_LADDERS.mechanism,
    dbQueryReturnedRows: alwaysReturnedRows,
    hasNarratedDecimalTotal: alwaysNarratesTotal,
  });
  assert.deepEqual(out, { successTurn: 3, successPromptTier: "dictated-sql", capabilityClaim: "mechanism-conformance" });
});

test("computeProvenanceSuccess: natural ladder always reports realistic-usage on success, at any turn", () => {
  const results = [turn(), turn(), turn(), turn(), turn(), turn({ toolSequence: ["db_query"] })];
  const out = computeProvenanceSuccess({
    results,
    ladderEntries: PROVENANCE_LADDERS.natural,
    dbQueryReturnedRows: alwaysReturnedRows,
    hasNarratedDecimalTotal: alwaysNarratesTotal,
  });
  assert.deepEqual(out, { successTurn: 5, successPromptTier: "natural", capabilityClaim: "realistic-usage" });
});

test("computeProvenanceSuccess: a raw tool ack (no real narration) is not success", () => {
  const results = [turn({ toolSequence: ["db_query"] })];
  const out = computeProvenanceSuccess({
    results,
    ladderEntries: PROVENANCE_LADDERS.mechanism,
    dbQueryReturnedRows: alwaysReturnedRows,
    hasNarratedDecimalTotal: neverNarratesTotal,
  });
  assert.equal(out.successTurn, null);
});
