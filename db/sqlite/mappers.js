// db/sqlite/mappers.js
// Pure row-shaping and query-text helpers shared across the SQLite store, its
// wiki sub-store, and the recall/search functions. No `this`, no db handle.

import { deserialiseRow } from '../types.js';

export function nowIso() {
  return new Date().toISOString();
}

export function assertJsonPersistable(value, field) {
  if (value === undefined) return null;
  const seen = new WeakSet();
  const visit = v => {
    if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) {
      throw new Error(`${field} must be JSON-serializable`);
    }
    if (!v || typeof v !== 'object') return;
    if (seen.has(v)) throw new Error(`${field} must be JSON-serializable`);
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    for (const item of Object.values(v)) visit(item);
  };
  visit(value);
  return JSON.stringify(value);
}

export function parseJsonColumn(value) {
  return value == null ? null : JSON.parse(value);
}

export function vecBuf(embedding) {
  // sqlite-vec accepts a Float32Array as the vector payload.
  return Float32Array.from(embedding);
}

// FTS5 parses the MATCH argument as a query *expression*, so raw user text with
// operator characters throws instead of matching — a `:` reads as a
// `column:term` filter (e.g. "meeting at 21:00" → "no such column: 21"), and
// `-`/`*`/`^`/`(`/`"` are operators too. Wrap each whitespace-delimited token as
// a quoted phrase so arbitrary text is matched literally (implicit-AND, same as
// bare terms). Tokens with no letter or digit are dropped, since they tokenize
// to nothing and would make an empty phrase. Returns "" when nothing is left,
// which callers treat as "no text query" (Postgres' plainto_tsquery is already
// safe this way).
export function ftsMatchQuery(raw) {
  return String(raw ?? '')
    .split(/\s+/)
    .map(tok => tok.replace(/"/g, '').trim())
    .filter(tok => /[\p{L}\p{N}]/u.test(tok))
    .map(tok => `"${tok}"`)
    .join(' ');
}

export function rowToMemory(row) {
  if (!row) return null;
  // Tags come back as JSON text; parse for caller. Match Postgres' shape —
  // `lang` is preserved on the returned object so update() can re-use it.
  return {
    ...deserialiseRow({
      ...row,
      tags:        row.tags ? JSON.parse(row.tags) : [],
      pinned:      !!row.pinned,
      confidence:  row.confidence !== null ? Number(row.confidence) : 1.0,
      importance:  Number(row.importance),
    }),
    lang: row.lang ?? 'english',
  };
}

export function rowToSelf(row) {
  if (!row) return null;
  // Self-memories have no type/pin/versioning — a lean shape distinct from
  // the user `memories` row.
  return {
    id:           row.id,
    title:        row.title,
    content:      row.content,
    tags:         row.tags ? JSON.parse(row.tags) : [],
    importance:   Number(row.importance),
    created_at:   new Date(row.created_at),
    updated_at:   new Date(row.updated_at),
    source:       row.source ?? 'self',
    lang:         row.lang ?? 'english',
    confidence:   row.confidence !== null ? Number(row.confidence) : 1.0,
    generated_by: row.generated_by ?? null,
  };
}

export function rowToArticle(row) {
  if (!row) return null;
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}
