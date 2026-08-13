// The T-R5 gate, as pure functions.
//
// The gate this replaces tested bare numeral presence (/260\.50?/ anywhere in the
// answer). That proves almost nothing: `50.00` occurs in unrelated document text,
// and a right number under the wrong category passed. These functions instead
// associate every claimed figure with the category it was claimed for, and check
// exclusions, coverage and the known failure signatures.
//
// Kept separate from the harness so the mutation tests can exercise it without
// booting an app, an llama-server or a database.

/** Money tokens: 1 234,56 / 1,234.56 / 260.50 / -34,20. */
const MONEY = /-?\d{1,3}(?:[  ,.]\d{3})*[.,]\d{2}(?!\d)|-?\d+[.,]\d{2}(?!\d)/g;

/** Normalise a printed money token to a Number. */
export function parseMoney(token) {
  const text = String(token).trim();
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const decimalAt = Math.max(lastComma, lastDot);
  const whole = text.slice(0, decimalAt).replace(/[^\d-]/g, "");
  const fraction = text.slice(decimalAt + 1).replace(/\D/g, "");
  const value = Number(`${whole}.${fraction}`);
  return Number.isFinite(value) ? value : null;
}

export function moneyTokens(text) {
  return [...String(text).matchAll(MONEY)].map(match => parseMoney(match[0])).filter(value => value !== null);
}

// Category synonyms, English and Bulgarian. A model answering in either language
// must be gradable; a model inventing its own label is not silently credited.
const SYNONYMS = {
  Utilities: [/utilit/i, /комунал/i, /битови сметки/i, /сметки за дома/i],
  Internet: [/internet/i, /интернет/i],
  Fuel: [/fuel/i, /petrol/i, /diesel/i, /горив/i, /бензин/i, /дизел/i],
  Groceries: [/grocer/i, /supermarket/i, /food/i, /хранителни/i, /храни/i, /продукти/i],
  Transport: [/transport/i, /transit/i, /metro card/i, /транспорт/i],
  Health: [/health/i, /pharmac/i, /здраве/i, /аптек/i],
  Dining: [/dining/i, /restaurant/i, /ресторант/i],
  Shopping: [/shopping/i, /clothing/i, /облекло/i, /покупки/i],
  Vehicle: [/vehicle/i, /car service/i, /tyre/i, /автосервиз/i, /гуми/i],
  Insurance: [/insurance/i, /застрахов/i],
  Mobile: [/mobile/i, /prepaid/i, /мобил/i],
};

const TOTAL_CUES = [/\btotal\b/i, /\bsum\b/i, /\ball categories\b/i, /общо/i, /общa сума/i, /сума за/i, /grand total/i];

// A currency code/symbol adjacent to a money token, so a total-cue line's own
// currencies can be counted without re-parsing every money token in the answer.
const CURRENCY_TAG = /\b(?:BGN|EUR|USD|GBP)\b|лв\.?|€|(?<![A-Za-z])\$|£/gi;

// Language the DeepSeek pass used to explicitly decline a blend ("I'm not
// combining the two currencies into one number...") — a line saying it will
// NOT combine currencies is the honest behaviour T-G2.4 asks for, not a leak.
// Also covers the gemma4 2026-08-13 phrasing ("there is no single grand
// total; the totals are provided per currency") — a denial that any single
// combined figure exists is the same disclosure, just worded as an absence
// rather than a refusal.
const NON_BLEND_DISCLOSURE = /not combin|not merging|kept separate|haven'?t (?:been asked|converted)|without (?:an?|)\s*(?:fx|exchange|conversion)|no (?:fx|exchange|conversion)|no single (?:grand )?total|no (?:combined|blended|merged) total/i;

// Markdown emphasis, brackets and whitespace may sit between a figure and its
// own currency tag ("**912.44** BGN", "196.40 EUR**"); letters and digits may
// not, so "893.24 across BGN and EUR" never counts as tagged.
const PAIR_GAP = "[\\s*_`~()\\[\\]]*";
const CURRENCY_SRC = "(?:\\b(?:BGN|EUR|USD|GBP)\\b|лв\\.?|€|\\$|£)";

/**
 * Money tokens on a line that carry no currency tag of their own — the figures
 * a reader cannot assign to one currency. "912.44 BGN + 196.40 EUR" has none;
 * "893.24 (696.84 BGN + 196.40 EUR)" has one, and it is the blended figure.
 */
