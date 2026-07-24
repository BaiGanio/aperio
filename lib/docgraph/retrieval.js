// Bounded, manifest-first document retrieval primitives.
//
// The manifest is deliberately independent of a database implementation so the
// SQLite and Postgres adapters can share ordering, deduplication, and limits.
// Batch reading is also injected: adapters own storage access while this module
// owns lifecycle, accounting, and cancellation semantics.

import { extractDateCandidates, extractAmountCandidates } from "./extract-facts.js";

export const RETRIEVAL_LIMITS = Object.freeze({
  maxCandidates: 48,
  batchSize: 6,
  maxFileBytes: 120_000,
  maxBatchBytes: 160_000,
  maxTotalBytes: 160_000,
});

function abortError() {
  const err = new Error("Document retrieval aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function termsOf(query = "") {
  return String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// The Postgres backend returns TIMESTAMPTZ columns as JS Date objects
// (node-postgres auto-parses them; SQLite's TEXT mtime column never does) —
// normalize both to ISO so callers get one shape regardless of backend.
function fileMtimeIso(row) {
  if (row.mtime instanceof Date) return row.mtime.toISOString();
  return row.mtime ?? null;
}

// Derived ONLY from the filename/title — never from filesystem mtime. mtime
// reflects when a file was indexed or last touched on disk, which routinely
// diverges from any date the document itself carries (a June-dated invoice
// re-saved in July has a July mtime). Blending mtime into this hint let
// indexing-time noise masquerade as a document date and wrongly exclude
// eligible documents from period-filtered manifests (#311). The real
// content date — with a role label (invoice/service-period/due/...) — is
// only available after reading the body, via extractDateCandidates() in
// doc_batch; this hint is a best-effort, pre-read signal only.
function filenameDateHint(row) {
  const source = `${row.rel_path ?? ""} ${row.title ?? ""}`;
  return source.match(/20\d{2}[-_]\d{1,2}(?:[-_]\d{1,2})?|\b(?:0?[1-9]|1[0-2])[-_]20\d{2}\b/)?.[0] ?? null;
}

// Canonicalizes a filenameDateHint (which may be "YYYY-MM[-DD]" or
// "MM-YYYY", with either "-" or "_" separators) down to "YYYY-MM" so it can
// be compared against a requested period regardless of which shape produced it.
function canonicalPeriod(hint) {
  if (!hint) return null;
  const ymd = hint.match(/^(\d{4})[-_](\d{1,2})(?:[-_]\d{1,2})?$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}`;
  const mdy = hint.match(/^(\d{1,2})[-_](\d{4})$/);
  if (mdy) return `${mdy[2]}-${mdy[1].padStart(2, "0")}`;
  return null;
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// Parses a relative or explicit month-level period out of a free-text query
// ("utilities last month", "internet cost in March 2026", "2026-06 bills"),
// returning "YYYY-MM" or null when no period is mentioned. `now` is injectable
// so relative phrases ("last month", "this month") are testable deterministically.
function periodOf(query, now = new Date()) {
  const t = String(query).toLowerCase();

  const explicit = t.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])\b/);
  if (explicit) return `${explicit[1]}-${explicit[2].padStart(2, "0")}`;

  const monthYear = t.match(new RegExp(`\\b(${MONTH_NAMES.join("|")})\\s+(20\\d{2})\\b`));
  if (monthYear) {
    const monthIndex = MONTH_NAMES.indexOf(monthYear[1]) + 1;
    return `${monthYear[2]}-${String(monthIndex).padStart(2, "0")}`;
  }

  if (/\blast month\b/.test(t)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (/\bthis month\b/.test(t)) {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return null;
}

function scoreRow(row, terms) {
  const haystack = [row.rel_path, row.title, row.summary, row.headings, row.content].filter(Boolean).join(" ").toLowerCase();
  let score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
  if (terms.some(term => ["utilities", "utility"].includes(term)) && /electric|water|heating|waste|internet|utility|utilities/.test(haystack)) score += 5;
  const aggregation = terms.some(term => ["total", "sum", "spent", "spend", "paid", "pay", "month", "monthly", "amount"].includes(term));
  if (aggregation) {
    if (/bill|receipt|invoice|statement|transaction|payment|topup|grocery|fuel|transport|internet|electricity|water|heating|waste/.test(haystack)) score += 2;
    if (/tax|notice|blank|form|commercial|swift|letter-of-credit/.test(haystack)) score -= 2;
  }
  return score;
}

function normalizeCandidate(row, score) {
  return {
    id: row.id,
    repo_id: row.repo_id,
    root_path: row.root_path,
    rel_path: row.rel_path,
    mime: row.mime,
    size: Number(row.size) || 0,
    file_mtime: fileMtimeIso(row),
    sha256: row.sha256 ?? null,
    filename_date_hint: filenameDateHint(row),
    duplicates: [],
    selection_reason: score > 0 ? `matched ${score} query term${score === 1 ? "" : "s"}` : "indexed-corpus fallback",
    score,
  };
}

/**
 * Build a deterministic, deduplicated manifest from indexed-document rows.
 * The caller may pass rows in any order; output is stable across backends.
 */
export function buildCandidateManifest(rows = [], { query = "", limit = RETRIEVAL_LIMITS.maxCandidates, now = new Date() } = {}) {
  const terms = termsOf(query);
  const requestedPeriod = periodOf(query, now);
  const byContent = new Map();
  for (const row of rows) {
    const score = scoreRow(row, terms);
    const candidate = normalizeCandidate(row, score);
    const key = candidate.sha256 || `${candidate.repo_id ?? ""}:${candidate.rel_path}`;
    const previous = byContent.get(key);
    if (!previous) { byContent.set(key, candidate); continue; }
    const candidateWins = candidate.score > previous.score ||
      (candidate.score === previous.score && `${candidate.root_path}/${candidate.rel_path}` < `${previous.root_path}/${previous.rel_path}`);
    const winner = candidateWins ? candidate : previous;
    const loser = candidateWins ? previous : candidate;
    // Content-identical copies are merged into one candidate so the model
    // doesn't read the same document twice, but the drop must stay visible
    // — silently vanishing a sibling copy makes coverage look off by one to
    // whoever reads the manifest without noticing the merge (#311).
    winner.duplicates = [...previous.duplicates, { id: loser.id, rel_path: loser.rel_path, root_path: loser.root_path }];
    byContent.set(key, winner);
  }

  const ordered = [...byContent.values()].sort((a, b) =>
    b.score - a.score || String(a.root_path).localeCompare(String(b.root_path)) ||
    String(a.rel_path).localeCompare(String(b.rel_path)) || Number(a.id) - Number(b.id));
  const boundedLimit = Math.max(1, Math.min(Number(limit) || RETRIEVAL_LIMITS.maxCandidates, RETRIEVAL_LIMITS.maxCandidates));
  // A hard `score >= 5` floor used to gate the whole pool whenever the query
  // said "utilities"/"utility" — meant to push genuine utility bills above
  // tax notices/blank forms, but it applied to every candidate, not just the
  // tie-break: a query naming several categories in one breath ("utilities,
  // fuel, groceries, transport, and internet" — the actual #313 household
  // gate prompt) silently dropped every non-utility-keyword document from
  // the manifest outright — fuel receipts, payment forms — whenever they
  // fit comfortably under maxCandidates and would never have been truncated
  // anyway. The score-sort below already ranks real utility bills first for
  // the case that bonus exists for (truncating a large corpus); it must not
  // also eliminate candidates that were never at risk of truncation (#313).
  let relevant = ordered;
  // Apply the requested period BEFORE the candidate-count bound below, not
  // after: a flat relevance score treats every month alike, so without this,
  // documents from the requested month can lose the alphabetical tie-break
  // against unrelated months once a corpus exceeds maxCandidates. Matched
  // against filename_date_hint only — filesystem mtime is indexing-time
  // noise, not a document date, and must never exclude an eligible candidate
  // (#311).
  if (requestedPeriod) {
    const periodMatches = relevant.filter(candidate => canonicalPeriod(candidate.filename_date_hint) === requestedPeriod);
    if (periodMatches.length) relevant = periodMatches;
  }
  const pool = relevant.length ? relevant : ordered;
  const candidates = pool.slice(0, boundedLimit);
  const truncated = pool.length > candidates.length || rows.length > candidates.length;
  return {
    candidates,
    found: rows.length,
    selected: candidates.length,
    truncated,
    continuation: truncated ? { next_offset: candidates.length, remaining: Math.max(0, pool.length - candidates.length) } : null,
  };
}

// Declared `size` estimates a group's read cost for splitting purposes only.
// Greedily fills each sub-batch up to maxBatchBytes rather than rejecting the
// whole group when the combined estimate exceeds it — a candidate whose own
// declared size already exceeds maxBatchBytes still gets a singleton
// sub-batch (there's nothing left to split it against), leaving the actual
// accept/reject decision to the post-read maxFileBytes/maxTotalBytes checks.
function splitIntoByteBoundedSubBatches(candidates, maxBatchBytes) {
  const subBatches = [];
  let current = [];
  let currentBytes = 0;
  for (const candidate of candidates) {
    const size = Number(candidate.size || 0);
    if (current.length && currentBytes + size > maxBatchBytes) {
      subBatches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(candidate);
    currentBytes += size;
  }
  if (current.length) subBatches.push(current);
  return subBatches;
}

/**
 * Read candidates through bounded batch calls. `readBatch` must return one
 * `{id, text?, bytes?}` result per successfully read candidate.
 */
export async function retrieveInBatches(candidates = [], {
  readBatch,
  signal,
  batchSize = RETRIEVAL_LIMITS.batchSize,
  maxFileBytes = RETRIEVAL_LIMITS.maxFileBytes,
  maxBatchBytes = RETRIEVAL_LIMITS.maxBatchBytes,
  maxTotalBytes = RETRIEVAL_LIMITS.maxTotalBytes,
} = {}) {
  if (typeof readBatch !== "function") throw new TypeError("readBatch is required");
  const documents = [];
  const skippedReasons = {};
  let bytes = 0;
  let read = 0;

  const width = Math.max(1, Math.min(Number(batchSize) || RETRIEVAL_LIMITS.batchSize, RETRIEVAL_LIMITS.batchSize));
  let index = 0;
  while (index < candidates.length) {
    throwIfAborted(signal);
    // Accumulate against a running `projected` total (seeded from the real
    // `bytes` read so far), not each candidate against the same stale `bytes`
    // snapshot — otherwise multiple candidates that individually fit the
    // remaining budget can collectively blow past maxTotalBytes. Scan forward
    // and admit up to `width` candidates densely (skipping ineligible ones
    // inline) rather than slicing fixed-size windows of the raw array —
    // otherwise an excluded candidate mid-window pushes a later, perfectly
    // eligible one into its own separate readBatch call for no reason.
    let projected = bytes;
    const admitted = [];
    while (index < candidates.length && admitted.length < width) {
      const candidate = candidates[index++];
      const size = Number(candidate.size || 0);
      if (projected + size > maxTotalBytes) {
        skippedReasons[candidate.rel_path] = "retrieval exceeds maxTotalBytes";
        documents.push({ ...candidate, status: "skipped", reason: "retrieval exceeds maxTotalBytes" });
        continue;
      }
      projected += size;
      admitted.push(candidate);
    }
    if (!admitted.length) continue;

    for (const subBatch of splitIntoByteBoundedSubBatches(admitted, maxBatchBytes)) {
      throwIfAborted(signal);
      const results = await readBatch(subBatch, { signal });
      throwIfAborted(signal);
      const byId = new Map((results ?? []).map(result => [String(result.id), result]));
      for (const candidate of subBatch) {
        const result = byId.get(String(candidate.id));
        if (!result) {
          skippedReasons[candidate.rel_path] = "reader returned no result";
          documents.push({ ...candidate, status: "skipped", reason: "reader returned no result" });
          continue;
        }
        const resultBytes = Number(result.bytes ?? Buffer.byteLength(String(result.text ?? ""), "utf8"));
        // The per-file cap applies to the actual extracted text, not the
        // candidate's declared source size — a compressed/binary source
        // (e.g. a PDF) can sit well over maxFileBytes on disk while its
        // extracted text is tiny, and vice versa. Checking pre-read against
        // candidate.size silently drops supported documents for no real
        // context-budget reason.
        if (resultBytes > maxFileBytes) {
          skippedReasons[candidate.rel_path] = "extracted text exceeds maxFileBytes";
          documents.push({ ...candidate, status: "skipped", reason: "extracted text exceeds maxFileBytes" });
          continue;
        }
        // The pre-batch admission check above uses the candidate's declared
        // `size`, which can understate the actual read (stale metadata,
        // encoding overhead). Re-check against the real byte count before
        // committing it to the total — never trust the estimate alone.
        if (bytes + resultBytes > maxTotalBytes) {
          skippedReasons[candidate.rel_path] = "retrieval exceeds maxTotalBytes";
          documents.push({ ...candidate, status: "skipped", reason: "retrieval exceeds maxTotalBytes" });
          continue;
        }
        bytes += resultBytes;
        read++;
        // Structured evidence over the raw text, not a replacement for it —
        // the model still gets `text` for verification, but role-labeled
        // dates and currency-tagged amounts mean it no longer has to parse
        // an undifferentiated blob to answer "what period, how much" (#311).
        // An empty array here is a real "none found", never a fabricated 0.
        const dates = extractDateCandidates(result.text);
        const amounts = extractAmountCandidates(result.text);
        documents.push({ ...candidate, ...result, status: "read", bytes: resultBytes, dates, amounts });
      }
    }
  }
  return {
    documents,
    coverage: {
      found: candidates.length,
      read,
      skipped: candidates.length - read,
      bytes,
      complete: read === candidates.length,
      skipped_reasons: skippedReasons,
    },
  };
}
