// T3.3 persistence — audit/scripts/ledger.js.
//
// The durable ledger is append-only JSONL. These tests pin the dangerous seam:
// Anthropic's stream usage cache-write count must survive the trip to disk,
// and a missing count must fail before it can be misrepresented as zero.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunRecord,
  createRunRecord,
  readRunLedger,
} from "../scripts/ledger.js";
import { checkUsageAccountingContract } from "../scripts/usage-accounting.js";

const BASE = {
  runId: "A06-2026-08-20-01",
  baselineSha: "a".repeat(40),
  lens: "software architect",
  scope: "A06",
  filesRead: ["lib/agent/providers/anthropic.js"],
  commandsRun: ["npm run test:audit"],
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  candidates: [],
  confirmedFindings: [],
  rejectedCandidates: [],
  residualUncertainty: "none",
  elapsedMs: 1234,
};

const USAGE = {
  input_tokens: 120_000,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 20_000,
  thinking_tokens: 1_000,
  output_tokens: 5_000,
};

function withLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), "aperio-audit-ledger-"));
  const file = join(dir, "runs.jsonl");
  try { return fn(file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("audit/scripts/ledger.js", () => {
  test("T3.3 — streamUsage maps to the durable token schema without dropping cache writes", () => {
    const record = createRunRecord({ ...BASE, streamUsage: USAGE });
    assert.deepStrictEqual(record.tokens, {
      input: 120_000,
      cachedInput: 90_000,
      cacheCreationInput: 20_000,
      reasoning: 1_000,
      output: 5_000,
    });

    withLedger((file) => {
      appendRunRecord(record, { file });
      const loaded = readRunLedger({ file });
      assert.deepStrictEqual(loaded, { records: [record], errors: [] });
      assert.match(readFileSync(file, "utf8"), /"cacheCreationInput":20000/);
    });
  });

  test("T3.3 — a cache-writing provider cannot persist a missing cache-creation count as zero", () => {
    const missing = { ...USAGE };
    delete missing.cache_creation_input_tokens;
    assert.throws(
      () => createRunRecord({ ...BASE, streamUsage: missing }),
      /anthropic.*cache_creation_input_tokens.*missing/,
    );
  });

  test("T3.3 — providers whose real loop does not report cache writes record an explicit zero", () => {
    const record = createRunRecord({
      ...BASE,
      runId: "A06-deepseek",
      provider: "deepseek",
      model: "deepseek-chat",
      streamUsage: {
        input_tokens: 30_000,
        output_tokens: 4_000,
        thinking_tokens: 0,
      },
    });
    assert.strictEqual(record.tokens.cacheCreationInput, 0);
    assert.strictEqual(record.tokens.cachedInput, 0);
  });

  test("T3.3 — append is immutable by runId and leaves the original bytes untouched", () => {
    withLedger((file) => {
      const record = createRunRecord({ ...BASE, streamUsage: USAGE });
      appendRunRecord(record, { file });
      const before = readFileSync(file, "utf8");
      assert.throws(() => appendRunRecord(record, { file }), /duplicate runId/);
      assert.strictEqual(readFileSync(file, "utf8"), before);
    });
  });

  test("T3.3 — a missing configured ledger and duplicate rows both fail closed", () => {
    withLedger((file) => {
      const missing = checkUsageAccountingContract({ ledgerFile: file });
      assert.strictEqual(missing.ok, false);
      assert.ok(missing.errors.some((e) => e.includes("could not be read") && e.includes("ENOENT")));

      const record = createRunRecord({ ...BASE, streamUsage: USAGE });
      writeFileSync(file, `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`, "utf8");
      const duplicated = readRunLedger({ file });
      assert.ok(duplicated.errors.some((e) => e.includes("duplicate runId") && e.includes("line 2")));
      assert.throws(
        () => appendRunRecord({ ...record, runId: "another-run" }, { file }),
        /cannot append to an invalid audit ledger.*duplicate runId/,
      );
    });
  });

  test("T3.3 — the real accounting contract reads the persisted ledger by default", () => {
    withLedger((file) => {
      const record = createRunRecord({
        ...BASE,
        runId: "A06-local",
        provider: "llamacpp",
        model: "qwen2.5-coder-7b",
        streamUsage: { input_tokens: 18_000, output_tokens: 2_000, thinking_tokens: 0 },
      });
      appendRunRecord(record, { file });
      const result = checkUsageAccountingContract({ ledgerFile: file });
      assert.strictEqual(result.ok, true, JSON.stringify(result.errors, null, 2));
      assert.strictEqual(result.ledgerFile, file);
      assert.strictEqual(result.rows.length, 1);
      assert.strictEqual(result.rows[0].runId, "A06-local");
      assert.strictEqual(result.rows[0].tokens.cacheCreationInput, 0);
    });
  });

  test("T3.3 — malformed and schema-invalid rows are reported, never skipped", () => {
    withLedger((file) => {
      writeFileSync(file, "{not json}\n{}\n", "utf8");
      const loaded = readRunLedger({ file });
      assert.deepStrictEqual(loaded.records, []);
      assert.ok(loaded.errors.some((e) => e.includes("line 1") && e.includes("invalid JSON")));
      assert.ok(loaded.errors.some((e) => e.includes("line 2") && e.includes("missing required field")));

      const result = checkUsageAccountingContract({ ledgerFile: file });
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes("line 1") && e.includes("invalid JSON")));
    });
  });
});