function untaggedMoneyTokens(line) {
  const before = new RegExp(`${CURRENCY_SRC}${PAIR_GAP}$`, "i");
  const after = new RegExp(`^${PAIR_GAP}${CURRENCY_SRC}`, "i");
  return [...String(line).matchAll(MONEY)].filter(match => {
    const start = match.index;
    const end = start + match[0].length;
    return !after.test(line.slice(end)) && !before.test(line.slice(0, start));
  });
}

/**
 * A total-cue line that tags two or more distinct currencies is either an
 * honest per-currency report (allowed) or an undisclosed single figure computed
 * by adding amounts across currencies — exactly the "893.24 (696.84 BGN +
 * 196.40 EUR)" pattern a hero-model run produced while a *separate*, correct
 * BGN-only total line also existed elsewhere in the same answer. A permissive
 * "does any total line match?" check credits the correct line and never notices
 * the extra, wrong one — this is the one place that must be exclusive: any
 * offending line fails the gate regardless of what else it says.
 *
 * 2026-08-13: naming two currencies was the whole test, which made every
 * per-currency total a failure. Round 11 failed
 * `"**Overall Combined Total:** **912.44 BGN + 196.40 EUR**"` — two figures,
 * one per currency, with "(Note: No FX conversion was applied…)" on the very
 * next line — because the rule saw two currency tags and stopped looking. A
 * blend is a *figure* that spans currencies, not a line that mentions two, so
 * the line only fails when some figure on it carries no currency of its own.
 * Blending stays a failure even when disclosed one line later: the wrong number
 * is still stated. The same-line NON_BLEND_DISCLOSURE escape is kept for prose
 * that names currencies without tagging a figure at all ("no single grand
 * total; the totals are provided per currency").
 */
function currencyBlendedTotalLines(text) {
  return text.split(/\r?\n/).filter(line => {
    if (!TOTAL_CUES.some(cue => cue.test(line))) return false;
    if (NON_BLEND_DISCLOSURE.test(line)) return false;
    const distinctCurrencies = new Set([...line.matchAll(CURRENCY_TAG)].map(m => m[0].toUpperCase().replace("ЛВ.", "BGN").replace("ЛВ", "BGN")));
    if (distinctCurrencies.size < 2) return false;
    return untaggedMoneyTokens(line).length > 0;
  });
}

/**
 * Which figures did the answer attach to which category?
 * Same-line association only, with one narrow fallback: a category heading whose
 * own line carries no figure may take the next line's figure, provided that line
 * names no other category.
 */
export function parseCategoryClaims(answer) {
  const lines = String(answer).split(/\r?\n/);
  const claims = new Map();
  const categoriesOn = line => Object.entries(SYNONYMS)
    .filter(([, patterns]) => patterns.some(pattern => pattern.test(line)))
    .map(([category]) => category);

  lines.forEach((line, index) => {
    const named = categoriesOn(line);
    if (named.length === 0) return;
    let values = moneyTokens(line);
    if (values.length === 0) {
      const next = lines[index + 1] ?? "";
      if (categoriesOn(next).length === 0) values = moneyTokens(next);
    }
    if (values.length === 0) return;
    // A line naming exactly one category attributes all its figures to it; a line
    // naming several is ambiguous and attributes to none.
    if (named.length !== 1) return;
    const [category] = named;
    claims.set(category, (claims.get(category) ?? []).concat(values));
  });
  return claims;
}

/** Figures the answer presents as a grand total (on a total-cue line). */
export function parseGrandTotals(answer) {
  return String(answer)
    .split(/\r?\n/)
    .filter(line => TOTAL_CUES.some(cue => cue.test(line)))
    .flatMap(line => moneyTokens(line));
}

/** Path-like strings the model's tool calls actually touched. */
export function documentsTouched(toolCalls = []) {
  const seen = new Set();
  for (const call of toolCalls) {
    const blob = `${JSON.stringify(call.arguments ?? {})} ${String(call.summary ?? "")}`;
    for (const match of blob.matchAll(/[\w./-]+\.(?:txt|pdf|docx|xlsx|html|eml|png|md)/gi)) {
      seen.add(match[0].split("/").pop().toLowerCase());
    }
  }
  return seen;
}

const RETRIEVAL_TOOLS = ["doc_repos", "doc_manifest", "doc_batch", "doc_search", "doc_context"];

