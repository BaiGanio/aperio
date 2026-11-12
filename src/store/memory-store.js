// src/store/memory-store.js - create, read, update, delete, list and search
// memories (spec S2.3). Built by openStore(); holds no module state.
//
// Every vector change and its `embedding_sig` change share one transaction,
// and delete removes the vector in code, on the one delete path (L-C13).
// There is no cache (AP6): every read asks SQLite.

import { randomUUID } from 'node:crypto';
import { SEARCH_MODES, filterSql, ftsMatchQuery, rankCandidates } from './memory-search.js';

export class StoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export const MEMORY_TYPES = Object.freeze([
  'fact', 'preference', 'project', 'decision', 'solution', 'source', 'person', 'inference', 'workflow',
]);
const LIMITS = Object.freeze({ title: 200, content: 8000, tags: 20, tagLength: 100, search: 50, list: 200 });
const COLUMNS = 'seq, id, type, title, content, tags, importance, source, created_at, updated_at, embedding_sig';

const clamp = (value, fallback, max) => Math.min(Math.max(Number.parseInt(value ?? fallback, 10) || 0, 1), max);

function toMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags),
    importance: row.importance,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function textProblem(field, value, max) {
  if (typeof value !== 'string' || !value.trim()) return { field, why: 'must be a non-empty text' };
  if (value.length > max) return { field, why: `is ${value.length} characters; the limit is ${max}` };
  return null;
}

function tagsProblem(tags) {
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || !t || t.length > LIMITS.tagLength)) {
    return { field: 'tags', why: 'must be a list of short texts' };
  }
  return tags.length > LIMITS.tags ? { field: 'tags', why: `has ${tags.length} entries; the limit is ${LIMITS.tags}` } : null;
}

const badDate = (value) => !Number.isFinite(Date.parse(value));

/** Check the fields that are present. Returns the first problem as { field, why }, or null. */
function problemIn(fields) {
  let p;
  if ('title' in fields && (p = textProblem('title', fields.title, LIMITS.title))) return p;
  if ('content' in fields && (p = textProblem('content', fields.content, LIMITS.content))) return p;
  if ('type' in fields && !MEMORY_TYPES.includes(fields.type)) return { field: 'type', why: `must be one of ${MEMORY_TYPES.join(', ')}` };
  if ('importance' in fields && !(Number.isInteger(fields.importance) && fields.importance >= 1 && fields.importance <= 5)) {
    return { field: 'importance', why: 'must be an integer from 1 to 5' };
  }
  if ('tags' in fields && (p = tagsProblem(fields.tags))) return p;
  if ('source' in fields && (typeof fields.source !== 'string' || !fields.source)) return { field: 'source', why: 'must be a non-empty text' };
  if ('createdAt' in fields && badDate(fields.createdAt)) return { field: 'createdAt', why: 'must be an absolute date' };
  if ('updatedAt' in fields && badDate(fields.updatedAt)) return { field: 'updatedAt', why: 'must be an absolute date' };
  return null;
}

/** Check the fields that are present. Throws a StoreError that names the field. */
function validate(fields) {
  const problem = problemIn(fields);
  if (problem) throw new StoreError(`${problem.field}: ${problem.why}`);
}

const PATCHABLE = ['type', 'title', 'content', 'tags', 'importance'];
const present = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {number} deps.dims
 * @param {boolean} deps.vectorSupported
 * @param {boolean} deps.vectorsReset
 */
