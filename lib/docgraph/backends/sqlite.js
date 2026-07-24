// lib/docgraph/backends/sqlite.js
// SQLite backend for docgraph. Parallel to lib/codegraph/backends/sqlite.js —
// same shape (better-sqlite3 sync wrapped in async, FTS5 + sqlite-vec, BigInt
// rowids), different domain: documents → sections → chunks instead of
// files → symbols → edges.
//
// Notes:
//   • vec0 wants rowid as BigInt — every chunk id passed to vec_docgraph_chunks
//     goes through BigInt(...).
//   • FTS5 BM25 rank is more-negative = better; we negate so larger = better,
//     keeping RRF math uniform with vector scores.
//   • The bulk indexRepoFiles pass embeds inline. The incremental indexOneFile
//     (watcher path) defers: it returns `pending` chunks and the watcher's
//     chunk-embedding queue backfills them via setChunkEmbedding (mirrors
//     codegraph's symbol-embedding queue).

import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { logError } from '../../helpers/logger.js';
import { chunkText } from '../chunk.js';
import { extractRefs } from '../extract-refs.js';
import {
  RETRIEVAL_LIMITS,
  buildCandidateManifest,
  retrieveInBatches,
} from '../retrieval.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const vecBuf = (e) => Float32Array.from(e);
const SNIPPET_CHARS = 320;

// Window the snippet around the first matching term (lowercased terms) so the
// hit is actually visible; fall back to the head of the chunk when nothing
// matches lexically (e.g. a vector-only hit).
const snippetOf = (text, terms = []) => {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= SNIPPET_CHARS) return clean;
  const lower = clean.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return clean.slice(0, SNIPPET_CHARS).trimEnd() + '…';
  // Little leading context so the matched term stays visible even when the list
  // row truncates the snippet to one line.
  const start = Math.max(0, at - 24);
  const end = Math.min(clean.length, start + SNIPPET_CHARS);
  return (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '');
};

// ── Indexer primitives ───────────────────────────────────────────────────────

function upsertRepoSync(db, rootPath) {
  const existing = db.prepare(`SELECT id FROM docgraph_repos WHERE root_path = ?`).get(rootPath);
  if (existing) return existing.id;
  const info = db.prepare(`INSERT INTO docgraph_repos (root_path) VALUES (?)`).run(rootPath);
  return Number(info.lastInsertRowid);
}