/**
 * Evaluate one answer against one period of the oracle.
 *
 * `expectations` is built by buildExpectations() below so the harness and the
 * mutation tests share exactly one definition of "correct".
 */
export function evaluateAnswer({ answer = "", toolSequence = [], toolCalls = [], expectations }) {
  const text = String(answer);
  const claims = parseCategoryClaims(text);
  const grandTotals = parseGrandTotals(text);
  const allValues = moneyTokens(text);
  const failures = [];

  const categoryResults = {};
  for (const [category, expected] of Object.entries(expectations.categoryTotals)) {
    const found = claims.get(category) ?? [];
    const ok = found.some(value => Math.abs(value - expected) < 0.005);
    categoryResults[category] = { expected, found, ok };
    if (!ok) {
      failures.push(found.length
        ? `${category}: expected ${expected.toFixed(2)}, answer attributed ${found.map(value => value.toFixed(2)).join("/")}`
        : `${category}: expected ${expected.toFixed(2)}, answer attributed no figure to this category`);
    }
  }

  const correctTotalPresent = grandTotals.some(value => Math.abs(value - expectations.monthlyTotal) < 0.005);
  if (!correctTotalPresent) {
    failures.push(`grand total: expected ${expectations.monthlyTotal.toFixed(2)} on a total line, saw ${grandTotals.map(value => value.toFixed(2)).join("/") || "no total line"}`);
  }
  const blendedLines = currencyBlendedTotalLines(text);
  for (const line of blendedLines) {
    failures.push(`grand total: a total-cue line combines multiple currencies into one figure without disclosing that it isn't converting — "${line.trim().slice(0, 120)}"`);
  }
  // Exclusive, not permissive: a correct BGN-only total line existing elsewhere
  // in the answer does not excuse a second, blended total line stated alongside it.
  const grandTotalOk = correctTotalPresent && blendedLines.length === 0;

  // Failure signatures with a known cause.
  const signatures = {};
  for (const [name, signature] of Object.entries(expectations.signatures)) {
    const hit = allValues.some(value => Math.abs(value - signature.value) < 0.005);
    signatures[name] = { value: signature.value, hit, means: signature.means };
    if (hit) failures.push(`${name}: ${signature.value.toFixed(2)} appears in the answer — ${signature.means}`);
  }

  // Excluded documents must not be reported as household spending. Prose that
  // *names* an excluded item while explaining the exclusion is correct behaviour,
  // so a leak is only counted when the figure sits on a line claiming a category.
  const leaks = [];
  const lines = text.split(/\r?\n/);
  for (const excluded of expectations.excluded) {
    for (const line of lines) {
      if (!moneyTokens(line).some(value => Math.abs(value - excluded.amount) < 0.005)) continue;
      const named = Object.entries(SYNONYMS).filter(([, patterns]) => patterns.some(pattern => pattern.test(line)));
      const exclusionCue = /exclud|not included|outside|ignored|separate|excluded|не са включени|извън/i.test(line);
      if (named.length > 0 && !exclusionCue) {
        leaks.push({ document: excluded.document, amount: excluded.amount, currency: excluded.currency, line: line.trim().slice(0, 120), kind: excluded.kind });
      }
    }
  }
  for (const leak of leaks) {
    failures.push(`${leak.kind} leak: ${leak.amount} ${leak.currency} (${leak.document}) reported under a spending category — "${leak.line}"`);
  }

  // Coverage: every included event must have been reached through at least one of
  // its own documents, or through the statement row that evidences it. PNG scans
  // are not docgraph-indexable, so retrieval alone can never reach a scan-only
  // purchase — the statement is its legitimate route.
  const touched = documentsTouched(toolCalls);
  const uncovered = [];
  for (const event of expectations.coverage) {
    const routes = event.routes.map(path => path.split("/").pop().toLowerCase());
    if (!routes.some(route => touched.has(route))) uncovered.push(event.id);
  }
  if (uncovered.length) failures.push(`coverage: no document was read for ${uncovered.join(", ")}`);

  const invokedRetrieval = toolSequence.some(name => RETRIEVAL_TOOLS.includes(name));
  if (!invokedRetrieval) failures.push("retrieval was never invoked; no document tool appears in the tool sequence");

  const oracleExposed = /ground[- ]truth|oracle|answer key/i.test(text);
  if (oracleExposed) failures.push("the answer references the oracle");

  const fenceBroken = text.includes(expectations.corpusRoot);
  if (fenceBroken) failures.push(`the answer leaks the private corpus path ${expectations.corpusRoot}`);

  const gate = {
    invokedRetrieval,
    categories: Object.fromEntries(Object.entries(categoryResults).map(([category, result]) => [category, result.ok])),
    grandTotalCorrect: grandTotalOk,
    noFailureSignatures: Object.values(signatures).every(signature => !signature.hit),
    noExcludedLeak: leaks.length === 0,
    fullCoverage: uncovered.length === 0,
    noOracleExposure: !oracleExposed,
    cleanCorpusFence: !fenceBroken,
  };

  const flat = [
    gate.invokedRetrieval, gate.grandTotalCorrect, gate.noFailureSignatures,
    gate.noExcludedLeak, gate.fullCoverage, gate.noOracleExposure, gate.cleanCorpusFence,
    ...Object.values(gate.categories),
  ];

  return {
    status: flat.every(Boolean) ? "pass" : "fail",
    gate,
    detail: { categories: categoryResults, grandTotals, signatures, leaks, uncovered },
    failures,
  };
}

