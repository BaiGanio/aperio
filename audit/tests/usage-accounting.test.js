// T3.3 — audit/scripts/usage-accounting.js (aperio-continuous-audit-tests.md, T3.3).
//
// The plan's fixture: "records with input, cached input, reasoning, and output
// tokens, unit prices, and one subscription/local invocation." The gate must
// sum the API costs correctly, LABEL the local/subscription rows instead of
// pricing them, keep estimated and actual apart, and report an unknown price as
// `unknown` rather than zero.
//
// The real-input proof is not a fixture: checkSourceInvariants() is driven
// against the actual current bytes of lib/agent/providers/anthropic.js,
// lib/pricing.js, lib/providers/index.js, lib/streaming/llamacppHandler.js,
// lib/emitters/handlers/wsHandler.js and public/index.js, with one real line
// removed at a time — each mutation must turn the gate red on its own.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  reconcileUsage,
  checkUsageAccountingContract,
  checkSourceInvariants,
  makeRepoPriceLookup,
  parseSetLiteral,
  parseWatchedModels,
  catalogCovers,
  resolveCatalogModel,
  parseProviderAnnounces,
  parseCacheCreationProviders,
  checkProviderAnnounces,
  SOURCE_INVARIANTS,
  REVIEWED_PRICE_EXCEPTIONS,
  REVIEWED_ANNOUNCE_EXEMPTIONS,
  REVIEWED_BILLING_CLASSES,
  USAGE_SOURCES,
  DEFAULT_USAGE_SOURCE,
} from "../scripts/usage-accounting.js";
import { validateRun, SCHEMA } from "../scripts/schema.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const readReal = (rel) => readFileSync(`${ROOT}/${rel}`, "utf8");

// USD per million. Deliberately round numbers so an arithmetic slip is visible
// in the assertion rather than hidden in a float.
const RATES = { "audit-model": { in: 3, out: 15 } };
const priceLookup = (model) =>
  RATES[model] ? { status: "priced", rates: RATES[model] } : { status: "unknown", reason: `no rate for "${model}"` };

// The fifth count is stated explicitly in fixtures, because "not recorded" and
// "there were none" have opposite consequences for the upper bound.
const tokens = (input, cachedInput = 0, reasoning = 0, output = 0, cacheCreationInput = 0) =>
  ({ input, cachedInput, reasoning, output, cacheCreationInput });

const isLocal = (p) => p === "llamacpp";
const isSubscription = (p) => p === "claude-code" || p === "codex";

/** The plan's T3.3 record set. */
function ledger() {
  return [
    // Two API runs: one with a clean cache miss, one served largely from cache.
    { runId: "A06-primary", provider: "deepseek", model: "audit-model",
      usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000) },
    { runId: "A03-primary", provider: "deepseek", model: "audit-model",
      usageSource: "provider-reported", tokens: tokens(30_000, 20_000, 0, 4_000) },
    // A reasoning run: reasoning is a slice of output, not an extra charge.
    { runId: "A03-adjudication", provider: "anthropic", model: "audit-model",
      usageSource: "provider-reported", tokens: tokens(12_000, 0, 2_000, 3_000) },
    // A planning estimate, never mixed into the actual column.
    { runId: "A17-planned", provider: "deepseek", model: "audit-model",
      usageSource: "estimated", tokens: tokens(30_000, 0, 0, 4_000) },
    // The local recon pass and the subscription adjudication pass.
    { runId: "A06-recon", provider: "llamacpp", model: "qwen2.5-coder-7b",
      usageSource: "provider-reported", tokens: tokens(18_000, 0, 0, 2_000) },
    { runId: "A06-review", provider: "claude-code", model: "claude-opus-4-8",
      usageSource: "provider-reported", tokens: tokens(12_000, 8_000, 1_000, 3_000) },
  ];
}

const run = (overrides = {}) =>
  reconcileUsage({ records: ledger(), priceLookup, isLocal, isSubscription, exceptions: {}, ...overrides });