function upsertDocumentSync(db, repoId, { relPath, mime, size, mtime, hash }) {
  const existing = db.prepare(
    `SELECT id, sha256 FROM docgraph_documents WHERE repo_id = ? AND rel_path = ?`
  ).get(repoId, relPath);
  const now = new Date().toISOString();
  if (existing?.sha256 === hash) return { docId: existing.id, changed: false };
  if (existing) {
    db.prepare(
      `UPDATE docgraph_documents SET mime = ?, size = ?, mtime = ?, sha256 = ?, indexed_at = ? WHERE id = ?`
    ).run(mime, size, mtime.toISOString(), hash, now, existing.id);
    return { docId: existing.id, changed: true };
  }
  const info = db.prepare(
    `INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, mtime, sha256, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(repoId, relPath, mime, size, mtime.toISOString(), hash, now);
  return { docId: Number(info.lastInsertRowid), changed: true };
}

// Wipe and rebuild a document's sections + chunks from a fresh extraction.
// Cascade deletes (sections → chunks) plus FTS/vec triggers keep indexes in
// sync. Returns the pending {id, text} chunks awaiting embedding.
function reindexDocumentSync(db, docId, parsed) {
  db.prepare(`UPDATE docgraph_documents SET title = ?, summary = ? WHERE id = ?`)
    .run(parsed.title ?? null, parsed.summary ?? null, docId);
  // Sections cascade to chunks; refs only SET NULL their section_id, so wipe
  // them explicitly before re-extracting.
  db.prepare(`DELETE FROM docgraph_sections WHERE document_id = ?`).run(docId);
  db.prepare(`DELETE FROM docgraph_refs WHERE document_id = ?`).run(docId);

  const insSection = db.prepare(
    `INSERT INTO docgraph_sections (document_id, parent_id, ord, level, heading, text)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insChunk = db.prepare(
    `INSERT INTO docgraph_chunks (document_id, section_id, ord, text, token_count)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insRef = db.prepare(
    `INSERT INTO docgraph_refs (document_id, section_id, kind, value) VALUES (?, ?, ?, ?)`
  );

  const localToDb = new Map();
  const pending = [];
  let chunkCount = 0;
  let refCount = 0;
  for (const s of parsed.sections) {
    const parentDbId = s.parentLocalId != null ? (localToDb.get(s.parentLocalId) ?? null) : null;
    const secInfo = insSection.run(docId, parentDbId, s.ord, s.level, s.heading ?? null, s.text ?? '');
    const sectionId = Number(secInfo.lastInsertRowid);
    localToDb.set(s.localId, sectionId);

    const chunks = chunkText(s.text);
    chunks.forEach((c, i) => {
      const info = insChunk.run(docId, sectionId, i, c.text, c.token_count);
      pending.push({ id: Number(info.lastInsertRowid), text: c.text });
      chunkCount++;
    });

    for (const ref of extractRefs(s.text)) {
      insRef.run(docId, sectionId, ref.kind, ref.value);
      refCount++;
    }
  }
  return { sectionCount: parsed.sections.length, chunkCount, refCount, pending };
}

async function embedInline(db, pending, generateEmbedding) {
  if (!generateEmbedding) return;
  for (const { id, text } of pending) {
    const vec = await generateEmbedding(text, 'document').catch(() => null);
    if (!vec) continue;
    db.prepare(`DELETE FROM vec_docgraph_chunks WHERE rowid = ?`).run(BigInt(id));
    db.prepare(`INSERT INTO vec_docgraph_chunks (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(id), vecBuf(vec));
  }
}

// ── Public indexer API ──────────────────────────────────────────────────────

export async function indexRepoFiles(store, rootPath, fileIterator, { generateEmbedding, deferEmbedding = false, onProgress } = {}) {
  const db = store.db;
  const counts = { docs: 0, changed: 0, sections: 0, chunks: 0, skipped: 0 };
  const pending = []; // collected for the caller's queue when deferEmbedding
  const repoId = upsertRepoSync(db, rootPath);

  for await (const { abs, rel, mime, extract } of fileIterator) {
    try {
      const buf = await readFile(abs);
      const hash = sha256(buf);
      const st = await stat(abs);
      const { docId, changed } = upsertDocumentSync(db, repoId, {
        relPath: rel, mime, size: st.size, mtime: st.mtime, hash,
      });
      counts.docs++;
      // Throttled live progress so the UI shows movement during a long folder.
      if (onProgress && counts.docs % 20 === 0) onProgress({ ...counts });
      if (!changed) continue;

      const parsed = await extract(buf, rel);
      const result = reindexDocumentSync(db, docId, parsed);
      if (deferEmbedding) for (const p of result.pending) pending.push(p);
      else await embedInline(db, result.pending, generateEmbedding);
      counts.changed++;
      counts.sections += result.sectionCount;
      counts.chunks += result.chunkCount;
    } catch (err) {
      counts.skipped++;
      logError(`[docgraph/sqlite] indexRepo: skipped ${rel}`, err, { repo: rootPath });
    }
  }

  const docCount = db.prepare(`SELECT COUNT(*) AS n FROM docgraph_documents WHERE repo_id = ?`).get(repoId).n;
  const chunkCount = db.prepare(
    `SELECT COUNT(*) AS n FROM docgraph_chunks c JOIN docgraph_documents d ON d.id = c.document_id WHERE d.repo_id = ?`
  ).get(repoId).n;
  db.prepare(`UPDATE docgraph_repos SET last_indexed_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), repoId);
  return { ...counts, docCount, chunkCount, pending };
}

// Incremental single-document index (watcher add/change). Reads the file,
// short-circuits on unchanged sha256, otherwise re-extracts. Embedding is
// deferred to the watcher's queue: returns `pending` chunks unless a caller
// passes embedInlineFn to force synchronous embedding.
export async function indexOneFile(store, rootPath, relPath, { mime, extract, embedInlineFn = null } = {}) {
  const db = store.db;
  const abs = path.join(rootPath, relPath);
  let buf, st;
  try { buf = await readFile(abs); st = await stat(abs); }
  catch { return { skipped: true, reason: 'file gone' }; }
  const hash = sha256(buf);

  const repoId = upsertRepoSync(db, rootPath);
  const { docId, changed } = upsertDocumentSync(db, repoId, {
    relPath, mime, size: st.size, mtime: st.mtime, hash,
  });
  if (!changed) return { skipped: true, reason: 'unchanged' };

  const parsed = await extract(buf, relPath);
  const result = reindexDocumentSync(db, docId, parsed);
  await embedInline(db, result.pending, embedInlineFn);
  return { skipped: false, ...result };
}

export async function removeOneFile(store, rootPath, relPath) {
  const db = store.db;
  const repo = db.prepare(`SELECT id FROM docgraph_repos WHERE root_path = ?`).get(rootPath);
  if (!repo) return { removed: false };
  const info = db.prepare(`DELETE FROM docgraph_documents WHERE repo_id = ? AND rel_path = ?`).run(repo.id, relPath);
  return { removed: info.changes > 0 };
}

// Backfill a single chunk's embedding (async chunk-embedding queue target).
export async function setChunkEmbedding(store, chunkId, embedding) {
  const db = store.db;
  db.prepare(`DELETE FROM vec_docgraph_chunks WHERE rowid = ?`).run(BigInt(chunkId));
  db.prepare(`INSERT INTO vec_docgraph_chunks (rowid, embedding) VALUES (?, ?)`)
    .run(BigInt(chunkId), vecBuf(embedding));
}

// Drop DB rows for documents deleted from disk while the watcher was off.
export async function sweepMissingFiles(store, rootPath, statFn) {
  const db = store.db;
  const repo = db.prepare(`SELECT id FROM docgraph_repos WHERE root_path = ?`).get(rootPath);
  if (!repo) return { removed: 0 };
  const docs = db.prepare(`SELECT rel_path FROM docgraph_documents WHERE repo_id = ?`).all(repo.id);
  const gone = [];
  for (const d of docs) {
    try { await statFn(path.join(rootPath, d.rel_path)); }
    catch { gone.push(d.rel_path); }
  }
  if (gone.length) {
    const placeholders = gone.map(() => '?').join(',');
    db.prepare(`DELETE FROM docgraph_documents WHERE repo_id = ? AND rel_path IN (${placeholders})`)
      .run(repo.id, ...gone);
  }
  return { removed: gone.length };
}

export async function deleteRepo(store, rootPath) {
  const info = store.db.prepare(`DELETE FROM docgraph_repos WHERE root_path = ?`).run(rootPath);
  return { deleted: info.changes > 0 };
}

// ── Read-side query API ──────────────────────────────────────────────────────

// Every result carrying a repo-relative path also carries its repo so callers
// never guess which folder a relative path belongs to (multiple repos can share
// a layout). Mirrors codegraph's withRepo.
const withRepo = (row) => row && { ...row, repo: path.basename(row.root_path) };

function resolveRepoIdSync(db, folder) {
  if (!folder) return null;
  const exact = db.prepare(`SELECT id FROM docgraph_repos WHERE root_path = ?`).all(folder);
  if (exact.length === 1) return exact[0].id;
  const rows = db.prepare(
    `SELECT id, root_path FROM docgraph_repos WHERE root_path LIKE '%' || ? || '%'`
  ).all(folder);
  if (rows.length === 0) { const e = new Error(`No indexed folder matches '${folder}'.`); e.userFacing = true; throw e; }
  if (rows.length > 1)   { const e = new Error(`Ambiguous folder '${folder}' — matches: ${rows.map(r => r.root_path).join(', ')}`); e.userFacing = true; throw e; }
  return rows[0].id;
}

function ftsTokens(q) {
  return q.split(/[\s\-\/\\.,;:()\[\]{}'"!?@#$%^&*+=<>|~`]+/).filter(Boolean);
}

