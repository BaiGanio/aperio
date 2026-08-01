// Negative mutation tests for the T-R5 gate.
//
//   node --test "tests/fixtures/household-gen/*.test.mjs"
//
// A gate that passes a correct answer proves nothing on its own — the old bare-regex
// gate did that too. What matters is that each deliberate defect fails, and fails
// for its own reason. Every case below mutates the same correct answer in exactly
// one way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildExpectations, evaluateAnswer, parseCategoryClaims, parseGrandTotals, parseMoney,
} from "./harness-gate.mjs";

const oracle = JSON.parse(await readFile(resolve(import.meta.dirname, "ground-truth.json"), "utf8"));
const CORPUS_ROOT = "/Users/lk/Projects/household";
const expectations = buildExpectations(oracle, "2026-06", { corpusRoot: CORPUS_ROOT });

const CORRECT_ANSWER = `Here is your June 2026 spending, by category:

- Utilities: 260.50 BGN (electricity 142.50, water 38.20, heating 64.80, waste fee 15.00)
- Fuel: 215.60 BGN (120.00 on 9 June and 95.60 on 25 June)
- Groceries: 140.75 BGN (87.45 and 53.30)
- Transport: 50.00 BGN
- Internet: 29.99 BGN

Total: 696.84 BGN

I excluded the Berlin hotel (128.00 EUR), the Munich train (49.90 EUR) and the
Paris airport receipt (18.50 EUR) because they are travel in another currency,
and the steel trade invoice because it is not household spending.`;

// Tool evidence covering every June source document plus the statement.
const FULL_TOOL_CALLS = [{
  name: "doc_batch",
  arguments: {
    paths: [
      "electricity-bill-03-jun.txt", "water-bill-05-jun.txt", "heating-bill-15-jun.txt",
      "waste-fee-22-jun.txt", "fuel-receipt-09-jun.txt", "fuel-receipt-25-jun.txt",
      "transport-topup-28-jun.txt", "internet-payment-12-jun.txt", "bank-statement-jun.txt",
    ],
  },
  summary: "read 9 documents",
}];
const FULL_SEQUENCE = ["doc_manifest", "doc_batch"];

function run(answer, options = {}) {
  return evaluateAnswer({
    answer,
    toolSequence: options.toolSequence ?? FULL_SEQUENCE,
    toolCalls: options.toolCalls ?? FULL_TOOL_CALLS,
    expectations,
  });
}

test("money parsing handles both decimal conventions and thousands separators", () => {
  assert.equal(parseMoney("260.50"), 260.5);
  assert.equal(parseMoney("260,50"), 260.5);
  assert.equal(parseMoney("1 266 250,00"), 1266250);
  assert.equal(parseMoney("1,266,250.00"), 1266250);
  assert.equal(parseMoney("-34,20"), -34.2);
});

test("category claims are associated, not merely present", () => {
  const claims = parseCategoryClaims("- Utilities: 260.50 BGN\n- Fuel: 215.60 BGN");
  assert.deepEqual(claims.get("Utilities"), [260.5]);
  assert.deepEqual(claims.get("Fuel"), [215.6]);
  assert.equal(parseGrandTotals("Total: 696.84 BGN")[0], 696.84);
});

test("a correct answer passes", () => {
  const result = run(CORRECT_ANSWER);
  assert.deepEqual(result.failures, []);
  assert.equal(result.status, "pass");
});

test("markdown table answers are gradable too", () => {
  const result = run(`| Category | Amount |
|---|---|
| Utilities | 260.50 |
| Fuel | 215.60 |
| Groceries | 140.75 |
| Transport | 50.00 |
| Internet | 29.99 |
| **Total** | **696.84** |`);
  assert.equal(result.status, "pass", result.failures.join("; "));
});

test("a Bulgarian-language answer is gradable", () => {
  const result = run(`Разходите ви за юни 2026 г.:

- Комунални услуги: 260,50 лв
- Горива: 215,60 лв
- Хранителни продукти: 140,75 лв
- Транспорт: 50,00 лв
- Интернет: 29,99 лв

Общо: 696,84 лв`);
  assert.equal(result.status, "pass", result.failures.join("; "));
});

// --- mutations -------------------------------------------------------------

test("MUTATION omitted source: dropping the internet payment fails on Internet and the total", () => {
  const result = run(CORRECT_ANSWER
    .replace("- Internet: 29.99 BGN\n", "")
    .replace("Total: 696.84 BGN", "Total: 666.85 BGN"));
  assert.equal(result.status, "fail");
  assert.equal(result.gate.categories.Internet, false);
  assert.equal(result.gate.grandTotalCorrect, false);
  assert.ok(result.failures.some(failure => failure.startsWith("Internet:")), result.failures.join("; "));
});

test("MUTATION doubled fuel: counting the statement row and the receipt twice fails on the signature", () => {
  const result = run(CORRECT_ANSWER
    .replace("- Fuel: 215.60 BGN (120.00 on 9 June and 95.60 on 25 June)", "- Fuel: 240.00 BGN (120.00 twice)")
    .replace("Total: 696.84 BGN", "Total: 721.24 BGN"));
  assert.equal(result.status, "fail");
  assert.equal(result.gate.categories.Fuel, false);
  assert.equal(result.gate.noFailureSignatures, false);
  assert.ok(result.detail.signatures["fuelDoubleCounted_120.00"].hit);
  assert.equal(result.detail.signatures["fuelDoubleCounted_120.00"].value, 240);
});

