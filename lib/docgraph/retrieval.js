// Bounded, manifest-first document retrieval primitives.
//
// The manifest is deliberately independent of a database implementation so the
// SQLite and Postgres adapters can share ordering, deduplication, and limits.
// Batch reading is also injected: adapters own storage access while this module
// owns lifecycle, accounting, and cancellation semantics.
//
// Also exports composeMemoryFromDoc() — a pure function that detects whether a
// document's extracted dates/amounts carry high-confidence terminal facts
// suitable for auto-promotion into the memory store (issue #314).

import { extractDateCandidates, extractAmountCandidates } from "./extract-facts.js";

export const RETRIEVAL_LIMITS = Object.freeze({
  maxCandidates: 48,
  batchSize: 6,
  maxFileBytes: 120_000,
  maxBatchBytes: 160_000,
  maxTotalBytes: 160_000,
});

// Session-scoped doc_batch dedup (llamacpp-multiturn-latency.md Step 3): avoid
// re-injecting a document's full raw text into MODEL-FACING context on a
// repeat doc_batch call within the same conversation. Keyed by sha256 so
// unrelated or content-changed documents are never affected.
//
// Caches the REAL extracted text alongside dates/amounts/identity — not just
// a seen-flag, and not dates/amounts alone. The deterministic aggregation
// pipeline (aggregateDocuments → factsFromDocument, lib/docgraph/facts/
// extract.js) needs the raw text itself to recognize statements, parse
// transaction rows, detect commercial documents, and extract locators/
// merchant/category — dates/amounts are its OUTPUT for charge documents, not
// a substitute input for every document shape. A dedup hit therefore returns
// the real cached text (so a caller's aggregation pass over `documents` sees
// the same input a fresh read would have), and separately carries a short
// `dedupPointerText` the caller substitutes in for `text` — but only in the
// model-facing payload, and only AFTER aggregation has consumed the real
// text (see docgraphHandlers.js's _batch). `bytes` on a dedup hit already
// reflects the pointer's small size, not the real text's, so caller-side
// budget/coverage accounting matches what the model actually receives.
//
// Bounded to the MOST RECENT MAX_TRACKED_SESSIONS conversations: the MCP
// process is shared across every conversation for the life of the server
// (see mcp/index.js — it is not spawned fresh per chat), so an unbounded
// outer Map here would retain every conversation's document facts for as
// long as the process stays up.
const MAX_TRACKED_SESSIONS = 20;
// Also bound each SESSION's own facts map: a single long-lived, heavily-used
// conversation reading many distinct documents (well beyond one manifest's
// RETRIEVAL_LIMITS.maxCandidates=48, across many doc_batch calls over the
// conversation's lifetime) must not retain every one of them forever either
// — only the outer eviction above would otherwise bound it, and only once
// that whole session is evicted, by which point this one session alone could
// have retained an unbounded number of entries. Each entry now carries real
// text too (required for correct aggregation, see above), bounded per-
// document by RETRIEVAL_LIMITS.maxFileBytes (120,000B) — so the worst case
// is a HARD ceiling, not unbounded: 200 × 120KB ≈ 24MB per session, ×20
// tracked sessions ≈ 480MB total. Bounded, not small; acceptable for a
// single-user personal app, revisit if it ever becomes a real constraint.
const MAX_FACTS_PER_SESSION = 200;
const sessionReadFacts = new Map(); // sessionId -> Map<sha256, {id, relPath, rootPath, mime, title, dates, amounts, text}>

function sessionFactsFor(sessionId) {
  if (!sessionId) return null;
  let facts = sessionReadFacts.get(sessionId);
  if (facts) {
    // Refresh LRU position: Map iteration order is insertion order, so a
    // delete+re-set moves this session to the most-recently-used end.
    sessionReadFacts.delete(sessionId);
    sessionReadFacts.set(sessionId, facts);
    return facts;
  }
  if (sessionReadFacts.size >= MAX_TRACKED_SESSIONS) {
    sessionReadFacts.delete(sessionReadFacts.keys().next().value);
  }
  facts = new Map();
  sessionReadFacts.set(sessionId, facts);
  return facts;
}

