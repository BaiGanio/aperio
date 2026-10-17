import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAmount } from "../../../lib/handlers/database/amounts.js";

test("normalizes BG/DE/FR/EN amount forms without FX conversion", () => {
  assert.deepEqual(normalizeAmount("142.50 BGN"), { amount: 142.5, currency: "BGN", source: "142.50 BGN" });
  assert.equal(normalizeAmount("1 266 250,00 EUR").amount, 1266250);
  assert.equal(normalizeAmount("1.266,25 €", { locale: "de" }).amount, 1266.25);
  assert.equal(normalizeAmount("1 266,25 €", { locale: "fr" }).amount, 1266.25);
  assert.equal(normalizeAmount("1,266.25 USD", { locale: "en" }).amount, 1266.25);
  assert.equal(normalizeAmount("-12,50 BGN").amount, -12.5);
});

test("requires currency and rejects ambiguous separators", () => {
  assert.throws(() => normalizeAmount("1,234"), /ambiguous|currency/i);
  assert.throws(() => normalizeAmount("12.345", { currency: "USD" }), /ambiguous/i);
  assert.equal(normalizeAmount("1 234", { currency: "EUR" }).amount, 1234);
  assert.equal(normalizeAmount("€12.50").currency, "EUR");
});
