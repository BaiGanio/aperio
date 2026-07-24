// audit/tests/schema.test.js
// T3 — Run and finding schema tests for Aperio Continuous Audit.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateRun,
  validateFinding,
  canTransition,
  transitionFinding,
  makeRunId,
  FINDING_STATUSES,
  SEVERITIES,
} from "../scripts/schema.js";

function validRun(overrides = {}) {
  return {
    schema_version: "aperio-audit-run-v1",
    run_id: "A14-abc-1234",
    slice_id: "A14",
    revision: "abc123def456",
    branch: "main",
    timestamp: new Date().toISOString(),
    scope: "Database migration parity",
    observer: "inventory.js",
    elapsed_ms: 1234,
    ...overrides,
  };
}

function validFinding(overrides = {}) {
  return {
    id: "A14-001",
    revision: "abc123def456",
    status: "candidate",
    severity: "medium",
    confidence: "high",
    affected_locations: ["db/sqlite.js:45"],
    invariant: "All store operations exist in both backends",
    expected_behavior: "Both adapters implement get()",
    actual_behavior: "SQLite get() exists, Postgres get() missing",
    evidence: "db/postgres/store.js does not export get",
    reproduction: "See audit/tests/database-contract.test.js:55",
    ...overrides,
  };
}

// ─── T3.1: Run record validation ────────────────────────────────────────────

