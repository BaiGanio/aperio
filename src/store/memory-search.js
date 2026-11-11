// src/store/memory-search.js - full-text, semantic and hybrid search over
// `memories` (spec S2.3 behaviour 8).
//
// Kept from v1 (db/sqlite/search.js at archive/v1-final): token quoting, the
// 60-row candidate lists, reciprocal rank fusion with constant 60.
// Changed from v1: tokens join with OR and rank by bm25 with a title weight
// (v1 used an implicit AND and found 10 of 24 corpus queries; OR finds 22).

const CANDIDATES = 60;
const RRF_K = 60;
const TITLE_WEIGHT = 4.0;
export const SEARCH_MODES = Object.freeze(['auto', 'fulltext', 'semantic']);

/**
 * FTS5 reads MATCH text as a query expression, so `21:00`, `-`, `*`, `(` or a
 * lone quote would throw. Each token is quoted, so it matches as plain text.
 * Tokens with no letter or digit are dropped. '' means "no words".
 */
export function ftsMatchQuery(raw) {
  return String(raw ?? '')
    .split(/\s+/)
    .map((tok) => tok.replace(/"/g, '').trim())
    .filter((tok) => /[\p{L}\p{N}]/u.test(tok))
    .map((tok) => `"${tok}"`)
    .join(' OR ');
}

/** SQL for the optional type / tag filters, on the `m` alias. */
export function filterSql({ type, tags }) {
  const conds = [];
  const params = {};
  if (type) {
    conds.push('m.type = @type');
    params.type = type;
  }
  if (tags?.length) {
    const names = tags.map((_, i) => `@tag${i}`);
    conds.push(`EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value IN (${names.join(', ')}))`);
    tags.forEach((tag, i) => { params[`tag${i}`] = tag; });
  }
  return { where: conds.length ? ` AND ${conds.join(' AND ')}` : '', params };
}

function ftsCandidates(db, match, filter) {
  return db.prepare(`
    SELECT m.seq AS seq, bm25(memories_fts, ${TITLE_WEIGHT}, 1.0) AS rank
      FROM memories_fts
      JOIN memories m ON m.seq = memories_fts.rowid
     WHERE memories_fts MATCH @match${filter.where}
     ORDER BY rank
     LIMIT ${CANDIDATES}
  `).all({ ...filter.params, match });
}

// With a sig, only vectors from that model count: two models never mix (L-C17, spec S2.4 #7).
function vecCandidates(db, vector, filter, sig) {
  const sigWhere = sig ? ' AND m.embedding_sig = @sig' : '';
  return db.prepare(`
    SELECT m.seq AS seq, v.distance AS distance
      FROM vec_memories v
      JOIN memories m ON m.seq = v.rowid
     WHERE v.embedding MATCH @vec AND k = ${CANDIDATES}${filter.where}${sigWhere}
     ORDER BY v.distance
  `).all({ ...filter.params, vec: vector, ...(sig ? { sig } : {}) });
}

/**
 * @returns {{seq: number, score: number, matched: string[]}[]} best first, score 0..1.
 * Full-text only: bm25 relative to the best row. Semantic only: cosine
 * similarity (absolute). Both: fused rank, relative to the best row.
 */
export function rankCandidates(db, { match, vector, mode, filter, sig }) {
  const fts = match && mode !== 'semantic' ? ftsCandidates(db, match, filter) : [];
  const vec = vector && mode !== 'fulltext' ? vecCandidates(db, vector, filter, sig) : [];

  // One list only: keep its own strength, which says more than a rank.
  if (vec.length === 0) {
    const best = -fts[0]?.rank || 1;
    return fts.map((row) => ({ seq: row.seq, score: Math.min(-row.rank / best, 1), matched: ['fts'] }));
  }
  if (fts.length === 0) {
    // Unit vectors: cosine similarity = 1 - (L2 distance squared) / 2.
    return vec.map((row) => ({ seq: row.seq, score: Math.max(1 - (row.distance * row.distance) / 2, 0), matched: ['vec'] }));
  }

  // Both lists: reciprocal rank fusion, relative to the best row.
  const fused = new Map();
  const add = (rows, kind) => rows.forEach((row, i) => {
    const entry = fused.get(row.seq) ?? { seq: row.seq, score: 0, matched: [] };
    entry.score += 1 / (RRF_K + i + 1);
    entry.matched.push(kind);
    fused.set(row.seq, entry);
  });
  add(fts, 'fts');
  add(vec, 'vec');

  // Stable sort: on a tie, a full-text match stays ahead (it was added first).
  const ranked = [...fused.values()].sort((x, y) => y.score - x.score);
  const top = ranked[0].score;
  for (const entry of ranked) entry.score = entry.score / top;
  return ranked;
}
