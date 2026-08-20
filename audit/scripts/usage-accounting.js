// audit/scripts/usage-accounting.js
//
// T3.3 — usage accounting reconciles (aperio-continuous-audit-tests.md T3.3;
// aperio-continuous-audit.md Step 3 + §4 "Token controls that are mandatory",
// item 8: "Store per-run input, cached-input, reasoning, and output token
// counts in the audit ledger").
//
// audit/scripts/schema.js validates ONE run record and stops there, by its own
// header. This is the layer above it: aggregation across many already-valid run
// records into a cost ledger that never invents a number. Per-record field
// validation is NOT repeated here — a record validateRun() accepts reconciles
// here unchanged, including the canonical shape from the plan's Step 3, which
// carries no usageSource. That field is owned by schema.js and is optional
// there: a run record is a record of a run that happened, so an omitted value
// means DEFAULT_USAGE_SOURCE ("provider-reported") and the row says so via
// `usageSourceDefaulted`. Only an explicit out-of-enum value is an error.
// `runId` runs the other way: this layer needs to address a row and to notice
// the same run arriving twice through a merge or replay, so schema.js requires
// it, and a duplicate is reported AND excluded from the totals — an inflated
// sum sitting under an error message is still an inflated sum. Every rejected
// record is treated the same way, not only duplicates: a record this layer
// raises any error for is priced for its own row, marked `excluded`, and left
// out of every total. Otherwise a record with an unusable `usageSource` would
// land in the ACTUAL column — column() sends everything that is not
// "estimated" there — and a negative hand-entered rate could push a total
// below zero, both under an error nobody has to read to see the number.
//
// The invariant being defended is lib/providers/index.js's own docstring for
// isSubscriptionProvider(): "No per-token $ estimate should ever be shown for
// these — it would be fiction, not a guide." The plan says the same thing about
// models that are not on a price sheet: "do not invent a V4 cost — use the
// published alias/rate actually billed." So this gate has exactly three
// non-numeric verdicts and they are all load-bearing:
//
//   not-applicable  local / subscription provider — labeled, never priced
//   unknown         API provider, no rate available — NOT zero
//   bounded         API provider, rate available, but part of the token mix
//                   has no published rate (see "Cached input" below)
//
// The totals are nested usage source FIRST, billing class second —
// `totals.actual.api`, `totals.estimated.local`, and so on. Billing class first
// would let an estimated local run share a bucket with a provider-reported one,
// so the closeout's "actual non-API token usage" would quietly include a
// projection. Nothing is ever summed across the two columns, only `.api` ever
// carries a cost, and there is deliberately no grand total to mistake for
// actuals.
//
// The same three verdicts bind the AGGREGATE, not only the rows. A bucket that
// holds even one unpriced record has no upper bound — summing only the priced
// rows into `cost.high` would present a partial sum as the bucket's total, and
// a bucket where every record is unpriced would report {low: 0, high: 0}, which
// says "this cost nothing". Both are the fiction this gate exists to prevent,
// and the second is the DEFAULT state in a cold process, where the repo price
// lookup returns "unknown" for every model. So each bucket carries its own
// `costStatus` (exact / bounded / partial / unknown), `cost` is null unless the
// whole bucket is priced, and the priced rows' interval stays visible under
// `pricedSubsetCost`, which names how many rows it covers. See finalizeBucket().
//
// ── Decision: cached-input and reasoning tokens ──────────────────────────────
//
// T3.3's spec names four token classes. lib/pricing.js carries four rates
// (`in`, `out`, `cacheRead`, `cacheWrite`, USD per million), but the two cache
// rates are per-model and nullable: OpenRouter publishes `input_cache_read` and
// `input_cache_write` only for the providers that actually charge a separate
// rate. So each class is resolved as follows, and the resolution is re-checked
// against real source by checkUsageAccountingContract() so it cannot rot
// silently:
//
// * REASONING tokens are a BREAKDOWN OF OUTPUT, not an addition to it.
//   lib/streaming/llamacppHandler.js reads `thinking_tokens` out of
//   `completion_tokens_details.reasoning_tokens` — a sub-field of the
//   completion count — and Anthropic likewise counts thinking inside
//   `output_tokens`. So reasoning is already paid for at the output rate.
//   Adding `reasoning * rateOut` on top would double-charge. It is reported,
//   never summed. The gate rejects any record with reasoning > output.
//
// * CACHED INPUT (cache READS) are a SUBSET OF INPUT, not an addition to it.
//   lib/agent/providers/anthropic.js sets
//   `streamUsage.input_tokens = uncachedInput + cacheRead + cacheCreated`, so
//   `tokens.cachedInput` is part of `tokens.input`. When the price sheet
//   publishes a `cacheRead` rate for the model, those tokens are billed at it
//   and the record's cost is a POINT. When it does not, pricing them at `in`
//   over-reports and pricing them at 0 under-reports — neither is honest — so
//   the cost falls back to an interval:
//       low  = cached tokens billed at 0
//       high = cached tokens billed at the full `in` rate
//   The true cost is inside it. costStatus is "bounded" whenever low < high and
//   "exact" otherwise.
//
// * CACHE CREATION (cache WRITES) are also a subset of input, and are billed
//   ABOVE the base input rate. That is why they can never fall back to the
//   interval above: pricing them at `rates.in` puts the true cost OUTSIDE it,
//   and an upper bound that is not one is worse than no bound at all. So a
//   `cacheWrite` rate is required, never approximated — inventing a multiplier
//   is the fabrication this whole gate exists to prevent. `tokens.
//   cacheCreationInput` is an optional FIFTH count, deliberately tri-state
//   rather than defaulted to 0:
//       0          → no cache writes; the reads above settle the cost
//       > 0        → priced at `cacheWrite` when the sheet publishes one for
//                    this model; costStatus "unknown" when it does not
//       undefined  → "not recorded", which is NOT "there were none". Unknown
//                    for any provider whose loop reports cache writes (derived
//                    from real source by parseCacheCreationProviders), sound
//                    for one that never has any to report. A published rate
//                    does not rescue this case: a rate without a count prices
//                    nothing.
//
// ── Determinism ─────────────────────────────────────────────────────────────
//
// getPricing() reads var/pricing-cache.json, refreshed from OpenRouter over the
// network. A gate must not depend on cache warmth, so the price lookup is
// injectable and the default (makeRepoPriceLookup) NEVER warms the cache: it
// derives the price-sheet ROSTER from lib/pricing.js's WATCHED table in source
// (deterministic) and consults getPricing() only for RATES. A cold cache
// therefore yields "unknown" for every model, which is the correct answer — not
// zero, and not an error. `ok`/`errors` never depend on cache state.
//
// The roster resolution follows getPricing()'s own alias semantics so the two
// cannot disagree: exact alias, then the same `-YYYYMMDD` suffix strip (a dated
// alias such as claude-opus-4-8-20260820 is a real model, not an unknown one),
// then a fragment match. One deliberate difference — a fragment that names more
// than one model resolves to `ambiguous`, hence `unknown`. getPricing() settles
// "claude" by taking whichever indexed key is longest, which is a reasonable UI
// hint and an unacceptable ledger entry: it would bill one model's tokens at
// another model's rate. The prefilter can therefore only ever be MORE
// conservative than the runtime lookup, never less.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPricing } from "../../lib/pricing.js";
import { isLocalProvider, isSubscriptionProvider } from "../../lib/providers/index.js";
import { USAGE_SOURCES, DEFAULT_USAGE_SOURCE } from "./schema.js";
import { readRunLedger, RUN_LEDGER_FILE } from "./ledger.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const PRICING_FILE = "lib/pricing.js";
const PROVIDERS_FILE = "lib/providers/index.js";

