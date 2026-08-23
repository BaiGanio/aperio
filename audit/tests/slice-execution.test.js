// T6 — slice execution (aperio-continuous-audit-tests.md T6.1-T6.4;
// aperio-continuous-audit.md Step 6). Pure validation: no GitHub, no cloud
// provider, no model, no server/MCP process. Reuses audit/scripts/schema.js's
// status vocabulary and transition table instead of inventing a second one.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SLICE_REPORT_REQUIRED_FIELDS,
  DEFERRAL_REQUIRED_FIELDS,
  LEDGER_TOKEN_KEYS,
  AUDIT_SLICE_IDS,
  CONFIRMATION_REQUIRED_FIELDS,
  checkSliceExitGate,
  checkWaveExitGate,
  classifyCandidateEvidence,
  checkCandidateEscalation,
  checkLensBudget,
  classifyDuplicate,
  resolveAnchorInTree,
} from "../scripts/slice-execution.js";
import { SCHEMA } from "../scripts/schema.js";

// The ledger's key set, not schema.js's smaller one: cacheCreationInput is
// mandatory on a durable run row (aperio-continuous-audit.md §4.8).
const TOKENS = { input: 12_000, cachedInput: 0, cacheCreationInput: 0, reasoning: 0, output: 800 };

/** A minimal but complete A14-shaped slice report, per Step 6's exit gate. */
function completeReport(overrides = {}) {
  return {
    slice: "A14",
    revision: "ad1d6ce365e0",
    scope: "db/index.js, db/sqlite/store.js, db/postgres/store.js",
    lens: "code reviewer",
    // A real 64-character hex digest: the fixture carried a 63-character paste
    // until the exit gate started checking the shape computeManifestHash() emits.
    manifestHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    commandsRun: ["npm run test:audit:database-contract"],
    tokens: { ...TOKENS },
    candidates: [{ id: "A14-C1", status: "Rejected" }],
    cleanInvariants: ["SQLite/Postgres migration parity"],
    residualUncertainty: "none identified",
    ...overrides,
  };
}

function deferral(overrides = {}) {
  return {
    slice: "A21",
    deferred: true,
    reason: "codegraph watcher fixture not yet isolated from the real DB",
    owner: "lkikov",
    trigger: "2026-09-01 or when A21 fixture harness lands",
    ...overrides,
  };
}