describe("T3 — Schema validation", () => {
  describe("T3.1 — Run record validation", () => {
    test("accepts a complete valid run record", () => {
      const result = validateRun(validRun());
      assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join(", ")}`);
    });

    test("rejects run without schema_version", () => {
      const result = validateRun(validRun({ schema_version: undefined }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("schema_version")));
    });

    test("rejects run without run_id", () => {
      const result = validateRun(validRun({ run_id: undefined }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("run_id")));
    });

    test("rejects run without revision", () => {
      const result = validateRun(validRun({ revision: undefined }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("revision")));
    });

    test("rejects run without branch", () => {
      const result = validateRun(validRun({ branch: "" }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("branch")));
    });

    test("rejects run without timestamp", () => {
      const result = validateRun(validRun({ timestamp: null }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("timestamp")));
    });

    test("rejects run without observer", () => {
      const result = validateRun(validRun({ observer: undefined }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("observer")));
    });

    test("rejects run without elapsed_ms", () => {
      const result = validateRun(validRun({ elapsed_ms: undefined }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("elapsed_ms")));
    });

    test("rejects run with invalid model_usage type", () => {
      const result = validateRun(validRun({
        model_usage: { input_tokens: "not-a-number" },
      }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("input_tokens")));
    });

    test("accepts run with model_usage (valid type)", () => {
      const result = validateRun(validRun({
        model_usage: { input_tokens: 15000, output_tokens: 2000 },
      }));
      assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join(", ")}`);
    });
  });

  // ─── T3.2: Finding validation ────────────────────────────────────────────

  describe("T3.2 — Finding validation", () => {
    test("accepts a complete valid finding", () => {
      const result = validateFinding(validFinding());
      assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join(", ")}`);
    });

    test("rejects finding without id", () => {
      const result = validateFinding(validFinding({ id: undefined }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("id")));
    });

    test("rejects finding without revision", () => {
      const result = validateFinding(validFinding({ revision: "" }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("revision")));
    });

    test("rejects finding without evidence", () => {
      const result = validateFinding(validFinding({ evidence: undefined }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("evidence")));
    });

    test("rejects finding without invariant (not violated)", () => {
      const result = validateFinding(validFinding({ invariant: null }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("invariant")));
    });

    test("rejects invalid status", () => {
      const result = validateFinding(validFinding({ status: "invalid-status" }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("status")));
    });

    test("rejects invalid severity", () => {
      const result = validateFinding(validFinding({ severity: "catastrophic" }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("severity")));
    });

    test("rejects invalid confidence", () => {
      const result = validateFinding(validFinding({ confidence: "certain" }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("confidence")));
    });

    test("rejects non-array affected_locations", () => {
      const result = validateFinding(validFinding({ affected_locations: "db/sqlite.js:45" }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("affected_locations")));
    });

    test("rejects empty affected_locations", () => {
      const result = validateFinding(validFinding({ affected_locations: [] }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes("affected_locations")));
    });

    test("accepts all valid statuses", () => {
      for (const status of FINDING_STATUSES) {
        const result = validateFinding(validFinding({ status }));
        assert.ok(result.valid, `Status "${status}" should be valid`);
      }
    });

    test("accepts all valid severities", () => {
      for (const sev of SEVERITIES) {
        const result = validateFinding(validFinding({ severity: sev }));
        assert.ok(result.valid, `Severity "${sev}" should be valid`);
      }
    });
  });

  // ─── T3.3: Status transitions ────────────────────────────────────────────

  describe("T3.3 — Status transitions", () => {
    test("candidate → confirmed is allowed", () => {
      const check = canTransition("candidate", "confirmed");
      assert.ok(check.allowed, check.reason);
    });

    test("candidate → rejected is allowed", () => {
      const check = canTransition("candidate", "rejected");
      assert.ok(check.allowed, check.reason);
    });

    test("confirmed → planned is allowed", () => {
      const check = canTransition("confirmed", "planned");
      assert.ok(check.allowed, check.reason);
    });

    test("confirmed → duplicate is allowed", () => {
      const check = canTransition("confirmed", "duplicate");
      assert.ok(check.allowed, check.reason);
    });

    test("confirmed → accepted-risk is allowed", () => {
      const check = canTransition("confirmed", "accepted-risk");
      assert.ok(check.allowed, check.reason);
    });

    test("rejected is a terminal state", () => {
      // From the plan: Rejected → [*]
      const check = canTransition("rejected", "confirmed");
      assert.equal(check.allowed, false);
      assert.ok(check.reason.includes("terminal") || check.reason.includes("Cannot"));
    });

    test("duplicate is a terminal state", () => {
      const check = canTransition("duplicate", "candidate");
      assert.equal(check.allowed, false);
    });

    test("accepted-risk can be reopened", () => {
      const check = canTransition("accepted-risk", "reopened");
      assert.ok(check.allowed, check.reason);
    });

    test("planned → fixed is allowed", () => {
      const check = canTransition("planned", "fixed");
      assert.ok(check.allowed, check.reason);
    });

    test("fixed can be reopened", () => {
      const check = canTransition("fixed", "reopened");
      assert.ok(check.allowed, check.reason);
    });

    test("reopened → confirmed is allowed (reinvestigation)", () => {
      const check = canTransition("reopened", "confirmed");
      assert.ok(check.allowed, check.reason);
    });

    test("transitionFinding applies transition and preserves history", () => {
      const finding = validFinding({ status: "candidate" });
      const updated = transitionFinding(finding, "confirmed", {
        reason: "Evidence reproduced in tests",
      });

      assert.equal(updated.status, "confirmed");
      assert.ok(Array.isArray(updated.history));
      assert.equal(updated.history.length, 1);
      assert.equal(updated.history[0].from, "candidate");
      assert.equal(updated.history[0].to, "confirmed");
      assert.equal(updated.history[0].reason, "Evidence reproduced in tests");
      assert.ok(updated.updated_at);
    });

    test("transitionFinding throws on invalid transition", () => {
      const finding = validFinding({ status: "rejected" });
      assert.throws(() => {
        transitionFinding(finding, "confirmed");
      }, /Cannot transition|terminal/);
    });

    test("transitionFinding appends to existing history", () => {
      const finding = validFinding({ status: "confirmed", history: [
        { from: "candidate", to: "confirmed", timestamp: "2024-01-01", reason: "v1" },
      ]});
      const updated = transitionFinding(finding, "planned", { reason: "Scheduled" });
      assert.equal(updated.history.length, 2);
      assert.equal(updated.history[1].to, "planned");
    });
  });

  // ─── T3.4: Run ID generation ─────────────────────────────────────────────

  describe("T3.4 — Run ID generation", () => {
    test("makeRunId includes the slice prefix", () => {
      const id = makeRunId("A14");
      assert.ok(id.startsWith("A14-"), `Expected A14- prefix, got: ${id}`);
    });

    test("makeRunId produces unique IDs", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(makeRunId("A01"));
      }
      assert.equal(ids.size, 100, "All 100 generated IDs should be unique");
    });
  });
});