// The six loops provider-contract.js (T2.1) reconciles. Listed here only to
// know which files to read; T2.1 is what keeps the list itself honest.
const PROVIDER_LOOPS = ["anthropic", "deepseek", "gemini", "llamacpp", "claude-code", "codex"];

/** How a run was billed. Only `api` is ever assigned a per-token cost. */
export const BILLING_KINDS = ["api", "local", "subscription"];

// Where a record's token counts came from. Owned by schema.js so the two audit
// layers cannot drift: a record validateRun() accepts must reconcile here, and
// a run record that omits the field means DEFAULT_USAGE_SOURCE. Kept apart in
// the totals forever — the plan's Step 9 asks for "actual token/cost totals",
// and an estimate added into the actual column can never be subtracted back out.
export { USAGE_SOURCES, DEFAULT_USAGE_SOURCE };

/**
 * The billing class each provider is on record as belonging to. Non-emptiness
 * is not enough: dropping `claude-code` from SUBSCRIPTION_PROVIDERS while
 * `codex` stays leaves the set populated and would reclassify every Claude Code
 * run as billable API usage — precisely the fiction this gate exists to
 * prevent. So the real sets are compared against this membership, and any
 * difference in either direction fails until a human confirms the provider's
 * billing really changed and updates it here.
 */
export const REVIEWED_BILLING_CLASSES = {
  local: {
    providers: ["llamacpp"],
    reason: "llama.cpp runs on the user's own machine — inference costs nothing per token",
  },
  subscription: {
    providers: ["claude-code", "codex"],
    reason: "billed via a flat Claude Code / Codex subscription, not per-token API pricing " +
      "(lib/providers/index.js isSubscriptionProvider)",
  },
};

/**
 * Models deliberately priced from something other than lib/pricing.js's
 * catalog. The provider-contract.js `localOnly` hook is the model: an exception
 * survives only while its stated reason still holds in the code. Here the
 * reason is `absentFromCatalog` — "lib/pricing.js does not carry this model, so
 * the record must supply the rate it was actually billed at" — and it is
 * re-validated against the WATCHED roster parsed from real source. The day the
 * model is added to lib/pricing.js, this exception fails as stale instead of
 * quietly keeping a hand-entered rate alive next to a catalog rate.
 */
export const REVIEWED_PRICE_EXCEPTIONS = {
  "deepseek-chat": {
    reason:
      "the plan's primary-audit alias (aperio-continuous-audit.md §4); billed at DeepSeek's own " +
      "published rate, which lib/pricing.js's OpenRouter catalog does not carry under this name",
    absentFromCatalog: true,
    source: "https://api-docs.deepseek.com/quick_start/pricing-details-usd",
  },
};

// Source invariants the aggregation above rests on. Each one is a textual
// marker on a real file: if the marker goes, the arithmetic here silently
// changes meaning, so the gate fails and names what to re-derive.
export const SOURCE_INVARIANTS = [
  {
    id: "no-fiction-doctrine",
    file: PROVIDERS_FILE,
    marker: /No per-token \$ estimate should ever be shown/,
    why: "the stated invariant this gate enforces — subscription runs are labeled, never priced",
  },
  {
    id: "cached-input-subset-of-input",
    file: "lib/agent/providers/anthropic.js",
    marker: /streamUsage\.input_tokens\s*=\s*uncachedInput\s*\+\s*cacheRead\s*\+\s*cacheCreated/,
    why: "tokens.cachedInput is part of tokens.input; the cost interval subtracts it out. " +
      "If input became uncached-only, the subtraction would under-report every cached run",
  },
  {
    id: "reasoning-subset-of-output",
    file: "lib/streaming/llamacppHandler.js",
    marker: /thinking_tokens:\s*parsed\.usage\.completion_tokens_details\?\.reasoning_tokens/,
    why: "reasoning tokens are a breakdown of the completion count, so they are already paid " +
      "for at the output rate and must not be summed on top",
  },
  {
    id: "price-sheet-carries-cache-rates",
    file: PRICING_FILE,
    marker: /cacheRead: Number\.isFinite\(entry\.cacheRead\)[\s\S]{0,200}?cacheWrite: Number\.isFinite\(entry\.cacheWrite\)/,
    why: "cached input collapses to an exact cost when getPricing() publishes a cacheRead rate " +
      "and falls back to an interval when it does not, and cache-creation tokens are priceable " +
      "at all only through cacheWrite. If either stops being returned, every cached run silently " +
      "loses its exact cost and every anthropic run goes back to unknown",
  },
  {
    id: "price-sheet-has-no-reasoning-rate",
    file: PRICING_FILE,
    marker: /internal_reasoning/,
    absent: true,
    // What the forbidden change would look like. An `absent` invariant cannot be
    // proved red by DELETING a real line, so the T5.1 proof inserts this instead.
    sample: "    cacheReasoning: parseRate(p.internal_reasoning),",
    why: "reasoning tokens need no rate of their own — they are a breakdown of the output count " +
      "on every provider Aperio talks to, so they are already billed at `out`, reported and never " +
      "summed. OpenRouter publishes an `internal_reasoning` rate for some models; the day this " +
      "file starts reading it, reasoning is billed separately somewhere and this gate is " +
      "under-reporting every thinking run",
  },
  {
    id: "search-key-normaliser",
    file: PRICING_FILE,
    literal: 'return raw.toLowerCase().replace(/[^a-z0-9]/g, "");',
    why: "catalogCovers() mirrors this normaliser to decide whether a model is on the price " +
      "sheet; if it changes, a reviewed price exception could stay alive after the model was added",
  },
  {
    id: "ui-keeps-billing-state-when-an-announce-omits-it",
    file: "public/index.js",
    marker: /if \(subscription !== undefined\) _currentIsSubscription = Boolean\(subscription\)/,
    why: "the reason checkProviderAnnounces() requires the flags UNCONDITIONALLY: an omitted " +
      "flag does not reset the display, it keeps the previous provider's billing class",
  },
  {
    id: "announce-carries-the-cache-rates",
    file: "lib/emitters/handlers/wsHandler.js",
    marker: /cacheRead: p\.cacheRead, cacheWrite: p\.cacheWrite/,
    why: "the browser prices a turn from the announced rates alone. Drop the two cache rates " +
      "and every cache read is billed at the full input rate again — on a long Anthropic " +
      "conversation that is most of the prompt, and the figure on screen is several times the " +
      "real cost",
  },
  {
    id: "ui-bills-cached-input-at-the-cache-rate",
    file: "public/index.js",
    marker: /const uncached = Math\.max\(0, used - cacheRead - cacheWrite\)/,
    why: "the three input classes are disjoint slices of the prompt. If the UI stops subtracting " +
      "them it bills the cached tokens twice — once at `in` and once at the cache rate",
  },
  {
    id: "ui-gates-cost-on-billing-flags",
    file: "public/index.js",
    marker: /!isLocal\s*&&\s*!isSubscription/,
    why: "the flags must actually suppress the estimate; sending them and ignoring them is " +
      "the same fiction the doctrine forbids",
  },
];