export function createMemoryStore({ db, dims, vectorSupported, vectorsReset }) {
  const byId = db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`);
  const bySeq = db.prepare(`SELECT ${COLUMNS} FROM memories WHERE seq = ?`);
  const setSig = db.prepare('UPDATE memories SET embedding_sig = ? WHERE seq = ?');
  const insertRow = db.prepare(`
    INSERT INTO memories (id, type, title, content, tags, importance, source, created_at, updated_at)
    VALUES (@id, @type, @title, @content, @tags, @importance, @source, @createdAt, @updatedAt)`);
  const insertHistory = db.prepare(`
    INSERT INTO memory_history (memory_id, type, title, content, tags, importance, source, replaced_at)
    VALUES (@id, @type, @title, @content, @tags, @importance, @source, @replacedAt)`);
  // The vector statements exist only when the table does.
  const vec = vectorSupported
    ? {
        remove: db.prepare('DELETE FROM vec_memories WHERE rowid = ?'),
        add: db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)'),
      }
    : null;

  /** Check a vector before any use. Returns a unit-length Float32Array, or null for "none". */
  function checkVector(embedding, sig) {
    if (embedding == null) return null;
    if (embedding.length !== dims) throw new StoreError(`embedding: has ${embedding.length} values; this store needs ${dims}`);
    if (typeof sig !== 'string' || !sig) throw new StoreError('sig: an embedding needs its signature');
    // Unit length, so the fast L2 search ranks rows as cosine would.
    const vector = Float32Array.from(embedding);
    let sum = 0;
    for (const x of vector) sum += x * x;
    if (!Number.isFinite(sum)) throw new StoreError('embedding: holds a value that is not a number');
    const norm = Math.sqrt(sum);
    if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
  }

  /** Replace or remove the vector of one row. Runs inside the caller's transaction. */
  function writeVector(seq, vector, sig) {
    if (!vec) return;
    vec.remove.run(BigInt(seq));
    if (vector) vec.add.run(BigInt(seq), vector);
    setSig.run(vector ? sig : null, seq);
  }

  async function insert(input, embedding, sig) {
    const row = {
      type: input?.type,
      title: input?.title,
      content: input?.content,
      tags: input?.tags ?? [],
      importance: input?.importance ?? 3,
      source: input?.source ?? 'manual',
    };
    validate(input?.createdAt === undefined ? row : { ...row, createdAt: input.createdAt });
    const vector = checkVector(embedding, sig);
    const now = new Date().toISOString();
    const createdAt = input.createdAt === undefined ? now : new Date(input.createdAt).toISOString();
    const id = randomUUID();
    db.transaction(() => {
      const info = insertRow.run({ ...row, id, tags: JSON.stringify(row.tags), createdAt, updatedAt: createdAt });
      if (vector) writeVector(Number(info.lastInsertRowid), vector, sig);
    })();
    return toMemory(byId.get(id));
  }

  /**
   * Import rows that already have an id and both dates (spec S2.12). One
   * transaction. A known id is skipped; a row that fails a check is listed in
   * `rejected` with its field, never written. Rows may be any iterable, so a
   * big source streams through. `beforeCommit(result)` may throw to roll back;
   * `dryRun` always rolls back. Vectors are left to reindex().
   */
  function importRows(rows, { dryRun = false, beforeCommit, onImported } = {}) {
    const result = { imported: 0, skipped: 0, rejected: [] };
    const rollback = Symbol('rollback');
    try {
      db.transaction(() => {
        for (const input of rows) {
          const id = input?.id;
          if (typeof id !== 'string' || !id) {
            result.rejected.push({ id: String(id), field: 'id', why: 'must be a non-empty text' });
            continue;
          }
          if (byId.get(id)) { result.skipped++; continue; }
          const row = {
            type: input.type, title: input.title, content: input.content, tags: input.tags,
            importance: input.importance, source: input.source, createdAt: input.createdAt, updatedAt: input.updatedAt,
          };
          const problem = problemIn(row);
          if (problem) { result.rejected.push({ id, ...problem }); continue; }
          insertRow.run({
            ...row, id, tags: JSON.stringify(row.tags),
            createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
          });
          result.imported++;
          onImported?.(input);
        }
        beforeCommit?.(result);
        if (dryRun) throw rollback;
      })();
    } catch (err) {
      if (err !== rollback) throw err;
    }
    return result;
  }

  async function getById(id) {
    return toMemory(byId.get(id));
  }

  async function update(id, patch, embedding, sig) {
    const current = byId.get(id);
    if (!current) throw new StoreError(`memory ${id}: not found`);
    const changes = present(patch ?? {}, PATCHABLE);
    validate(changes);
    const vector = checkVector(embedding, sig);

    const before = toMemory(current);
    const after = { ...before, ...changes };
    const changed = PATCHABLE.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const textChanged = before.title !== after.title || before.content !== after.content;
    if (!changed && !vector) return before;

    db.transaction(() => {
      if (changed) {
        insertHistory.run({
          id, type: before.type, title: before.title, content: before.content, tags: current.tags,
          importance: before.importance, source: before.source, replacedAt: new Date().toISOString(),
        });
        db.prepare(`UPDATE memories SET type = @type, title = @title, content = @content, tags = @tags,
                           importance = @importance, updated_at = @updatedAt WHERE seq = @seq`).run({
          seq: current.seq, type: after.type, title: after.title, content: after.content,
          tags: JSON.stringify(after.tags), importance: after.importance, updatedAt: new Date().toISOString(),
        });
      }
      // New text makes the old vector wrong: replace it, or remove it.
      if (vector || textChanged) writeVector(current.seq, vector, sig);
    })();
    return toMemory(byId.get(id));
  }

  async function remove(id) {
    const current = byId.get(id);
    if (!current) return null;
    db.transaction(() => {
      if (vec) vec.remove.run(BigInt(current.seq));
      db.prepare('DELETE FROM memory_history WHERE memory_id = ?').run(id);
      db.prepare('DELETE FROM memories WHERE seq = ?').run(current.seq);
    })();
    return current.title;
  }

  async function list({ type, tags, limit, offset, order = 'importance' } = {}) {
    const filter = filterSql({ type, tags });
    const orderBy = order === 'recent' ? 'm.created_at DESC, m.seq DESC' : 'm.importance DESC, m.created_at DESC, m.seq DESC';
    return db.prepare(`SELECT ${COLUMNS} FROM memories m WHERE 1 = 1${filter.where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
      .all({ ...filter.params, limit: clamp(limit, 50, LIMITS.list), offset: Math.max(Number.parseInt(offset ?? 0, 10) || 0, 0) })
      .map(toMemory);
  }

  async function search({ query, queryEmbedding, mode = 'auto', limit, type, tags, sig } = {}) {
    if (!SEARCH_MODES.includes(mode)) throw new StoreError(`mode: must be one of ${SEARCH_MODES.join(', ')}`);
    const cap = clamp(limit, 10, LIMITS.search);
    const match = ftsMatchQuery(query);
    const vector = vec && queryEmbedding != null ? checkVector(queryEmbedding, 'query') : null;
    // A semantic search with no usable vector still answers, with words (v1 rule).
    const effectiveMode = mode === 'semantic' && !vector ? 'fulltext' : mode;
    if (!match && !vector) {
      return (await list({ type, tags, limit: cap })).map((memory) => ({ ...memory, score: 0, matched: [] }));
    }
    return rankCandidates(db, { match, vector, mode: effectiveMode, filter: filterSql({ type, tags }), sig })
      .slice(0, cap)
      .map(({ seq, score, matched }) => ({ ...toMemory(bySeq.get(seq)), score, matched }));
  }

  async function setEmbedding(id, embedding, sig) {
    if (!vec) return false;
    const vector = checkVector(embedding, sig);
    if (!vector) throw new StoreError('embedding: is required');
    const current = byId.get(id);
    if (!current) return false;
    db.transaction(() => writeVector(current.seq, vector, sig))();
    return true;
  }

  async function listNeedingEmbedding(sig, limit) {
    return db.prepare(`SELECT id, title, content FROM memories
                        WHERE embedding_sig IS NULL OR embedding_sig <> ? ORDER BY seq LIMIT ?`)
      .all(sig, clamp(limit, 100, 1000));
  }

  async function counts() {
    return db.prepare('SELECT count(*) AS total, count(embedding_sig) AS embedded FROM memories').get();
  }

  async function history(id) {
    return db.prepare('SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id DESC').all(id).map((row) => ({
      type: row.type,
      title: row.title,
      content: row.content,
      tags: JSON.parse(row.tags),
      importance: row.importance,
      source: row.source,
      replacedAt: row.replaced_at,
    }));
  }

  async function close() {
    db.close();
  }

  return Object.freeze({
    db, vectorSupported, vectorsReset,
    insert, importRows, getById, update, delete: remove, list, search, setEmbedding, listNeedingEmbedding, counts, history, close,
  });
}