// Bounded, LRU-ordered write into one session's facts map. Also used to
// refresh a fact's LRU position on a cache hit (dedup read), so a
// frequently-re-requested document doesn't get evicted ahead of one read
// once and never touched again.
function touchSessionFact(facts, sha256, fact) {
  if (facts.has(sha256)) {
    facts.delete(sha256);
  } else if (facts.size >= MAX_FACTS_PER_SESSION) {
    facts.delete(facts.keys().next().value);
  }
  facts.set(sha256, fact);
}

// Test-only escape hatch — production code never needs to clear this.
export function _resetDocBatchSessionCacheForTests() {
  sessionReadFacts.clear();
}

// Invalidate one session's dedup cache. Two call sites need this, both
// because a document's real text stops being reachable by the model even
// though its sha256 is still "known" here:
//
// 1. Session end (ws close → finaliseSession, lib/helpers/sessions.js) — the
//    conversation is over; retaining raw document text in this process-
//    resident cache past that point has no purpose and only extends how
//    long sensitive content sits in memory. Mirrors the existing
//    endSessionLog(id) cleanup already called from the same place.
// 2. Context summarization (handleSummarize, lib/emitters/handlers/ws/
//    summarize.js), manual OR auto-triggered — it wipes messages[] down to
//    a greeting + summary, and ragStore.index() explicitly skips tool-only
//    turns when indexing history for later recall. After that point NOTHING
//    holds the document's real text for the model to draw on — not the live
//    messages, not RAG, not the session file (appendSummary persists only
//    the summary text). Without this call, a later doc_batch for the same
//    sha256 would still hit this cache and return the "already read" pointer,
//    silently withholding a document the model can no longer actually see.
export function clearSessionFacts(sessionId) {
  if (!sessionId) return;
  sessionReadFacts.delete(sessionId);
}

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
const MONTH_ABBR_TO_NUM = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export function filenameDateHint(row) {
  const source = `${row.rel_path ?? ""} ${row.title ?? ""}`;
  const numeric = source.match(/20\d{2}[-_]\d{1,2}(?:[-_]\d{1,2})?|\b(?:0?[1-9]|1[0-2])[-_]20\d{2}\b/)?.[0];
  if (numeric) return numeric;
  // Some corpora spell the month out across a path instead of using the
  // numeric date the pattern above expects (e.g. "2026/June/electricity-
  // bill-03-jun.txt" — a year folder, a month-name folder, and a day-month
  // abbreviation in the filename, with no adjacent digit pair anywhere).
  // A bare month name/abbreviation with no accompanying year is not a date
  // — "utilities/june.txt" alone must still resolve to null — so both a
  // year and a recognizable month token are required before this counts.
  const year = source.match(/\b20\d{2}\b/)?.[0];
  if (!year) return null;
  const month = source.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i)?.[1]?.toLowerCase();
  if (!month) return null;
  return `${year}-${MONTH_ABBR_TO_NUM[month]}`;
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
// `admitted` items are {candidate, position} pairs — the position is the
// candidate's ORIGINAL index in the caller's input array, so the fresh-read
// pass can slot results back into input order after this function re-groups
// them into byte-bounded sub-batches.
function splitIntoByteBoundedSubBatches(admitted, maxBatchBytes) {
  const subBatches = [];
  let current = [];
  let currentBytes = 0;
  for (const pair of admitted) {
    const size = Number(pair.candidate.size || 0);
    if (current.length && currentBytes + size > maxBatchBytes) {
      subBatches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(pair);
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
  sessionId = null,
  // When true, this function does NOT commit new facts into the cross-call
  // sessionFacts cache before returning — it instead returns a
  // `commitSessionFacts()` function for the CALLER to invoke once it is sure
  // the result will actually reach the model. Without this, a caller that
  // does more work after retrieveInBatches returns (docgraphHandlers.js's
  // `_batch` runs highlights/aggregation/the memory bridge afterward) could
  // have its own request aborted or time out in THAT window — after this
  // function already committed the read as "seen" — and the model would
  // never receive the document, yet a retry would still get the dedup
  // pointer for it (llamacpp-multiturn-latency.md Step 3 review, round 5,
  // P1). Default false preserves the original auto-commit contract for every
  // existing/direct caller.
  deferCommit = false,
  batchSize = RETRIEVAL_LIMITS.batchSize,
  maxFileBytes = RETRIEVAL_LIMITS.maxFileBytes,
  maxBatchBytes = RETRIEVAL_LIMITS.maxBatchBytes,
  maxTotalBytes = RETRIEVAL_LIMITS.maxTotalBytes,
} = {}) {
  if (typeof readBatch !== "function") throw new TypeError("readBatch is required");
  // One result slot per input candidate, filled in INPUT order. The dedup-hit
  // and budget-skip branches slot immediately, while fresh reads slot only
  // after readBatch resolves — without preallocated slots, a cached candidate
  // earlier in the manifest would be pushed before a fresh candidate that
  // precedes it, silently reversing their order and making ranked results and
  // generated highlights depend on cache state instead of manifest order
  // (llamacpp-multiturn-latency.md Step 3 review, round 8, P2). Every
  // candidate takes exactly one path below, so every slot is filled exactly
  // once.
  const documents = new Array(candidates.length);
  const skippedReasons = {};
  let bytes = 0;
  let read = 0;
  const sessionFacts = sessionFactsFor(sessionId);
  // New facts from THIS call are staged here and only committed into the
  // real, cross-call sessionFacts map on a normal (non-throwing) return —
  // see the commit step at the end of this function. Without this, a
  // mid-batch failure (a later sub-batch's readBatch throws, or the caller's
  // signal aborts) would still leave earlier sub-batches' successful reads
  // written into the session cache, even though the whole call surfaces as
  // an error and the model/conversation never received ANY of this batch's
  // document text — a retry would then wrongly report those documents as
  // "already read earlier in this conversation".
  const pendingFactWrites = sessionFacts ? new Map() : null;

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
    // Admitted pairs keep each candidate's ORIGINAL input position so the
    // fresh-read pass can slot results back into input order even though
    // splitIntoByteBoundedSubBatches re-groups them.
    const admitted = [];
    // Dedup hits in this admission window, resolved (charged + slotted) only
    // in the input-order resolution pass below — never charged immediately.
    // Charging a cached pointer before a PRECEDING fresh candidate's real
    // (possibly much larger) text size is known let the lower-ranked cached
    // document consume the budget and skip the higher-ranked fresh one
    // (llamacpp-multiturn-latency.md Step 3 review, round 10, P2).
    const pendingDedup = [];
    while (index < candidates.length && admitted.length < width) {
      const position = index;
      const candidate = candidates[index++];
      // Session dedup: this exact content was already read (and its facts
      // extracted) earlier in this conversation. Skip the real read and
      // extraction entirely — no `readBatch` call, no re-parsing — and
      // return a short pointer instead of the full text.
      if (sessionFacts && candidate.sha256 && sessionFacts.has(candidate.sha256)) {
        const cached = sessionFacts.get(candidate.sha256);
        // Refresh LRU position on access too, not just on write — a
        // frequently-re-requested document should outlive one read once and
        // never touched again when MAX_FACTS_PER_SESSION forces an eviction.
        touchSessionFact(sessionFacts, candidate.sha256, cached);
        const pointerText = `Already read earlier in this conversation (unchanged — sha256 match, originally read as "${cached.relPath}"). Full text omitted to save context; dates/amounts below are preserved from that earlier read.`;
        const pointerBytes = Buffer.byteLength(pointerText, "utf8");
        pendingDedup.push({ position, candidate, cached, pointerText, pointerBytes });
        continue;
      }
      const size = Number(candidate.size || 0);
      // Admission-time estimate check for fresh candidates only — the
      // authoritative budget check happens in the input-order resolution pass
      // below against real byte counts (the estimate can understate the text).
      if (projected + size > maxTotalBytes) {
        skippedReasons[candidate.rel_path] = "retrieval exceeds maxTotalBytes";
        documents[position] = { ...candidate, status: "skipped", reason: "retrieval exceeds maxTotalBytes" };
        continue;
      }
      projected += size;
      admitted.push({ candidate, position });
    }
    if (!admitted.length && !pendingDedup.length) continue;

    // Read the fresh candidates. No budget charging or slotting happens here —
    // the resolution pass below charges EVERYTHING (fresh reads AND cached
    // pointers) in input order, so a later cached pointer can never consume
    // the budget before an earlier fresh candidate's real size is charged.
    const pendingFresh = [];
    for (const subBatch of splitIntoByteBoundedSubBatches(admitted, maxBatchBytes)) {
      throwIfAborted(signal);
      const results = await readBatch(subBatch.map(({ candidate }) => candidate), { signal });
      throwIfAborted(signal);
      const byId = new Map((results ?? []).map(result => [String(result.id), result]));
      for (const { candidate, position } of subBatch) {
        const result = byId.get(String(candidate.id));
        if (!result) {
          skippedReasons[candidate.rel_path] = "reader returned no result";
          pendingFresh.push({ position, candidate, skipReason: "reader returned no result" });
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
          pendingFresh.push({ position, candidate, skipReason: "extracted text exceeds maxFileBytes" });
          continue;
        }
        // Structured evidence over the raw text, not a replacement for it —
        // the model still gets `text` for verification, but role-labeled
        // dates and currency-tagged amounts mean it no longer has to parse
        // an undifferentiated blob to answer "what period, how much" (#311).
        // An empty array here is a real "none found", never a fabricated 0.
        const dates = extractDateCandidates(result.text);
        const amounts = extractAmountCandidates(result.text);
        // NOTE: the session-facts entry for this document is NOT staged here.
        // It is staged in the resolution pass below, only AFTER the actual-
        // byte budget check accepts the result — a document whose declared
        // size fits but whose extracted text exceeds the remaining
        // maxTotalBytes is read then budget-skipped, and caching it as
        // "already seen" would make a later request with a larger budget get
        // an "already read" pointer for text that was never delivered
        // (llamacpp-multiturn-latency.md Step 3 review, round 11, P1).
        pendingFresh.push({ position, candidate, result, resultBytes, dates, amounts });
      }
    }

    // Charge and slot THIS window's results in INPUT order — fresh reads and
    // cached pointers together. Every candidate is judged against the running
    // total in manifest order, so a higher-ranked candidate can only be
    // budget-skipped because of its OWN real cost, never because a
    // lower-ranked cached pointer was charged first
    // (llamacpp-multiturn-latency.md Step 3 review, round 10, P2).
    const resolutions = [
      ...pendingDedup.map(d => ({ kind: "dedup", ...d })),
      ...pendingFresh.map(f => ({ kind: "fresh", ...f })),
    ].sort((a, b) => a.position - b.position);
    for (const r of resolutions) {
      const { position, candidate } = r;
      if (r.kind === "dedup") {
        // A dedup pointer is tiny but not free — it must still respect the
        // caller's own budget (e.g. max_total_bytes: 1), the same as a real
        // read. Skipping this check let an exhausted or deliberately tiny
        // budget still report coverage.complete: true.
        if (bytes + r.pointerBytes > maxTotalBytes) {
          skippedReasons[candidate.rel_path] = "retrieval exceeds maxTotalBytes";
          documents[position] = { ...candidate, status: "skipped", reason: "retrieval exceeds maxTotalBytes" };
          continue;
        }
        bytes += r.pointerBytes;
        read++;
        documents[position] = {
          ...candidate,
          // Identity follows the REQUESTED document, not the cache. The cache
          // is keyed by sha256, which two DIFFERENT documents can share
          // (content twins) and which is unchanged by a rename — returning
          // the first reader's cached id/path/title would misattribute this
          // read to the wrong source, and aggregation + the auto-memory
          // bridge key off the stable path (llamacpp-multiturn-latency.md
          // Step 3 review, round 8, P1). Production backends refresh
          // candidate identity from the CURRENT DB row before this runs
          // (withTrustedSha256*), so candidate fields are the trusted
          // identity for the requested id; fall back to the cached values
          // only when a direct caller omitted a field, mirroring what a fresh
          // read's {...candidate, ...result} spread would honor.
          id: candidate.id ?? r.cached.id,
          rel_path: candidate.rel_path ?? r.cached.relPath,
          root_path: candidate.root_path ?? r.cached.rootPath,
          mime: candidate.mime ?? r.cached.mime,
          title: candidate.title ?? r.cached.title,
          status: "read", bytes: r.pointerBytes,
          // The REAL cached text, not the pointer — a caller computing
          // deterministic facts (aggregateDocuments → factsFromDocument)
          // needs the raw text to recognize statements, parse transaction
          // rows, detect commercial documents, and extract locators/merchant/
          // category; cached dates/amounts alone are not enough to reproduce
          // that. `bytes` above already reflects the SMALL pointer size (the
          // budget/coverage accounting a caller sees), matching what the
          // model will actually receive once the caller substitutes
          // `dedupPointerText` for `text` in the model-facing payload, AFTER
          // aggregation has consumed the real text (see docgraphHandlers.js).
          text: r.cached.text,
          dates: r.cached.dates, amounts: r.cached.amounts,
          dedup: true, dedupPointerText: r.pointerText,
        };
        continue;
      }
      if (r.skipReason) {
        documents[position] = { ...candidate, status: "skipped", reason: r.skipReason };
        continue;
      }
      // The pre-batch admission check above uses the candidate's declared
      // `size`, which can understate the actual read (stale metadata,
      // encoding overhead). Re-check against the real byte count before
      // committing it to the total — never trust the estimate alone.
      if (bytes + r.resultBytes > maxTotalBytes) {
        skippedReasons[candidate.rel_path] = "retrieval exceeds maxTotalBytes";
        documents[position] = { ...candidate, status: "skipped", reason: "retrieval exceeds maxTotalBytes" };
        continue;
      }
      bytes += r.resultBytes;
      read++;
      // Stage the session fact ONLY now that the actual-byte budget check has
      // accepted the result — this document's text is genuinely being
      // delivered, so a later repeat read may safely dedup against it. A
      // budget-skipped document (skipReason or the check above) never reaches
      // this line, so it can never be recorded as "already read" for text the
      // model never received (round 11, P1). See the note in the read loop
      // above for the identity/hash-key rationale (rounds 8 + 9).
      if (pendingFactWrites && candidate.sha256) {
        pendingFactWrites.set(r.result.sha256 ?? candidate.sha256, {
          id: r.result.id ?? candidate.id,
          relPath: r.result.rel_path ?? candidate.rel_path,
          rootPath: r.result.root_path ?? candidate.root_path,
          mime: r.result.mime ?? candidate.mime,
          title: r.result.title ?? candidate.title,
          dates: r.dates, amounts: r.amounts, text: r.result.text,
        });
      }
      documents[position] = { ...candidate, ...r.result, status: "read", bytes: r.resultBytes, dates: r.dates, amounts: r.amounts };
    }
  }

  // Commit staged facts only now that every candidate has been processed
  // without throwing — an earlier exception (readBatch failure, abort) skips
  // this line entirely, so a batch that errors out to the caller never
  // leaves phantom "already read" entries for the sub-batches that happened
  // to succeed before the failure.
  function commitSessionFacts() {
    if (pendingFactWrites) {
      for (const [sha256, fact] of pendingFactWrites) touchSessionFact(sessionFacts, sha256, fact);
    }
  }
  if (!deferCommit) commitSessionFacts();
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
    // Present only in deferred mode, and only when there was ever a session
    // to commit into — callers that don't opt in keep the original
    // auto-commit contract and never see this field.
    ...(deferCommit && pendingFactWrites ? { commitSessionFacts } : {}),
  };
}