describe("audit/scripts/usage-accounting.js", () => {
  test("T3.3 — API costs sum correctly across the four token classes", () => {
    const result = run();
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));

    // A06-primary: 30_000 uncached in @ $3/M = $0.09, 4_000 out @ $15/M = $0.06.
    const primary = result.rows.find((r) => r.runId === "A06-primary");
    assert.deepStrictEqual(primary.cost, { low: 0.15, high: 0.15, currency: "USD" });
    assert.strictEqual(primary.costStatus, "exact");

    // A03-adjudication: 12_000 in = $0.036, 3_000 out = $0.045. The 2_000
    // reasoning tokens are INSIDE the 3_000 output tokens and add nothing.
    const adjudication = result.rows.find((r) => r.runId === "A03-adjudication");
    assert.deepStrictEqual(adjudication.cost, { low: 0.081, high: 0.081, currency: "USD" });

    // Three provider-reported API runs: 0.15 + 0.09 + 0.081 = 0.321 at the low
    // bound, 0.15 + 0.15 + 0.081 = 0.381 at the high bound.
    assert.deepStrictEqual(result.totals.actual.api.cost, { low: 0.321, high: 0.381, currency: "USD" });
    assert.strictEqual(result.totals.actual.api.records, 3);
  });

  test("T3.3 — reasoning tokens are reported but never billed on top of output", () => {
    const withReasoning = reconcileUsage({
      records: [{ runId: "r", provider: "deepseek", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(12_000, 0, 2_900, 3_000) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    const withoutReasoning = reconcileUsage({
      records: [{ runId: "r", provider: "deepseek", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(12_000, 0, 0, 3_000) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.deepStrictEqual(withReasoning.rows[0].cost, withoutReasoning.rows[0].cost);
    // Reported, not discarded — the ledger still carries the breakdown.
    assert.strictEqual(withReasoning.totals.actual.api.tokens.reasoning, 2_900);
  });

  test("T3.3 — cached input is a subset of input, so its cost is an interval, not a point", () => {
    const cached = run().rows.find((r) => r.runId === "A03-primary");
    // 10_000 uncached in = $0.03, 4_000 out = $0.06 → low $0.09.
    // High prices all 30_000 input tokens at the full rate → $0.15.
    assert.deepStrictEqual(cached.cost, { low: 0.09, high: 0.15, currency: "USD" });
    assert.strictEqual(cached.costStatus, "bounded");
    assert.match(cached.label, /no published rate/);
  });

  test("T3.3 — local and subscription runs are labeled, never priced", () => {
    const result = run();
    const local = result.rows.find((r) => r.runId === "A06-recon");
    const subscription = result.rows.find((r) => r.runId === "A06-review");

    for (const row of [local, subscription]) {
      assert.strictEqual(row.cost, null, `${row.runId} was assigned a cost`);
      assert.strictEqual(row.costStatus, "not-applicable");
      assert.strictEqual(row.priceSource, null);
      assert.ok(row.label, `${row.runId} has no billing label`);
    }
    assert.strictEqual(local.billing, "local");
    assert.strictEqual(subscription.billing, "subscription");

    // Their tokens are still accounted for — they just carry no dollar figure,
    // and they are kept out of both cost columns entirely.
    assert.strictEqual(result.totals.actual.local.tokens.input, 18_000);
    assert.strictEqual(result.totals.actual.subscription.tokens.output, 3_000);
    // `null`, not a zero-dollar total — "$0.00" would be a claim about cost.
    assert.strictEqual(result.totals.actual.local.cost, null);
    assert.strictEqual(result.totals.actual.subscription.cost, null);
    assert.strictEqual(result.totals.actual.api.records, 3, "a not-applicable run leaked into the api column");
  });

  test("T3.3 — a per-token rate attached to a local or subscription run is rejected as fiction", () => {
    for (const provider of ["llamacpp", "claude-code"]) {
      const result = reconcileUsage({
        records: [{ runId: "x", provider, model: "audit-model", usageSource: "provider-reported",
          tokens: tokens(100, 0, 0, 10), unitPrices: { in: 3, out: 15 } }],
        priceLookup, isLocal, isSubscription, exceptions: {},
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes("fiction, not a guide")),
        `expected the no-fiction error for ${provider}, got ${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.rows[0].cost, null);
    }
  });

  test("T3.3 — estimated and actual costs are separate columns and never merged", () => {
    const result = run();
    assert.strictEqual(result.totals.estimated.api.records, 1);
    assert.deepStrictEqual(result.totals.estimated.api.cost, { low: 0.15, high: 0.15, currency: "USD" });
    assert.strictEqual(result.totals.estimated.api.tokens.input, 30_000);
    // The actual column is unchanged by the presence of the estimate.
    assert.deepStrictEqual(result.totals.actual.api.cost, { low: 0.321, high: 0.381, currency: "USD" });
    // And there is deliberately no combined grand total to mistake for actuals.
    assert.strictEqual(result.totals.cost, undefined);
  });

  test("estimated non-API usage stays in the estimated column too — a planned local " +
    "or subscription pass must not inflate actual non-API token totals", () => {
    const planned = [
      { runId: "A06-recon-actual", provider: "llamacpp", model: "qwen2.5-coder-7b",
        usageSource: "provider-reported", tokens: tokens(18_000, 0, 0, 2_000) },
      { runId: "A07-recon-planned", provider: "llamacpp", model: "qwen2.5-coder-7b",
        usageSource: "estimated", tokens: tokens(20_000, 0, 0, 2_000) },
      { runId: "A07-review-planned", provider: "claude-code", model: "claude-opus-4-8",
        usageSource: "estimated", tokens: tokens(12_000, 0, 0, 3_000) },
    ];
    const result = reconcileUsage({ records: planned, priceLookup, isLocal, isSubscription, exceptions: {} });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));

    // The actual local column carries ONLY the run that actually happened.
    assert.strictEqual(result.totals.actual.local.records, 1);
    assert.strictEqual(result.totals.actual.local.tokens.input, 18_000);
    assert.strictEqual(result.totals.actual.subscription.records, 0);

    // The projections sit in their own column, still fully counted.
    assert.strictEqual(result.totals.estimated.local.records, 1);
    assert.strictEqual(result.totals.estimated.local.tokens.input, 20_000);
    assert.strictEqual(result.totals.estimated.subscription.tokens.output, 3_000);

    // Neither column ever carries a cost for a non-API class.
    for (const source of ["actual", "estimated"]) {
      for (const kind of ["local", "subscription"]) {
        assert.strictEqual(result.totals[source][kind].cost, null, `${source}.${kind} was priced`);
      }
    }
  });

  test("T3.3 — a record whose usageSource is set to something unrecognised is rejected", () => {
    for (const usageSource of ["guess", null, 0]) {
      const result = reconcileUsage({
        records: [{ runId: "x", provider: "deepseek", model: "audit-model", usageSource, tokens: tokens(10, 0, 0, 1) }],
        priceLookup, isLocal, isSubscription, exceptions: {},
      });
      assert.strictEqual(result.ok, false, `usageSource ${JSON.stringify(usageSource)} was accepted`);
      assert.ok(result.errors.some((e) => e.includes("usageSource must be one of")));
    }
    assert.deepStrictEqual(USAGE_SOURCES, ["provider-reported", "estimated"]);
    assert.strictEqual(DEFAULT_USAGE_SOURCE, "provider-reported");
  });

  test("this layer composes with schema.js: a record validateRun() accepts reconciles " +
    "here unchanged, and its omitted usageSource defaults to the actual column", () => {
    // The canonical run record: exactly schema.js's RUN_REQUIRED_FIELDS, no
    // more. It carries no usageSource, because a run record IS a record of a
    // run that happened — nothing is added here to make it reconcile.
    const canonical = {
      runId: "A14-2026-08-20-01",
      baselineSha: "a".repeat(40),
      lens: "code reviewer",
      scope: "A14",
      filesRead: ["db/index.js"],
      commandsRun: ["node --test audit/tests/database-contract.test.js"],
      model: "audit-model",
      provider: "deepseek",
      tokens: tokens(30_000, 0, 0, 4_000),
      candidates: [],
      confirmedFindings: [],
      rejectedCandidates: [],
      residualUncertainty: "none",
      elapsedMs: 1000,
    };
    // Every required field, and nothing this layer needs that the schema does
    // not already demand.
    assert.deepStrictEqual(
      SCHEMA.RUN_REQUIRED_FIELDS.filter((f) => canonical[f] === undefined), []);
    assert.deepStrictEqual(validateRun(canonical), { valid: true, errors: [] });

    const result = reconcileUsage({
      records: [canonical], priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.rows[0].usageSource, "provider-reported");
    assert.strictEqual(result.rows[0].usageSourceDefaulted, true,
      "a defaulted usageSource must be visible on the row, not silently assumed");
    assert.deepStrictEqual(result.totals.actual.api.cost, { low: 0.15, high: 0.15, currency: "USD" });
    assert.strictEqual(result.totals.estimated.api.records, 0);

    // A declared value is carried through and marked as declared.
    const declared = reconcileUsage({
      records: [{ ...canonical, usageSource: "estimated" }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(declared.rows[0].usageSourceDefaulted, false);
    assert.strictEqual(declared.totals.estimated.api.records, 1);
    assert.strictEqual(declared.totals.actual.api.records, 0);

    // …and schema.js validates the same enum, so the two layers cannot drift.
    assert.deepStrictEqual(validateRun({ ...canonical, usageSource: "estimated" }), { valid: true, errors: [] });
    const bogus = validateRun({ ...canonical, usageSource: "guess" });
    assert.strictEqual(bogus.valid, false);
    assert.ok(bogus.errors.some((e) => e.includes("usageSource must be one of")));
  });

  test("T3.3 — an unknown price produces `unknown`, not zero", () => {
    const result = reconcileUsage({
      records: [{ runId: "A19", provider: "deepseek", model: "deepseek-v9-unreleased",
        usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    const row = result.rows[0];
    assert.strictEqual(row.costStatus, "unknown");
    assert.strictEqual(row.cost, null, "an unpriced run must not be given a cost object");
    assert.notStrictEqual(row.cost, 0);
    // It is surfaced, not swallowed: the totals name it…
    assert.deepStrictEqual(result.totals.unknownPrice, [
      { runId: "A19", model: "deepseek-v9-unreleased", reason: 'no rate for "deepseek-v9-unreleased"' },
    ]);
    assert.strictEqual(result.totals.actual.api.unknownPriceRecords, 1);
    assert.strictEqual(result.totals.actual.api.tokens.input, 30_000);

    // …and the BUCKET says unknown too. {low: 0, high: 0} here would read as
    // "this bucket cost nothing", which is a claim about a run nobody can
    // price — the same fiction the row-level verdict refuses to make.
    const bucket = result.totals.actual.api;
    assert.strictEqual(bucket.costStatus, "unknown");
    assert.strictEqual(bucket.cost, null, "an all-unknown bucket must not report a dollar total");
    assert.deepStrictEqual(bucket.pricedSubsetCost, { low: 0, high: 0, currency: "USD", records: 0 });
  });

  test("a bucket holding one unpriced run reports `partial`, never a sum of the " +
    "priced rows dressed up as the bucket's total", () => {
    // The priced row's interval is a LOWER bound on the bucket and there is no
    // upper bound at all, so `high` would not be a bound — it would be a
    // partial sum wearing the name of a total.
    const result = reconcileUsage({
      records: [
        { runId: "A20-priced", provider: "deepseek", model: "audit-model",
          usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000) },
        { runId: "A20-unpriced", provider: "deepseek", model: "deepseek-v9-unreleased",
          usageSource: "provider-reported", tokens: tokens(10_000, 0, 0, 1_000) },
      ],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));

    const bucket = result.totals.actual.api;
    assert.strictEqual(bucket.records, 2);
    assert.strictEqual(bucket.unknownPriceRecords, 1);
    assert.strictEqual(bucket.costStatus, "partial");
    assert.strictEqual(bucket.cost, null, "a bucket with an unpriced row must not report a total");
    // The priced part is not lost — it is just labelled as the subset it is.
    assert.deepStrictEqual(bucket.pricedSubsetCost,
      { low: 0.15, high: 0.15, currency: "USD", records: 1 });
    // Tokens are still complete: unpriced is not unrecorded.
    assert.strictEqual(bucket.tokens.input, 40_000);
  });

  test("a fully priced bucket still reports its interval, and an empty one is not " +
    "mistaken for a priced zero", () => {
    const full = run().totals.actual.api;
    assert.strictEqual(full.costStatus, "bounded");
    assert.deepStrictEqual(full.cost, { low: 0.321, high: 0.381, currency: "USD" });
    assert.deepStrictEqual(full.pricedSubsetCost,
      { low: 0.321, high: 0.381, currency: "USD", records: 3 });

    // An exact bucket: no cached input anywhere in it.
    const exact = reconcileUsage({
      records: [{ runId: "r", provider: "deepseek", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    }).totals.actual.api;
    assert.strictEqual(exact.costStatus, "exact");

    // An empty bucket holds no claim to contradict: zero records, zero cost.
    const empty = reconcileUsage({ records: [] }).totals.actual.api;
    assert.strictEqual(empty.records, 0);
    assert.strictEqual(empty.costStatus, "exact");
    assert.deepStrictEqual(empty.cost, { low: 0, high: 0, currency: "USD" });
  });

  test("the default repo lookup prices nothing in a cold process, and the totals " +
    "say so instead of reporting $0", () => {
    // makeRepoPriceLookup() never warms var/pricing-cache.json, so in a fresh
    // process every model is "unknown". That is the correct answer — but only
    // if the aggregate refuses to call it zero.
    const result = reconcileUsage({
      records: [{ runId: "A21", provider: "deepseek", model: "deepseek-chat",
        usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000) }],
      priceLookup: makeRepoPriceLookup({ pricingSource: "", getPrice: () => null }),
      isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(result.rows[0].costStatus, "unknown");
    assert.strictEqual(result.totals.actual.api.costStatus, "unknown");
    assert.strictEqual(result.totals.actual.api.cost, null);
  });

  test("cache-creation tokens have no honest upper bound, so the run prices as " +
    "`unknown` instead of an interval that does not contain the true cost", () => {
    // A cache WRITE is billed above the base input rate. Pricing it at rates.in
    // would put the real cost above `high` — an upper bound that is not one.
    const wrote = reconcileUsage({
      records: [{ runId: "r", provider: "anthropic", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(30_000, 10_000, 0, 4_000, 5_000) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
      cacheCreationProviders: new Set(["anthropic"]),
    });
    assert.strictEqual(wrote.ok, true, JSON.stringify(wrote.errors));
    assert.strictEqual(wrote.rows[0].costStatus, "unknown");
    assert.strictEqual(wrote.rows[0].cost, null);
    assert.match(wrote.rows[0].label, /no honest upper bound exists/);
    assert.strictEqual(wrote.totals.unknownPrice.length, 1);
    // The count is still carried in the totals — unpriced is not unrecorded.
    assert.strictEqual(wrote.totals.actual.api.tokens.cacheCreationInput, 5_000);

    // Explicitly zero cache writes: the interval is sound again.
    const none = reconcileUsage({
      records: [{ runId: "r", provider: "anthropic", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(30_000, 20_000, 0, 4_000, 0) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
      cacheCreationProviders: new Set(["anthropic"]),
    });
    assert.deepStrictEqual(none.rows[0].cost, { low: 0.09, high: 0.15, currency: "USD" });
    assert.strictEqual(none.rows[0].costStatus, "bounded");
  });

  test("`not recorded` is not `there were none`: an omitted cache-creation count is " +
    "unbounded for a provider that reports cache writes, and sound for one that does not", () => {
    const record = (provider) => ({
      runId: "r", provider, model: "audit-model", usageSource: "provider-reported",
      tokens: { input: 30_000, cachedInput: 0, reasoning: 0, output: 4_000 }, // no fifth field
    });

    const reports = reconcileUsage({
      records: [record("anthropic")], priceLookup, isLocal, isSubscription, exceptions: {},
      cacheCreationProviders: new Set(["anthropic", "claude-code", "codex"]),
    });
    assert.strictEqual(reports.rows[0].costStatus, "unknown");
    assert.strictEqual(reports.rows[0].cost, null);
    assert.match(reports.rows[0].label, /does not state tokens\.cacheCreationInput/);

    const doesNot = reconcileUsage({
      records: [record("deepseek")], priceLookup, isLocal, isSubscription, exceptions: {},
      cacheCreationProviders: new Set(["anthropic", "claude-code", "codex"]),
    });
    assert.strictEqual(doesNot.rows[0].costStatus, "exact");
    assert.deepStrictEqual(doesNot.rows[0].cost, { low: 0.15, high: 0.15, currency: "USD" });
  });

  test("cache reads and cache writes are both subsets of input, and the pair is checked " +
    "together", () => {
    const result = reconcileUsage({
      records: [{ runId: "r", provider: "anthropic", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(10_000, 6_000, 0, 100, 6_000) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("exceeds tokens.input")), JSON.stringify(result.errors));

    const negative = reconcileUsage({
      records: [{ runId: "r", provider: "anthropic", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(10_000, 0, 0, 100, -1) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(negative.ok, false);
    assert.ok(negative.errors.some((e) => e.includes("cacheCreationInput must be a non-negative")));
  });

  test("a runId that is not a non-empty string is rejected, because duplicate " +
    "detection compares addresses by value", () => {
    const base = { provider: "deepseek", model: "audit-model",
      usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000) };

    for (const runId of [undefined, "", "   ", 0, 7, { id: "A06" }, ["A06"]]) {
      const result = reconcileUsage({
        records: [{ ...base, runId }], priceLookup, isLocal, isSubscription, exceptions: {},
      });
      assert.strictEqual(result.ok, false, `runId ${JSON.stringify(runId)} was accepted`);
      assert.ok(result.errors.some((e) => e.includes("runId must be a non-empty string")),
        JSON.stringify(result.errors));
      assert.strictEqual(result.rows[0].runId, null);
    }

    // Two records naming the same run through equal-but-not-identical objects
    // would be distinct Set members, so the duplicate could not be seen. The
    // record is rejected before it can reach that comparison at all.
    const twoObjects = reconcileUsage({
      records: [{ ...base, runId: { id: "A06" } }, { ...base, runId: { id: "A06" } }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(twoObjects.ok, false);
    assert.ok(!twoObjects.errors.some((e) => e.includes("duplicate runId")));
  });

  test("a record that fails validation is reported AND kept out of the totals, the " +
    "same way a duplicate is", () => {
    const good = { runId: "A22-ok", provider: "deepseek", model: "audit-model",
      usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000) };
    const clean = reconcileUsage({ records: [good], priceLookup, isLocal, isSubscription, exceptions: {} });

    // `usageSource: "guess"` is the sharp case: column() sends everything that
    // is not "estimated" to the ACTUAL column, so an unusable record would have
    // been added there as an exact dollar figure under its own error message.
    const bad = reconcileUsage({
      records: [{ ...good, runId: "A22-bad", usageSource: "guess" }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.rows.length, 1, "the row stays visible — it is excluded, not hidden");
    assert.strictEqual(bad.rows[0].excluded, true);
    assert.strictEqual(bad.totals.actual.api.records, 0);
    assert.deepStrictEqual(bad.totals.actual.api.pricedSubsetCost,
      { low: 0, high: 0, currency: "USD", records: 0 });
    assert.strictEqual(bad.totals.actual.api.tokens.input, 0);

    // A valid record beside an invalid one still counts, exactly once.
    const mixed = reconcileUsage({
      records: [good, { ...good, runId: "A22-bad", usageSource: "guess" }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(mixed.ok, false);
    assert.deepStrictEqual(mixed.totals.actual, clean.totals.actual);

    // A negative hand-entered rate would otherwise drive the total below zero.
    const negative = reconcileUsage({
      records: [{ ...good, runId: "A22-neg", model: "deepseek-chat",
        unitPrices: { in: -3, out: -15 } }],
      priceLookup, isLocal, isSubscription,
      exceptions: { "deepseek-chat": { reason: "test", absentFromCatalog: true } },
    });
    assert.strictEqual(negative.ok, false);
    assert.strictEqual(negative.rows[0].excluded, true);
    assert.strictEqual(negative.totals.actual.api.records, 0);
    assert.strictEqual(negative.totals.actual.api.pricedSubsetCost.low, 0);

    // The unpriced path is excluded too — an invalid record must not even be
    // listed as a run whose price is merely unknown.
    const unpriced = reconcileUsage({
      records: [{ ...good, runId: "A22-unpriced", model: "no-such-model", usageSource: "guess" }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.deepStrictEqual(unpriced.totals.unknownPrice, []);
    assert.strictEqual(unpriced.totals.actual.api.records, 0);

    // And so is the never-priced path: a local run carrying a per-token rate is
    // fiction, so its TOKENS are not quietly banked either.
    const localWithRates = reconcileUsage({
      records: [{ ...good, runId: "A22-local", provider: "llamacpp", model: "qwen2.5-coder-7b",
        unitPrices: { in: 3, out: 15 } }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(localWithRates.ok, false);
    assert.strictEqual(localWithRates.rows[0].excluded, true);
    assert.strictEqual(localWithRates.totals.actual.local.records, 0);
    assert.strictEqual(localWithRates.totals.actual.local.tokens.input, 0);

    // A clean record is not marked excluded, so the flag means what it says.
    assert.strictEqual(clean.rows[0].excluded, false);
  });

  test("a duplicate runId is rejected and kept out of the totals, so a merged or " +
    "replayed ledger cannot double-count a run", () => {
    const one = { runId: "A06-primary", provider: "deepseek", model: "audit-model",
      usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000) };

    const single = reconcileUsage({ records: [one], priceLookup, isLocal, isSubscription, exceptions: {} });
    const twice = reconcileUsage({ records: [one, { ...one }], priceLookup, isLocal, isSubscription, exceptions: {} });

    assert.strictEqual(twice.ok, false);
    assert.ok(twice.errors.some((e) => e.includes("duplicate runId")), JSON.stringify(twice.errors));
    // Both rows stay visible — the duplicate is reported, not hidden…
    assert.strictEqual(twice.rows.length, 2);
    assert.strictEqual(twice.rows[0].duplicate, false);
    assert.strictEqual(twice.rows[1].duplicate, true);
    // …but the totals are identical to the single-record run.
    assert.deepStrictEqual(twice.totals.actual, single.totals.actual);
    assert.strictEqual(twice.totals.actual.api.records, 1);
    assert.deepStrictEqual(twice.totals.actual.api.cost, { low: 0.15, high: 0.15, currency: "USD" });

    // The same holds for the columns that carry no cost.
    const local = { ...one, runId: "A06-recon", provider: "llamacpp", model: "qwen2.5-coder-7b" };
    const localTwice = reconcileUsage({
      records: [local, { ...local }], priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(localTwice.ok, false);
    assert.strictEqual(localTwice.totals.actual.local.records, 1);
    assert.strictEqual(localTwice.totals.actual.local.tokens.input, 30_000);

    // And an unpriced duplicate is not listed twice under unknownPrice.
    const unpriced = { ...one, model: "no-such-model" };
    const unpricedTwice = reconcileUsage({
      records: [unpriced, { ...unpriced }], priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(unpricedTwice.totals.unknownPrice.length, 1);
    assert.strictEqual(unpricedTwice.totals.actual.api.records, 1);
  });

  test("T3.3 — a hand-entered rate is honoured only when the model is a reviewed exception", () => {
    const record = {
      runId: "A06-primary", provider: "deepseek", model: "deepseek-chat",
      usageSource: "provider-reported", tokens: tokens(30_000, 0, 0, 4_000),
      unitPrices: { in: 0.27, out: 1.1 },
    };

    const unreviewed = reconcileUsage({ records: [record], priceLookup, isLocal, isSubscription, exceptions: {} });
    assert.strictEqual(unreviewed.ok, false);
    assert.ok(unreviewed.errors.some((e) => e.includes("REVIEWED_PRICE_EXCEPTIONS")));

    const reviewed = reconcileUsage({ records: [record], priceLookup, isLocal, isSubscription });
    assert.strictEqual(reviewed.ok, true, JSON.stringify(reviewed.errors));
    assert.strictEqual(reviewed.rows[0].priceSource, "record");
    // 30_000 @ $0.27/M = $0.0081, 4_000 @ $1.10/M = $0.0044 → $0.0125, the
    // plan's own per-slice figure.
    assert.deepStrictEqual(reviewed.rows[0].cost, { low: 0.0125, high: 0.0125, currency: "USD" });
  });

  test("T3.3 edge case — a reviewed price exception passes only while its stated reason " +
    "still holds: absent from the catalog survives, present in it goes stale", () => {
    const records = [{ runId: "r", provider: "deepseek", model: "deepseek-chat",
      usageSource: "provider-reported", tokens: tokens(100, 0, 0, 10), unitPrices: { in: 0.27, out: 1.1 } }];

    const stillAbsent = reconcileUsage({
      records, priceLookup, isLocal, isSubscription,
      catalogRoster: ["deepseek/deepseek-v4-pro", "anthropic/claude-opus-4.8"],
    });
    assert.strictEqual(stillAbsent.ok, true, JSON.stringify(stillAbsent.errors));

    const nowOnTheSheet = reconcileUsage({
      records, priceLookup, isLocal, isSubscription,
      catalogRoster: ["deepseek/deepseek-chat", "deepseek/deepseek-v4-pro"],
    });
    assert.strictEqual(nowOnTheSheet.ok, false);
    assert.ok(nowOnTheSheet.errors.some((e) => e.includes("stated reason no longer holds")),
      JSON.stringify(nowOnTheSheet.errors));

    // …and the record that leaned on the stale exception is EXCLUDED, not just
    // complained about. The staleness check used to run after aggregation, so
    // the possibly-obsolete hand-entered rate stayed inside the totals under
    // `excluded: false` — a wrong number sitting beneath an error message,
    // which is the one people read.
    assert.strictEqual(nowOnTheSheet.rows[0].excluded, true);
    assert.strictEqual(nowOnTheSheet.totals.actual.api.records, 0);
    assert.deepStrictEqual(nowOnTheSheet.totals.actual.api.pricedSubsetCost,
      { low: 0, high: 0, currency: "USD", records: 0 });
    assert.strictEqual(nowOnTheSheet.totals.actual.api.tokens.input, 0);
    assert.ok(nowOnTheSheet.errors.some((e) => e.startsWith("run r:") && e.includes("stale")),
      JSON.stringify(nowOnTheSheet.errors));

    // The still-absent case is untouched: the exception holds, so the row is
    // priced from the record and counted.
    assert.strictEqual(stillAbsent.rows[0].excluded, false);
    assert.strictEqual(stillAbsent.totals.actual.api.records, 1);

    // A record for the same model that does NOT hand-enter a rate is priced
    // from the catalog, so staleness costs it nothing — only the hand-entered
    // rate is in question.
    const catalogPriced = reconcileUsage({
      records: [{ ...records[0], model: "audit-model", unitPrices: undefined }],
      priceLookup, isLocal, isSubscription,
      catalogRoster: ["deepseek/deepseek-chat"],
    });
    assert.strictEqual(catalogPriced.rows[0].excluded, false);
    assert.strictEqual(catalogPriced.totals.actual.api.records, 1);
  });

  test("token counts that break the subset relations are rejected, because the cost " +
    "arithmetic depends on them", () => {
    const cachedTooBig = reconcileUsage({
      records: [{ runId: "r", provider: "deepseek", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(1_000, 2_000, 0, 100) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(cachedTooBig.ok, false);
    assert.ok(cachedTooBig.errors.some((e) => e.includes("subsets of input")));

    const reasoningTooBig = reconcileUsage({
      records: [{ runId: "r", provider: "deepseek", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(1_000, 0, 500, 100) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(reasoningTooBig.ok, false);
    assert.ok(reasoningTooBig.errors.some((e) => e.includes("breakdown of output")));

    const negative = reconcileUsage({
      records: [{ runId: "r", provider: "deepseek", model: "audit-model",
        usageSource: "provider-reported", tokens: tokens(-5, 0, 0, 100) }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(negative.ok, false);
    assert.ok(negative.errors.some((e) => e.includes("tokens.input must be a non-negative number")));
  });

  test("a record carrying its own precomputed cost is rejected — cost is derived here " +
    "so it can never disagree with the tokens beside it", () => {
    const result = reconcileUsage({
      records: [{ runId: "r", provider: "deepseek", model: "audit-model", usageSource: "provider-reported",
        tokens: tokens(1_000, 0, 0, 100), cost: 0 }],
      priceLookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("precomputed cost")));
  });

  test("parsers read the real price sheet and the real billing sets", () => {
    const roster = parseWatchedModels(readReal("lib/pricing.js"));
    const aliases = roster.flatMap((e) => e.aliases);
    assert.ok(aliases.includes("anthropic/claude-opus-4.8"));
    assert.ok(aliases.includes("claude-opus-4-8"));
    assert.ok(roster.length >= 10, `roster looks truncated: ${roster.length}`);
    // Every entry is one model with its aliases, not a flat name soup — the
    // ambiguity rule below depends on knowing which aliases share a model.
    assert.deepStrictEqual(
      roster.find((e) => e.id === "claude-opus-4-8"),
      { id: "claude-opus-4-8", aliases: ["anthropic/claude-opus-4.8", "claude-opus-4-8"] });

    const providers = readReal("lib/providers/index.js");
    assert.deepStrictEqual(parseSetLiteral(providers, "LOCAL_PROVIDERS"), ["llamacpp"]);
    assert.deepStrictEqual(parseSetLiteral(providers, "SUBSCRIPTION_PROVIDERS"), ["claude-code", "codex"]);
  });

  test("the catalog resolver follows getPricing()'s alias semantics — including the " +
    "date-suffix strip — and refuses an alias that could name more than one model", () => {
    const roster = parseWatchedModels(readReal("lib/pricing.js"));

    // Exact, either spelling.
    assert.deepStrictEqual(resolveCatalogModel(roster, "claude-opus-4.8"), { status: "hit", id: "claude-opus-4-8" });
    assert.deepStrictEqual(resolveCatalogModel(roster, "anthropic/claude-opus-4.8"), { status: "hit", id: "claude-opus-4-8" });

    // Dated alias: getPricing() strips `-YYYYMMDD` before looking up, so this
    // resolver must too, or a real dated model is wrongly reported unknown.
    assert.deepStrictEqual(resolveCatalogModel(roster, "claude-opus-4-8-20260820"), { status: "hit", id: "claude-opus-4-8" });
    assert.strictEqual(catalogCovers(roster, "claude-haiku-4-5-20251001"), true);

    // Fragment that names exactly one model still resolves.
    assert.strictEqual(catalogCovers(roster, "gemini-2.5-pro"), true);

    // Underspecified fragments would let getPricing() attach whichever indexed
    // key is longest — one model's rate on another model's tokens. Here they
    // are ambiguous, so they price as `unknown` instead of fabricating a cost.
    for (const vague of ["claude", "gpt", "o", "deepseek"]) {
      const resolved = resolveCatalogModel(roster, vague);
      assert.strictEqual(resolved.status, "ambiguous", `"${vague}" resolved to ${JSON.stringify(resolved)}`);
      assert.ok(resolved.ids.length > 1);
      assert.strictEqual(catalogCovers(roster, vague), false);
    }

    assert.strictEqual(catalogCovers(roster, "deepseek-chat"), false);
    assert.strictEqual(catalogCovers(roster, ""), false);
  });

  test("an ambiguous model name is priced as `unknown`, never with another model's rate", () => {
    const lookup = makeRepoPriceLookup({
      pricingSource: readReal("lib/pricing.js"),
      // A warm cache: getPricing() WOULD hand back a rate for "claude".
      getPrice: () => ({ in: 15, out: 75, contextWindow: 200_000 }),
    });
    const vague = lookup("claude");
    assert.strictEqual(vague.status, "unknown");
    assert.match(vague.reason, /too ambiguous to price/);

    const result = reconcileUsage({
      records: [{ runId: "r", provider: "anthropic", model: "claude",
        usageSource: "provider-reported", tokens: tokens(1_000_000, 0, 0, 0) }],
      priceLookup: lookup, isLocal, isSubscription, exceptions: {},
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.strictEqual(result.rows[0].cost, null);
    assert.strictEqual(result.rows[0].costStatus, "unknown");
    // The dated sibling of a real model still prices, so the guard is not a
    // blanket refusal to resolve anything.
    assert.strictEqual(lookup("claude-opus-4-8-20260820").status, "priced");
  });

  test("the default price lookup never fabricates a rate, and never fetches: a cold " +
    "pricing cache reports `unknown`, not zero", () => {
    const lookup = makeRepoPriceLookup({
      pricingSource: readReal("lib/pricing.js"),
      getPrice: () => null, // exactly what getPricing() returns on a cold cache
    });
    const onSheet = lookup("claude-opus-4-8");
    assert.strictEqual(onSheet.status, "unknown");
    assert.match(onSheet.reason, /no rate is loaded/);

    const offSheet = lookup("deepseek-chat");
    assert.strictEqual(offSheet.status, "unknown");
    assert.match(offSheet.reason, /not on lib\/pricing\.js's price sheet/);

    // A warm cache prices it; the two states differ in detail but never in
    // kind — neither can produce a zero rate.
    const warm = makeRepoPriceLookup({
      pricingSource: readReal("lib/pricing.js"),
      getPrice: () => ({ in: 5, out: 25, contextWindow: 200_000 }),
    });
    assert.deepStrictEqual(warm("claude-opus-4-8"), { status: "priced", rates: { in: 5, out: 25 } });
  });

  test("T5.1 red/green proof — every source invariant is checked against the REAL " +
    "current source, and removing its real line turns the gate red on its own", () => {
    // Green first: the unmutated tree satisfies all of them.
    assert.deepStrictEqual(checkSourceInvariants(), []);

    const red = (invariant, mutated) => {
      assert.notStrictEqual(mutated, readReal(invariant.file), `${invariant.id}: mutation was a no-op`);
      const errors = checkSourceInvariants(SOURCE_INVARIANTS, (file) =>
        file === invariant.file ? mutated : readReal(file));
      assert.ok(errors.some((e) => e.startsWith(`${invariant.id}:`)),
        `${invariant.id} survived its mutation: ${JSON.stringify(errors)}`);
    };

    for (const invariant of SOURCE_INVARIANTS) {
      const real = readReal(invariant.file);
      const hit = invariant.literal ? invariant.literal : real.match(invariant.marker)?.[0];
      assert.ok(hit, `${invariant.id}: no real match in ${invariant.file} to mutate`);
      red(invariant, real.split(hit).join("/* removed by the T5.1 proof */"));
    }

    // Green again, to prove the red above came from the mutation and not from
    // a check that fails either way.
    assert.deepStrictEqual(checkSourceInvariants(), []);
  });

  test("the announce parser finds both real shapes and bounds each payload separately", () => {
    const ws = parseProviderAnnounces(readReal("lib/emitters/handlers/wsHandler.js"));
    assert.strictEqual(ws.length, 2, "expected the connect and provider-switch announces");
    for (const payload of ws) {
      assert.match(payload, /costRates:/);
      assert.match(payload, /local:\s*isLocalProvider\(/);
      assert.match(payload, /subscription:\s*isSubscriptionProvider\(/);
    }

    // The other real shape: `emitter.send({ type: "provider", … })` in a loop.
    const loop = parseProviderAnnounces(readReal("lib/agent/providers/llamacpp.js"));
    assert.strictEqual(loop.length, 1);
    assert.match(loop[0], /type: "provider"/);

    // A `send({...})` that is not a provider announce is not picked up.
    assert.deepStrictEqual(parseProviderAnnounces('send({ type: "status", text: "hi" });'), []);
  });

  test("every provider announce must carry both billing flags — with NO trigger " +
    "condition, because an announce that drops pricing and the flags together is " +
    "the case that leaves stale billing state on screen", () => {
    const flags = 'local: isLocalProvider(p), subscription: isSubscriptionProvider(p),';
    const file = "lib/emitters/handlers/wsHandler.js";

    const clean = checkProviderAnnounces({
      sources: { [file]: `send("provider", { name, costRates, ${flags} });` },
      exemptions: {}, isLocal: () => false,
    });
    assert.deepStrictEqual(clean, []);

    // The reviewer's case: a switch announce carrying NO costRates and NO flags.
    // A trigger keyed on costRates would step straight over it, and
    // setCostProvider() would keep the previous paid provider's rate and flags.
    const silent = checkProviderAnnounces({
      sources: { [file]: `send("provider", { name: provider().name, model: provider().model });` },
      exemptions: {}, isLocal: () => false,
    });
    assert.strictEqual(silent.length, 2, JSON.stringify(silent));
    assert.ok(silent.some((e) => e.includes("omits the local flag")));
    assert.ok(silent.some((e) => e.includes("omits the subscription flag")));
    assert.ok(silent[0].includes("keeps the previous provider's billing class"));

    // Each announce is judged on its own: a flag moved from one to another
    // cannot balance the books the way a file-wide occurrence count would.
    const moved = checkProviderAnnounces({
      sources: { [file]:
        `send("provider", { costRates, ${flags} });\n` +
        `send("provider", { costRates, local: isLocalProvider(p) });\n` +
        `const decoy = { subscription: isSubscriptionProvider("codex") };` },
      exemptions: {}, isLocal: () => false,
    });
    assert.strictEqual(moved.length, 1);
    assert.ok(moved[0].includes("announce #2") && moved[0].includes("omits the subscription flag"));

    // No announce anywhere is a failure, not a vacuous pass.
    assert.ok(checkProviderAnnounces({ sources: { [file]: "// nothing" }, exemptions: {} })
      .some((e) => e.includes("found no provider announce")));
  });

  test("the sparse same-provider re-announce is a reviewed exemption, and it stops " +
    "being one the day llamacpp stops being local", () => {
    const file = "lib/agent/providers/llamacpp.js";
    // The reviewed payload, in the shape the real loop sends it.
    const sparse = { [file]: 'emitter.send({ type: "provider", name: provider.name, ' +
      'model: provider.model, thinks: state.thinks, contextWindow: actualContext });' };

    const local = checkProviderAnnounces({ sources: sparse, isLocal: (n) => n === "llamacpp" });
    assert.deepStrictEqual(local, [], "the exemption should hold while llamacpp is local");

    const noLongerLocal = checkProviderAnnounces({ sources: sparse, isLocal: () => false });
    assert.ok(noLongerLocal.some((e) => e.includes("stated reason no longer holds")),
      JSON.stringify(noLongerLocal));

    // An exemption for a file that is no longer read is stale.
    const stale = checkProviderAnnounces({
      sources: { "lib/emitters/handlers/wsHandler.js": `send("provider", { local: isLocalProvider(p), subscription: isSubscriptionProvider(p) });` },
      isLocal: (n) => n === "llamacpp",
    });
    assert.ok(stale.some((e) => e.startsWith(`${file}:`) && e.includes("stale")));
  });

  test("a reviewed exemption covers ONE announce, not the file — a second announce in " +
    "the same file is judged on its own", () => {
    const file = "lib/agent/providers/llamacpp.js";
    const reviewed = 'emitter.send({ type: "provider", name: provider.name, ' +
      'model: provider.model, thinks: state.thinks, contextWindow: actualContext });';
    const isLocal = (n) => n === "llamacpp";

    // The regression the exemption must not hide: llamacpp.js grows a SECOND
    // announce that omits both flags. Keyed by file alone, the gate would wave
    // it through under a reason written about the context-window re-announce.
    const second = checkProviderAnnounces({
      sources: { [file]: `${reviewed}\nemitter.send({ type: "provider", name: "anthropic", costRates });` },
      isLocal,
    });
    assert.strictEqual(second.length, 2, JSON.stringify(second));
    assert.ok(second.every((e) => e.includes("announce #2")), JSON.stringify(second));
    assert.ok(second.some((e) => e.includes("omits the local flag")));
    assert.ok(second.some((e) => e.includes("omits the subscription flag")));

    // Removing the reviewed announce leaves the exemption covering nothing —
    // it must go red rather than sit there looking live.
    const gone = checkProviderAnnounces({
      sources: { [file]: 'emitter.send({ type: "provider", name: provider.name, ' +
        'model: provider.model, local: isLocalProvider(p), subscription: isSubscriptionProvider(p) });' },
      isLocal,
    });
    assert.ok(gone.some((e) => e.includes("matches 0 announces")), JSON.stringify(gone));

    // A marker that stops naming a single announce is equally unusable.
    const ambiguous = checkProviderAnnounces({
      sources: { [file]: `${reviewed}\n${reviewed}` },
      isLocal,
    });
    assert.ok(ambiguous.some((e) => e.includes("matches 2 announces")), JSON.stringify(ambiguous));

    // An omission the review never covered is still reported on the reviewed
    // announce itself.
    const partial = checkProviderAnnounces({
      sources: { [file]: reviewed },
      exemptions: { [file]: { ...REVIEWED_ANNOUNCE_EXEMPTIONS[file], omits: ["local"] } },
      isLocal,
    });
    assert.strictEqual(partial.length, 1, JSON.stringify(partial));
    assert.ok(partial[0].includes("omits the subscription flag"));

    // And an exemption that names no payload is not honoured at all.
    const unscoped = checkProviderAnnounces({
      sources: { [file]: 'emitter.send({ type: "provider", name: provider.name });' },
      exemptions: { [file]: { reason: "trust me", provider: "llamacpp", localOnly: true } },
      isLocal,
    });
    assert.ok(unscoped.some((e) => e.includes("no `payload` marker")), JSON.stringify(unscoped));
    assert.ok(unscoped.some((e) => e.includes("omits the local flag")));
  });

  test("current real state — every real provider announce carries both billing flags, " +
    "except the one reviewed exemption", () => {
    const sources = Object.fromEntries(
      ["lib/emitters/handlers/wsHandler.js",
        ...["anthropic", "deepseek", "gemini", "llamacpp", "claude-code", "codex"]
          .map((n) => `lib/agent/providers/${n}.js`)]
        .map((f) => [f, readReal(f)]));
    assert.deepStrictEqual(checkProviderAnnounces({ sources }), []);
    assert.deepStrictEqual(Object.keys(REVIEWED_ANNOUNCE_EXEMPTIONS), ["lib/agent/providers/llamacpp.js"]);
  });

  test("T5.1 red/green proof — dropping ONE subscription provider from the real " +
    "registry source makes the contract go red, even though the set stays populated", () => {
    const providers = readReal("lib/providers/index.js");

    // The dangerous mutation is not an empty set — it is claude-code removed
    // while codex remains, which leaves every non-emptiness check green.
    const demoted = providers.replace(
      /const SUBSCRIPTION_PROVIDERS = new Set\(\[[^\]]*\]\)/,
      'const SUBSCRIPTION_PROVIDERS = new Set(["codex"])');
    assert.notStrictEqual(demoted, providers);
    assert.deepStrictEqual(parseSetLiteral(demoted, "SUBSCRIPTION_PROVIDERS"), ["codex"]);

    // The mutated source is fed through the WHOLE contract, not just the parser.
    const red = checkUsageAccountingContract({
      read: (file) => (file === "lib/providers/index.js" ? demoted : readReal(file)),
    });
    assert.strictEqual(red.ok, false, "a demoted subscription provider passed the gate");
    assert.ok(red.errors.some((e) => e.startsWith("claude-code:") && e.includes("billable API usage")),
      JSON.stringify(red.errors, null, 2));

    // The reverse drift — a provider silently added to a billing class — is
    // caught too, because an unreviewed member stops being priced.
    const promoted = providers.replace(
      /const SUBSCRIPTION_PROVIDERS = new Set\(\[[^\]]*\]\)/,
      'const SUBSCRIPTION_PROVIDERS = new Set(["claude-code", "codex", "deepseek"])');
    const added = checkUsageAccountingContract({
      read: (file) => (file === "lib/providers/index.js" ? promoted : readReal(file)),
    });
    assert.strictEqual(added.ok, false);
    assert.ok(added.errors.some((e) => e.startsWith("deepseek:") && e.includes("not on record")));

    // The same mutation applied to the local class fails the same way.
    const localGone = providers.replace(
      /const LOCAL_PROVIDERS = new Set\(\[[^\]]*\]\)/,
      "const LOCAL_PROVIDERS = new Set([])");
    const localRed = checkUsageAccountingContract({
      read: (file) => (file === "lib/providers/index.js" ? localGone : readReal(file)),
    });
    assert.strictEqual(localRed.ok, false);
    assert.ok(localRed.errors.some((e) => e.startsWith("llamacpp:")));

    // Green again on the unmutated tree.
    assert.strictEqual(checkUsageAccountingContract().ok, true);
  });

  test("current real state — the source invariants hold, the billing sets are " +
    "disjoint and populated, and the real price sheet is readable", () => {
    const result = checkUsageAccountingContract();
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors, null, 2));
    assert.deepStrictEqual(result.billing.local, ["llamacpp"]);
    assert.deepStrictEqual(result.billing.subscription, ["claude-code", "codex"]);
    // …and those sets match the membership on record, name for name.
    assert.deepStrictEqual(result.billing.local, REVIEWED_BILLING_CLASSES.local.providers);
    assert.deepStrictEqual(result.billing.subscription, REVIEWED_BILLING_CLASSES.subscription.providers);
    assert.ok(result.rosterSize >= 10);

    // The cache-writing providers are read off the real loops, not listed by
    // hand: anthropic is the one that matters (claude-code and codex are
    // subscription, so they never reach the pricing path at all).
    assert.ok(result.cacheCreationProviders.includes("anthropic"));
    assert.ok(!result.cacheCreationProviders.includes("deepseek"));
    assert.deepStrictEqual(
      [...parseCacheCreationProviders({
        anthropic: "cache_creation_input_tokens: 0,",
        deepseek: "usage.prompt_tokens",
      })], ["anthropic"]);
    // The one reviewed price exception is still absent from the real catalog.
    assert.deepStrictEqual(Object.keys(REVIEWED_PRICE_EXCEPTIONS), ["deepseek-chat"]);
    // No ledger is persisted yet, so the real record set is empty by design —
    // the gate is green on an empty ledger and stays useful because the source
    // invariants above are what actually rot.
    assert.deepStrictEqual(result.rows, []);
  });

  test("a provider loop that cannot be read is assumed to report cache writes, so a " +
    "file nobody could open can never hand a run an upper bound", () => {
    // deepseek's loop does NOT report cache writes today, which is exactly why
    // it is the honest test: losing the file must not be read as "no cache
    // writes here". The record deliberately omits cacheCreationInput, so its
    // upper bound depends entirely on that question.
    const missing = "lib/agent/providers/deepseek.js";
    const record = { runId: "A23", provider: "deepseek", model: "deepseek-chat",
      usageSource: "provider-reported",
      tokens: { input: 30_000, cachedInput: 10_000, reasoning: 0, output: 4_000 } };

    const whole = checkUsageAccountingContract({ records: [record] });
    assert.strictEqual(whole.ok, true, JSON.stringify(whole.errors, null, 2));
    assert.ok(!whole.cacheCreationProviders.includes("deepseek"));
    assert.doesNotMatch(whole.rows[0].label ?? "", /upper bound is unproven/);

    const lost = checkUsageAccountingContract({
      records: [record],
      read: (rel) => (rel === missing ? null : readReal(rel)),
    });
    // One unreadable loop is the dangerous case, not the all-missing one: it
    // used to drop out of the set in silence while five others kept the check
    // looking healthy.
    assert.strictEqual(lost.ok, false);
    assert.ok(lost.errors.some((e) => e.startsWith(`${missing}: could not be read`)),
      JSON.stringify(lost.errors, null, 2));
    assert.ok(lost.cacheCreationProviders.includes("deepseek"),
      "an unread loop must be assumed to report cache writes");
    assert.match(lost.rows[0].label, /upper bound is unproven/);
  });

  test("an announce source that cannot be read is a failure, not a pass — the flags " +
    "contract must never stand on files nobody could open", () => {
    // wsHandler.js is the sharp case: it is the connect and provider-SWITCH
    // announce, so it is exactly the file whose flags stop a paid rate from
    // surviving a switch to a subscription provider. Losing it used to leave
    // the other announces carrying the check, so the gate stayed green while
    // neither WebSocket provider announcement had been read at all.
    const ws = "lib/emitters/handlers/wsHandler.js";
    const lostWs = checkUsageAccountingContract({
      read: (rel) => (rel === ws ? null : readReal(rel)),
    });
    assert.strictEqual(lostWs.ok, false, JSON.stringify(lostWs.errors, null, 2));
    assert.ok(lostWs.errors.some((e) => e.startsWith(`${ws}: could not be read`)),
      JSON.stringify(lostWs.errors, null, 2));

    // Every announce file gets the same treatment, one at a time.
    for (const name of ["anthropic", "deepseek", "gemini", "llamacpp", "claude-code", "codex"]) {
      const file = `lib/agent/providers/${name}.js`;
      const lost = checkUsageAccountingContract({ read: (rel) => (rel === file ? null : readReal(rel)) });
      assert.strictEqual(lost.ok, false, file);
      assert.ok(lost.errors.some((e) => e.startsWith(`${file}: could not be read`) &&
        e.includes("billing")), `${file}: ${JSON.stringify(lost.errors, null, 2)}`);
    }

    // And the unmutated tree is still green, so the new check is not a
    // permanent red.
    assert.strictEqual(checkUsageAccountingContract().ok, true);
  });

  test("current real state — a real record set reconciles against the real classifiers " +
    "without any fabricated price", () => {
    const result = checkUsageAccountingContract({ records: ledger() });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors, null, 2));

    // llamacpp and claude-code are classified by the REAL isLocalProvider /
    // isSubscriptionProvider, not by the test's stand-ins.
    assert.strictEqual(result.rows.find((r) => r.runId === "A06-recon").billing, "local");
    assert.strictEqual(result.rows.find((r) => r.runId === "A06-review").billing, "subscription");

    for (const row of result.rows) {
      if (row.billing !== "api") {
        assert.strictEqual(row.cost, null, `${row.runId}: a ${row.billing} run was priced`);
        assert.ok(row.label);
      } else {
        // "audit-model" is not on the real price sheet, so every API row is
        // honestly unknown — and no row anywhere reports a cost of zero.
        assert.strictEqual(row.costStatus, "unknown");
        assert.strictEqual(row.cost, null);
      }
    }
    assert.strictEqual(result.totals.unknownPrice.length, 4);
    // …and the aggregate says the same thing the rows do. Against the real repo
    // in a cold process this is the DEFAULT state, so a {low: 0, high: 0} here
    // would be the gate's own headline number claiming the audit was free.
    assert.strictEqual(result.totals.actual.api.costStatus, "unknown");
    assert.strictEqual(result.totals.actual.api.cost, null);
  });
});
