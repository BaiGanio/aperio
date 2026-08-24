// T3 — audit/scripts/schema.js (aperio-continuous-audit-tests.md, T3.1/T3.2).
//
// Verify-first proof for the finding/run record schema: an incomplete finding
// is rejected with every missing field named (T3.1), and the finding
// lifecycle only accepts the transitions the plan's stateDiagram draws,
// preserving history across a reopen (T3.2).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateFinding, validateRun, transitionFinding, SCHEMA, DEFAULT_USAGE_SOURCE } from "../scripts/schema.js";

const VALID_FINDING = {
  id: "F-001",
  title: "example",
  severity: "high",
  confidence: "high",
  affectedPaths: [{ file: "lib/example.js", line: 42 }],
  violatedInvariant: "example invariant",
  reproduction: "run X, observe Y",
  expected: "Y",
  actual: "Z",
  impact: "example impact",
  evidence: "example evidence",
  suggestedMitigation: "example mitigation",
  regressionTestLocation: "tests/unit/example.test.js",
  status: "Candidate",
};

const VALID_RUN = {
  runId: "A14-2026-08-20-01",
  baselineSha: "a".repeat(40),
  lens: "code reviewer",
  scope: "A14",
  filesRead: ["db/index.js"],
  commandsRun: ["node --test audit/tests/database-contract.test.js"],
  model: "deepseek-chat",
  provider: "deepseek",
  tokens: { input: 100, cachedInput: 0, reasoning: 0, output: 50 },
  candidates: [],
  confirmedFindings: [],
  rejectedCandidates: [],
  residualUncertainty: "none",
  elapsedMs: 1000,
};

