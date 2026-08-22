// Validates the oracle against the corpus on disk.
//
//   node tests/fixtures/household-gen/validate-oracle.mjs
//
// Exits non-zero on any failure. This is the check that makes the oracle worth
// trusting: every number it declares is re-derived in integer minor units and,
// where the document is plain text, located verbatim inside the document that is
// supposed to prove it.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { money, periodOf } from "./money.mjs";

const HOUSEHOLD = process.env.HOUSEHOLD_ROOT ?? "/Users/lk/Projects/household";
const ORACLE = resolve(import.meta.dirname, "ground-truth.json");

const failures = [];
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
}

const oracle = JSON.parse(await readFile(ORACLE, "utf8"));
const cents = value => Math.round(value * 100);

// --- corpus inventory ------------------------------------------------------
async function walk(dir, prefix = "") {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

const onDisk = new Set(await walk(HOUSEHOLD));
const declared = new Map();
for (const disposition of oracle.dispositions) {
  if (declared.has(disposition.document)) {
    failures.push(`duplicate disposition for ${disposition.document}`);
  }
  declared.set(disposition.document, disposition);
}

check("every corpus file has exactly one disposition", true);
const undeclared = [...onDisk].filter(path => !declared.has(path));
check("no undeclared corpus files", undeclared.length === 0, `${undeclared.length}: ${undeclared.slice(0, 6).join(", ")}`);
const phantom = [...declared.keys()].filter(path => !onDisk.has(path));
check("no dispositions for missing files", phantom.length === 0, `${phantom.length}: ${phantom.slice(0, 6).join(", ")}`);

check("oracle is not inside the model-readable corpus", !onDisk.has("ground-truth.json"),
  "an oracle file exists in the household folder — that is the answer key sitting in the model's own workspace");

check("PNG documents are marked non-indexable",
  oracle.dispositions.filter(entry => entry.format === "png").every(entry => entry.docgraph_indexable === false),
  "a .png disposition claims docgraph can index it; docgraph's extractor table has no png entry");

// --- arithmetic ------------------------------------------------------------
let grandTotalAllPeriods = 0;
for (const [period, data] of Object.entries(oracle.periods)) {
  const byCategory = new Map();
  for (const event of data.included_events) {
    byCategory.set(event.category, (byCategory.get(event.category) ?? 0) + cents(event.amount_bgn));
  }
  for (const [category, declaredTotal] of Object.entries(data.category_totals_bgn)) {
    const recomputed = byCategory.get(category) ?? 0;
    check(`${period} ${category} total re-derives`, recomputed === cents(declaredTotal),
      `declared ${declaredTotal}, events sum to ${recomputed / 100}`);
  }
  const missingCategories = [...byCategory.keys()].filter(category => !(category in data.category_totals_bgn));
  check(`${period} no category is silently omitted`, missingCategories.length === 0, missingCategories.join(", "));

  const sumOfCategories = [...byCategory.values()].reduce((total, value) => total + value, 0);
  check(`${period} monthly total equals the sum of its categories`,
    sumOfCategories === cents(data.monthly_total_bgn),
    `categories ${sumOfCategories / 100} vs monthly_total ${data.monthly_total_bgn}`);
  grandTotalAllPeriods += sumOfCategories;

  // Period assignment: an event belongs to the month of its own document date.
  for (const event of data.included_events) {
    check(`${event.id} sits in the period of its document date`,
      periodOf(event.document_date) === period,
      `document_date ${event.document_date} but filed under ${period}`);
  }

  // Every included event must be evidenced by at least one real document.
  for (const event of data.included_events) {
    const live = event.source_documents.filter(path => onDisk.has(path));
    check(`${event.id} has a live source document`, live.length > 0,
      `none of ${event.source_documents.join(", ")} exists`);
    check(`${event.id} primary document is one of its sources`,
      event.source_documents.includes(event.primary_document));
  }

  // Deduplication integrity.
  const eventIds = new Set(data.included_events.concat(data.excluded_events.map(entry => ({ id: entry.id }))).map(event => event.id));
  for (const group of data.deduplication_groups) {
    if (group.canonical_event) {
      check(`${group.id} canonical event exists`, eventIds.has(group.canonical_event), group.canonical_event);
    }
    check(`${group.id} has at least two records`, group.records.length >= 2);
    const nonAmountBasis = group.match_basis.filter(basis => !/^same amount/i.test(basis));
    check(`${group.id} is not amount-only`, nonAmountBasis.length > 0,
      `match_basis is ${JSON.stringify(group.match_basis)} — equal amounts alone never establish duplication`);
    if (group.kind === "transaction") {
      check(`${group.id} adjudicated matches are labelled as such`,
        group.verification_status === "adjudicated",
        "a receipt/statement match has no shared transaction identifier and must be recorded as adjudicated");
    }
  }

  // Distinct events that merely share an amount must never share a group.
  const byAmount = new Map();
  for (const event of data.included_events) {
    const key = event.amount_bgn;
    byAmount.set(key, (byAmount.get(key) ?? []).concat(event));
  }
  for (const [amount, group] of byAmount) {
    if (group.length < 2) continue;
    const groups = group.map(event => event.deduplication_group).filter(Boolean);
    check(`${period} equal amounts (${amount}) are not merged`,
      new Set(groups).size === groups.length,
      `${group.map(event => event.id).join(" and ")} share a deduplication group despite being distinct events`);
  }

  // Duplicate representations must point back at their event.
  for (const [path, disposition] of declared) {
    if (disposition.period !== period || disposition.disposition !== "duplicate_representation") continue;
    if (!disposition.event) {
      // A duplicate of a supporting-evidence document (a statement re-exported as
      // PDF) has no event of its own, but it must still say what it duplicates.
      check(`${path} names the document it duplicates`,
        Boolean(disposition.duplicates_document) && onDisk.has(disposition.duplicates_document),
        `duplicates_document is ${JSON.stringify(disposition.duplicates_document ?? null)}`);
      continue;
    }
    const event = data.included_events.concat(data.excluded_events).find(candidate => candidate.id === disposition.event);
    check(`${path} maps to one event`, Boolean(event), `event ${disposition.event} not found in ${period}`);
    if (event?.source_documents) {
      check(`${path} is listed on its event`, event.source_documents.includes(path));
    }
  }
}

check("year totals re-derive from the periods",
  cents(Object.values(oracle.totals_by_year_bgn).reduce((total, value) => total + value, 0)) === grandTotalAllPeriods,
  `${Object.values(oracle.totals_by_year_bgn).reduce((total, value) => total + value, 0)} vs ${grandTotalAllPeriods / 100}`);

// --- the frozen June gate --------------------------------------------------
const FROZEN_JUNE = { Utilities: 260.5, Fuel: 215.6, Groceries: 140.75, Transport: 50, Internet: 29.99 };
const june = oracle.periods["2026-06"];
for (const [category, expected] of Object.entries(FROZEN_JUNE)) {
  check(`June 2026 ${category} is unchanged at ${expected}`, june.category_totals_bgn[category] === expected,
    `got ${june.category_totals_bgn[category]}`);
}
check("June 2026 total is unchanged at 696.84", june.monthly_total_bgn === 696.84, `got ${june.monthly_total_bgn}`);
check("June 2026 reports exactly the five gate categories",
  Object.keys(june.category_totals_bgn).length === 5, Object.keys(june.category_totals_bgn).join(", "));

// June's statement must remain a near-collision distractor, not the answer.
check("June statement total stays 0.25 BGN off the Utilities total",
  cents(june.bank_statement.total_debits_bgn) - cents(june.category_totals_bgn.Utilities) === 25,
  `${june.bank_statement.total_debits_bgn} vs ${june.category_totals_bgn.Utilities}`);
check("June statement on/off reconciliation holds",
  cents(june.bank_statement.total_debits_bgn) + cents(june.bank_statement.off_statement_total_bgn) === cents(june.monthly_total_bgn),
  june.bank_statement.reconciliation);

// --- documents prove their own numbers ------------------------------------
// Any plain-text primary document must literally contain the amount the oracle
// claims for it. A hand-edit to a frozen file fails here instead of drifting.
let proved = 0;
let unproved = [];
for (const [period, data] of Object.entries(oracle.periods)) {
  for (const event of data.included_events) {
    const path = event.primary_document;
    if (!path.endsWith(".txt") || !onDisk.has(path)) continue;
    const text = await readFile(join(HOUSEHOLD, path), "utf8");
    const magnitude = Math.abs(cents(event.amount_bgn));
    const bgForm = money(magnitude, "bg");
    const enForm = money(magnitude, "en");
    if (text.includes(bgForm) || text.includes(enForm)) proved += 1;
    else unproved.push(`${path} does not contain ${bgForm} (${period} ${event.id})`);
  }
}
check("every plain-text source document contains its own declared amount",
  unproved.length === 0, unproved.slice(0, 8).join("; "));

// --- fixture sets ----------------------------------------------------------
for (const [name, fixture] of Object.entries(oracle.fixture_sets)) {
  for (const path of fixture.primary_paths.concat(fixture.secondary_paths)) {
    let ok = onDisk.has(path);
    if (!ok) {
      try { ok = (await stat(join(HOUSEHOLD, path))).isDirectory(); } catch { ok = false; }
    }
    check(`fixture set ${name} path exists: ${path}`, ok);
  }
}
const tr5 = oracle.fixture_sets["T-R5"];
check("T-R5 fixture set is single-period",
  tr5.primary_paths.every(path => !/^20\d\d\/[A-Z]/.test(path) || path === "2026/June"),
  `${tr5.primary_paths.join(", ")} — a multi-month fixture set makes an 'out of period' gate meaningless`);
check("T-R5 expectations match the June period block",
  JSON.stringify(tr5.expected.category_totals_bgn) === JSON.stringify(june.category_totals_bgn)
  && tr5.expected.monthly_total_bgn === june.monthly_total_bgn);

// --- report ---------------------------------------------------------------
const passed = checks.filter(entry => entry.ok).length;
console.log(`${passed}/${checks.length} checks passed over ${onDisk.size} corpus files and ${Object.keys(oracle.periods).length} periods`);
console.log(`${proved} plain-text documents proved their own amount`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures.slice(0, 40)) console.error(`  - ${failure}`);
  if (failures.length > 40) console.error(`  … and ${failures.length - 40} more`);
  process.exit(1);
}
console.log("oracle validates against the corpus on disk");