/** Members of a `new Set([...])` literal assigned to `name`. */
export function parseSetLiteral(source, name) {
  const body = source.match(new RegExp(`${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`))?.[1] ?? "";
  return [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

/** lib/pricing.js's WATCHED table as one entry per priced model: the internal
 *  key it is cached under, plus every alias that names it (the OpenRouter id and
 *  the key itself). Read from source, so the roster does not depend on whether
 *  the runtime cache has ever been warmed. */
export function parseWatchedModels(source) {
  const body = source.match(/WATCHED\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
  const entries = [];
  for (const [, orId, key] of body.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g)) {
    entries.push({ id: key, aliases: [orId, key] });
  }
  return entries;
}

// Mirrors lib/pricing.js's buildSearchKey(). The `search-key-normaliser`
// invariant above fails if that function stops matching this one.
const searchKey = (raw) => String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Mirrors getPricing()'s date-suffix strip, so a dated alias such as
// claude-opus-4-8-20260820 resolves here exactly as it does there.
const stripDate = (model) => String(model ?? "").replace(/-\d{8}$/, "").replace(/\.\d{8}$/, "");

/** Accepts a roster of entries or of bare alias strings. */
function rosterEntries(roster) {
  return (roster ?? []).map((r) => (typeof r === "string" ? { id: r, aliases: [r] } : r));
}

/**
 * Resolve a model name against the price sheet using the SAME semantics as
 * getPricing(): exact alias, then date-suffix strip, then fragment match. One
 * deliberate difference — a fragment that matches more than one distinct model
 * is `ambiguous`, not a coin flip. getPricing() resolves "claude" by picking
 * whichever indexed key happens to be longest, which is fine for a UI hint and
 * unacceptable for a cost ledger: it would attach one model's rate to another
 * model's tokens. Ambiguous resolves to `unknown`, so this prefilter can only
 * ever be more conservative than the runtime lookup, never less.
 */
export function resolveCatalogModel(roster, model) {
  const entries = rosterEntries(roster);
  const key = searchKey(model);
  if (!key) return { status: "miss" };

  for (const probe of [key, searchKey(stripDate(model))]) {
    if (!probe) continue;
    const exact = entries.filter((e) => e.aliases.some((a) => searchKey(a) === probe));
    const ids = [...new Set(exact.map((e) => e.id))];
    if (ids.length === 1) return { status: "hit", id: ids[0] };
    if (ids.length > 1) return { status: "ambiguous", ids };
  }

  const fragment = entries.filter((e) => e.aliases.some((a) => searchKey(a).includes(key)));
  const ids = [...new Set(fragment.map((e) => e.id))];
  if (ids.length === 1) return { status: "hit", id: ids[0] };
  if (ids.length > 1) return { status: "ambiguous", ids };
  return { status: "miss" };
}

/** True when `model` resolves to exactly one model on the price-sheet roster. */
export function catalogCovers(roster, model) {
  return resolveCatalogModel(roster, model).status === "hit";
}

/**
 * The default price lookup: roster from source, rates from the real
 * getPricing(). Returns one of
 *   { status: "priced", rates: { in, out } }
 *   { status: "unknown", reason }
 * and never a zero rate.
 */
export function makeRepoPriceLookup({
  pricingSource = readIfPresent(PRICING_FILE) ?? "",
  getPrice = getPricing,
} = {}) {
  const roster = parseWatchedModels(pricingSource);
  return (model) => {
    const resolved = resolveCatalogModel(roster, model);
    if (resolved.status === "ambiguous") {
      return { status: "unknown", reason: `"${model}" matches ${resolved.ids.length} models on ` +
        `lib/pricing.js's price sheet (${resolved.ids.join(", ")}) — too ambiguous to price` };
    }
    if (resolved.status !== "hit") {
      return { status: "unknown", reason: `"${model}" is not on lib/pricing.js's price sheet` };
    }
    const rates = getPrice(model);
    if (!rates || !Number.isFinite(rates.in) || !Number.isFinite(rates.out)) {
      // On the sheet, but var/pricing-cache.json has never been warmed in this
      // process. Deliberately still "unknown" — the gate does not fetch.
      return { status: "unknown", reason: `"${model}" is on the price sheet but no rate is loaded` };
    }
    // The two cache rates are carried through as-is, `null` included: a model
    // whose provider charges no separate cache rate has none to carry, and a
    // null is what makes the reads fall back to an interval and the writes to
    // `unknown` instead of being priced off `in`.
    return {
      status: "priced",
      rates: {
        in: rates.in,
        out: rates.out,
        cacheRead: Number.isFinite(rates.cacheRead) ? rates.cacheRead : null,
        cacheWrite: Number.isFinite(rates.cacheWrite) ? rates.cacheWrite : null,
      },
    };
  };
}

const ZERO_TOKENS = { input: 0, cachedInput: 0, reasoning: 0, output: 0 };
const TOKEN_KEYS = Object.keys(ZERO_TOKENS);

// The fifth count is OPTIONAL and tri-state on purpose: a number states how
// many cache-WRITE tokens the run had, and `undefined` states that the record
// does not know. It cannot default to 0 — see the cache-creation note in the
// header — because "we did not record it" and "there were none" have opposite
// consequences for the upper bound.
const CACHE_CREATION_KEY = "cacheCreationInput";
const BUCKET_TOKEN_KEYS = [...TOKEN_KEYS, CACHE_CREATION_KEY];

const round = (v) => Math.round(v * 1e10) / 1e10;

function emptyBucket({ priced = true } = {}) {
  return {
    records: 0,
    tokens: { ...ZERO_TOKENS, [CACHE_CREATION_KEY]: 0 },
    // `null`, not {low: 0, high: 0}, for the classes that are never priced —
    // a zero-dollar total reads as "this cost nothing", which is a claim.
    // For the API class it starts as the empty interval and is replaced by
    // finalizeBucket() with `null` the moment any record in it is unpriced.
    cost: priced ? { low: 0, high: 0, currency: "USD" } : null,
    // The interval over the PRICED rows only, and it says how many rows that
    // is. Kept separate from `cost` so the partial information survives
    // without ever being read as the bucket's total.
    pricedSubsetCost: priced ? { low: 0, high: 0, currency: "USD", records: 0 } : null,
    costStatus: priced ? "exact" : "not-applicable",
    unknownPriceRecords: 0,
  };
}

/**
 * Decide what a bucket's aggregate cost is ALLOWED to claim. Same three
 * non-numeric verdicts the rows use, for the same reason: a bucket holding even
 * one record with no published rate has no honest upper bound, so `high` would
 * not be a bound at all, and an all-unknown bucket would otherwise report
 * {low: 0, high: 0} — "this cost nothing", which is exactly the fiction this
 * gate exists to prevent, and the default lookup returns "unknown" for every
 * model in a cold process. So `cost` is emptied and the priced rows' interval
 * stays visible under `pricedSubsetCost`, which names the subset it covers.
 *
 *   exact    every record priced at a published rate for each of its token
 *            classes — a point
 *   bounded  every record priced, but some cached input has no published
 *            cacheRead rate — a true interval
 *   partial  some records unpriced — pricedSubsetCost is a LOWER bound on the
 *            bucket and there is no upper bound
 *   unknown  every record unpriced — nothing is known about this bucket's cost
 */
function finalizeBucket(bucket) {
  if (!bucket.cost) return bucket;
  if (bucket.unknownPriceRecords > 0) {
    bucket.cost = null;
    bucket.costStatus = bucket.unknownPriceRecords >= bucket.records ? "unknown" : "partial";
    return bucket;
  }
  const { low, high } = bucket.pricedSubsetCost;
  bucket.cost = { low, high, currency: "USD" };
  bucket.costStatus = low === high ? "exact" : "bounded";
  return bucket;
}

// Usage source FIRST, billing class second. Nesting it the other way round let
// an estimated local run land in the same bucket as a provider-reported one, so
// the closeout's "actual non-API token usage" quietly included a projection.
// This shape makes that impossible: nothing is ever added across the two
// columns, and only `.api` can ever carry a cost.
function emptyColumn() {
  return {
    api: emptyBucket(),
    local: emptyBucket({ priced: false }),
    subscription: emptyBucket({ priced: false }),
  };
}

function addTokens(target, tokens) {
  for (const key of BUCKET_TOKEN_KEYS) target[key] += Number(tokens?.[key] ?? 0);
}

/** Providers whose loops report `cache_creation_input_tokens` — derived from
 *  real source rather than hardcoded, so a provider that starts (or stops)
 *  reporting cache writes changes this set on its own. See the cache-creation
 *  note in the header for why it matters to the upper bound. */
export function parseCacheCreationProviders(loopSources = {}) {
  return new Set(Object.entries(loopSources)
    .filter(([, source]) => /cache_creation_input_tokens/.test(source ?? ""))
    .map(([name]) => name));
}

/**
 * Reconcile many run records into a cost ledger. Fully injectable so the
 * plan's fixture — records across all four token classes plus one
 * subscription/local invocation — can be driven without a repo or a network.
 */
export function reconcileUsage({
  records = [],
  priceLookup = () => ({ status: "unknown", reason: "no price lookup supplied" }),
  isLocal = isLocalProvider,
  isSubscription = isSubscriptionProvider,
  exceptions = REVIEWED_PRICE_EXCEPTIONS,
  catalogRoster = null,
  cacheCreationProviders = new Set(),
} = {}) {
  const errors = [];
  const rows = [];
  const seenRunIds = new Set();
  const totals = { actual: emptyColumn(), estimated: emptyColumn(), unknownPrice: [] };
  const column = (usageSource) => totals[usageSource === "estimated" ? "estimated" : "actual"];

  // Reviewed exceptions are re-validated against the real roster BEFORE any
  // record is priced: an exception justified by "not on the price sheet" must
  // fail the day the model lands on the price sheet, and the record that leans
  // on it must not be summed in the meantime. Doing this after the loop left the
  // hand-entered — now possibly obsolete — rate inside the totals with
  // `excluded: false`, contradicting the rule that every record this layer
  // raises an error for is left out of every total.
  const staleExceptions = new Map();
  if (catalogRoster) {
    for (const [model, exception] of Object.entries(exceptions ?? {})) {
      if (exception?.absentFromCatalog && catalogCovers(catalogRoster, model)) {
        staleExceptions.set(model, `it is on ${PRICING_FILE}'s price sheet now`);
        errors.push(`${model}: reviewed price exception claims the model is absent from ` +
          `${PRICING_FILE}'s catalog, but it is on the price sheet now — the exception's stated ` +
          `reason no longer holds and the hand-entered rate is competing with a real one`);
      }
    }
  }

  records.forEach((record, index) => {
    // Every error raised from here on belongs to THIS record, and a record that
    // raised one is not summed. A rejected record whose tokens are in the totals
    // anyway is the same failure as a double-counted duplicate: a wrong number
    // sitting under an error message is still a wrong number, and it is the one
    // people read. The row is kept and marked `excluded`, so nothing is hidden.
    const errorsBefore = errors.length;

    // An address has to be a comparable string, not merely present: two records
    // carrying an equal-but-not-identical object would be distinct Set members,
    // so the duplicate below would go unnoticed and the run would be summed
    // twice. schema.js rejects the same shapes at record level.
    const addressable = typeof record?.runId === "string" && record.runId.trim() !== "";
    const at = addressable ? `run ${record.runId}` : `records[${index}]`;
    if (!addressable) {
      errors.push(`${at}: runId must be a non-empty string — a ledger row must be addressable and ` +
        `comparable by value, got ${JSON.stringify(record?.runId)}`);
    }

    // Ledgers get merged and replayed. The same run arriving twice would have
    // its tokens and cost counted twice while leaving two rows nothing can tell
    // apart, so the duplicate is reported AND kept out of the totals — an
    // inflated sum sitting under an error message is still an inflated sum.
    const duplicate = addressable && seenRunIds.has(record.runId);
    if (duplicate) {
      errors.push(`${at}: duplicate runId — it is already in this ledger, so summing it again ` +
        `would double-count the run; de-duplicate before reconciling`);
    }
    if (addressable) seenRunIds.add(record.runId);

    const tokens = { ...ZERO_TOKENS, ...(record?.tokens ?? {}) };
    for (const key of TOKEN_KEYS) {
      const value = tokens[key];
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`${at}: tokens.${key} must be a non-negative number, got ${JSON.stringify(value)}`);
        tokens[key] = 0;
      }
    }
    const cacheCreation = tokens[CACHE_CREATION_KEY];
    if (cacheCreation !== undefined && (!Number.isFinite(cacheCreation) || cacheCreation < 0)) {
      errors.push(`${at}: tokens.${CACHE_CREATION_KEY} must be a non-negative number when present ` +
        `(omit it to mean "not recorded"), got ${JSON.stringify(cacheCreation)}`);
      tokens[CACHE_CREATION_KEY] = undefined;
    }
    if (tokens.cachedInput + (tokens[CACHE_CREATION_KEY] ?? 0) > tokens.input) {
      errors.push(`${at}: tokens.cachedInput (${tokens.cachedInput}) plus ` +
        `tokens.${CACHE_CREATION_KEY} (${tokens[CACHE_CREATION_KEY] ?? 0}) exceeds tokens.input ` +
        `(${tokens.input}) — cache reads and cache writes are both subsets of input, not extra charges`);
    }
    if (tokens.reasoning > tokens.output) {
      errors.push(`${at}: tokens.reasoning (${tokens.reasoning}) exceeds tokens.output ` +
        `(${tokens.output}) — reasoning is a breakdown of output, not an addition to it`);
    }

    // A run record that omits usageSource is an actual run — see schema.js's
    // note on DEFAULT_USAGE_SOURCE. Defaulting it (rather than rejecting it) is
    // what lets a validateRun()-clean record reconcile here unchanged; the
    // default only ever moves a record INTO the actual column, which is the
    // safe direction, and the row records that it was defaulted. An explicit
    // value that is not in the enum is still an error.
    const usageSourceDefaulted = record?.usageSource === undefined;
    const usageSource = usageSourceDefaulted ? DEFAULT_USAGE_SOURCE : record.usageSource;
    if (!USAGE_SOURCES.includes(usageSource)) {
      errors.push(`${at}: usageSource must be one of ${USAGE_SOURCES.join("/")} when present, got ` +
        `${JSON.stringify(record?.usageSource)} — an estimate merged into the actual column cannot be undone`);
    }
    if (record?.cost !== undefined) {
      errors.push(`${at}: carries a precomputed cost — cost is derived here from tokens and ` +
        `rates so it can never disagree with the ledger`);
    }

    const provider = record?.provider;
    const model = record?.model;
    const billing = isLocal(provider) ? "local" : isSubscription(provider) ? "subscription" : "api";

    if (billing !== "api") {
      if (record?.unitPrices) {
        errors.push(`${at}: ${billing} provider "${provider}" carries unitPrices — ` +
          `a per-token rate for a ${billing} run is fiction, not a guide`);
      }
      const rejected = duplicate || errors.length > errorsBefore;
      const row = {
        runId: addressable ? record.runId : null, provider, model, billing, usageSource, usageSourceDefaulted,
        duplicate, excluded: rejected, tokens, priceSource: null, costStatus: "not-applicable", cost: null,
        label: billing === "local"
          ? "local inference — no per-token charge"
          : "flat subscription — not billed per token",
      };
      rows.push(row);
      if (rejected) return;
      const bucket = column(usageSource)[billing];
      bucket.records += 1;
      addTokens(bucket.tokens, tokens);
      return;
    }

    // A stale exception is no longer a licence to hand-enter a rate, so it is
    // not honoured for this record either — the ledger-level error above says
    // the reason is gone, and this is what keeps the rate it justified out of
    // the totals that error sits under.
    const staleReason = staleExceptions.get(model) ?? null;
    const exception = staleReason ? null : (exceptions?.[model] ?? null);
    const lookup = record?.unitPrices
      ? { status: "priced", rates: record.unitPrices, fromRecord: true }
      : priceLookup(model);

    if (record?.unitPrices) {
      for (const key of ["in", "out"]) {
        if (!Number.isFinite(record.unitPrices[key]) || record.unitPrices[key] < 0) {
          errors.push(`${at}: unitPrices.${key} must be a non-negative USD-per-million number, ` +
            `got ${JSON.stringify(record.unitPrices[key])}`);
        }
      }
      // The cache rates are optional in a hand-entered price the same way they
      // are optional on the sheet: absent means "no published rate", which the
      // arithmetic already handles. Present but nonsense is still an error.
      for (const key of ["cacheRead", "cacheWrite"]) {
        const rate = record.unitPrices[key];
        if (rate === undefined || rate === null) continue;
        if (!Number.isFinite(rate) || rate < 0) {
          errors.push(`${at}: unitPrices.${key} must be a non-negative USD-per-million number ` +
            `(omit it to mean "no published rate"), got ${JSON.stringify(rate)}`);
        }
      }
      if (!exception) {
        errors.push(staleReason
          ? `${at}: supplies its own unitPrices for "${model}", but that model's reviewed price ` +
            `exception is stale — ${staleReason}, so the hand-entered rate may be obsolete and is ` +
            `excluded from the totals`
          : `${at}: supplies its own unitPrices for "${model}" but that model has no ` +
            `entry in REVIEWED_PRICE_EXCEPTIONS — a hand-entered rate must be on record`);
      }
    }

    // Every per-record check has run by now, so this is the record's verdict:
    // an unusable record (bad usageSource, unaddressable, broken token subsets,
    // a negative hand-entered rate) is priced for the row's sake but never
    // added to a total, exactly as a duplicate is not.
    const rejected = duplicate || errors.length > errorsBefore;
    const row = {
      runId: addressable ? record.runId : null, provider, model, billing, usageSource, usageSourceDefaulted,
      duplicate, excluded: rejected, tokens, priceSource: null, costStatus: "unknown", cost: null, label: null,
    };
    rows.push(row);

    const priced = lookup?.status === "priced" &&
      Number.isFinite(lookup.rates?.in) && Number.isFinite(lookup.rates?.out);
    const readRate = Number.isFinite(lookup?.rates?.cacheRead) ? lookup.rates.cacheRead : null;
    const writeRate = Number.isFinite(lookup?.rates?.cacheWrite) ? lookup.rates.cacheWrite : null;

    // Cache WRITES are billed ABOVE the base input rate, so they are priceable
    // only at a published `cacheWrite` rate — pricing them at `rates.in` would
    // put the true cost OUTSIDE the interval, which is worse than reporting
    // nothing. A record that does not state the count stays unbounded whatever
    // the rate, whenever its provider is one that reports cache writes:
    // "not recorded" is not "there were none", and a rate with no count prices
    // nothing.
    const stated = tokens[CACHE_CREATION_KEY];
    const unbounded = stated === undefined
      ? (cacheCreationProviders.has(provider)
        ? `"${provider}" reports cache-creation tokens but this record does not state ` +
          `tokens.${CACHE_CREATION_KEY} — the upper bound is unproven`
        : null)
      : (stated > 0 && writeRate === null
        ? `${stated} cache-creation token(s): cache writes are billed above the base input rate ` +
          `and ${PRICING_FILE} publishes no cache-write rate for "${model}", so no honest upper ` +
          `bound exists`
        : null);

    if (!priced || unbounded) {
      row.label = unbounded ?? lookup?.reason ?? `no published rate for "${model}"`;
      if (!rejected) totals.unknownPrice.push({ runId: row.runId, model, reason: row.label });
      if (rejected) return;
      const bucket = column(usageSource).api;
      bucket.records += 1;
      bucket.unknownPriceRecords += 1;
      addTokens(bucket.tokens, tokens);
      return;
    }

    row.priceSource = lookup.fromRecord ? "record" : "catalog";
    // All three input classes are disjoint subsets of `tokens.input` (the record
    // check above rejects any record where they are not), so each is billed once
    // at its own rate and the remainder at `in`.
    const created = stated ?? 0;
    const uncached = Math.max(0, tokens.input - tokens.cachedInput - created);
    const base = (uncached / 1e6) * lookup.rates.in
      + (tokens.output / 1e6) * lookup.rates.out
      // Reached only when the writes are bounded, i.e. `writeRate` is published.
      + (created / 1e6) * (writeRate ?? 0);
    // Cache reads are a point when their rate is published and an interval when
    // it is not — [billed at nothing, billed at the full input rate].
    const low = round(base + (readRate === null ? 0 : (tokens.cachedInput / 1e6) * readRate));
    const high = round(base + (readRate === null
      ? (tokens.cachedInput / 1e6) * lookup.rates.in
      : (tokens.cachedInput / 1e6) * readRate));
    row.cost = { low, high, currency: "USD" };
    row.costStatus = low === high ? "exact" : "bounded";
    if (row.costStatus === "bounded") {
      row.label = `cached input has no published rate — cost is bounded, not exact`;
    }

    if (rejected) return;
    const bucket = column(usageSource).api;
    bucket.records += 1;
    addTokens(bucket.tokens, tokens);
    bucket.pricedSubsetCost.low = round(bucket.pricedSubsetCost.low + low);
    bucket.pricedSubsetCost.high = round(bucket.pricedSubsetCost.high + high);
    bucket.pricedSubsetCost.records += 1;
  });

  // Only now can a bucket say what its cost is: whether an upper bound exists
  // at all depends on every record that landed in it.
  for (const source of ["actual", "estimated"]) {
    for (const kind of BILLING_KINDS) finalizeBucket(totals[source][kind]);
  }

  return { ok: errors.length === 0, errors, rows, totals };
}