/** Derive everything the gate needs from the oracle, for one period. */
export function buildExpectations(oracle, period, { corpusRoot }) {
  const data = oracle.periods[period];
  if (!data) throw new Error(`oracle has no period ${period}`);
  const statement = data.bank_statement;
  const signatures = {};
  // A receipt that also appears as a statement row, counted twice, produces
  // exactly double its amount. Derived from the oracle's own dedup groups rather
  // than hardcoded, so the signature follows the corpus.
  for (const group of data.deduplication_groups) {
    if (group.kind !== "transaction" || !group.count_once_bgn) continue;
    const event = data.included_events.find(candidate => candidate.id === group.canonical_event);
    if (!event) continue;
    // Keyed by amount as well as category: a month can have several overlapping
    // payments in one category, and a shared key silently dropped all but the last.
    signatures[`${event.category.toLowerCase()}DoubleCounted_${group.count_once_bgn.toFixed(2)}`] = {
      value: Number((group.count_once_bgn * 2).toFixed(2)),
      means: `the bank-statement row and the receipt for the same ${event.category} payment (${group.count_once_bgn.toFixed(2)}) were counted as two payments`,
    };
  }
  if (statement?.total_debits_bgn) {
    signatures.statementShortcut = {
      value: statement.total_debits_bgn,
      means: "this is the statement's own total debits — the answer came from reading only the statement",
    };
  }
  // Non-BGN spending the corpus declares in its own currency. The oracle keeps
  // it out of the BGN totals but still states it (policy.currency: "Per-currency
  // totals only ... reported separately"), and until now nothing derived from it
  // — so a run could attribute the whole EUR total to a category the corpus
  // never assigned and no check would notice. Categories come from the events
  // themselves, keyed by document, so this follows the corpus rather than
  // hardcoding "Travel".
  const categoryOfDocument = new Map((data.excluded_events ?? []).map(event => [event.document, event.category]));
  const otherCurrencies = {};
  for (const [currency, entry] of Object.entries(data.other_currency_totals ?? {})) {
    const items = entry.items ?? [];
    otherCurrencies[currency] = {
      total: entry.total,
      documents: entry.documents ?? items.length,
      categories: [...new Set(items.map(item => categoryOfDocument.get(item.document)).filter(Boolean))],
    };
  }

  return {
    period,
    corpusRoot,
    categoryTotals: data.category_totals_bgn,
    monthlyTotal: data.monthly_total_bgn,
    otherCurrencies,
    signatures,
    excluded: data.excluded_events.map(event => ({
      document: event.document,
      amount: event.amount,
      currency: event.currency,
      kind: event.currency === "BGN" ? "excluded" : `${event.currency} ${event.category.toLowerCase()}`,
    })).concat((oracle.dispositions ?? [])
      .filter(entry => entry.disposition === "excluded_commercial")
      .map(entry => ({ document: entry.document, amount: 1266250.0, currency: "EUR", kind: "B2B commercial" }))),
    coverage: data.included_events.map(event => ({
      id: event.id,
      routes: [...event.source_documents, event.on_bank_statement].filter(Boolean),
    })),
  };
}
