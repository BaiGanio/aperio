// lib/docgraph/facts/aggregate.js
// Deterministic reconciliation and aggregation.
//
// This is the module that takes the arithmetic away from the model. Given
// facts, it decides which records describe the same purchase, sums by
// currency and category in integer minor units, and reports what it could not
// resolve. The same input always produces the same output, and no step of it
// depends on a language model being careful.
//
// Deduplication policy, taken from the benchmark's own rules:
//   Equal amounts NEVER establish duplication. Records collapse into one
//   event only when a shared identifier proves it, or when a specific
//   identity tuple — merchant, date, amount, currency, document role —
//   supports the conclusion. A receipt matched to a bank-statement row has no
//   shared transaction identifier, so it is recorded as an ADJUDICATED match
//   carrying its evidence and its uncertainty, never as a joined identity.

import { FACT_LIMITS, merchantTokens, sharedMerchantTokens } from "./contract.js";
import { fromMinor, sumMinor } from "./money.js";

const UNCATEGORIZED = "Uncategorized";

/**
 * Collapse facts that describe the same economic event.
 *
 * @param {Array<object>} facts
 * @returns {{facts: Array<object>, duplicates: Array<object>, conflicts: Array<object>}}
 *   `facts` keeps one record per event; `duplicates` explains every merge;
 *   `conflicts` reports searches abandoned at the candidate bound.
 */
export function reconcileFacts(facts) {
  const kept = [...(facts ?? [])];
  const duplicates = [];
  const conflicts = [];
  const dropped = new Set();

  // ── Pass 1: shared identifier ──────────────────────────────────────────
  // An invoice number that appears on the .txt bill, the .html e-invoice and
  // the .eml reminder is three representations of one charge. This is the
  // only merge that needs no adjudication: the documents say so themselves.
  const byIdentifier = new Map();
  for (const [index, fact] of kept.entries()) {
    for (const [key, value] of Object.entries(fact.source_locators ?? {})) {
      if (!value) continue;
      const id = `${key}:${String(value).toLowerCase()}|${fact.currency}|${fact.amount_minor}`;
      if (!byIdentifier.has(id)) { byIdentifier.set(id, index); continue; }
      const primaryIndex = byIdentifier.get(id);
      if (dropped.has(index) || primaryIndex === index) continue;
      dropped.add(index);
      duplicates.push({
        kept: describe(kept[primaryIndex]),
        dropped: describe(fact),
        basis: "shared_identifier",
        evidence: [`${key} = ${value}`, `same amount ${fact.amount} ${fact.currency}`],
        confidence: "high",
      });
    }
  }

  // ── Pass 2: adjudicated duplicate representations ──────────────────────
  // Two records can describe one charge with no identifier in common:
  //   • a card purchase leaves a receipt AND a bank-statement row;
  //   • a payment order settles an invoice that also exists on its own.
  // Only such a secondary record may be matched against a charge document —
  // never two statement rows (a bank does not print a purchase twice), never
  // two payment orders, and never two charge documents (two receipts for the
  // same amount are two purchases; the corpus contains exactly that trap,
  // same merchant and same card).
  //
  // Candidates are looked up through an index rather than by scanning every
  // charge document per secondary record. Each required condition that is an
  // equality — currency, amount, category, and the date or period window — is
  // part of the key, so a non-matching corpus costs one failed lookup per
  // record instead of a full pass over the other side.
  const index = buildCandidateIndex(kept, dropped);

  for (const [i, secondary] of kept.entries()) {
    if (dropped.has(i) || !SECONDARY_KINDS.has(secondary.evidence_kind)) continue;

    let matched = null;
    let examined = 0;
    for (const candidate of candidatesFor(index, secondary)) {
      if (dropped.has(candidate.i)) continue;
      if (examined >= FACT_LIMITS.maxDedupCandidates) {
        // A bucket this crowded means thousands of charges share an amount,
        // a category and a date. Report the abandoned search instead of
        // scanning without limit or dropping the record silently.
        conflicts.push({
          kind: "duplicate_search_truncated",
          document: secondary.document, locator: secondary.locator,
          detail: `stopped after ${examined} candidates sharing ${secondary.amount} ${secondary.currency} / ${secondary.category}`,
        });
        break;
      }
      examined++;
      const verdict = adjudicate(secondary, candidate.f);
      if (verdict.matched) { matched = { ...candidate, ...verdict }; break; }
    }
    if (!matched) continue;

    // The charge document is kept: it carries the provider, the identifiers
    // and the dates. The secondary record is the thinner of the two.
    dropped.add(i);
    duplicates.push({
      kept: describe(matched.f),
      dropped: describe(secondary),
      basis: "adjudicated",
      evidence: matched.evidence,
      confidence: matched.confidence,
      uncertainty: secondary.evidence_kind === "payment_order"
        ? "a payment order and the invoice it settles share no transaction identifier; matched on identity evidence"
        : "no shared transaction identifier links a receipt to a statement row; matched on identity evidence",
    });
  }

  return { facts: kept.filter((_, i) => !dropped.has(i)), duplicates, conflicts };
}