describe("audit/scripts/schema.js", () => {
  test("T3.1 — a complete finding validates clean", () => {
    assert.deepStrictEqual(validateFinding(VALID_FINDING), { valid: true, errors: [] });
  });

  test("T3.1 — a finding missing reproduction, revision-bearing evidence, invariant, and file/line is rejected " +
    "and every missing field is named", () => {
    const incomplete = { id: "F-002", title: "incomplete", severity: "high", confidence: "high" };
    const result = validateFinding(incomplete);
    assert.strictEqual(result.valid, false);
    for (const field of [
      "affectedPaths", "violatedInvariant", "reproduction", "expected", "actual",
      "impact", "evidence", "suggestedMitigation", "regressionTestLocation", "status",
    ]) {
      assert.ok(
        result.errors.some((e) => e.includes(field)),
        `expected an error naming "${field}", got: ${JSON.stringify(result.errors)}`
      );
    }
  });

  test("T3.1 — severity cannot substitute for confidence (independent enums, both checked)", () => {
    const bad = { ...VALID_FINDING, severity: "urgent", confidence: "definitely" };
    const result = validateFinding(bad);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.startsWith("severity must be")));
    assert.ok(result.errors.some((e) => e.startsWith("confidence must be")));
  });

  test("T3.1 — affectedPaths entries must carry file+line, not prose", () => {
    const bad = { ...VALID_FINDING, affectedPaths: ["lib/example.js:42"] };
    const result = validateFinding(bad);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("affectedPaths[0]")));
  });

  test("T3.1 — a complete run record validates clean", () => {
    assert.deepStrictEqual(validateRun(VALID_RUN), { valid: true, errors: [] });
  });

  test("T3.1 — usageSource is optional on a run record and enum-checked when present, " +
    "so a canonical record composes with the T3.3 accounting layer unchanged", () => {
    // Omitted: a run record is a record of a run that happened, so its tokens
    // are the provider's. usage-accounting.js defaults it to DEFAULT_USAGE_SOURCE
    // rather than rejecting the shape the plan's Step 3 lists.
    assert.strictEqual(VALID_RUN.usageSource, undefined);
    assert.deepStrictEqual(validateRun(VALID_RUN), { valid: true, errors: [] });
    assert.strictEqual(DEFAULT_USAGE_SOURCE, "provider-reported");

    for (const usageSource of SCHEMA.USAGE_SOURCES) {
      assert.deepStrictEqual(validateRun({ ...VALID_RUN, usageSource }), { valid: true, errors: [] });
    }

    // Present but wrong is an error — a budget projection mislabelled here
    // would be summed into the actual cost column and could never be undone.
    const bad = validateRun({ ...VALID_RUN, usageSource: "guess" });
    assert.strictEqual(bad.valid, false);
    assert.ok(bad.errors.some((e) => e.includes("usageSource must be one of")));
  });

  test("T3.1 — runId must be a non-empty string, not merely present, because it is " +
    "the address the T3.3 ledger de-duplicates by", () => {
    for (const runId of [undefined, null, "", "   ", 0, 7, true, { id: "A14" }, ["A14"]]) {
      const result = validateRun({ ...VALID_RUN, runId });
      assert.strictEqual(result.valid, false, `runId ${JSON.stringify(runId)} was accepted`);
      assert.ok(result.errors.some((e) => e.includes("runId")),
        `expected an error naming runId, got: ${JSON.stringify(result.errors)}`);
    }
    // `runId: 0` is the sharp case: it clears the required-field check but
    // usage-accounting.js reads it as absent, so the record would be
    // schema-valid and unaddressable at the same time.
    assert.ok(validateRun({ ...VALID_RUN, runId: 0 }).errors
      .some((e) => e.includes("runId must be a non-empty string")));
  });

  test("T3.1 — a run missing token accounting is rejected per-field", () => {
    const bad = { ...VALID_RUN, tokens: { input: 100 } };
    const result = validateRun(bad);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("tokens.cachedInput")));
    assert.ok(result.errors.some((e) => e.includes("tokens.reasoning")));
    assert.ok(result.errors.some((e) => e.includes("tokens.output")));
  });

  test("T3.2 — valid transitions pass: Candidate -> Confirmed -> Planned -> Fixed", () => {
    let f = { ...VALID_FINDING, status: "Candidate" };
    for (const to of ["Confirmed", "Planned", "Fixed"]) {
      const result = transitionFinding(f, to);
      assert.strictEqual(result.ok, true, `${f.status} -> ${to} should be valid`);
      f = result.finding;
    }
    assert.strictEqual(f.status, "Fixed");
    assert.deepStrictEqual(f.history.map((h) => `${h.from}->${h.to}`), [
      "Candidate->Confirmed", "Confirmed->Planned", "Planned->Fixed",
    ]);
  });

  test("T3.2 — invalid transition Rejected -> Fixed fails with a reason", () => {
    const rejected = { ...VALID_FINDING, status: "Rejected" };
    const result = transitionFinding(rejected, "Fixed");
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /invalid transition Rejected -> Fixed/);
  });

  test("T3.2 — reopening a fixed finding preserves its full history", () => {
    const fixed = {
      ...VALID_FINDING,
      status: "Fixed",
      history: [
        { from: "Candidate", to: "Confirmed", at: "t0" },
        { from: "Confirmed", to: "Planned", at: "t1" },
        { from: "Planned", to: "Fixed", at: "t2" },
      ],
    };
    const result = transitionFinding(fixed, "Reopened");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.finding.status, "Reopened");
    assert.strictEqual(result.finding.history.length, 4);
    assert.deepStrictEqual(result.finding.history.slice(0, 3), fixed.history);
    assert.strictEqual(result.finding.history[3].from, "Fixed");
    assert.strictEqual(result.finding.history[3].to, "Reopened");
  });

  test("T5.1 red/green proof — every declared status has a reachable transition edge except " +
    "the documented terminal states", () => {
    // DocumentationOnly joins the terminal set for the reason recorded in
    // schema.js: the decision is the whole outcome. IssueFiled deliberately
    // does NOT — it keeps Planned's `-> Fixed` edge, because a filed issue is
    // work that is still owed.
    const terminal = ["Rejected", "Duplicate", "AcceptedRisk", "DocumentationOnly", "Reopened"];
    for (const status of SCHEMA.STATUSES) {
      if (terminal.includes(status)) {
        assert.strictEqual(SCHEMA.TRANSITIONS[status], undefined, `${status} should have no outgoing edge`);
      } else {
        assert.ok(SCHEMA.TRANSITIONS[status]?.length > 0, `${status} should have at least one outgoing edge`);
      }
    }
  });
});
