// db/postgres/mappers.js
// Pure row-shaping and locale helpers shared by the Postgres store and its
// recall/search functions. No pool, no `this`.

import { deserialiseRow } from '../types.js';

// Maps locale codes to PostgreSQL text-search config names.
// Languages without a native pg config fall back to 'simple' (no stemming,
// but tokenises correctly for any script).
export const LOCALE_TO_PG_CONFIG = {
  en: 'english', de: 'german',  fr: 'french',  es: 'spanish',
  it: 'italian', nl: 'dutch',   da: 'danish',  fi: 'finnish',
  pt: 'portuguese', sv: 'swedish',
  // no native pg config — use language-agnostic tokeniser
  bg: 'simple', cs: 'simple', pl: 'simple', sk: 'simple', sl: 'simple',
};

export function localeToPgConfig(locale) {
  return LOCALE_TO_PG_CONFIG[locale] ?? 'english';
}

export function toVec(embedding) {
  return `[${embedding.join(',')}]`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres' native UUID columns (memories, self_memories) throw a hard 22P02
// syntax error for any non-UUID-shaped input instead of matching zero rows —
// SQLite's TEXT id columns just no-op on the same input. Callers on those
// tables check this first so a missing/malformed id behaves like SQLite
// (not-found), not a crash.
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// node-postgres auto-parses TIMESTAMPTZ columns into JS Date objects; SQLite's
// TEXT columns return the raw ISO string untouched. agent_jobs/agent_runs/
// agent_interrupts have no row mapper on the SQLite side either, so ISO
// string is the de facto shared contract — normalize Postgres to match.
export function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
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

export function rowToMemory(row) {
  return { ...deserialiseRow(row), lang: row.lang ?? 'english' };
}

export function rowToSelf(row) {
  // Self-memories have no type/pin/versioning — a lean shape distinct from
  // the user `memories` row.
  return {
    id:           row.id,
    title:        row.title,
    content:      row.content,
    tags:         Array.isArray(row.tags) ? row.tags : [],
    importance:   row.importance,
    created_at:   new Date(row.created_at),
    updated_at:   new Date(row.updated_at),
    source:       row.source ?? 'self',
    lang:         row.lang ?? 'english',
    confidence:   row.confidence ?? 1.0,
    generated_by: row.generated_by ?? null,
  };
}