function readIfPresent(rel) {
  try {
    return readFileSync(`${ROOT}/${rel}`, "utf8");
  } catch {
    return null;
  }
}

/** Every provider-announce payload in a source file, in both shapes the repo
 *  uses — `send("provider", { … })` and `emitter.send({ type: "provider", … })`
 *  — brace-matched from its own opening brace so each announce is checked as
 *  one object. Same brace-walking approach provider-contract.js uses to bound a
 *  function body. */
export function parseProviderAnnounces(source) {
  const payloads = [];
  const re = /send\(\s*(?:["']provider["']\s*,\s*)?\{/g;
  let m;
  while ((m = re.exec(source))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        const payload = source.slice(open, i + 1);
        // The object-literal shape is only an announce when it says so.
        if (m[0].includes("provider") || /^\{\s*type:\s*["']provider["']/.test(payload)) {
          payloads.push(payload);
        }
        break;
      }
    }
  }
  return payloads;
}

// The billing flags are checked on EVERY provider announce, with no trigger
// condition. An announce that drops costRates AND both flags looks harmless and
// is the worst case: public/index.js's setCostProvider() treats an omitted
// field as "keep what we have", so a switch from a paid API provider to Claude
// Code would carry the previous provider's dollar rate straight through the
// switch — pricing a subscription session, which is the fiction this whole gate
// exists to prevent. Checking only announces that already carry costRates would
// step over exactly that case.
const ANNOUNCE_FLAGS = [
  { name: "local", marker: /local:\s*isLocalProvider\(/ },
  { name: "subscription", marker: /subscription:\s*isSubscriptionProvider\(/ },
];

// Files that announce the provider to a client. wsHandler is the connect and
// provider-switch path; a provider loop can re-announce itself mid-turn.
const ANNOUNCE_FILES = [
  "lib/emitters/handlers/wsHandler.js",
  ...PROVIDER_LOOPS.map((name) => `lib/agent/providers/${name}.js`),
];

/**
 * Announces that are allowed to omit the billing flags. Same discipline as
 * REVIEWED_PRICE_EXCEPTIONS: honoured only while the stated reason still holds
 * in the code. `localOnly` is re-checked against isLocalProvider(), so the day
 * llamacpp stops being local — the day its sparse re-announce could leave a
 * paid rate on screen — this exemption fails instead of passing quietly.
 *
 * An exemption is keyed by file but SCOPED TO ONE PAYLOAD, because the rule it
 * suspends is per-payload. A file-wide exemption would blanket every announce
 * the file ever grows: llamacpp.js could add a second, genuinely unsafe
 * announce and the gate would wave it through under a reason written about a
 * different line. So `payload` must match exactly one announce in the file —
 * zero means the reviewed announce is gone and the exemption is stale, more
 * than one means it can no longer name which announce was reviewed — and
 * `omits` lists the only flags that announce is allowed to leave out. Any other
 * announce in the same file, and any further omission in the reviewed one, is
 * reported normally.
 */
export const REVIEWED_ANNOUNCE_EXEMPTIONS = {
  "lib/agent/providers/llamacpp.js": {
    reason: "a mid-turn re-announce of the SAME provider (the served context window grew), so it " +
      "cannot change the billing class; public/index.js deliberately reads the omitted fields as " +
      "\"keep what we have\"",
    provider: "llamacpp",
    localOnly: true,
    // The served-context re-announce, and only it — the very field the stated
    // reason is about.
    payload: /contextWindow:\s*actualContext/,
    omits: ["local", "subscription"],
  },
};

/** Every provider announce carries both billing flags, unless it is the ONE
 *  announce a reviewed exemption names and the exemption's stated reason still
 *  holds. Scope is per payload, never per file. */
export function checkProviderAnnounces({
  sources = {},
  exemptions = REVIEWED_ANNOUNCE_EXEMPTIONS,
  isLocal = isLocalProvider,
} = {}) {
  const errors = [];
  let announces = 0;
  // Which announces each exemption actually claimed, so the exemption audit
  // below can tell a live exemption from one whose announce is gone.
  const claimed = {};

  for (const [file, source] of Object.entries(sources)) {
    const exemption = exemptions?.[file] ?? null;
    // An exemption that does not name a payload cannot be scoped, so it is not
    // honoured at all — the file-wide reading is the bug this guards against.
    const scoped = exemption?.payload instanceof RegExp ? exemption : null;
    if (exemption) claimed[file] = [];

    for (const [i, payload] of parseProviderAnnounces(source ?? "").entries()) {
      announces += 1;
      const exempt = Boolean(scoped?.payload.test(payload));
      if (exempt) claimed[file].push(i + 1);

      for (const flag of ANNOUNCE_FLAGS) {
        if (flag.marker.test(payload)) continue;
        // Exempt only from the omissions that were actually reviewed. A NEW
        // omission in the reviewed announce is a change nobody signed off on.
        if (exempt && (scoped.omits ?? []).includes(flag.name)) continue;
        errors.push(`${file}: provider announce #${i + 1} omits the ${flag.name} flag ` +
          `(${flag.marker}) — setCostProvider() keeps the previous provider's billing class when ` +
          `a flag is omitted, so this announce can leave a paid rate on screen for a provider ` +
          `that is not billed per token`);
      }
    }
  }

  for (const [file, exemption] of Object.entries(exemptions ?? {})) {
    if (!(file in sources)) {
      errors.push(`${file}: has a reviewed announce exemption but was not read — the exemption ` +
        `is stale or the file moved`);
      continue;
    }
    if (!(exemption?.payload instanceof RegExp)) {
      errors.push(`${file}: announce exemption has no \`payload\` marker — an exemption must name ` +
        `the single announce it covers, or it silently exempts every announce the file ever grows`);
      continue;
    }
    // Exactly one. Zero means the reviewed announce is gone and the exemption
    // is now covering nothing while still looking live; more than one means it
    // no longer identifies which announce a human actually reviewed.
    const hits = claimed[file] ?? [];
    if (hits.length !== 1) {
      errors.push(`${file}: announce exemption's payload marker ${exemption.payload} matches ` +
        `${hits.length} announces (${hits.join(", ") || "none"}) — it must name exactly one, or it ` +
        `is stale or has stopped identifying the announce that was reviewed`);
    }
    if (exemption.localOnly && !isLocal(exemption.provider)) {
      errors.push(`${file}: exempt from the billing-flag contract because "${exemption.provider}" ` +
        `is local, but isLocalProvider("${exemption.provider}") is false — the exemption's stated ` +
        `reason no longer holds`);
    }
  }

  if (!announces) {
    errors.push(`found no provider announce in ${Object.keys(sources).join(", ") || "any file"} — ` +
      `the check has nothing to stand on, which is a failure, not a pass`);
  }
  return errors;
}

/** Check the SOURCE_INVARIANTS against real on-disk source. `read` is
 *  injectable so the T5.1 proof can feed back the real bytes with one real
 *  line removed, without touching the tree. */
export function checkSourceInvariants(invariants = SOURCE_INVARIANTS, read = readIfPresent) {
  const errors = [];
  const seen = {};
  for (const invariant of invariants) {
    const source = seen[invariant.file] ?? (seen[invariant.file] = read(invariant.file));
    if (source == null) {
      errors.push(`${invariant.id}: ${invariant.file} could not be read`);
      continue;
    }
    const shown = invariant.literal ? JSON.stringify(invariant.literal) : String(invariant.marker);
    const found = invariant.literal ? source.includes(invariant.literal) : invariant.marker.test(source);
    // Most invariants pin something that must STAY; `absent` pins something that
    // must not APPEAR. Both are tripwires — the second is the only shape that
    // can catch a rate being added to a file whose arithmetic assumes there
    // isn't one.
    if (invariant.absent && found) {
      errors.push(`${invariant.id}: ${invariant.file} now matches ${shown} — ${invariant.why}`);
    } else if (!invariant.absent && !found) {
      errors.push(`${invariant.id}: ${invariant.file} no longer matches ${shown} — ${invariant.why}`);
    }
  }
  return errors;
}

/**
 * The real repo's usage accounting. Reconciles explicit records when supplied,
 * otherwise reads the durable audit ledger, against the real billing
 * classifiers and price sheet. Ledger damage is a contract error, never an
 * empty-set fallback.
 */
export function checkUsageAccountingContract({
  records,
  ledgerFile = RUN_LEDGER_FILE,
  read = readIfPresent,
  billingClasses = REVIEWED_BILLING_CLASSES,
} = {}) {
  const persisted = records === undefined ? readRunLedger({ file: ledgerFile }) : null;
  const usageRecords = records ?? persisted.records;
  const pricingSource = read(PRICING_FILE) ?? "";
  const providersSource = read(PROVIDERS_FILE) ?? "";
  const roster = parseWatchedModels(pricingSource);

  const errors = [
    ...(persisted?.errors ?? []),
    ...checkSourceInvariants(SOURCE_INVARIANTS, read),
  ];

  const sets = {
    local: parseSetLiteral(providersSource, "LOCAL_PROVIDERS"),
    subscription: parseSetLiteral(providersSource, "SUBSCRIPTION_PROVIDERS"),
  };

  // Membership, not merely non-emptiness. `codex` alone keeps the subscription
  // set populated while every Claude Code run silently becomes billable API
  // usage, so each class is diffed against the reviewed membership in both
  // directions.
  for (const [kind, expected] of Object.entries(billingClasses)) {
    const actual = sets[kind] ?? [];
    const missing = expected.providers.filter((n) => !actual.includes(n));
    const added = actual.filter((n) => !expected.providers.includes(n));
    for (const name of missing) {
      errors.push(`${name}: on record as a ${kind} provider (${expected.reason}) but no longer in ` +
        `${kind.toUpperCase()}_PROVIDERS (${PROVIDERS_FILE}) — its runs would be reconciled as ` +
        `billable API usage. If its billing really changed, update REVIEWED_BILLING_CLASSES`);
    }
    for (const name of added) {
      errors.push(`${name}: is in ${kind.toUpperCase()}_PROVIDERS (${PROVIDERS_FILE}) but is not on ` +
        `record as a ${kind} provider — its runs would stop being priced without a reviewed reason`);
    }
  }

  for (const name of sets.subscription.filter((n) => sets.local.includes(n))) {
    errors.push(`${name}: is in both LOCAL_PROVIDERS and SUBSCRIPTION_PROVIDERS — its billing ` +
      `label is ambiguous`);
  }
  if (!roster.length) errors.push(`${PRICING_FILE}: WATCHED is empty or unparseable — every ` +
    `model would report "unknown" and no cost could ever be reconciled`);

  const { local, subscription } = sets;

  // Which provider loops report cache writes, read off the real loops rather
  // than listed here — a loop that starts reporting them joins the set on its
  // own, and its runs stop being given an upper bound they cannot support.
  //
  // The absence of a marker in a file that was never read is not evidence. One
  // unreadable loop is the dangerous case, not the all-missing one: lose
  // anthropic.js alone and `anthropic` silently drops out of the set, so every
  // anthropic record that omits its cache-write count would be reported as
  // `bounded` on an upper bound nobody proved. So each missing loop is an error
  // AND is assumed to report cache writes, which is the direction that can only
  // withhold a bound, never invent one.
  const loopSources = {};
  const unreadableLoops = [];
  for (const name of PROVIDER_LOOPS) {
    const source = read(`lib/agent/providers/${name}.js`);
    if (source == null) unreadableLoops.push(name);
    else loopSources[name] = source;
  }
  const cacheCreationProviders = parseCacheCreationProviders(loopSources);
  for (const name of unreadableLoops) {
    cacheCreationProviders.add(name);
    errors.push(`lib/agent/providers/${name}.js: could not be read — whether this loop reports ` +
      `cache-creation tokens is unknown, so "${name}" runs that do not state ` +
      `tokens.${CACHE_CREATION_KEY} are treated as unbounded rather than given an upper bound ` +
      `that rests on a file nobody could open`);
  }

  // Same rule as the loops above, for the same reason: a file nobody could open
  // is not evidence that its announces are sound. An unreadable announce file
  // used to drop out of `announceSources` in silence, and the announces that
  // remained kept the "found no provider announce" backstop satisfied — so the
  // billing-flag contract could report green without ever having read
  // wsHandler.js, the file that announces the provider on connect and on every
  // provider SWITCH, which is precisely the case that leaves a paid rate on
  // screen for a provider that is not billed per token. Only llamacpp.js was
  // ever covered, and only incidentally, by its reviewed exemption's own
  // was-not-read check.
  const announceSources = {};
  for (const file of ANNOUNCE_FILES) {
    const source = read(file);
    if (source == null) {
      errors.push(`${file}: could not be read — whether its provider announces carry the billing ` +
        `flags is unknown, so the billing-flag contract cannot be said to hold; a missing announce ` +
        `source is a failure, not a pass`);
      continue;
    }
    announceSources[file] = source;
  }
  errors.push(...checkProviderAnnounces({ sources: announceSources }));

  const reconciled = reconcileUsage({
    records: usageRecords,
    priceLookup: makeRepoPriceLookup({ pricingSource }),
    catalogRoster: roster,
    cacheCreationProviders,
  });

  return {
    ok: errors.length === 0 && reconciled.ok,
    errors: [...errors, ...reconciled.errors],
    billing: { local, subscription },
    cacheCreationProviders: [...cacheCreationProviders],
    ledgerFile: records === undefined ? ledgerFile : null,
    rosterSize: roster.length,
    rows: reconciled.rows,
    totals: reconciled.totals,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkUsageAccountingContract(), null, 2));
}
