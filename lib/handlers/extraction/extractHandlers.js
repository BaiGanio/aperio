// lib/handlers/extraction/extractHandlers.js
// Regex-first, LLM-fallback field extraction against a matched template, plus
// the extraction_log dedup/verification round-trip (Document Intelligence
// WS3, issue #250 — T-G4.2/T-G4.4) and the cold-start orchestration that ties
// matchHandlers + templateHandlers together (T-G4.3).
//
// extract-facts.js is used as-is (already hardened for BG/DE/FR — #312/#313)
// for the regex/label pass; nothing here re-implements or duplicates its
// matching logic.

import { createHash } from "node:crypto";
import { extractAmountCandidates, extractDateCandidates } from "../../docgraph/extract-facts.js";
import * as templateHandlers from "./templateHandlers.js";
import { matchTemplates, classifyMatch, significantWords } from "./matchHandlers.js";

function userError(message) {
  return Object.assign(new Error(message), { userFacing: true });
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Confidence weight per field provenance. "fallback" is extract-facts.js's
// own likely_total/unlabeled_date guess — real signal, but explicitly weaker
// than a labeled hit. "llm" is weaker still (no structural evidence at all).
// "missing" contributes nothing — an unresolved field must pull the overall
// score down, not be silently excluded from the average.
const PROVENANCE_WEIGHT = { label: 1, fallback: 0.6, llm: 0.4, missing: 0 };

function computeConfidence(fields) {
  if (!fields.length) return 0;
  const total = fields.reduce((sum, f) => sum + (PROVENANCE_WEIGHT[f.provenance] ?? 0), 0);
  return Math.round((total / fields.length) * 100) / 100;
}

// The template's own rolling extraction-success rate (distinct from a single
// extraction's confidence above) — an exponential moving average so it needs
// no separate extraction-count column. ALPHA weights each new sample against
// the running value; the first-ever extraction (existing 0, the create-time
// default) takes the sample outright rather than being diluted 70% toward a
// value that was never a real measurement.
const CONFIDENCE_ROLLING_ALPHA = 0.3;

function nextRollingConfidence(existing, sample) {
  const next = existing === 0 ? sample : existing * (1 - CONFIDENCE_ROLLING_ALPHA) + sample * CONFIDENCE_ROLLING_ALPHA;
  return Math.round(next * 100) / 100;
}

/**
 * Resolves each of `template.fields` against extract-facts.js's labeled
 * candidates. A field whose role has an exact label match is "label"
 * provenance; falling back to the LIKELY_TOTAL/unlabeled_date guess is
 * "fallback" provenance — reported distinctly, never conflated with a real
 * label hit. Anything still unresolved is returned in `unresolved` for the
 * caller's LLM fallback.
 */
export function extractFields(text, template) {
  const amounts = extractAmountCandidates(text);
  const dates = extractDateCandidates(text);
  const results = [];
  const unresolved = [];

  for (const field of template.fields) {
    if (field.amount_label) {
      const labeled = amounts.find((a) => a.label === field.amount_label);
      const hit = labeled ?? (field.amount_label !== "likely_total" ? amounts.find((a) => a.label === "likely_total") : null);
      if (hit) {
        results.push({
          name: field.name, value: hit.value, currency: hit.currency, raw: hit.raw,
          provenance: labeled ? "label" : "fallback",
        });
        continue;
      }
    } else if (field.date_role) {
      const labeled = dates.find((d) => d.role === field.date_role);
      const hit = labeled ?? (field.date_role !== "unlabeled_date" ? dates.find((d) => d.role === "unlabeled_date") : null);
      if (hit) {
        results.push({
          name: field.name, value: hit.value, raw: hit.raw,
          provenance: labeled ? "label" : "fallback",
        });
        continue;
      }
    }
    unresolved.push(field);
  }
  return { results, unresolved };
}

// ─── extraction_log (dedup / verification round-trip, T-G4.4) ───────────────

export async function getLogByHash(store, sourceHash) {
  if (store.db) return store.db.prepare(`SELECT * FROM extraction_log WHERE source_hash = ?`).get(sourceHash) ?? null;
  const { rows } = await store.pool.query(`SELECT * FROM extraction_log WHERE source_hash = $1`, [sourceHash]);
  return rows[0] ?? null;
}

async function getLogById(store, id) {
  if (store.db) return store.db.prepare(`SELECT * FROM extraction_log WHERE id = ?`).get(id) ?? null;
  const { rows } = await store.pool.query(`SELECT * FROM extraction_log WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Called only after the caller has confirmed the actual db_execute write
// succeeded — never optimistically at hash-compute time, or a declined/failed
// write would still mark the source "extracted" (plan §5 Step 2, T-G4.4).
export async function recordExtraction(store, { sourceHash, sourcePath = null, templateId = null, connection = "extraction", rowCount = 0 }) {
  if (store.db) {
    try {
      const info = store.db.prepare(`
        INSERT INTO extraction_log (source_hash, source_path, template_id, extraction_connection, row_count)
        VALUES (?, ?, ?, ?, ?)
      `).run(sourceHash, sourcePath, templateId, connection, rowCount);
      return getLogById(store, info.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE constraint failed/.test(err.message)) throw userError(`source already extracted (hash ${sourceHash})`);
      throw err;
    }
  }
  try {
    const { rows } = await store.pool.query(
      `INSERT INTO extraction_log (source_hash, source_path, template_id, extraction_connection, row_count)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [sourceHash, sourcePath, templateId, connection, rowCount]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") throw userError(`source already extracted (hash ${sourceHash})`);
    throw err;
  }
}

// The round-trip's second step: 'unverified' → 'verified' once the caller
// confirms the written rows match what was reported, or → 'rejected' if the
// user declined the write after the log row was (optimistically) created by
// a caller that chose to record before confirming. Most callers should
// prefer not calling recordExtraction at all until the write is confirmed;
// this exists for the "recorded, then the user pushed back" correction path.
export async function markVerification(store, { id, state }) {
  if (!["unverified", "verified", "rejected"].includes(state)) throw userError(`invalid verification_state "${state}"`);
  if (store.db) {
    store.db.prepare(`UPDATE extraction_log SET verification_state = ? WHERE id = ?`).run(state, id);
    return getLogById(store, id);
  }
  const { rows } = await store.pool.query(`UPDATE extraction_log SET verification_state=$1 WHERE id=$2 RETURNING *`, [state, id]);
  return rows[0] ?? null;
}

// ─── Extraction against a resolved template (T-G4.2) ─────────────────────────

/**
 * @param {object} args
 * @param {string} args.text - already-read document text (via doc_batch)
 * @param {object} args.template - a row from templateHandlers.get/list
 * @param {Function} [args.llmFallback] - async ({text, fields}) => {[fieldName]: value}
 *   called with ONLY the still-unresolved field names, never a full re-extraction.
 */
export async function extractFromTemplate(store, { text, template, llmFallback } = {}) {
  if (!text || !text.trim()) {
    return { sourceHash: null, alreadyExtracted: null, fields: [], confidence: 0 };
  }
  const sourceHash = sha256(text);
  const alreadyExtracted = await getLogByHash(store, sourceHash);
  if (alreadyExtracted) {
    return { sourceHash, alreadyExtracted, fields: [], confidence: null };
  }

  const { results, unresolved } = extractFields(text, template);

  let llmResults;
  if (unresolved.length && typeof llmFallback === "function") {
    const values = (await llmFallback({ text, fields: unresolved.map((f) => f.name) })) ?? {};
    llmResults = unresolved.map((f) => ({
      name: f.name,
      value: values[f.name] ?? null,
      provenance: values[f.name] != null ? "llm" : "missing",
    }));
  } else {
    llmResults = unresolved.map((f) => ({ name: f.name, value: null, provenance: "missing" }));
  }

  const fields = [...results, ...llmResults];
  const confidence = computeConfidence(fields);

  // Feed this extraction's outcome back into the template's own rolling
  // score. Done here, not left for the MCP layer to remember to call
  // separately — extraction quality doesn't depend on whether a later
  // db_execute write ever happens, so there's no sequencing reason to defer
  // it (unlike extraction_log recording below, which genuinely must wait for
  // write confirmation).
  await templateHandlers.update(store, { id: template.id, confidence: nextRollingConfidence(template.confidence ?? 0, confidence) });

  return { sourceHash, alreadyExtracted: null, fields, confidence };
}

// ─── Cold-start orchestration (T-G4.3) ───────────────────────────────────────
// Ties matchHandlers (does a known shape already exist?) to templateHandlers'
// propose/confirm flow (if not, ask before learning one) — never both matches
// AND silently proposes, and never persists a template without the user
// having seen and confirmed it.

/**
 * Infers a template proposal from one document's own labeled evidence.
 * `fields` come from the same role vocabulary extract-facts.js already
 * produces (language-independent by construction). `match_keywords` are
 * literal significant words pulled from the document's own text — NOT the
 * (necessarily English) field role names — so a BG/DE/FR document's proposed
 * template can still match a second document in the same language.
 */
export function inferTemplateProposal(text, { name } = {}) {
  const amounts = extractAmountCandidates(text);
  const dates = extractDateCandidates(text);

  const fields = [];
  const seen = new Set();
  const addField = (fieldName, roleProps) => {
    if (seen.has(fieldName)) return;
    seen.add(fieldName);
    fields.push({ name: fieldName, required: false, ...roleProps });
  };
  for (const a of amounts) if (a.label) addField(a.label, { amount_label: a.label });
  for (const d of dates) if (d.role !== "unlabeled_date") addField(d.role, { date_role: d.role });

  return {
    name: name ?? `template-${Date.now()}`,
    match_keywords: significantWords(text),
    fields,
    confidence: 0,
  };
}

/**
 * @returns one of:
 *   { status: "matched", template, ranked }     — confident existing template
 *   { status: "ambiguous", ranked }              — ask; don't guess
 *   { status: "no-evidence" }                     — nothing to propose from
 *   { status: "proposed", token, proposal, ranked } — pending user confirmation
 */
export async function matchOrPropose(ctx, { text, name } = {}) {
  const ranked = await matchTemplates(ctx.store, { text });
  const classified = classifyMatch(ranked);
  if (classified.status === "confident") return { status: "matched", template: classified.top.template, ranked };
  if (classified.status === "ambiguous") return { status: "ambiguous", ranked };

  const proposal = inferTemplateProposal(text, { name });
  if (!proposal.fields.length) return { status: "no-evidence", ranked };

  const { token } = await templateHandlers.proposeTemplate(ctx, proposal);
  return { status: "proposed", token, proposal, ranked };
}