/** Record kinds that may be a duplicate representation of a charge that is
 *  also evidenced by a charge document of its own. */
const SECONDARY_KINDS = new Set(["statement_row", "payment_order"]);

/**
 * Index charge documents by every equality a match requires. Two keyings,
 * because the two pairings differ in how far apart the records may sit: a
 * statement posts within days of the purchase, while a payment order can
 * settle an invoice weeks later, anywhere inside the charge's own month.
 */
function buildCandidateIndex(facts, dropped) {
  const byDay = new Map();
  const byPeriod = new Map();

  for (const [i, fact] of facts.entries()) {
    if (dropped.has(i) || SECONDARY_KINDS.has(fact.evidence_kind)) continue;
    // A match requires a resolved category on both sides, so a fact without
    // one can never be a candidate and is left out of the index entirely.
    if (!fact.category) continue;
    const entry = { f: fact, i };
    if (fact.assignment_date) push(byDay, dayKey(fact, fact.assignment_date), entry);
    push(byPeriod, periodKey(fact), entry);
  }
  return { byDay, byPeriod };
}

/** The bounded candidate set for one secondary record. */
function* candidatesFor(index, secondary) {
  if (!secondary.category) return;

  if (secondary.evidence_kind === "payment_order") {
    yield* index.byPeriod.get(periodKey(secondary)) ?? [];
    return;
  }

  // A statement row: probe each day inside the allowed posting window.
  if (!secondary.assignment_date) return;
  const seen = new Set();
  for (let offset = -FACT_LIMITS.dedupDateSkewDays; offset <= FACT_LIMITS.dedupDateSkewDays; offset++) {
    for (const candidate of index.byDay.get(dayKey(secondary, shiftDays(secondary.assignment_date, offset))) ?? []) {
      if (seen.has(candidate.i)) continue;
      seen.add(candidate.i);
      yield candidate;
    }
  }
}

function push(map, key, entry) {
  const bucket = map.get(key);
  if (bucket) bucket.push(entry);
  else map.set(key, [entry]);
}

const dayKey = (fact, date) => `${fact.currency}|${fact.amount_minor}|${fact.category}|${date}`;
const periodKey = (fact) => `${fact.currency}|${fact.amount_minor}|${fact.category}|${fact.period}`;

/** "2026-06-09" shifted by whole days, in UTC. */
function shiftDays(date, days) {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) return date;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Does a secondary record describe the same charge as a charge document?
 * Every condition is required. Merchant overlap is required whenever both
 * sides expose merchant text — dropping it would leave amount+date+category,
 * which is exactly the "equal amounts establish duplication" shortcut the
 * policy forbids.
 */
function adjudicate(row, doc) {
  const evidence = [];
  if (row.currency !== doc.currency) return { matched: false, evidence };
  if (row.amount_minor !== doc.amount_minor) return { matched: false, evidence };
  evidence.push(`same amount ${doc.amount} ${doc.currency}`);

  if (row.evidence_kind === "payment_order") {
    // A payment settles its invoice whenever the terms allow, so the day
    // window that fits a card posting is far too tight here; what must hold
    // is that both records place the charge in the same month.
    if (!row.period || row.period !== doc.period) return { matched: false, evidence };
    evidence.push(`settles a charge in the same period ${doc.period}`);
  } else {
    const skew = daysBetween(row.assignment_date, doc.assignment_date);
    if (skew == null || skew > FACT_LIMITS.dedupDateSkewDays) return { matched: false, evidence };
    evidence.push(skew === 0 ? `same date ${doc.assignment_date}` : `dates ${skew} day(s) apart`);
  }

  if (!row.category || !doc.category || row.category !== doc.category) return { matched: false, evidence };
  evidence.push(`same category ${doc.category}`);

  const rowTokens = merchantTokens(`${row.merchant ?? ""} ${row.description ?? ""}`);
  const docTokens = merchantTokens(`${doc.merchant ?? ""} ${doc.document ?? ""} ${doc.description ?? ""}`);
  const shared = sharedMerchantTokens(rowTokens, docTokens);
  if (rowTokens.length && docTokens.length) {
    if (!shared.length) return { matched: false, evidence };
    evidence.push(`merchant overlap: ${shared.map(s => s.exact ? s.token : `${s.token}≈${s.other}`).join(", ")}`);
    // A match resting only on transliteration-variant tokens is real evidence
    // but weaker than an exact one, and is flagged for review.
    const exact = shared.some(s => s.exact);
    return { matched: true, evidence, confidence: exact ? "adjudicated" : "adjudicated_weak" };
  }

  // One side named no merchant at all. The remaining evidence is real but
  // thinner, so the match is flagged for review rather than presented as
  // settled.
  evidence.push("merchant evidence unavailable on one side");
  return { matched: true, evidence, confidence: "adjudicated_weak" };
}