// ─── Docgraph → Memory Bridge (issue #314) ─────────────────────────────────

// Only these amount labels are "terminal" — the actual amount owed, not a
// breakdown. Subtotal, balance, paid, likely_total are never auto-promoted.
const TERMINAL_AMOUNT_LABELS = new Set(["amount_due", "grand_total"]);

// Only these date roles are "terminal" — a billing date that gives context
// for trend questions. Unlabeled dates and low-confidence matches are excluded.
const TERMINAL_DATE_ROLES = new Set(["due_date", "invoice_date", "service_period_start", "document_date"]);

/**
 * Given dates and amounts extracted from a document by extract-facts.js,
 * compose a compact memory suitable for trend-question recall if high-confidence
 * terminal facts exist. Returns null when no promotion candidate is found.
 *
 * @param {Array<{role, raw, value, confidence}>} dates
 * @param {Array<{value, currency, raw, label}>} amounts
 * @param {{sha256?, title?, rel_path?, root_path?}} [docInfo={}]
 * @returns {{title, content, tags, importance, dedupKey}|null}
 */
export function composeMemoryFromDoc(dates, amounts, docInfo = {}) {
  if (!Array.isArray(dates) || !Array.isArray(amounts)) return null;
  if (!dates.length || !amounts.length) return null;

  // ── Amount selection ──────────────────────────────────────────────────
  // Prefer amount_due (what's actually owed) over grand_total (what the
  // invoice was originally issued for). A partially paid invoice where
  // grand_total=100 and amount_due=20 must promote 20, not 100 (#314).
  const terminalAmounts = amounts.filter(a => TERMINAL_AMOUNT_LABELS.has(a.label));
  if (!terminalAmounts.length) return null;
  const amountDue = terminalAmounts.find(a => a.label === "amount_due");
  const bestAmount = amountDue ?? terminalAmounts.find(a => a.label === "grand_total");
  if (!bestAmount || bestAmount.value == null) return null;

  // Reject amounts with no resolved currency — trend aggregation cannot
  // safely distinguish an unknown unit from BGN, EUR, or USD (#314).
  if (bestAmount.currency == null) return null;

  // Guard: if multiple DISTINCT (value, currency) pairs share the winning
  // label, there are genuinely multiple records (e.g. two invoices in one
  // document or the same amount in two currencies). Repeated identical
  // pairs — common in payment stubs — are deduplicated first.
  const distinctWinningAmounts = new Set(
    terminalAmounts.filter(a => a.label === bestAmount.label)
      .map(a => `${a.value}|${a.currency}`));
  if (distinctWinningAmounts.size > 1) return null;

  // ── Date selection ────────────────────────────────────────────────────
  // The *period* (the month used in the memory title and for trend recall)
  // comes from the service period or invoice date — NOT the due date, which
  // can fall a month later and would misclassify a May bill as June (#314).
  // Filter out ambiguous dates (value: null) before prioritization —
  // otherwise a service_period_start with an unparseable format takes
  // priority and causes an early return even when a valid invoice date
  // or due date exists in the same array (#314).
  const terminalDates = dates.filter(d => TERMINAL_DATE_ROLES.has(d.role) && d.confidence === "high" && d.value != null);
  if (!terminalDates.length) return null;
  // Period priority: service period > invoice date > due date (last resort).
  // Document date is the last resort — it's the least specific label (assigned
  // to any line matching "дат(?:а|а[^:\n]*:)", including bilingual forms).
  const periodDatePriority = { service_period_start: 0, invoice_date: 1, due_date: 2, document_date: 3 };
  const sortedForPeriod = [...terminalDates].sort(
    (a, b) => (periodDatePriority[a.role] ?? 9) - (periodDatePriority[b.role] ?? 9));
  const periodDate = sortedForPeriod[0];
  if (!periodDate.value) return null;

  // Guard: if multiple DISTINCT dates share the winning role, there are
  // genuinely multiple records. Repeated identical dates (payment stubs,
  // form headers) are deduplicated first (#314).
  const distinctPeriodValues = new Set(
    terminalDates.filter(d => d.role === periodDate.role).map(d => d.value));
  if (distinctPeriodValues.size > 1) return null;

  // The *due date* is kept as separate context when it differs from the
  // period date — it informs "when is this due?", not "what month is this
  // bill for?". Multiple distinct due dates (e.g. original + revised) are
  // ambiguous — suppress the context rather than picking an arbitrary one.
  // Repeated identical dates (header + footer) are deduplicated first.
  const dueDateCandidates = terminalDates.filter(
    d => d.role === "due_date" && d.confidence === "high" && d.value !== periodDate.value);
  const distinctDueDates = new Map(dueDateCandidates.map(d => [d.value, d]));
  const dueDate = distinctDueDates.size === 1 ? distinctDueDates.values().next().value : null;

  // ── Content composition ───────────────────────────────────────────────
  const title = docInfo.title ?? docInfo.rel_path ?? "document";
  const displayTitle = title.replace(/\.[^.]+$/, ""); // strip file extension
  const period = periodDate.value.slice(0, 7); // "YYYY-MM"

  const currencyPart = bestAmount.currency && !bestAmount.raw.toUpperCase().includes(bestAmount.currency)
    ? ` ${bestAmount.currency}`
    : "";

  const periodContext = periodDate.role === "service_period_start"
    ? `Service period ${periodDate.value.slice(0, 7)}`
    : periodDate.role === "invoice_date"
      ? `Issued ${periodDate.value}`
      : `Due ${periodDate.value}`; // only reached as last-resort fallback

  // Join the base elements with space, then append the due line separately
  // to avoid a double-space between periodContext and ". Due…".
  const base = [`${displayTitle} summary — ${period}:`, `${bestAmount.raw}${currencyPart}.`, periodContext].join(" ");
  const content = dueDate ? `${base}. Due ${dueDate.value}` : base;

  return {
    title: `${displayTitle} summary — ${period}`,
    content,
    tags: ["fact", "bill"],
    importance: 4,
  };
}