describe("audit/scripts/slice-execution.js — T6.1 exit gate", () => {
  test("a complete slice report passes and is classified complete", () => {
    const result = checkSliceExitGate(completeReport());
    assert.strictEqual(result.complete, true, JSON.stringify(result.errors));
    assert.strictEqual(result.classification, "complete");
    assert.deepStrictEqual(result.errors, []);
  });

  test("every exit-gate field is required, one at a time", () => {
    for (const field of SLICE_REPORT_REQUIRED_FIELDS) {
      const report = completeReport();
      delete report[field];
      const result = checkSliceExitGate(report);
      assert.strictEqual(result.complete, false, `expected missing ${field} to fail the exit gate`);
      assert.ok(
        result.errors.some((e) => e.includes(field)),
        `expected an error naming "${field}", got ${JSON.stringify(result.errors)}`,
      );
    }
  });

  test("a deferred slice with reason, owner, and trigger/date is valid but NOT counted complete", () => {
    const result = checkSliceExitGate(deferral());
    assert.strictEqual(result.classification, "deferred");
    assert.strictEqual(result.complete, false);
    assert.deepStrictEqual(result.errors, []);
  });

  test("a deferred slice missing reason, owner, or trigger fails and is not silently accepted", () => {
    for (const field of DEFERRAL_REQUIRED_FIELDS.filter((f) => f !== "slice")) {
      const report = deferral();
      delete report[field];
      const result = checkSliceExitGate(report);
      assert.strictEqual(result.classification, "deferred");
      assert.strictEqual(result.complete, false);
      assert.ok(result.errors.some((e) => e.includes(field)));
    }
  });

  test("malformed input: null, a string, and an array are rejected without throwing", () => {
    for (const bad of [null, undefined, "A14", [], 42]) {
      const result = checkSliceExitGate(bad);
      assert.strictEqual(result.complete, false);
      assert.ok(result.errors.length > 0);
    }
  });

  test("boundary: candidates must carry a valid status/outcome from the schema vocabulary", () => {
    const result = checkSliceExitGate(completeReport({ candidates: [{ id: "A14-C1", status: "Maybe" }] }));
    assert.strictEqual(result.complete, false);
    assert.ok(result.errors.some((e) => e.includes("A14-C1") || e.includes("candidates[0]")));
  });

  test("negative: a candidate outcome with no id cannot be tied back to a candidate", () => {
    for (const bad of [[{ status: "Rejected" }], [{ id: "   ", status: "Rejected" }],
      [{ id: 7, status: "Rejected" }], [["A14-C1", "Rejected"]],
      [{ id: "A14-C1", status: "Rejected" }, { status: "Confirmed" }]]) {
      const result = checkSliceExitGate(completeReport({ candidates: bad }));
      assert.strictEqual(result.complete, false, `expected candidates=${JSON.stringify(bad)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("candidates[") && e.includes("non-empty string id")));
    }
  });

  test("negative: a cleanInvariants entry that names no invariant is a claim of coverage, not coverage", () => {
    for (const bad of [[{}], [null], ["   "], [""], [42], ["real invariant", {}]]) {
      const result = checkSliceExitGate(completeReport({ cleanInvariants: bad }));
      assert.strictEqual(result.complete, false, `expected cleanInvariants=${JSON.stringify(bad)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("cleanInvariants[")));
    }
  });

  test("boundary: an empty candidates/cleanInvariants array is present, not missing, and passes", () => {
    const result = checkSliceExitGate(completeReport({ candidates: [], cleanInvariants: [] }));
    assert.strictEqual(result.complete, true, JSON.stringify(result.errors));
  });

  test("boundary: tokens must be the {input, cachedInput, reasoning, output} shape, not a bare number", () => {
    const result = checkSliceExitGate(completeReport({ tokens: 12_800 }));
    assert.strictEqual(result.complete, false);
    assert.ok(result.errors.some((e) => e.includes("tokens")));
  });

  test("negative: negative, NaN, and infinite token counts are rejected, not merely non-numbers", () => {
    for (const bad of [-1, NaN, Infinity]) {
      const result = checkSliceExitGate(completeReport({ tokens: { ...TOKENS, output: bad } }));
      assert.strictEqual(result.complete, false, `expected tokens.output=${bad} to fail`);
      assert.ok(result.errors.some((e) => e.includes("tokens.output")));
    }
  });

  test("negative: a report the durable ledger would reject is not classified complete", () => {
    // ledger.js refuses a run row whose tokens omit cacheCreationInput, so the
    // exit gate must not approve the same record first.
    const tokens = { ...TOKENS };
    delete tokens.cacheCreationInput;
    const result = checkSliceExitGate(completeReport({ tokens }));
    assert.strictEqual(result.complete, false);
    assert.ok(result.errors.some((e) => e.includes("cacheCreationInput")));
    assert.ok(result.errors.some((e) => e.includes("not recorded")));
  });

  test("negative: every ledger token key, including the cache-write count, must be a finite count", () => {
    for (const key of LEDGER_TOKEN_KEYS) {
      for (const bad of [undefined, null, -1, NaN, Infinity, "0", {}]) {
        const result = checkSliceExitGate(completeReport({ tokens: { ...TOKENS, [key]: bad } }));
        assert.strictEqual(result.complete, false, `expected tokens.${key}=${JSON.stringify(bad)} to fail`);
        assert.ok(result.errors.some((e) => e.includes(`tokens.${key}`)));
      }
    }
  });

  test("negative: cachedInput plus cacheCreationInput may not exceed input — both are parts of it", () => {
    const result = checkSliceExitGate(completeReport({
      tokens: { ...TOKENS, input: 1_000, cachedInput: 900, cacheCreationInput: 200 },
    }));
    assert.strictEqual(result.complete, false);
    assert.ok(result.errors.some((e) => e.includes("exceeds tokens.input")));
  });

  test("negative: reasoning may not exceed output — it is a breakdown of output, not an addition", () => {
    const result = checkSliceExitGate(completeReport({
      tokens: { ...TOKENS, reasoning: 900, output: 800 },
    }));
    assert.strictEqual(result.complete, false);
    assert.ok(result.errors.some((e) => e.includes("exceeds tokens.output")));
  });

  test("boundary: reasoning exactly equal to output is a valid record", () => {
    const result = checkSliceExitGate(completeReport({
      tokens: { ...TOKENS, reasoning: 800, output: 800 },
    }));
    assert.strictEqual(result.complete, true, JSON.stringify(result.errors));
  });

  test("boundary: cachedInput plus cacheCreationInput exactly equal to input is a valid record", () => {
    const result = checkSliceExitGate(completeReport({
      tokens: { ...TOKENS, input: 1_000, cachedInput: 800, cacheCreationInput: 200 },
    }));
    assert.strictEqual(result.complete, true, JSON.stringify(result.errors));
  });

  test("negative: a whitespace-only required field is treated as blank, not present", () => {
    const result = checkSliceExitGate(completeReport({ residualUncertainty: "   " }));
    assert.strictEqual(result.complete, false);
    assert.ok(result.errors.some((e) => e.includes("residualUncertainty")));
  });

  test("negative: a whitespace-only deferral field is treated as blank, not present", () => {
    const result = checkSliceExitGate(deferral({ owner: "   " }));
    assert.strictEqual(result.classification, "deferred");
    assert.strictEqual(result.complete, false);
    assert.ok(result.errors.some((e) => e.includes("owner")));
  });

  test("malformed input: a present-but-shapeless required field is not accepted as documented", () => {
    for (const [field, bad] of [
      ["scope", {}], ["lens", []], ["manifestHash", {}], ["commandsRun", {}],
      ["residualUncertainty", {}], ["revision", 42], ["commandsRun", ["  "]], ["commandsRun", [null]],
    ]) {
      const result = checkSliceExitGate(completeReport({ [field]: bad }));
      assert.strictEqual(result.complete, false, `expected ${field}=${JSON.stringify(bad)} to fail the exit gate`);
      assert.ok(
        result.errors.some((e) => e.includes(field)),
        `expected an error naming "${field}", got ${JSON.stringify(result.errors)}`,
      );
    }
  });

  test("negative: a manifestHash that is not a digest identifies no tree state", () => {
    // The field is the slice's claim about WHICH tree it audited. A sentence,
    // a truncated paste, or a digest with a stray character cannot be compared
    // against computeManifestHash()'s output, so it checks no box.
    for (const bad of [
      "not computed", "n/a", "sha256:e3b0c442",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85",    // 63 chars
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8555",  // 65 chars
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85z",   // not hex
    ]) {
      const result = checkSliceExitGate(completeReport({ manifestHash: bad }));
      assert.strictEqual(result.complete, false, `expected manifestHash=${JSON.stringify(bad)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("manifestHash") && e.includes("SHA-256")),
        `expected a manifestHash shape error, got ${JSON.stringify(result.errors)}`);
    }
  });

  test("boundary: a manifest digest is accepted in either case, with surrounding whitespace trimmed", () => {
    const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    for (const good of [digest, digest.toUpperCase(), `  ${digest}  `]) {
      const result = checkSliceExitGate(completeReport({ manifestHash: good }));
      assert.strictEqual(result.complete, true, `expected ${JSON.stringify(good)}: ${JSON.stringify(result.errors)}`);
    }
  });

  test("boundary: scope/lens may be a list of strings, and an empty commandsRun is documented-as-none", () => {
    const result = checkSliceExitGate(completeReport({
      scope: ["db/index.js", "db/sqlite/store.js"], lens: ["code reviewer"], commandsRun: [],
    }));
    assert.strictEqual(result.complete, true, JSON.stringify(result.errors));
  });

  test("negative: a non-boolean deferred marker is malformed, not a valid deferral", () => {
    for (const bad of ["false", "true", 1, {}]) {
      const result = checkSliceExitGate({ ...deferral(), deferred: bad });
      assert.strictEqual(result.classification, "invalid", `expected deferred=${JSON.stringify(bad)} to be invalid`);
      assert.strictEqual(result.complete, false);
      assert.ok(result.errors.some((e) => e.includes("deferred")));
    }
  });

  test("negative: deferred:\"false\" is not silently excused by the wave exit gate", () => {
    const result = checkWaveExitGate(
      [{ ...deferral({ slice: "A21" }), deferred: "false" }], { expectedSlices: ["A21"] },
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.deferred, []);
    assert.deepStrictEqual(result.incomplete, ["A21"]);
  });

  test("boundary: deferred:false is not a deferral — the full exit gate still applies", () => {
    assert.strictEqual(checkSliceExitGate(completeReport({ deferred: false })).complete, true);
    const bare = checkSliceExitGate({ slice: "A21", deferred: false });
    assert.strictEqual(bare.classification, "incomplete");
    assert.ok(bare.errors.some((e) => e.includes("revision")));
  });

  test("malformed deferral: a shapeless reason/owner/trigger is not a documented deferral", () => {
    for (const field of ["reason", "owner", "trigger"]) {
      const result = checkSliceExitGate(deferral({ [field]: {} }));
      assert.strictEqual(result.classification, "deferred");
      assert.strictEqual(result.complete, false);
      assert.ok(result.errors.some((e) => e.includes(field)), `expected an error naming "${field}"`);
    }
  });

  test("negative: an empty or missing wave never satisfies the aggregate exit gate", () => {
    for (const bad of [[], undefined]) {
      const result = checkWaveExitGate(bad, { expectedSlices: AUDIT_SLICE_IDS });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(bad)} to fail`);
      assert.deepStrictEqual(result.complete, []);
    }
  });

  test("malformed input: a non-array wave is rejected instead of silently treated as empty", () => {
    const result = checkWaveExitGate({ slice: "A14" }, { expectedSlices: AUDIT_SLICE_IDS });
    assert.strictEqual(result.ok, false);
  });

  test("T6.1 wave aggregate: completed reports plus one documented deferral all satisfy the gate", () => {
    const reports = [
      completeReport({ slice: "A14" }),
      completeReport({ slice: "A02", scope: "config registry" }),
      deferral({ slice: "A21" }),
    ];
    const result = checkWaveExitGate(reports, { expectedSlices: ["A02", "A14", "A21"] });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(result.complete.sort(), ["A02", "A14"]);
    assert.deepStrictEqual(result.deferred, ["A21"]);
    assert.deepStrictEqual(result.incomplete, []);
    assert.deepStrictEqual(result.missing, []);
  });

  test("T6.1 wave aggregate: an incomplete report is neither complete nor a silently-accepted deferral", () => {
    const reports = [completeReport({ slice: "A14" }), { slice: "A03" }];
    const result = checkWaveExitGate(reports, { expectedSlices: ["A03", "A14"] });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.complete, ["A14"]);
    assert.deepStrictEqual(result.incomplete, ["A03"]);
  });

  test("negative: one valid report does not satisfy the A01-A22 run set", () => {
    const result = checkWaveExitGate([completeReport({ slice: "A01" })], { expectedSlices: AUDIT_SLICE_IDS });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.complete, ["A01"]);
    assert.strictEqual(result.missing.length, AUDIT_SLICE_IDS.length - 1);
    assert.ok(result.missing.includes("A22"));
    assert.ok(result.errors.some((e) => e.includes("run set is not covered")));
  });

  test("negative: 22 copies of one slice are not coverage of 22 slices", () => {
    const wave = Array.from({ length: AUDIT_SLICE_IDS.length }, () => completeReport({ slice: "A01" }));
    const result = checkWaveExitGate(wave, { expectedSlices: AUDIT_SLICE_IDS });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.duplicated, ["A01"]);
    assert.ok(result.errors.some((e) => e.includes("reported 22 times")));
    assert.ok(result.errors.some((e) => e.includes("run set is not covered")));
  });

  test("negative: a report for a slice outside the measured run set is flagged, not counted", () => {
    const result = checkWaveExitGate(
      [completeReport({ slice: "A14" }), completeReport({ slice: "A99" })],
      { expectedSlices: ["A14"] },
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.unexpected, ["A99"]);
    assert.deepStrictEqual(result.missing, []);
  });

  test("negative: a wave with no expected run set names no completion criterion and fails closed", () => {
    for (const bad of [undefined, [], "A01-A22", ["A01", "  "], [null]]) {
      const result = checkWaveExitGate([completeReport({ slice: "A01" })], { expectedSlices: bad });
      assert.strictEqual(result.ok, false, `expected expectedSlices=${JSON.stringify(bad)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("expectedSlices")));
    }
    assert.strictEqual(checkWaveExitGate([completeReport({ slice: "A01" })]).ok, false);
  });

  test("negative: a run set naming the same slice twice is not a usable coverage claim", () => {
    const result = checkWaveExitGate(
      [completeReport({ slice: "A01" })], { expectedSlices: ["A01", "A01"] },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("duplicate ids")));
  });

  test("boundary: a report with no usable slice id is incomplete and credits no slice's coverage", () => {
    const result = checkWaveExitGate(
      [completeReport({ slice: "A01" }), { revision: "abc" }],
      { expectedSlices: ["A01"] },
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.complete, ["A01"]);
    assert.deepStrictEqual(result.incomplete, ["reports[1]"]);
    assert.deepStrictEqual(result.unexpected, []);
    assert.deepStrictEqual(result.missing, []);
  });

  test("positive: the full A01-A22 run set, every slice reported once, satisfies the aggregate gate", () => {
    const wave = AUDIT_SLICE_IDS.map((slice) => completeReport({ slice }));
    const result = checkWaveExitGate(wave, { expectedSlices: AUDIT_SLICE_IDS });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.complete.length, 22);
    assert.deepStrictEqual(result.missing, []);
    assert.deepStrictEqual(result.duplicated, []);
  });
});

describe("audit/scripts/slice-execution.js — T6.2 unsupported candidates cannot escalate", () => {
  // A REAL candidate, mid-slice: the placeholders are honest here, because the
  // §7 boxes genuinely are not checked yet. This is what must not be confirmed.
  const finding = {
    id: "A06-F1",
    title: "usage misreported for a provider switch mid-turn",
    severity: "medium",
    confidence: "medium",
    affectedPaths: [{ file: "lib/agent/providers/gemini.js", line: 88 }],
    violatedInvariant: "same semantic turn/usage contract across providers",
    reproduction: "N/A pending evidence",
    expected: "usage.output_tokens reflects the final provider",
    actual: "usage.output_tokens reflects the previous provider",
    impact: "cost display is wrong after a mid-turn switch",
    evidence: "model claim only",
    suggestedMitigation: "TBD",
    regressionTestLocation: "TBD",
    status: "Candidate",
  };

  /** The same finding once every §7 exit-gate box is actually checked. */
  function confirmable(overrides = {}) {
    return {
      ...finding,
      // Both of these name REAL files: the evidence gate now checks that an
      // anchor supports this candidate, and the record's own reproduction /
      // regression-test locations are part of what a candidate points at.
      reproduction: "tests/unit/providers/gemini.test.js",
      suggestedMitigation: "read usage from the provider that closed the turn, not the one that opened it",
      regressionTestLocation: "tests/unit/providers/gemini.test.js",
      revision: "ad1d6ce365e0",
      variantsConsidered: ["llamacpp local", "gemini cloud", "mid-turn provider switch"],
      duplicateSearch: { classification: "Distinct", matches: [], relatedBySymptom: [] },
      model: "deepseek-chat",
      tokens: { ...TOKENS },
      ...overrides,
    };
  }

  test("positive: a static-trace evidence item is independent and allows Confirmed", () => {
    const result = checkCandidateEscalation({
      finding: confirmable(),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.finding.status, "Confirmed");
  });

  test("negative: a mid-slice candidate with TBD/N-A placeholders cannot be confirmed by good evidence", () => {
    const result = checkCandidateEscalation({
      finding,
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(result.ok, false);
    for (const field of ["reproduction", "suggestedMitigation", "regressionTestLocation"]) {
      assert.ok(result.errors.some((e) => e.includes(field) && e.includes("placeholder")),
        `expected a placeholder error naming "${field}", got ${JSON.stringify(result.errors)}`);
    }
  });

  test("negative: every §7 box schema.js does not cover is required for Confirmed", () => {
    for (const field of CONFIRMATION_REQUIRED_FIELDS) {
      const incomplete = confirmable();
      delete incomplete[field];
      const result = checkCandidateEscalation({
        finding: incomplete,
        toStatus: "Confirmed",
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
      });
      assert.strictEqual(result.ok, false, `expected a finding missing ${field} to fail confirmation`);
      assert.ok(result.errors.some((e) => e.includes(field === "tokens" ? "tokens" : field)),
        `expected an error naming "${field}", got ${JSON.stringify(result.errors)}`);
    }
  });

  test("negative: a present-but-unreadable confirmation field checks no box", () => {
    const fields = [
      "id", "title", "violatedInvariant", "expected", "actual", "impact",
      "evidence", "reproduction", "suggestedMitigation", "regressionTestLocation",
    ];
    for (const field of fields) {
      for (const bad of [{}, [], 42, true]) {
        const result = checkCandidateEscalation({
          finding: confirmable({ [field]: bad }),
          toStatus: "Confirmed",
          evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
        });
        assert.strictEqual(result.ok, false, `expected ${field}=${JSON.stringify(bad)} to fail confirmation`);
        assert.ok(result.errors.some((e) => e.includes(field)),
          `expected an error naming "${field}", got ${JSON.stringify(result.errors)}`);
      }
    }
  });

  test("negative: reproduction and regression-test location must name a place, not prose", () => {
    for (const field of ["reproduction", "regressionTestLocation"]) {
      const result = checkCandidateEscalation({
        finding: confirmable({ [field]: "somewhere in the provider code" }),
        toStatus: "Confirmed",
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
      });
      assert.strictEqual(result.ok, false, `expected prose in ${field} to fail`);
      assert.ok(result.errors.some((e) => e.includes(field) && e.includes("must name")));
    }
  });

  test("malformed record: a broken history fails the transition instead of crashing the run", () => {
    // transitionFinding() SPREADS finding.history, so a truthy non-iterable
    // value there throws out of this wrapper and takes the slice run with it.
    // The cheap Rejected path is the one such a record is most likely to take.
    for (const history of [{}, 42, "Candidate -> Rejected", true, [null], ["Candidate"],
      [{ from: "Nope", to: "Rejected", at: "2026-08-23" }],
      // Every field is required, not merely checked when present:
      // transitionFinding() writes all three on every transition, so an entry
      // missing any of them is a gap in the trail, and it would be carried
      // untouched through every future transition.
      [{}],
      [{ from: "Candidate", to: "Rejected" }],
      [{ to: "Rejected", at: "2026-08-23T09:00:00.000Z" }],
      [{ from: "Candidate", at: "2026-08-23T09:00:00.000Z" }],
      [{ from: "Candidate", to: "Rejected", at: "soon" }],
      [{ from: "Candidate", to: "Rejected", at: "   " }],
      [{ from: "Candidate", to: "Rejected", at: 1_755_900_000_000 }],
    ]) {
      let result;
      assert.doesNotThrow(() => {
        result = checkCandidateEscalation({ finding: { status: "Candidate", history }, toStatus: "Rejected" });
      }, `history=${JSON.stringify(history)} must not throw`);
      assert.strictEqual(result.ok, false, `expected history=${JSON.stringify(history)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("history")),
        `expected a history error, got ${JSON.stringify(result.errors)}`);
    }
  });

  test("boundary: an absent or empty history transitions normally", () => {
    // Nothing in the lifecycle graph transitions INTO Candidate, so a Candidate
    // with any trail at all is already a contradiction.
    for (const history of [undefined, null, []]) {
      const result = checkCandidateEscalation({ finding: { status: "Candidate", history }, toStatus: "Rejected" });
      assert.strictEqual(result.ok, true, `history=${JSON.stringify(history)}: ${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.finding.status, "Rejected");
    }
  });

  test("boundary: a real trail, produced by transitionFinding(), transitions again and is appended to", () => {
    const confirmed = checkCandidateEscalation({
      finding: confirmable(),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "file-line", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(confirmed.ok, true, JSON.stringify(confirmed.errors));

    const planned = checkCandidateEscalation({ finding: confirmed.finding, toStatus: "Planned" });
    assert.strictEqual(planned.ok, true, JSON.stringify(planned.errors));
    assert.deepStrictEqual(planned.finding.history.map((h) => `${h.from}->${h.to}`),
      ["Candidate->Confirmed", "Confirmed->Planned"]);
  });

  test("negative: a trail that could not have happened is not a trail", () => {
    const impossible = [
      // Out of a terminal state: no code in this repo can make this move.
      { status: "Fixed", history: [{ from: "Rejected", to: "Fixed", at: "2026-08-23T00:00:00Z" }] },
      // A gap: the second entry starts somewhere the first one never left.
      { status: "Planned", history: [
        { from: "Candidate", to: "Confirmed", at: "2026-08-23T00:00:00Z" },
        { from: "Fixed", to: "Planned", at: "2026-08-23T01:00:00Z" },
      ] },
      // The trail says Rejected, the record says Candidate.
      { status: "Candidate", history: [{ from: "Candidate", to: "Rejected", at: "2026-08-23T00:00:00Z" }] },
    ];
    for (const finding of impossible) {
      const result = checkCandidateEscalation({ finding, toStatus: "Rejected" });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(finding.history)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("history")),
        `expected a history error, got ${JSON.stringify(result.errors)}`);
    }
  });

  test("negative: an affectedPaths anchor that points at no current code cannot be confirmed", () => {
    const bad = [
      [{ file: "", line: 12 }],
      [{ file: "   ", line: 12 }],
      [{ file: ".", line: 12 }],
      [{ file: "foo/..", line: 12 }],
      [{ file: "lib/agent/index.js", line: -1 }],
      [{ file: "lib/agent/index.js", line: 0 }],
      [{ file: "lib/agent/index.js", line: NaN }],
      [{ file: "lib/agent/index.js", line: 12.5 }],
      [{ file: "lib/agent/index.js", line: Infinity }],
      [{ file: "lib/agent/index.js", line: 12 }, { file: "lib/x.js", line: -3 }],
    ];
    for (const affectedPaths of bad) {
      const result = checkCandidateEscalation({
        finding: confirmable({ affectedPaths }),
        toStatus: "Confirmed",
        // A valid evidence item must not carry a finding whose own anchor is unusable.
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
      });
      assert.strictEqual(result.ok, false, `expected affectedPaths=${JSON.stringify(affectedPaths)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("affectedPaths[")),
        `expected an affectedPaths error, got ${JSON.stringify(result.errors)}`);
    }
  });

  test("negative: a well-formed anchor that names no current code still cannot be confirmed", () => {
    // A synthetic tree, so the assertion is about the GATE and not about how
    // many lines some real file happens to have today.
    const tree = { "lib/routes/paths.js": 120 };
    const anchorResolver = (file) => (file in tree
      ? { inTree: true, exists: true, lines: tree[file] }
      : { inTree: true, exists: false, lines: 0 });

    const cases = [
      // Syntactically perfect, but the file is not in the audited tree.
      [[{ file: "does/not/exist.js", line: 12 }], "names no file in the audited tree"],
      // The file is there; the line is past its end.
      [[{ file: "lib/routes/paths.js", line: 999_999 }], "has 120 lines"],
      // One good anchor does not excuse a second bad one.
      [[{ file: "lib/routes/paths.js", line: 42 }, { file: "gone.js", line: 1 }], "names no file"],
    ];
    for (const [affectedPaths, expected] of cases) {
      const result = checkCandidateEscalation({
        finding: confirmable({ affectedPaths }),
        toStatus: "Confirmed",
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
        anchorResolver,
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(affectedPaths)} to fail`);
      assert.ok(result.errors.some((e) => e.includes(expected)),
        `expected an error containing ${JSON.stringify(expected)}, got ${JSON.stringify(result.errors)}`);
    }
  });

  test("negative: an anchor nobody could check is an unchecked box, not a passed one", () => {
    for (const resolver of [() => null, () => undefined, () => "yes"]) {
      const result = checkCandidateEscalation({
        finding: confirmable({ affectedPaths: [{ file: "lib/routes/paths.js", line: 42 }] }),
        toStatus: "Confirmed",
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
        anchorResolver: resolver,
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes("could not be checked against the audited tree")));
    }
  });

  test("negative: an anchor that climbs out of the audited tree is not an anchor into it", () => {
    for (const file of ["../other-checkout/lib/x.js", "/etc/passwd", "lib/../../escape.js"]) {
      const result = checkCandidateEscalation({
        finding: confirmable({ affectedPaths: [{ file, line: 1 }] }),
        toStatus: "Confirmed",
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
      });
      assert.strictEqual(result.ok, false, `expected ${file} to fail`);
      assert.ok(result.errors.some((e) => e.includes("outside the audited tree")),
        `expected an out-of-tree error for ${file}, got ${JSON.stringify(result.errors)}`);
    }
  });

  test("positive: the default resolver reads the real audited tree", () => {
    // This module's own file is the one anchor guaranteed to exist wherever the
    // suite runs, and its length is read rather than hardcoded.
    const self = resolveAnchorInTree("audit/scripts/slice-execution.js");
    assert.strictEqual(self.inTree, true);
    assert.strictEqual(self.exists, true);
    assert.ok(self.lines > 100, `expected a real line count, got ${self.lines}`);

    assert.deepStrictEqual(resolveAnchorInTree("audit/scripts/definitely-not-here.js"),
      { inTree: true, exists: false, lines: 0 });
    assert.strictEqual(resolveAnchorInTree("../outside.js").inTree, false);

    const ok = checkCandidateEscalation({
      finding: confirmable({ affectedPaths: [{ file: "audit/scripts/slice-execution.js", line: 1 }] }),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "static-trace", detail: "audit/scripts/slice-execution.js:1" }],
    });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.errors));

    const past = checkCandidateEscalation({
      finding: confirmable({ affectedPaths: [{ file: "audit/scripts/slice-execution.js", line: self.lines + 1 }] }),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "static-trace", detail: "audit/scripts/slice-execution.js:1" }],
    });
    assert.strictEqual(past.ok, false);
    assert.ok(past.errors.some((e) => e.includes("does not point at current code")));
  });

  test("negative: a duplicate search that never ran does not check the 'issues were searched' box", () => {
    for (const bad of [
      { classification: "invalid" }, {}, [], "Distinct", { classification: "Maybe" },
      // A verdict with no search result behind it: the arrays classifyDuplicate()
      // always returns are absent, so nothing records that a search ran.
      { classification: "Distinct" },
      { classification: "Distinct", matches: [] },
      { classification: "Distinct", matches: "none", relatedBySymptom: [] },
      // Duplicate without the record it duplicates is not actionable.
      { classification: "Duplicate", matches: [], relatedBySymptom: [] },
      { classification: "Duplicate", matches: [{ id: "   " }], relatedBySymptom: [] },
    ]) {
      const result = checkCandidateEscalation({
        finding: confirmable({ duplicateSearch: bad }),
        toStatus: "Confirmed",
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
      });
      assert.strictEqual(result.ok, false, `expected duplicateSearch=${JSON.stringify(bad)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("duplicateSearch")));
    }
  });

  test("boundary: finding an existing duplicate does not block confirmation — §3.4 routes it through Confirmed", () => {
    const result = checkCandidateEscalation({
      finding: confirmable({
        duplicateSearch: { classification: "Duplicate", matches: [{ id: "GH-501" }], relatedBySymptom: [] },
      }),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  });

  test("negative: the model and token cost of a confirmed finding must be recorded and possible", () => {
    const noModel = checkCandidateEscalation({
      finding: confirmable({ model: "   " }),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(noModel.ok, false);
    assert.ok(noModel.errors.some((e) => e.includes("model must record")));

    const badTokens = checkCandidateEscalation({
      finding: confirmable({ tokens: { ...TOKENS, reasoning: 5_000, output: 800 } }),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(badTokens.ok, false);
    assert.ok(badTokens.errors.some((e) => e.includes("exceeds tokens.output")));
  });

  test("negative: a plausible claim with no line evidence or reproduction cannot become Confirmed", () => {
    const result = checkCandidateEscalation({ finding, toStatus: "Confirmed", evidenceItems: [] });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("no independent evidence")));
  });

  test("a candidate with no independent evidence may still become Rejected", () => {
    const result = checkCandidateEscalation({ finding, toStatus: "Rejected", evidenceItems: [] });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.finding.status, "Rejected");
  });

  test("a candidate with no independent evidence may stay Candidate (classification only, no transition)", () => {
    const classified = classifyCandidateEvidence([]);
    assert.strictEqual(classified.hasIndependentEvidence, false);
  });

  test("negative: a SECOND model agreeing is not accepted as independent evidence", () => {
    const result = checkCandidateEscalation({
      finding,
      toStatus: "Confirmed",
      evidenceItems: [
        { kind: "model-agreement", detail: "deepseek-chat concurs" },
        { kind: "model-agreement", detail: "a third model also concurs" },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("model agreement") || e.includes("model-agreement")));
  });

  test("model agreement alongside one independent item is enough — the model agreement is not the reason it passes", () => {
    const result = checkCandidateEscalation({
      finding: confirmable(),
      toStatus: "Confirmed",
      evidenceItems: [
        { kind: "model-agreement", detail: "deepseek-chat concurs" },
        { kind: "reproduction", detail: "tests/unit/providers/gemini.test.js" },
      ],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  });

  test("malformed input: an invalid toStatus is rejected via schema.js's own transition table, not re-implemented", () => {
    const result = checkCandidateEscalation({
      finding: { ...finding, status: "Rejected" },
      toStatus: "Fixed",
      evidenceItems: [{ kind: "static-trace", detail: "lib/agent/index.js:210" }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("Rejected -> Fixed") || e.includes("invalid transition")));
  });

  test("boundary: evidenceItems defaults to empty and does not throw", () => {
    const result = checkCandidateEscalation({ finding, toStatus: "Confirmed" });
    assert.strictEqual(result.ok, false);
  });

  test("malformed input: a whitespace-only evidence detail is treated as no detail at all", () => {
    const result = checkCandidateEscalation({
      finding, toStatus: "Confirmed", evidenceItems: [{ kind: "static-trace", detail: "   " }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("no detail")));
  });

  test("malformed input: a missing or non-object finding is a structured failure, not a thrown error", () => {
    for (const bad of [undefined, null, "A06-F1", []]) {
      assert.doesNotThrow(() => checkCandidateEscalation({ finding: bad, toStatus: "Rejected", evidenceItems: [] }));
      const result = checkCandidateEscalation({ finding: bad, toStatus: "Rejected", evidenceItems: [] });
      assert.strictEqual(result.ok, false, `expected finding=${JSON.stringify(bad)} to fail`);
    }
  });

  test("malformed evidence: null, {}, and an unrecognized kind do not count as independent evidence", () => {
    for (const badItem of [null, {}, { kind: "reviewer-opinion", detail: "seems fine to me" }]) {
      const result = checkCandidateEscalation({ finding, toStatus: "Confirmed", evidenceItems: [badItem] });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(badItem)} to fail the evidence gate`);
    }
  });

  test("malformed evidence: a recognized kind with no detail payload does not count as independent evidence", () => {
    const result = checkCandidateEscalation({
      finding, toStatus: "Confirmed", evidenceItems: [{ kind: "static-trace" }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("no detail")));
  });

  test("malformed evidence: a content-free detail ({}, [], a number) cannot confirm a candidate", () => {
    for (const badDetail of [{}, [], 0, true, { file: "x" }]) {
      const result = checkCandidateEscalation({
        finding, toStatus: "Confirmed", evidenceItems: [{ kind: "file-line", detail: badDetail }],
      });
      assert.strictEqual(result.ok, false, `expected detail=${JSON.stringify(badDetail)} to fail the evidence gate`);
      assert.ok(result.errors.some((e) => e.includes("no detail")));
      assert.strictEqual(classifyCandidateEvidence([{ kind: "file-line", detail: badDetail }]).hasIndependentEvidence, false);
    }
  });

  test("negative: good evidence cannot confirm a finding record that says nothing", () => {
    const result = checkCandidateEscalation({
      finding: { status: "Candidate" },
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "focused-test", detail: "audit/tests/database-contract.test.js" }],
    });
    assert.strictEqual(result.ok, false);
    for (const field of ["affectedPaths", "violatedInvariant", "severity", "regressionTestLocation"]) {
      assert.ok(result.errors.some((e) => e.includes(field)), `expected an error naming "${field}"`);
    }
  });

  test("negative: each §7 record field is required for Confirmed, one at a time", () => {
    for (const field of ["affectedPaths", "violatedInvariant", "expected", "actual", "regressionTestLocation"]) {
      const incomplete = { ...finding };
      delete incomplete[field];
      const result = checkCandidateEscalation({
        finding: incomplete,
        toStatus: "Confirmed",
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
      });
      assert.strictEqual(result.ok, false, `expected a finding missing ${field} to fail confirmation`);
      assert.ok(result.errors.some((e) => e.includes(field)));
    }
  });

  test("negative: expected and actual must be distinguishable — formatting is not a difference", () => {
    // Distinguishable is about the BEHAVIORS. A reader seeing the same sentence
    // twice learns nothing about the defect, however it is spaced or capitalized.
    for (const actual of [
      "usage is correct",
      "  usage is correct  ",
      "usage  is\tcorrect",
      "Usage Is Correct",
    ]) {
      const result = checkCandidateEscalation({
        finding: { ...finding, expected: "usage is correct", actual },
        toStatus: "Confirmed",
        evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
      });
      assert.strictEqual(result.ok, false, `expected actual=${JSON.stringify(actual)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("describe the same behavior")),
        JSON.stringify(result.errors));
    }

    // A real difference in behavior still passes.
    const distinct = checkCandidateEscalation({
      finding: confirmable(),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "static-trace", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(distinct.ok, true, JSON.stringify(distinct.errors));
  });

  test("boundary: a half-formed candidate may still be Rejected — only Confirmed carries the record gate", () => {
    const result = checkCandidateEscalation({ finding: { status: "Candidate" }, toStatus: "Rejected" });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.finding.status, "Rejected");
  });

  test("negative: prose that points at nothing checkable is a claim, not evidence", () => {
    for (const kind of ["file-line", "static-trace", "focused-test", "reproduction"]) {
      for (const detail of ["trust me", "the code is clearly wrong here", "obvious on inspection"]) {
        const result = checkCandidateEscalation({ finding, toStatus: "Confirmed", evidenceItems: [{ kind, detail }] });
        assert.strictEqual(result.ok, false, `expected ${kind}/"${detail}" to fail the evidence gate`);
        assert.ok(result.errors.some((e) => e.includes("must name")));
      }
    }
  });

  test("negative: file-line and static-trace need an actual line number, not just a filename", () => {
    for (const kind of ["file-line", "static-trace"]) {
      const result = checkCandidateEscalation({
        finding, toStatus: "Confirmed", evidenceItems: [{ kind, detail: "lib/agent/providers/gemini.js" }],
      });
      assert.strictEqual(result.ok, false, `expected a bare filename to fail for ${kind}`);
      assert.ok(result.errors.some((e) => e.includes("file:line")));
    }
  });

  test("positive: each kind's real payload shape is accepted", () => {
    const good = [
      { kind: "file-line", detail: "lib/agent/providers/gemini.js:88" },
      { kind: "static-trace", detail: "handleTurn -> applyUsage at lib/agent/index.js:210" },
      { kind: "focused-test", detail: "audit/tests/database-contract.test.js" },
      {
        kind: "reproduction", detail: "npm run test:audit -- --grep gemini",
        ranAt: "2026-08-23T09:00:00.000Z", observed: "1 failing: usage.output_tokens is the previous provider's",
      },
      { kind: "reproduction", detail: "audit/tests/usage-accounting.test.js" },
    ];
    for (const item of good) {
      const classified = classifyCandidateEvidence([item]);
      assert.deepStrictEqual(classified.errors, [], `expected ${JSON.stringify(item)} to be accepted`);
      assert.strictEqual(classified.hasIndependentEvidence, true);
    }
  });

  test("classifyCandidateEvidence reports malformed items in its own errors array", () => {
    const classified = classifyCandidateEvidence([{ kind: "not-a-real-kind" }]);
    assert.strictEqual(classified.hasIndependentEvidence, false);
    assert.ok(classified.errors.length > 0);
  });

  test("negative: evidence of the right SHAPE that resolves to nothing is still not evidence", () => {
    // Each of these passes its kind's shape check and would otherwise carry an
    // otherwise-complete candidate to Confirmed on a path nobody can open.
    for (const item of [
      { kind: "focused-test", detail: "does/not/exist.test.js" },
      { kind: "reproduction", detail: "node does/not/exist.js" },
      { kind: "static-trace", detail: "handleTurn -> applyUsage at lib/agent/gone.js:12" },
      { kind: "file-line", detail: "../other-checkout/lib/x.js:3" },
      { kind: "file-line", detail: "audit/scripts/slice-execution.js:999999" },
    ]) {
      const result = checkCandidateEscalation({
        finding: confirmable(), toStatus: "Confirmed", evidenceItems: [item],
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(item)} to fail the evidence gate`);
      assert.ok(result.errors.some((e) => e.includes("audited tree")), JSON.stringify(result.errors));
      assert.strictEqual(classifyCandidateEvidence([item]).hasIndependentEvidence, false);
    }
  });

  test("negative: evidence anchored to unrelated code does not support THIS candidate", () => {
    // Every one of these resolves: a real file, at a real line. None of it is
    // code the candidate points at. Without the relatedness half, any
    // well-formed anchor anywhere in the repository would carry any candidate
    // to Confirmed — "package.json:1" proves nothing about a provider's usage
    // accounting.
    for (const item of [
      { kind: "file-line", detail: "package.json:1" },
      { kind: "static-trace", detail: "handleTurn -> applyUsage at audit/scripts/schema.js:1" },
      { kind: "focused-test", detail: "audit/tests/ledger.test.js" },
      { kind: "reproduction", detail: "audit/tests/usage-accounting.test.js" },
    ]) {
      const result = checkCandidateEscalation({
        finding: confirmable(), toStatus: "Confirmed", evidenceItems: [item],
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(item)} to fail the evidence gate`);
      assert.ok(result.errors.some((e) => e.includes("not code this candidate points at")),
        JSON.stringify(result.errors));
      assert.strictEqual(
        classifyCandidateEvidence([item], { candidate: confirmable() }).hasIndependentEvidence, false,
        `expected ${JSON.stringify(item)} not to count as independent evidence`);
    }
  });

  test("positive: an anchor in the affected code, or in the record's own reproduction, supports it", () => {
    for (const item of [
      { kind: "file-line", detail: "lib/agent/providers/gemini.js:88" },
      { kind: "focused-test", detail: "tests/unit/providers/gemini.test.js" },
      { kind: "reproduction", detail: "tests/unit/providers/gemini.test.js" },
    ]) {
      const result = checkCandidateEscalation({
        finding: confirmable(), toStatus: "Confirmed", evidenceItems: [item],
      });
      assert.strictEqual(result.ok, true, `expected ${JSON.stringify(item)}: ${JSON.stringify(result.errors)}`);
    }
  });

  test("negative: a bare basename is not shorthand — it is rejected, and the error names the full path", () => {
    // The real resolver probes <repo>/paths.js, which does not exist, so a
    // basename could never have worked. It is rejected against the DEFAULT
    // resolver here, the way a real slice run would see it.
    const candidate = confirmable({ affectedPaths: [{ file: "lib/routes/paths.js", line: 42 }] });

    const shorthand = classifyCandidateEvidence([{ kind: "file-line", detail: "paths.js:42" }], { candidate });
    assert.strictEqual(shorthand.hasIndependentEvidence, false);
    assert.ok(shorthand.errors.some((e) => e.includes(`this candidate names "lib/routes/paths.js"`)),
      JSON.stringify(shorthand.errors));

    // The full path is what works.
    const full = classifyCandidateEvidence([{ kind: "file-line", detail: "lib/routes/paths.js:42" }], { candidate });
    assert.strictEqual(full.hasIndependentEvidence, true, JSON.stringify(full.errors));
  });

  test("boundary: relatedness compares whole normalized paths, not lookalike suffixes", () => {
    // The tree half is turned off deliberately: this is about relatedness only.
    const anyFile = () => ({ inTree: true, exists: true, lines: Infinity });
    const candidate = confirmable({ affectedPaths: [{ file: "lib/routes/paths.js", line: 42 }] });

    for (const detail of ["mypaths.js:42", "other/lib/routes/paths.js:42", "paths.js:42"]) {
      const classified = classifyCandidateEvidence([{ kind: "file-line", detail }],
        { anchorResolver: anyFile, candidate });
      assert.strictEqual(classified.hasIndependentEvidence, false, `expected "${detail}" to be unrelated`);
    }

    // Spelling differences of the SAME path still match: normalization, not luck.
    const spelled = classifyCandidateEvidence([{ kind: "file-line", detail: "./lib//routes/paths.js:42" }],
      { anchorResolver: anyFile, candidate });
    assert.strictEqual(spelled.hasIndependentEvidence, true, JSON.stringify(spelled.errors));
  });

  test("boundary: with no candidate supplied, classification still checks shape and resolution", () => {
    // The standalone classifier has nothing to relate an anchor to, so it
    // reports shape and resolution only. checkCandidateEscalation() always
    // passes the candidate, so the Confirmed gate never runs without it.
    const unrelated = classifyCandidateEvidence([{ kind: "file-line", detail: "package.json:1" }]);
    assert.strictEqual(unrelated.hasIndependentEvidence, true, JSON.stringify(unrelated.errors));

    const missing = classifyCandidateEvidence([{ kind: "file-line", detail: "does/not/exist.js:1" }]);
    assert.strictEqual(missing.hasIndependentEvidence, false);
  });

  test("boundary: a reproduction that is a runnable command is not resolved as a path", () => {
    const classified = classifyCandidateEvidence([{
      kind: "reproduction", detail: "npm run test:audit -- --grep gemini",
      ranAt: "2026-08-23T09:00:00.000Z", observed: "1 failing: usage.output_tokens is the previous provider's",
    }]);
    assert.deepStrictEqual(classified.errors, []);
    assert.strictEqual(classified.hasIndependentEvidence, true);
  });

  test("negative: a command nobody ran is an intention, not evidence", () => {
    // This module never executes anything, so a command detail is verified
    // against its RECORDED run or not at all. "npm run nonexistent" is
    // syntactically runnable and supports nothing.
    const unrun = [
      { kind: "reproduction", detail: "npm run nonexistent" },
      { kind: "reproduction", detail: "npm run nonexistent", ranAt: "2026-08-23T09:00:00.000Z" },
      { kind: "reproduction", detail: "npm run nonexistent", observed: "3 tests failed" },
      { kind: "reproduction", detail: "npm run nonexistent", ranAt: "soon", observed: "3 tests failed" },
      { kind: "reproduction", detail: "npm run nonexistent", ranAt: "2026-08-23T09:00:00.000Z", observed: "TBD" },
    ];
    for (const item of unrun) {
      const result = checkCandidateEscalation({
        finding: confirmable(), toStatus: "Confirmed", evidenceItems: [item],
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(item)} to fail the evidence gate`);
      assert.ok(result.errors.some((e) => e.includes("a command nobody ran")), JSON.stringify(result.errors));
      assert.strictEqual(classifyCandidateEvidence([item]).hasIndependentEvidence, false);
    }
  });

  test("negative: an anchor-shaped detail that resolves to nothing cannot be rescued as a command", () => {
    // The shape regexes match anywhere in the string, so "x.js:12abc" passes
    // the file-line check and then yields no resolvable token. Routing that to
    // the command verifier would let a malformed anchor be confirmed by
    // recording a run of a "command" that is not one.
    const ran = { ranAt: "2026-08-23T09:00:00.000Z", observed: "failed" };
    for (const item of [
      { kind: "file-line", detail: "x.js:12abc", ...ran },
      { kind: "static-trace", detail: "applyUsage at x.js:12abc", ...ran },
      { kind: "focused-test", detail: "a.suite:9z", ...ran },
      { kind: "reproduction", detail: "x.js:12abc", ...ran },
    ]) {
      const result = checkCandidateEscalation({
        finding: confirmable(), toStatus: "Confirmed", evidenceItems: [item],
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(item)} to fail the evidence gate`);
      assert.ok(result.errors.some((e) => e.includes("names no path this module could resolve")),
        JSON.stringify(result.errors));
      assert.strictEqual(classifyCandidateEvidence([item]).hasIndependentEvidence, false);
    }
  });

  test("negative: a command that NAMES a real file is still a command nobody ran", () => {
    // The path resolves and belongs to the candidate, so the anchor half is
    // satisfied — but the claim is that running it showed the defect, and the
    // file merely existing is not that. Command syntax decides, not the path.
    const detail = "node tests/unit/providers/gemini.test.js";
    const unrun = checkCandidateEscalation({
      finding: confirmable(), toStatus: "Confirmed",
      evidenceItems: [{ kind: "reproduction", detail }],
    });
    assert.strictEqual(unrun.ok, false, JSON.stringify(unrun.errors));
    assert.ok(unrun.errors.some((e) => e.includes("a command nobody ran")), JSON.stringify(unrun.errors));

    const ran = checkCandidateEscalation({
      finding: confirmable(), toStatus: "Confirmed",
      evidenceItems: [{
        kind: "reproduction", detail,
        ranAt: "2026-08-23T09:00:00.000Z", observed: "1 failing: usage.output_tokens is the previous provider's",
      }],
    });
    assert.strictEqual(ran.ok, true, JSON.stringify(ran.errors));
  });

  test("negative: a command whose path does NOT resolve fails on the anchor, before its run is asked about", () => {
    const result = checkCandidateEscalation({
      finding: confirmable(), toStatus: "Confirmed",
      evidenceItems: [{
        kind: "reproduction", detail: "node does/not/exist.js",
        ranAt: "2026-08-23T09:00:00.000Z", observed: "1 failing",
      }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("audited tree")), JSON.stringify(result.errors));
  });

  test("positive: a recorded run makes a command evidence — and a FAILING run is the point", () => {
    const result = checkCandidateEscalation({
      finding: confirmable(),
      toStatus: "Confirmed",
      evidenceItems: [{
        kind: "reproduction", detail: "npm run test:audit -- --grep gemini",
        ranAt: "2026-08-23T09:00:00.000Z",
        observed: "1 failing — usage.output_tokens reports the provider that OPENED the turn",
      }],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  });

  test("boundary: a caller that really runs commands answers with its own verifier", () => {
    const item = { kind: "reproduction", detail: "npm run test:audit -- --grep gemini", runId: "run-42" };
    const ran = checkCandidateEscalation({
      finding: confirmable(), toStatus: "Confirmed", evidenceItems: [item],
      commandVerifier: (i) => ({ ran: i.runId === "run-42", reason: "not in the run log" }),
    });
    assert.strictEqual(ran.ok, true, JSON.stringify(ran.errors));

    const notRan = checkCandidateEscalation({
      finding: confirmable(), toStatus: "Confirmed", evidenceItems: [item],
      commandVerifier: () => ({ ran: false, reason: "not in the run log" }),
    });
    assert.strictEqual(notRan.ok, false);
    assert.ok(notRan.errors.some((e) => e.includes("not in the run log")), JSON.stringify(notRan.errors));
  });

  test("negative: an evidence anchor at line 0 points at no code, the same as one past the end", () => {
    for (const kind of ["file-line", "static-trace"]) {
      const result = checkCandidateEscalation({
        finding: confirmable(),
        toStatus: "Confirmed",
        evidenceItems: [{ kind, detail: "lib/agent/providers/gemini.js:0" }],
      });
      assert.strictEqual(result.ok, false, `expected ${kind} at line 0 to fail`);
      assert.ok(result.errors.some((e) => e.includes("the first line of a file is 1")),
        JSON.stringify(result.errors));
    }
  });

  test("negative: a regression-test LOCATION must name a place, even though a reproduction may be a command", () => {
    const command = checkCandidateEscalation({
      finding: confirmable({ regressionTestLocation: "npm run test:audit" }),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "file-line", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(command.ok, false);
    assert.ok(command.errors.some((e) => e.includes("regressionTestLocation") && e.includes("must name")),
      JSON.stringify(command.errors));

    // The same string is a perfectly good REPRODUCTION: it can be re-run.
    const reproduction = checkCandidateEscalation({
      finding: confirmable({ reproduction: "npm run test:audit" }),
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "file-line", detail: "lib/agent/providers/gemini.js:88" }],
    });
    assert.strictEqual(reproduction.ok, true, JSON.stringify(reproduction.errors));
  });
});

describe("audit/scripts/slice-execution.js — anchors resolve against the tree they name", () => {
  /** A throwaway checkout: anchors must resolve in a tree that is not this repo. */
  function scratchCheckout(prefix) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "inside.js"), "one\ntwo\nthree\n");
    return root;
  }

  test("a custom root without a trailing separator still finds its own files", () => {
    const root = scratchCheckout("aperio-audit-anchor-");
    try {
      // Concatenated, "/tmp/checkout" + "lib/inside.js" is "/tmp/checkoutlib/
      // inside.js" — a perfectly good checkout reported entirely missing.
      const resolved = resolveAnchorInTree("lib/inside.js", { root });
      assert.deepStrictEqual(resolved, { inTree: true, exists: true, lines: 3 });
      assert.deepStrictEqual(resolveAnchorInTree("lib/inside.js", { root: `${root}/` }), resolved);
      assert.deepStrictEqual(resolveAnchorInTree("lib/absent.js", { root }),
        { inTree: true, exists: false, lines: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlink that leaves the audited tree is not an anchor into it", () => {
    const root = scratchCheckout("aperio-audit-root-");
    const elsewhere = mkdtempSync(join(tmpdir(), "aperio-audit-outside-"));
    try {
      writeFileSync(join(elsewhere, "private.js"), "secret\n");
      symlinkSync(join(elsewhere, "private.js"), join(root, "linked.js"));
      symlinkSync(join(root, "lib", "inside.js"), join(root, "in-tree-link.js"));

      // The lexical check passes and readFileSync would follow the link, so
      // without canonicalization a finding could be confirmed against code the
      // audited checkout does not contain.
      assert.deepStrictEqual(resolveAnchorInTree("linked.js", { root }),
        { inTree: false, exists: false, lines: 0 });
      // A link that stays inside the tree is still an ordinary anchor.
      assert.deepStrictEqual(resolveAnchorInTree("in-tree-link.js", { root }),
        { inTree: true, exists: true, lines: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a cached anchor is revalidated — a concurrent session's edit is not answered from the cache", () => {
    // AGENTS.md expects other sessions working in this same worktree. Between
    // two findings in one wave the file behind an anchor can change, and a
    // cache keyed on the path alone would keep answering with the old state.
    const root = scratchCheckout("aperio-audit-stale-");
    try {
      assert.deepStrictEqual(resolveAnchorInTree("lib/inside.js", { root }),
        { inTree: true, exists: true, lines: 3 });

      // Shortened: an anchor at line 3 no longer points at current code.
      writeFileSync(join(root, "lib", "inside.js"), "one\n");
      assert.deepStrictEqual(resolveAnchorInTree("lib/inside.js", { root }),
        { inTree: true, exists: true, lines: 1 });

      // Grown again, and re-read rather than answered from the first count.
      writeFileSync(join(root, "lib", "inside.js"), "one\ntwo\nthree\nfour\n");
      assert.deepStrictEqual(resolveAnchorInTree("lib/inside.js", { root }),
        { inTree: true, exists: true, lines: 4 });

      // Deleted: a verified absence, not a remembered presence.
      rmSync(join(root, "lib", "inside.js"));
      assert.deepStrictEqual(resolveAnchorInTree("lib/inside.js", { root }),
        { inTree: true, exists: false, lines: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a cached anchor replaced by an escaping symlink stops resolving into the tree", () => {
    const root = scratchCheckout("aperio-audit-swap-");
    const elsewhere = mkdtempSync(join(tmpdir(), "aperio-audit-swap-outside-"));
    try {
      assert.deepStrictEqual(resolveAnchorInTree("lib/inside.js", { root }),
        { inTree: true, exists: true, lines: 3 });

      writeFileSync(join(elsewhere, "private.js"), "secret\n");
      rmSync(join(root, "lib", "inside.js"));
      symlinkSync(join(elsewhere, "private.js"), join(root, "lib", "inside.js"));

      // Cached by path alone, this would still report in-tree code — and a
      // finding could be confirmed against a file the checkout never held.
      assert.deepStrictEqual(resolveAnchorInTree("lib/inside.js", { root }),
        { inTree: false, exists: false, lines: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a filename that begins with two dots is in the tree, not a climb out of it", () => {
    // relative() returns "..config.js" for this file, and a startsWith("..")
    // test reads that as a parent-directory escape — so evidence anchored to a
    // perfectly ordinary in-tree file could never be confirmed. Only a path
    // SEGMENT that is ".." leaves the directory.
    const root = scratchCheckout("aperio-audit-dots-");
    try {
      writeFileSync(join(root, "lib", "..config.js"), "one\ntwo\n");
      assert.deepStrictEqual(resolveAnchorInTree("lib/..config.js", { root }),
        { inTree: true, exists: true, lines: 2 });

      // A real climb-out is still a climb-out.
      assert.strictEqual(resolveAnchorInTree("../outside.js", { root }).inTree, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory is not a file anchor — it is a failure to check, not an absence", () => {
    const root = scratchCheckout("aperio-audit-dir-");
    try {
      assert.strictEqual(resolveAnchorInTree("lib", { root }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("audit/scripts/slice-execution.js — T6.3 lens and escalation budget", () => {
  test("positive: exactly one primary lens and no precision use needs no override", () => {
    const result = checkLensBudget({
      sliceId: "A06",
      lensUsage: [{ id: "u1", kind: "primary-cloud", model: "deepseek-chat" }],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.primaryLensCount, 1);
  });

  test("negative: a routine slice requesting a second cloud lens without override is rejected", () => {
    const result = checkLensBudget({
      sliceId: "A06",
      lensUsage: [
        { id: "u1", kind: "primary-cloud", model: "deepseek-chat" },
        { id: "u2", kind: "primary-cloud", model: "gemini" },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("u2")));
  });

  test("negative: precision-model use without a recorded human override is rejected", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [
        { id: "u1", kind: "primary-cloud", model: "deepseek-chat" },
        { id: "u2", kind: "precision-adjudication", model: "opus-5" },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("u2")));
  });

  test("positive: precision-model use WITH a complete override (reason, approver, finding IDs) passes", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [
        { id: "u1", kind: "primary-cloud", model: "deepseek-chat" },
        { id: "u2", kind: "precision-adjudication", model: "opus-5" },
      ],
      overrides: [
        {
          lensUsageId: "u2",
          reason: "disputed security-high candidate needs cross-review",
          approvedBy: "lkikov",
          findingIds: ["A09-F3"],
        },
      ],
      knownFindingIds: ["A09-F3"],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.precisionCount, 1);
  });

  test("malformed override: missing findingIds still fails even when a reason and approver are present", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "precision-adjudication", model: "opus-5" }],
      overrides: [{ lensUsageId: "u1", reason: "why", approvedBy: "lkikov", findingIds: [] }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("finding ID")));
  });

  test("malformed override: findingIds containing null or an empty string is not a usable ID", () => {
    for (const badIds of [[null], [""], ["  "]]) {
      const result = checkLensBudget({
        sliceId: "A09",
        lensUsage: [{ id: "u1", kind: "precision-adjudication", model: "opus-5" }],
        overrides: [{ lensUsageId: "u1", reason: "why", approvedBy: "lkikov", findingIds: badIds }],
      });
      assert.strictEqual(result.ok, false, `expected findingIds=${JSON.stringify(badIds)} to fail`);
    }
  });

  test("malformed override: a whitespace-only approver is treated as missing", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "precision-adjudication", model: "opus-5" }],
      overrides: [{ lensUsageId: "u1", reason: "why", approvedBy: "   ", findingIds: ["A09-F1"] }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("approver")));
  });

  test("negative: a precision use with no id can never be matched to an override", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ kind: "precision-adjudication", model: "opus-5" }],
      overrides: [{ lensUsageId: undefined, reason: "why", approvedBy: "lkikov", findingIds: ["A09-F1"] }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("has no id")));
  });

  test("negative: two no-id precision uses are not both waved through by one override", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [
        { kind: "precision-adjudication", model: "opus-5" },
        { kind: "precision-adjudication", model: "opus-5" },
      ],
      overrides: [{ reason: "why", approvedBy: "lkikov", findingIds: ["A09-F1"] }],
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors.filter((e) => e.includes("has no id")).length, 2);
  });

  test("negative: duplicate lens-usage ids are rejected — an override must tie to one specific invocation", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [
        { id: "u1", kind: "primary-cloud", model: "deepseek-chat" },
        { id: "u1", kind: "precision-adjudication", model: "opus-5" },
      ],
      overrides: [{ lensUsageId: "u1", reason: "why", approvedBy: "lkikov", findingIds: ["A09-F1"] }],
      knownFindingIds: ["A09-F1"],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("used by more than one entry")));
  });

  test("malformed override: an approver that names no human ({}, [], a number) is treated as missing", () => {
    for (const bad of [{}, [], 42, true]) {
      const result = checkLensBudget({
        sliceId: "A09",
        lensUsage: [{ id: "u1", kind: "precision-adjudication", model: "opus-5" }],
        overrides: [{ lensUsageId: "u1", reason: "why", approvedBy: bad, findingIds: ["A09-F1"] }],
      });
      assert.strictEqual(result.ok, false, `expected approvedBy=${JSON.stringify(bad)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("approver")));
    }
  });

  test("malformed override: a non-string reason is not an adjudication reason", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "precision-adjudication", model: "opus-5" }],
      overrides: [{ lensUsageId: "u1", reason: {}, approvedBy: "lkikov", findingIds: ["A09-F1"] }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("adjudication reason")));
  });

  test("malformed input: a non-string lens-usage id cannot be named by an override", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: {}, kind: "precision-adjudication", model: "opus-5" }],
      overrides: [{ lensUsageId: {}, reason: "why", approvedBy: "lkikov", findingIds: ["A09-F1"] }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("has no id")));
  });

  test("malformed input: a non-array lensUsage is rejected, not silently replaced with empty", () => {
    const result = checkLensBudget({ sliceId: "A09", lensUsage: { kind: "primary-cloud" } });
    assert.strictEqual(result.ok, false);
  });

  test("boundary: no lens usage at all is a trivially valid empty budget", () => {
    const result = checkLensBudget({ sliceId: "A22", lensUsage: [] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.primaryLensCount, 0);
  });

  test("malformed input: lensUsage/overrides default safely when omitted", () => {
    const result = checkLensBudget({ sliceId: "A22" });
    assert.strictEqual(result.ok, true);
  });

  test("negative: an unrecognized lens kind fails closed instead of being excluded from the budget", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "frontier-sneak", model: "some-model" }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("u1") && e.includes("kind must be one of")));
  });

  test("negative: a frontier model labeled primary-cloud is reclassified as precision and still needs an override", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "primary-cloud", model: "claude-opus-5" }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("precision-tier")));
    assert.ok(result.errors.some((e) => e.includes("no recorded human override")));
  });

  test("negative: a frontier model hidden under ANY cheap kind still needs an override", () => {
    for (const kind of ["local-reconnaissance", "primary-cloud"]) {
      const result = checkLensBudget({
        sliceId: "A09",
        lensUsage: [{ id: "u1", kind, model: "claude-opus-5" }],
      });
      assert.strictEqual(result.ok, false, `expected a frontier model labeled ${kind} to fail`);
      assert.strictEqual(result.precisionCount, 1);
      assert.ok(result.errors.some((e) => e.includes("precision-tier") && e.includes(kind)));
      assert.ok(result.errors.some((e) => e.includes("no recorded human override")));
    }
  });

  test("negative: the deepseek-reasoner alias is precision-tier, not a routine primary lens", () => {
    for (const model of ["deepseek-reasoner", "deepseek-chat-reasoning", "o3-mini", "claude-opus-5"]) {
      const result = checkLensBudget({
        sliceId: "A06",
        lensUsage: [{ id: "u1", kind: "primary-cloud", model }],
      });
      assert.strictEqual(result.ok, false, `expected "${model}" to be treated as precision-tier`);
      assert.strictEqual(result.precisionCount, 1);
      assert.ok(result.errors.some((e) => e.includes("precision-tier")));
    }
  });

  test("negative: the frontier tiers of Aperio's own model catalog are precision, not primary", () => {
    // lib/pricing.js's WATCHED list is what this project actually bills for.
    // None of these names contains "opus", "gpt-5", or "reasoning", so a marker
    // built only from those words would wave the most expensive routine call in
    // the project through as a primary lens with no override.
    for (const model of [
      "claude-sonnet-5", "claude-sonnet-4.6", "claude-opus-4.8", "claude-fable-5",
      "gemini-2.5-pro", "deepseek-v4-pro", "gpt-5.6-luna", "gpt-5.5",
    ]) {
      const result = checkLensBudget({
        sliceId: "A09", lensUsage: [{ id: "u1", kind: "primary-cloud", model }],
      });
      assert.strictEqual(result.ok, false, `expected "${model}" to be treated as precision-tier`);
      assert.strictEqual(result.precisionCount, 1, `expected "${model}" to count against the precision budget`);
      assert.ok(result.errors.some((e) => e.includes("precision-tier")));
      assert.ok(result.errors.some((e) => e.includes("no recorded human override")));
    }
  });

  test("positive: the catalog's cheap tiers stay routine — the guard is not a blanket ban on cloud", () => {
    for (const model of ["deepseek-v4-flash", "gemini-2.5-flash", "claude-haiku-4.5"]) {
      const result = checkLensBudget({
        sliceId: "A09", lensUsage: [{ id: "u1", kind: "primary-cloud", model }],
      });
      assert.strictEqual(result.ok, true, `expected "${model}" to pass: ${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.precisionCount, 0);
      assert.strictEqual(result.primaryLensCount, 1);
    }
  });

  test("boundary: \"pro\" is a model tier only as a whole segment, not inside another word", () => {
    const result = checkLensBudget({
      sliceId: "A09", lensUsage: [{ id: "u1", kind: "primary-cloud", model: "deepseek-chat (provider: deepseek)" }],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.precisionCount, 0);
  });

  test("negative: a cloud lens naming no model cannot be classified and fails closed to precision", () => {
    for (const kind of ["primary-cloud", "precision-adjudication"]) {
      const result = checkLensBudget({ sliceId: "A06", lensUsage: [{ id: "u1", kind }] });
      assert.strictEqual(result.ok, false, `expected a ${kind} use with no model to fail`);
      assert.strictEqual(result.precisionCount, 1);
      assert.strictEqual(result.primaryLensCount, 0);
      assert.ok(result.errors.some((e) => e.includes("names no model")));
    }
  });

  test("negative: an unreadable model value is unclassifiable, not routine", () => {
    for (const bad of [{}, [], 42, "   "]) {
      const result = checkLensBudget({
        sliceId: "A06", lensUsage: [{ id: "u1", kind: "primary-cloud", model: bad }],
      });
      assert.strictEqual(result.ok, false, `expected model=${JSON.stringify(bad)} to fail`);
      assert.strictEqual(result.precisionCount, 1);
      assert.ok(result.errors.some((e) => e.includes("model must be a non-empty string")));
    }
  });

  test("boundary: reconnaissance may name no model — a ripgrep pass is not a model call", () => {
    const result = checkLensBudget({
      sliceId: "A06",
      lensUsage: [
        { id: "u1", kind: "local-reconnaissance" },
        { id: "u2", kind: "primary-cloud", model: "deepseek-chat" },
      ],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.precisionCount, 0);
  });

  test("positive: the non-reasoning DeepSeek coding model is the routine primary lens", () => {
    for (const model of ["deepseek-chat", "deepseek-coder"]) {
      const result = checkLensBudget({ sliceId: "A06", lensUsage: [{ id: "u1", kind: "primary-cloud", model }] });
      assert.strictEqual(result.ok, true, `expected "${model}" to pass: ${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.precisionCount, 0);
    }
  });

  test("boundary: a genuinely local reconnaissance pass costs nothing and needs no override", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [
        { id: "u1", kind: "local-reconnaissance", model: "qwen2.5-coder-7b", provider: "llamacpp" },
        { id: "u2", kind: "primary-cloud", model: "deepseek-chat" },
      ],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.precisionCount, 0);
    assert.strictEqual(result.primaryLensCount, 1);
  });

  test("negative: a cloud model labeled local-reconnaissance still spends the cloud-lens budget", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [
        { id: "u1", kind: "primary-cloud", model: "deepseek-chat" },
        // No local provider recorded: the free-kind label is the ONLY thing
        // claiming this never left the machine, so it is budgeted as cloud.
        { id: "u2", kind: "local-reconnaissance", model: "gemini-2.0-flash" },
      ],
    });
    assert.strictEqual(result.ok, false, JSON.stringify(result.errors));
    assert.strictEqual(result.primaryLensCount, 2);
    assert.ok(result.errors.some((e) => e.includes("u2") && e.includes("cannot be placed as a local model")));
  });

  test("boundary: locality comes from the provider/model runtime, and an injected classifier wins", () => {
    // The repo's own local model reads like a hosted one, so the name alone
    // must not be what grants the exemption.
    const byName = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "local-reconnaissance", model: "qwen2.5-coder-7b" }],
    });
    assert.strictEqual(byName.ok, true, JSON.stringify(byName.errors));
    assert.strictEqual(byName.primaryLensCount, 1, "an unplaceable recon model is budgeted as the slice's cloud lens");

    // A caller with a real roster can place it, and it costs nothing.
    const byRoster = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "local-reconnaissance", model: "qwen2.5-coder-7b" }],
      isLocalModel: (model) => model === "qwen2.5-coder-7b",
    });
    assert.strictEqual(byRoster.ok, true, JSON.stringify(byRoster.errors));
    assert.strictEqual(byRoster.primaryLensCount, 0);
  });

  test("boundary: a model-free reconnaissance pass (a ripgrep sweep) is still exempt", () => {
    // No model AND no provider: a local tool, not a call to anything.
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "local-reconnaissance" }],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.primaryLensCount, 0);

    // A local provider says the same thing, and stays exempt too.
    const local = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "local-reconnaissance", provider: "llamacpp" }],
    });
    assert.strictEqual(local.ok, true, JSON.stringify(local.errors));
    assert.strictEqual(local.primaryLensCount, 0);
  });

  test("negative: a model-free recon entry whose PROVIDER is a cloud one still spends the budget", () => {
    // Omitting the model must not be a cheaper way to hide a cloud lens than
    // naming it: the record says anthropic, so this is a second cloud call.
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [
        { id: "u1", kind: "primary-cloud", model: "deepseek-chat" },
        { id: "u2", kind: "local-reconnaissance", provider: "anthropic" },
      ],
    });
    assert.strictEqual(result.ok, false, JSON.stringify(result.errors));
    assert.strictEqual(result.primaryLensCount, 2);
    assert.ok(result.errors.some((e) => e.includes("u2") && e.includes("cannot be placed as local")),
      JSON.stringify(result.errors));
  });

  test("boundary: a model-free recon entry with an unreadable provider fails closed", () => {
    for (const provider of [{}, [], 42, "   "]) {
      const result = checkLensBudget({
        sliceId: "A09",
        lensUsage: [
          { id: "u1", kind: "primary-cloud", model: "deepseek-chat" },
          { id: "u2", kind: "local-reconnaissance", provider },
        ],
      });
      assert.strictEqual(result.ok, false, `expected provider=${JSON.stringify(provider)} to fail closed`);
      assert.strictEqual(result.primaryLensCount, 2);
    }
  });

  test("negative: a frontier model labeled local-reconnaissance is precision, not merely cloud", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "local-reconnaissance", model: "claude-opus-5", provider: "llamacpp" }],
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.precisionCount, 1);
  });

  test("negative: an override naming a finding this slice never produced authorizes nothing", () => {
    for (const findingIds of [["unrelated"], ["A09-F9"], ["A09-F3", "unrelated"]]) {
      const result = checkLensBudget({
        sliceId: "A09",
        lensUsage: [{ id: "u1", kind: "precision-adjudication", model: "opus-5" }],
        overrides: [{ lensUsageId: "u1", reason: "why", approvedBy: "lkikov", findingIds }],
        knownFindingIds: ["A09-F3"],
      });
      assert.strictEqual(result.ok, false, `expected findingIds=${JSON.stringify(findingIds)} to fail`);
      assert.ok(result.errors.some((e) => e.includes("not findings of this slice")),
        JSON.stringify(result.errors));
    }
  });

  test("negative: an override whose finding IDs cannot be checked fails closed", () => {
    // No set supplied, an unreadable set, and a slice with no findings at all:
    // in none of them is the precision spend tied to evidence that warranted it.
    for (const knownFindingIds of [undefined, "A09-F3", {}, []]) {
      const result = checkLensBudget({
        sliceId: "A09",
        lensUsage: [{ id: "u1", kind: "precision-adjudication", model: "opus-5" }],
        overrides: [{ lensUsageId: "u1", reason: "why", approvedBy: "lkikov", findingIds: ["A09-F3"] }],
        knownFindingIds,
      });
      assert.strictEqual(result.ok, false, `expected knownFindingIds=${JSON.stringify(knownFindingIds)} to fail`);
    }
  });

  test("positive: a frontier model labeled primary-cloud passes once it carries a full override", () => {
    const result = checkLensBudget({
      sliceId: "A09",
      lensUsage: [{ id: "u1", kind: "primary-cloud", model: "claude-opus-5" }],
      overrides: [{ lensUsageId: "u1", reason: "why", approvedBy: "lkikov", findingIds: ["A09-F1"] }],
      knownFindingIds: ["A09-F1"],
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  });
});

describe("audit/scripts/slice-execution.js — T6.4 duplicate search", () => {
  const candidate = {
    violatedInvariant: "path traversal cannot escape APERIO_ALLOWED_PATHS_TO_READ",
    affectedPaths: [{ file: "lib/routes/paths.js", line: 42 }],
    symptom: "read outside allowed dir",
  };

  test("positive: same invariant and same affected path links as Duplicate", () => {
    const result = classifyDuplicate(candidate, [
      {
        id: "GH-501",
        source: "github",
        violatedInvariant: "path traversal cannot escape APERIO_ALLOWED_PATHS_TO_READ",
        affectedPaths: [{ file: "lib/routes/paths.js", line: 42 }],
      },
    ]);
    assert.strictEqual(result.classification, "Duplicate");
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].id, "GH-501");
  });

  test("positive: same invariant and same FILE (different line) still links as Duplicate", () => {
    const result = classifyDuplicate(candidate, [
      {
        id: "LEDGER-A15-F2",
        source: "ledger",
        violatedInvariant: "path traversal cannot escape APERIO_ALLOWED_PATHS_TO_READ",
        affectedPaths: [{ file: "lib/routes/paths.js", line: 91 }],
      },
    ]);
    assert.strictEqual(result.classification, "Duplicate");
  });

  test("positive: equivalent spellings of the same file still link as Duplicate", () => {
    for (const file of [
      "./lib/routes/paths.js",
      "lib//routes/paths.js",
      "lib\\routes\\paths.js",
      "lib/tools/../routes/paths.js",
      "  lib/routes/paths.js  ",
    ]) {
      const result = classifyDuplicate(candidate, [
        {
          id: "GH-501",
          source: "github",
          violatedInvariant: "path traversal cannot escape APERIO_ALLOWED_PATHS_TO_READ",
          affectedPaths: [{ file, line: 42 }],
        },
      ]);
      assert.strictEqual(result.classification, "Duplicate",
        `expected "${file}" to match "lib/routes/paths.js", got ${result.classification}`);
    }
  });

  test("boundary: an absolute path is not silently merged with a repo-relative one", () => {
    const result = classifyDuplicate(candidate, [
      {
        id: "GH-501",
        source: "github",
        violatedInvariant: "path traversal cannot escape APERIO_ALLOWED_PATHS_TO_READ",
        affectedPaths: [{ file: "/lib/routes/paths.js", line: 42 }],
      },
    ]);
    assert.strictEqual(result.classification, "Distinct");
  });

  test("negative: an unrelated finding (different invariant, different file) stays distinct", () => {
    const result = classifyDuplicate(candidate, [
      {
        id: "GH-777",
        source: "github",
        violatedInvariant: "ctx shape must equal createContext()",
        affectedPaths: [{ file: "mcp/index.js", line: 12 }],
      },
    ]);
    assert.strictEqual(result.classification, "Distinct");
    assert.deepStrictEqual(result.matches, []);
  });

  test("edge case: same symptom but a different invariant/root cause remains a distinct, linked finding", () => {
    const result = classifyDuplicate(candidate, [
      {
        id: "GH-888",
        source: "github",
        violatedInvariant: "read-only tool must not trigger a write",
        affectedPaths: [{ file: "lib/tools/webRead.js", line: 5 }],
        symptom: "read outside allowed dir",
      },
    ]);
    assert.strictEqual(result.classification, "Distinct");
    assert.strictEqual(result.relatedBySymptom.length, 1);
    assert.strictEqual(result.relatedBySymptom[0].id, "GH-888");
  });

  test("boundary: no existing records at all is trivially Distinct", () => {
    const result = classifyDuplicate(candidate, []);
    assert.strictEqual(result.classification, "Distinct");
    assert.deepStrictEqual(result.matches, []);
  });

  test("malformed input: a candidate missing affectedPaths is invalid, NOT an actionable Distinct verdict", () => {
    const result = classifyDuplicate({ violatedInvariant: "x" }, [{ id: "GH-1", violatedInvariant: "x" }]);
    assert.strictEqual(result.classification, "invalid");
    assert.strictEqual(result.matches.length, 0);
    assert.ok(result.errors.length > 0);
  });

  test("malformed input: a non-string violatedInvariant is invalid, NOT an actionable Distinct", () => {
    for (const bad of [{}, [], ["path traversal"], 42, "   "]) {
      const result = classifyDuplicate({ ...candidate, violatedInvariant: bad }, [
        {
          id: "GH-501",
          source: "github",
          violatedInvariant: "path traversal cannot escape APERIO_ALLOWED_PATHS_TO_READ",
          affectedPaths: [{ file: "lib/routes/paths.js", line: 42 }],
        },
      ]);
      assert.strictEqual(result.classification, "invalid",
        `expected violatedInvariant=${JSON.stringify(bad)} to be invalid, got ${result.classification}`);
      assert.ok(result.errors.some((e) => e.includes("violatedInvariant")));
    }
  });

  test("malformed record: an unreadable existing record makes the search invalid, not Distinct", () => {
    // The records ARE the search space. A record this search cannot read is
    // skipped silently — and a skipped record is indistinguishable from one
    // that did not match, so it could be the very duplicate being cleared.
    for (const bad of [
      { id: "GH-502", violatedInvariant: {}, affectedPaths: [{ file: "lib/routes/paths.js" }] },
      { id: "GH-503", violatedInvariant: "x", affectedPaths: [{ line: 4 }] },
      { id: "GH-504", violatedInvariant: "x" },
      { id: "GH-506", violatedInvariant: "x", affectedPaths: [{ file: "." }] },
      { id: "GH-507", violatedInvariant: "x", affectedPaths: [{ file: "lib/.." }] },
      { violatedInvariant: "x", affectedPaths: [{ file: "lib/routes/paths.js" }] },
      null,
      "GH-505",
    ]) {
      const result = classifyDuplicate(candidate, [bad]);
      assert.strictEqual(result.classification, "invalid",
        `expected record ${JSON.stringify(bad)} to make the search invalid`);
      assert.ok(result.errors.some((e) => e.includes("existingRecords[0]")));
    }
  });

  test("malformed input: affectedPaths that name no usable file is invalid, NOT an actionable Distinct", () => {
    // The last four are non-blank strings that normalize away to nothing: they
    // produce no comparison key at all, so the search would compare against an
    // empty file set and clear the way to a duplicate finding.
    for (const badPaths of [[{ line: 1 }], [{ file: "" }], [{ file: "   " }], [{ file: 42 }], [null],
      [{ file: "." }], [{ file: "./" }], [{ file: "foo/.." }], [{ file: "a/b/../.." }]]) {
      const result = classifyDuplicate({ ...candidate, affectedPaths: badPaths }, [
        {
          id: "GH-501",
          source: "github",
          violatedInvariant: "path traversal cannot escape APERIO_ALLOWED_PATHS_TO_READ",
          affectedPaths: [{ file: "lib/routes/paths.js", line: 42 }],
        },
      ]);
      assert.strictEqual(result.classification, "invalid",
        `expected affectedPaths=${JSON.stringify(badPaths)} to be invalid, got ${result.classification}`);
      assert.ok(result.errors.some((e) => e.includes("affectedPaths")));
    }
  });

  test("malformed input: one unusable path among good ones is still reported, not quietly skipped", () => {
    const result = classifyDuplicate(
      { ...candidate, affectedPaths: [{ file: "lib/routes/paths.js", line: 42 }, { line: 9 }] },
      [],
    );
    assert.strictEqual(result.classification, "invalid");
    assert.ok(result.errors.some((e) => e.includes("affectedPaths[1]")));
  });

  test("malformed input: an unsearchable (non-array) existingRecords is invalid, not Distinct", () => {
    const result = classifyDuplicate(candidate, "not-an-array");
    assert.strictEqual(result.classification, "invalid");
    assert.ok(result.errors.some((e) => e.includes("existingRecords")));
  });

  test("malformed input: a non-object candidate is invalid and does not throw", () => {
    assert.doesNotThrow(() => classifyDuplicate(null, []));
    const result = classifyDuplicate(null, []);
    assert.strictEqual(result.classification, "invalid");
  });
});

describe("audit/scripts/slice-execution.js — exercise against A01-A22-style fixtures", () => {
  test("a representative mixed wave (complete, deferred, incomplete) reconciles end to end", () => {
    const wave = [
      completeReport({ slice: "A02" }),
      completeReport({ slice: "A03" }),
      completeReport({ slice: "A04" }),
      completeReport({ slice: "A09" }),
      completeReport({ slice: "A14" }),
      completeReport({ slice: "A15" }),
      deferral({ slice: "A21" }),
      { slice: "A22" }, // still in progress
    ];
    const gate = checkWaveExitGate(wave, {
      expectedSlices: ["A02", "A03", "A04", "A09", "A14", "A15", "A21", "A22"],
    });
    assert.strictEqual(gate.complete.length, 6);
    assert.deepStrictEqual(gate.deferred, ["A21"]);
    assert.deepStrictEqual(gate.incomplete, ["A22"]);
    assert.strictEqual(gate.ok, false);

    const escalation = checkCandidateEscalation({
      finding: {
        id: "A14-F1", title: "t", severity: "low", confidence: "low",
        affectedPaths: [{ file: "db/sqlite/store.js", line: 10 }],
        violatedInvariant: "SQLite/Postgres semantics remain equivalent",
        reproduction: "audit/tests/database-contract.test.js",
        expected: "e", actual: "a", impact: "i", evidence: "e",
        suggestedMitigation: "m", regressionTestLocation: "audit/tests/database-contract.test.js",
        status: "Candidate",
        revision: "ad1d6ce365e0",
        variantsConsidered: ["sqlite", "postgres"],
        duplicateSearch: { classification: "Distinct", matches: [], relatedBySymptom: [] },
        model: "deepseek-chat",
        tokens: { ...TOKENS },
      },
      toStatus: "Confirmed",
      evidenceItems: [{ kind: "focused-test", detail: "audit/tests/database-contract.test.js" }],
    });
    assert.strictEqual(escalation.ok, true, JSON.stringify(escalation.errors));

    const duplicate = classifyDuplicate(
      { violatedInvariant: "SQLite/Postgres semantics remain equivalent", affectedPaths: [{ file: "db/sqlite/store.js", line: 10 }] },
      [],
    );
    assert.strictEqual(duplicate.classification, "Distinct");

    const budget = checkLensBudget({
      sliceId: "A14",
      lensUsage: [{ id: "u1", kind: "primary-cloud", model: "deepseek-chat" }],
    });
    assert.strictEqual(budget.ok, true);
  });
});

// SCHEMA re-export sanity: T6 reuses the vocabulary rather than duplicating it.
describe("audit/scripts/slice-execution.js — reuses schema.js's vocabulary", () => {
  test("candidate status validation uses SCHEMA.STATUSES, not a private copy", () => {
    assert.ok(SCHEMA.STATUSES.includes("Confirmed"));
    const result = checkSliceExitGate(completeReport({ candidates: [{ id: "x", status: "Confirmed" }] }));
    assert.strictEqual(result.complete, true, JSON.stringify(result.errors));
  });
});