// FTS5 reads bare `-term` as NOT, throwing "no such column" when the term isn't
// a column name. Tokenize on non-word chars, then prefix-match each token so
// search-as-you-type works: "introduc" → "introduc"* matches "introduction".
function safeFtsQuery(q) {
  const tokens = ftsTokens(q);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(' ') : q;
}

export async function search(store, { query, folder, mime, limit = 20 }, { generateEmbedding, vectorEnabled } = {}) {
  const db = store.db;
  const repoId = resolveRepoIdSync(db, folder);
  const useVector = vectorEnabled?.() ?? false;
  const queryVec = useVector ? await generateEmbedding?.(query, 'query').catch(() => null) : null;
  const ftsQuery = safeFtsQuery(query);
  const terms = ftsTokens(query).map((t) => t.toLowerCase());

  const detailById = (ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT c.id AS chunk_id, c.section_id, c.text AS chunk_text,
             d.rel_path, d.title, d.mime, s.heading, s.level, r.root_path
        FROM docgraph_chunks c
        JOIN docgraph_sections  s ON s.id = c.section_id
        JOIN docgraph_documents d ON d.id = c.document_id
        JOIN docgraph_repos     r ON r.id = d.repo_id
       WHERE c.id IN (${placeholders})
    `).all(...ids);
    return new Map(rows.map((r) => [r.chunk_id, r]));
  };
  const toHit = (r, score) => ({
    score,
    document: { rel_path: r.rel_path, title: r.title, mime: r.mime, repo: path.basename(r.root_path), root_path: r.root_path },
    section: { id: r.section_id, heading: r.heading, level: r.level },
    chunk_id: r.chunk_id,
    snippet: snippetOf(r.chunk_text, terms),
  });

  // ── FTS-only path ──────────────────────────────────────────────────────────
  if (!queryVec) {
    const params = { q: ftsQuery, cap: limit };
    const conds = [`docgraph_fts MATCH @q`];
    if (repoId) { conds.push(`d.repo_id = @repo`); params.repo = repoId; }
    if (mime)   { conds.push(`d.mime = @mime`);    params.mime = mime; }
    const rows = db.prepare(`
      SELECT c.id AS chunk_id, c.section_id, c.text AS chunk_text,
             d.rel_path, d.title, d.mime, s.heading, s.level, r.root_path,
             (-docgraph_fts.rank) AS score
        FROM docgraph_fts
        JOIN docgraph_chunks    c ON c.id = docgraph_fts.rowid
        JOIN docgraph_sections  s ON s.id = c.section_id
        JOIN docgraph_documents d ON d.id = c.document_id
        JOIN docgraph_repos     r ON r.id = d.repo_id
       WHERE ${conds.join(' AND ')}
       ORDER BY score DESC
       LIMIT @cap
    `).all(params);
    return { matches: rows.map((r) => toHit(r, r.score)), mode: 'fulltext' };
  }

  // ── Hybrid path — FTS (lexical) is AUTHORITATIVE; vector search is only a
  // fallback for queries with no lexical hit at all. A naive RRF blend lets a
  // top vector hit (rank 1 → 1/61) tie or outrank real text matches, so with a
  // weak local embedding model an irrelevant chunk (none of the query terms)
  // surfaces at #1 and pollutes the tail. Lexical-first matches the "find in
  // document" expectation; pure-semantic still kicks in when FTS finds nothing.
  const ftsConds = [`docgraph_fts MATCH @q`];
  const params = { q: ftsQuery, cap: limit };
  if (repoId) { ftsConds.push(`d.repo_id = @repo`); params.repo = repoId; }
  if (mime)   { ftsConds.push(`d.mime = @mime`);    params.mime = mime; }

  const ftsRows = db.prepare(`
    SELECT c.id FROM docgraph_fts
      JOIN docgraph_chunks    c ON c.id = docgraph_fts.rowid
      JOIN docgraph_documents d ON d.id = c.document_id
     WHERE ${ftsConds.join(' AND ')}
     ORDER BY docgraph_fts.rank
     LIMIT @cap
  `).all(params);

  let orderedIds = ftsRows.map((r) => r.id);
  if (orderedIds.length === 0) {
    // No lexical hit anywhere — fall back to nearest-vector chunks.
    const vecConds = [`vec_docgraph_chunks.embedding MATCH @vec`, `k = 60`];
    const vparams = { vec: vecBuf(queryVec) };
    if (repoId) { vecConds.push(`d.repo_id = @repo`); vparams.repo = repoId; }
    if (mime)   { vecConds.push(`d.mime = @mime`);    vparams.mime = mime; }
    const vecRows = db.prepare(`
      SELECT c.id FROM vec_docgraph_chunks
        JOIN docgraph_chunks    c ON c.id = vec_docgraph_chunks.rowid
        JOIN docgraph_documents d ON d.id = c.document_id
       WHERE ${vecConds.join(' AND ')}
       ORDER BY vec_docgraph_chunks.distance
       LIMIT 60
    `).all(vparams);
    orderedIds = vecRows.map((r) => r.id).slice(0, limit);
  }
  if (orderedIds.length === 0) return { matches: [], mode: 'hybrid' };

  const detail = detailById(orderedIds);
  const matches = orderedIds
    .map((id, i) => { const r = detail.get(id); return r ? toHit(r, (orderedIds.length - i) / orderedIds.length) : null; })
    .filter(Boolean);
  return { matches, mode: 'hybrid' };
}

export async function outline(store, { path: docPath, folder }) {
  const db = store.db;
  const repoId = resolveRepoIdSync(db, folder);
  const doc = db.prepare(`
    SELECT d.id, d.title, d.mime, d.summary, r.root_path
      FROM docgraph_documents d JOIN docgraph_repos r ON r.id = d.repo_id
     WHERE d.rel_path = ? ${repoId ? 'AND d.repo_id = ?' : ''}
     ORDER BY r.root_path LIMIT 1
  `).get(...(repoId ? [docPath, repoId] : [docPath]));
  if (!doc) return null;
  const sections = db.prepare(`
    SELECT s.id, s.parent_id, s.ord, s.level, s.heading,
           (SELECT COUNT(*) FROM docgraph_chunks c WHERE c.section_id = s.id) AS chunks
      FROM docgraph_sections s
     WHERE s.document_id = ?
     ORDER BY s.ord
  `).all(doc.id);
  return { path: docPath, title: doc.title, mime: doc.mime, summary: doc.summary,
           repo: path.basename(doc.root_path), root_path: doc.root_path, sections };
}

// Returns the stored text for a section or chunk. Section text is persisted at
// index time (not re-sliced from the file), so this works uniformly across
// formats — including PDF/DOCX where file offsets are meaningless — and is
// robust to the source file moving.
export async function context(store, { path: docPath, section_id, chunk_id, folder }) {
  const db = store.db;
  const repoId = resolveRepoIdSync(db, folder);

  if (chunk_id != null) {
    const row = db.prepare(`
      SELECT c.text, c.ord, s.heading, d.rel_path, r.root_path
        FROM docgraph_chunks c
        JOIN docgraph_sections  s ON s.id = c.section_id
        JOIN docgraph_documents d ON d.id = c.document_id
        JOIN docgraph_repos     r ON r.id = d.repo_id
       WHERE c.id = ? ${repoId ? 'AND d.repo_id = ?' : ''} LIMIT 1
    `).get(...(repoId ? [chunk_id, repoId] : [chunk_id]));
    return row ? { mode: 'chunk', heading: row.heading, rel_path: row.rel_path, root_path: row.root_path, text: row.text } : null;
  }

  if (section_id == null) { const e = new Error('section_id or chunk_id is required'); e.userFacing = true; throw e; }
  const row = db.prepare(`
    SELECT s.heading, s.text, d.rel_path, r.root_path
      FROM docgraph_sections s
      JOIN docgraph_documents d ON d.id = s.document_id
      JOIN docgraph_repos     r ON r.id = d.repo_id
     WHERE s.id = ? ${repoId ? 'AND d.repo_id = ?' : ''} LIMIT 1
  `).get(...(repoId ? [section_id, repoId] : [section_id]));
  if (!row) return null;
  return { mode: 'section', heading: row.heading, rel_path: row.rel_path, root_path: row.root_path, text: row.text };
}

export async function repos(store) {
  const db = store.db;
  const rows = db.prepare(`
    SELECT r.id, r.root_path, r.last_indexed_at,
           COUNT(DISTINCT d.id) AS docs,
           COUNT(c.id)          AS chunks
      FROM docgraph_repos r
      LEFT JOIN docgraph_documents d ON d.repo_id = r.id
      LEFT JOIN docgraph_chunks    c ON c.document_id = d.id
     GROUP BY r.id ORDER BY r.last_indexed_at IS NULL, r.last_indexed_at DESC
  `).all();
  const mimeStmt = db.prepare(
    `SELECT mime, COUNT(*) AS n FROM docgraph_documents WHERE repo_id = ? GROUP BY mime ORDER BY n DESC`
  );
  return {
    repos: rows.map((r) => ({
      ...withRepo(r),
      by_mime: Object.fromEntries(mimeStmt.all(r.id).map((m) => [m.mime, m.n])),
    })),
  };
}

// ── Manifest-first retrieval ────────────────────────────────────────────────

/** Return bounded, deterministic document candidates without reading content. */
export async function manifest(store, { query = '', folder, mime, limit = RETRIEVAL_LIMITS.maxCandidates } = {}) {
  const db = store.db;
  const repoId = resolveRepoIdSync(db, folder);
  const params = {};
  const conditions = [];
  if (repoId) { conditions.push('d.repo_id = @repo'); params.repo = repoId; }
  if (mime) { conditions.push('d.mime = @mime'); params.mime = mime; }
  // Candidate scoring uses title/summary/headings only — never section body
  // text. Manifest-first means bounded metadata reads before any content
  // read; GROUP_CONCAT(s.text) here would materialize every document's full
  // body for the whole corpus before the candidate limit is even applied,
  // contradicting that contract (real bodies are read later, per-candidate,
  // by batch() below, which is bounded to the requested id list).
  const rows = db.prepare(`
    SELECT d.id, d.repo_id, r.root_path, d.rel_path, d.mime, d.size,
           d.mtime, d.sha256, d.title, d.summary,
           GROUP_CONCAT(COALESCE(s.heading, ''), ' ') AS headings
      FROM docgraph_documents d
      JOIN docgraph_repos r ON r.id = d.repo_id
      LEFT JOIN docgraph_sections s ON s.document_id = d.id
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     GROUP BY d.id
  `).all(params);
  return buildCandidateManifest(rows, { query, limit });
}

/** Read a manifest through bounded database batches and return coverage. */
export async function batch(store, { candidates = [], signal, batch_size, max_file_bytes, max_batch_bytes, max_total_bytes } = {}) {
  const db = store.db;
  return retrieveInBatches(candidates, {
    signal,
    batchSize: batch_size ?? RETRIEVAL_LIMITS.batchSize,
    maxFileBytes: max_file_bytes ?? RETRIEVAL_LIMITS.maxFileBytes,
    maxBatchBytes: max_batch_bytes ?? RETRIEVAL_LIMITS.maxBatchBytes,
    maxTotalBytes: max_total_bytes ?? RETRIEVAL_LIMITS.maxTotalBytes,
    readBatch: async (batchCandidates) => {
      if (signal?.aborted) {
        const err = new Error('Document batch read aborted');
        err.name = 'AbortError';
        throw err;
      }
      const ids = batchCandidates.map(c => Number(c.id)).filter(Number.isInteger);
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(',');
      // ORDER BY inside the aggregate (SQLite 3.44+) mirrors the Postgres
      // batch query's `string_agg(..., ORDER BY s.ord)` — without it,
      // GROUP_CONCAT's row order is whatever the query planner happens to
      // produce, which can silently rearrange a document's sections.
      const rows = db.prepare(`
        SELECT d.id, d.mime, d.title, d.rel_path, r.root_path,
               GROUP_CONCAT(s.text, char(10) || char(10) ORDER BY s.ord) AS text
          FROM docgraph_documents d
          JOIN docgraph_repos r ON r.id = d.repo_id
          LEFT JOIN docgraph_sections s ON s.document_id = d.id
         WHERE d.id IN (${placeholders})
         GROUP BY d.id
      `).all(...ids);
      return rows.map(row => ({
        id: row.id,
        text: row.text ?? '',
        bytes: Buffer.byteLength(row.text ?? '', 'utf8'),
        mime: row.mime,
        title: row.title,
        rel_path: row.rel_path,
        root_path: row.root_path,
      }));
    },
  });
}

// Find every document mentioning a given reference (URL, ID, citation key,
// email, wikilink). Matches the ref value case-insensitively (exact).
export async function refs(store, { ref, folder, limit = 50 }) {
  const db = store.db;
  const repoId = resolveRepoIdSync(db, folder);
  const params = repoId ? [ref, repoId, limit] : [ref, limit];
  const rows = db.prepare(`
    SELECT DISTINCT rf.kind, rf.value, rf.section_id, s.heading,
           d.rel_path, d.title, d.mime, r.root_path
      FROM docgraph_refs rf
      JOIN docgraph_documents d ON d.id = rf.document_id
      JOIN docgraph_repos     r ON r.id = d.repo_id
      LEFT JOIN docgraph_sections s ON s.id = rf.section_id
     WHERE rf.value = ? COLLATE NOCASE ${repoId ? 'AND d.repo_id = ?' : ''}
     ORDER BY d.rel_path
     LIMIT ?
  `).all(...params);
  return {
    ref,
    matches: rows.map((row) => ({
      kind: row.kind,
      value: row.value,
      document: { rel_path: row.rel_path, title: row.title, mime: row.mime, repo: path.basename(row.root_path), root_path: row.root_path },
      section: { id: row.section_id, heading: row.heading },
    })),
  };
}