test("MUTATION wrong category: a right number under the wrong label fails", () => {
  // The old regex gate passed this: every expected numeral is still present.
  const result = run(CORRECT_ANSWER
    .replace("- Utilities: 260.50 BGN", "- Utilities: 215.60 BGN")
    .replace("- Fuel: 215.60 BGN", "- Fuel: 260.50 BGN"));
  assert.equal(result.status, "fail");
  assert.equal(result.gate.categories.Utilities, false);
  assert.equal(result.gate.categories.Fuel, false);
});

test("MUTATION statement shortcut: answering with the statement's own total debits fails", () => {
  const result = run(`Your utilities came to 260.75 BGN for June 2026.

Total: 260.75 BGN`);
  assert.equal(result.status, "fail");
  assert.ok(result.detail.signatures.statementShortcut.hit);
  assert.equal(result.detail.signatures.statementShortcut.value, 260.75);
});

test("MUTATION travel leak: folding a EUR travel receipt into a category fails", () => {
  const result = run(CORRECT_ANSWER
    .replace("- Groceries: 140.75 BGN (87.45 and 53.30)", "- Groceries: 159.25 BGN (87.45, 53.30 and airport food 18.50)")
    .replace("Total: 696.84 BGN", "Total: 715.34 BGN"));
  assert.equal(result.status, "fail");
  assert.equal(result.gate.noExcludedLeak, false);
  assert.ok(result.detail.leaks.some(leak => leak.amount === 18.5), JSON.stringify(result.detail.leaks));
});

test("MUTATION B2B leak: reporting the steel invoice as a spending category fails", () => {
  const result = run(`${CORRECT_ANSWER}
- Shopping: 1 266 250.00 (Deutsche Edelstahl invoice)`);
  assert.equal(result.status, "fail");
  assert.equal(result.gate.noExcludedLeak, false);
  assert.ok(result.detail.leaks.some(leak => leak.kind === "B2B commercial"));
});

test("MUTATION out-of-period record: pulling a July bill into June fails", () => {
  const result = run(CORRECT_ANSWER
    .replace("- Utilities: 260.50 BGN", "- Utilities: 425.63 BGN (including the July electricity bill 165.13)")
    .replace("Total: 696.84 BGN", "Total: 861.97 BGN"));
  assert.equal(result.status, "fail");
  assert.equal(result.gate.categories.Utilities, false);
  assert.equal(result.gate.grandTotalCorrect, false);
});

test("MUTATION missing coverage: correct figures without reading the documents fails", () => {
  const result = run(CORRECT_ANSWER, {
    toolCalls: [{ name: "doc_batch", arguments: { paths: ["bank-statement-jun.txt"] }, summary: "read 1 document" }],
  });
  assert.equal(result.status, "fail");
  assert.equal(result.gate.fullCoverage, false);
  // The statement evidences the fuel and grocery rows, so only the off-statement
  // documents should be reported as unreached.
  assert.ok(result.detail.uncovered.includes("2026-06-utilities-electricity"));
  assert.ok(!result.detail.uncovered.includes("2026-06-groceries-07-jun"));
});

test("MUTATION no retrieval: answering from memory fails", () => {
  const result = run(CORRECT_ANSWER, { toolSequence: ["recall"], toolCalls: [] });
  assert.equal(result.status, "fail");
  assert.equal(result.gate.invokedRetrieval, false);
});

test("MUTATION oracle exposure and path leaks fail", () => {
  const exposed = run(`${CORRECT_ANSWER}\n(from ground-truth.json)`);
  assert.equal(exposed.gate.noOracleExposure, false);
  const leaked = run(`${CORRECT_ANSWER}\nSource: ${CORPUS_ROOT}/2026/June/`);
  assert.equal(leaked.gate.cleanCorpusFence, false);
});

test("naming an excluded item while explaining the exclusion is not a leak", () => {
  const result = run(CORRECT_ANSWER);
  assert.equal(result.gate.noExcludedLeak, true);
  assert.deepEqual(result.detail.leaks, []);
});

test("the gate is derived from the oracle, so other periods are gradable", () => {
  const february = buildExpectations(oracle, "2026-02", { corpusRoot: CORPUS_ROOT });
  // February's credit note must survive into the expectations as a reduction.
  assert.equal(february.categoryTotals.Utilities, 445.55);
  assert.equal(february.monthlyTotal, 961.09);
  const result = evaluateAnswer({
    answer: `- Utilities: 445.55 BGN (including a -34.20 credit note)
- Internet: 29.99 BGN
- Fuel: 120.00 BGN
- Groceries: 159.55 BGN
- Transport: 50.00 BGN
- Vehicle: 156.00 BGN

Total: 961.09 BGN`,
    toolSequence: FULL_SEQUENCE,
    toolCalls: [{
      name: "doc_batch",
      arguments: {
        paths: oracle.periods["2026-02"].included_events.flatMap(event => event.source_documents)
          .concat(["bank-statement-feb.txt"]),
      },
    }],
    expectations: february,
  });
  assert.equal(result.status, "pass", result.failures.join("; "));
});