// ─── Doc_batch highlights (T-R5 model-aid) ──────────────────────────────

// Filename-based category hints for the highlights summary. Kept simple and
// deterministic — never the model's only source of truth, just a navigation
// aid so a small model can orient itself before reading the full JSON. Matches
// the same keyword conventions used by scoreRow() in the manifest builder.
function categoryHint(relPath, title) {
  const path = String(relPath ?? "").toLowerCase();
  const t = String(title ?? "").toLowerCase();
  const both = `${path} ${t}`;
  if (/electricity|water.*bill|heating|waste/.test(both)) return "utility";
  if (/fuel|petrol/.test(both)) return "fuel";
  if (/grocery|market/.test(both)) return "groceries";
  if (/transport|topup|metro|bus|train/.test(both)) return "transport";
  if (/internet/.test(both)) return "internet";
  if (/bank.*statement/.test(both)) return "statement";
  if (/tax.*notice|increase.*notice/.test(both)) return "tax_notice";
  if (/(?:commercial|trade).*invoice|proforma|swift|letter.of.credit/.test(both)) return "commercial";
  if (/airport|hotel/.test(both)) return "travel";
  return null;
}

/**
 * Build a plain-text highlights summary from a doc_batch result's documents
 * array. Lists every document that carries a terminal-labeled amount
 * (amount_due / grand_total) with its value, currency, label, and a
 * filename-based category hint. A small model can use this to navigate the
 * full result without parsing all 16+ document entries blindly (#313).
 *
 * @param {Array<{status, rel_path, title, amounts, dates?}>} documents
 * @returns {string} plain-text highlights, multi-line, or empty string
 */