/**
 * Totals by currency and category.
 *
 * Currencies are never merged and no exchange rate is ever invented: each
 * currency reports its own total. A fact whose category could not be resolved
 * still counts toward its currency total under `Uncategorized` — a charge you
 * cannot name is still money spent, and silently dropping it is the failure
 * mode this pipeline exists to prevent.
 *
 * @param {Array<object>} facts
 * @param {{period?: string|null, baseCurrency?: string|null, excluded?: Array<object>,
 *          documentsSeen?: number}} [opts]
 */
export function aggregateFacts(facts, opts = {}) {
  const { period = null, baseCurrency = null, excluded = [], documentsSeen = null } = opts;

  const outOfPeriod = [];
  const inPeriod = [];
  for (const fact of facts ?? []) {
    if (period && fact.period !== period) {
      outOfPeriod.push({ document: fact.document, locator: fact.locator, reason: "out_of_period", detail: `period ${fact.period}` });
      continue;
    }
    inPeriod.push(fact);
  }

  const { facts: reconciled, duplicates, conflicts } = reconcileFacts(inPeriod);

  const byCurrency = {};
  for (const fact of reconciled) {
    const bucket = (byCurrency[fact.currency] ??= { total: 0, total_minor: 0, by_category: {}, facts: 0 });
    const category = fact.category ?? UNCATEGORIZED;
    (bucket.by_category[category] ??= { total: 0, total_minor: 0, facts: [] }).facts.push(minorRef(fact));
    bucket.facts++;
  }

  for (const [currency, bucket] of Object.entries(byCurrency)) {
    for (const entry of Object.values(bucket.by_category)) {
      entry.total_minor = sumMinor(entry.facts.map(f => f.amount_minor));
      entry.total = round(fromMinor(entry.total_minor, currency));
    }
    bucket.total_minor = sumMinor(Object.values(bucket.by_category).map(c => c.total_minor));
    bucket.total = round(fromMinor(bucket.total_minor, currency));
  }

  // Anything the pipeline could not settle, surfaced rather than averaged in.
  const review = [
    ...duplicates.filter(d => d.confidence === "adjudicated_weak").map(d => ({ kind: "weak_duplicate_match", ...d })),
    ...(conflicts ?? []),
  ];

  return {
    period,
    base_currency: baseCurrency,
    by_currency: sortKeys(byCurrency, baseCurrency),
    duplicates,
    excluded: [...excluded, ...outOfPeriod],
    review,
    coverage: {
      documents_seen: documentsSeen,
      facts_extracted: (facts ?? []).length,
      facts_in_period: inPeriod.length,
      facts_counted: reconciled.length,
      duplicates_merged: duplicates.length,
      excluded: excluded.length + outOfPeriod.length,
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function minorRef(fact) {
  return {
    document: fact.document,
    locator: fact.locator,
    amount: fact.amount,
    amount_minor: fact.amount_minor,
    merchant: fact.merchant,
    date: fact.assignment_date,
    evidence_kind: fact.evidence_kind,
    payment_status: fact.payment_status,
    confidence: fact.confidence,
  };
}

function describe(fact) {
  return {
    document: fact.document, locator: fact.locator,
    amount: fact.amount, currency: fact.currency,
    date: fact.assignment_date, evidence_kind: fact.evidence_kind,
  };
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const first = Date.parse(`${a}T00:00:00Z`);
  const second = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(second)) return null;
  return Math.abs(first - second) / 86_400_000;
}

/** Deterministic key order: the base currency first, then alphabetical. */
function sortKeys(byCurrency, baseCurrency) {
  const keys = Object.keys(byCurrency).sort((a, b) => {
    if (a === baseCurrency) return -1;
    if (b === baseCurrency) return 1;
    return a.localeCompare(b);
  });
  const out = {};
  for (const key of keys) {
    const bucket = byCurrency[key];
    const categories = Object.keys(bucket.by_category).sort();
    const sortedCategories = {};
    for (const category of categories) sortedCategories[category] = bucket.by_category[category];
    out[key] = { ...bucket, by_category: sortedCategories };
  }
  return out;
}

function round(value) {
  return value == null ? null : Math.round(value * 1e6) / 1e6;
}