export function buildDocumentHighlights(documents = []) {
  const lines = [];
  let docCount = 0;
  let amountCount = 0;
  const amountDocs = [];

  for (const doc of documents) {
    if (doc.status !== "read") continue;
    docCount++;
    const amounts = doc.amounts;
    if (!Array.isArray(amounts) || !amounts.length) continue;

    const terminal = amounts.filter(a =>
      a.label && TERMINAL_AMOUNT_LABELS.has(a.label) && a.currency != null && a.value != null);
    if (!terminal.length) continue;

    const filename = doc.rel_path?.split("/").pop() ?? doc.title ?? "?";
    const hint = categoryHint(doc.rel_path, doc.title);
    for (const a of terminal) {
      amountCount++;
      const valueStr = a.value.toFixed(2);
      amountDocs.push(
        `${filename.padEnd(35)} ${valueStr.padStart(8)} ${(a.currency ?? "???").padEnd(4)} ${(a.label ?? "?").padEnd(13)} ${hint ?? "—"}`);
    }
  }

  if (!amountCount) {
    return `doc_batch highlights: ${docCount} documents read, none with detected terminal amounts (amount_due/grand_total).\n`;
  }

  lines.push(`── doc_batch highlights ──`);
  lines.push(`Read ${docCount} documents, ${amountCount} terminal amount${amountCount === 1 ? "" : "s"} across ${amountDocs.length} file${amountDocs.length === 1 ? "" : "s"}:`);
  lines.push("");
  lines.push(`  ${"Filename".padEnd(33)}  Amount   Curr   Label          Category`);
  lines.push(`  ${"─".repeat(33)}  ${"─".repeat(8)}  ${"─".repeat(4)}  ${"─".repeat(13)}  ${"─".repeat(10)}`);
  for (const row of amountDocs) {
    lines.push(`  ${row}`);
  }
  lines.push("");
  lines.push("Category hint is filename-based — verify against text and amounts[]. Full JSON below.");
  return lines.join("\n");
}
