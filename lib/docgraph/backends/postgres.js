// lib/docgraph/backends/postgres.js
// Postgres backend for docgraph. Parallel to backends/sqlite.js — same exported
// functions, pg dialect (pgvector for embeddings, tsvector/GIN for FTS, RRF
// fused in SQL). Mirrors lib/codegraph/backends/postgres.js conventions.
//
// Every export takes the store and pulls `.pool` internally; the dispatcher in
// indexer.js / docgraphHandlers.js routes to the right backend.

import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { logError } from '../../helpers/logger.js';
import { chunkText } from '../chunk.js';
import { extractRefs } from '../extract-refs.js';

const toVec = (e) => `[${e.join(',')}]`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// Postgres text/tsvector columns reject NUL (0x00); some inputs (e.g. lcov HTML
// reports) carry stray NULs. Strip them before insert — never meaningful here.
const noNul = (s) => (s == null ? s : String(s).replace(/\u0000/g, ""));
const SNIPPET_CHARS = 320;
// Window the snippet around the first matching term so the hit is visible;
// fall back to the head of the chunk for vector-only (non-lexical) hits.
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

// Prefix tsquery ("introduc" → introduction). null when no usable tokens, so
// the caller falls back to plainto_tsquery on the raw text.
function tsPrefixQuery(q) {
  const tokens = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.length ? tokens.map((t) => `${t}:*`).join(' & ') : null;
}

// ── Indexer primitives ───────────────────────────────────────────────────────

async function upsertRepo(client, rootPath) {
  const { rows } = await client.query(
    `INSERT INTO docgraph_repos (root_path) VALUES ($1)
     ON CONFLICT (root_path) DO UPDATE SET root_path = EXCLUDED.root_path
     RETURNING id`, [rootPath]
  );
  return rows[0].id;
}

async function upsertDocument(client, repoId, { relPath, mime, size, mtime, hash }) {
  const existing = await client.query(
    `SELECT id, sha256 FROM docgraph_documents WHERE repo_id = $1 AND rel_path = $2`,
    [repoId, relPath]
  );
  if (existing.rows[0]?.sha256 === hash) return { docId: existing.rows[0].id, changed: false };
  const { rows } = await client.query(
    `INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, mtime, sha256, indexed_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (repo_id, rel_path) DO UPDATE
       SET mime=EXCLUDED.mime, size=EXCLUDED.size, mtime=EXCLUDED.mtime,
           sha256=EXCLUDED.sha256, indexed_at=now()
     RETURNING id`,
    [repoId, relPath, mime, size, mtime, hash]
  );
  return { docId: rows[0].id, changed: true };
}

async function reindexDocument(client, docId, parsed) {
  await client.query(`UPDATE docgraph_documents SET title=$1, summary=$2 WHERE id=$3`,
    [noNul(parsed.title) ?? null, noNul(parsed.summary) ?? null, docId]);
  await client.query(`DELETE FROM docgraph_sections WHERE document_id=$1`, [docId]);
  await client.query(`DELETE FROM docgraph_refs WHERE document_id=$1`, [docId]);

  const localToDb = new Map();
  const pending = [];
  let chunkCount = 0, refCount = 0;
  for (const s of parsed.sections) {
    const parent = s.parentLocalId != null ? (localToDb.get(s.parentLocalId) ?? null) : null;
    const { rows } = await client.query(
      `INSERT INTO docgraph_sections (document_id, parent_id, ord, level, heading, text)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [docId, parent, s.ord, s.level, noNul(s.heading) ?? null, noNul(s.text) ?? '']
    );
    const sectionId = rows[0].id;
    localToDb.set(s.localId, sectionId);

    for (const [i, c] of chunkText(s.text).entries()) {
      const text = noNul(c.text);
      const { rows: cr } = await client.query(
        `INSERT INTO docgraph_chunks (document_id, section_id, ord, text, token_count)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [docId, sectionId, i, text, c.token_count]
      );
      pending.push({ id: cr[0].id, text });
      chunkCount++;
    }
    for (const ref of extractRefs(s.text)) {
      await client.query(
        `INSERT INTO docgraph_refs (document_id, section_id, kind, value) VALUES ($1,$2,$3,$4)`,
        [docId, sectionId, ref.kind, noNul(ref.value)]
      );
      refCount++;
    }
  }
  return { sectionCount: parsed.sections.length, chunkCount, refCount, pending };
}

async function embedInline(client, pending, generateEmbedding) {
  if (!generateEmbedding) return;
  for (const { id, text } of pending) {
    const vec = await generateEmbedding(text, 'document').catch(() => null);
    if (!vec) continue;
    await client.query(`UPDATE docgraph_chunks SET embedding=$1::vector WHERE id=$2`, [toVec(vec), id]);
  }
}

// ── Public indexer API ──────────────────────────────────────────────────────

export async function indexRepoFiles(store, rootPath, fileIterator, { generateEmbedding, deferEmbedding = false } = {}) {
  const client = await store.pool.connect();
  const counts = { docs: 0, changed: 0, sections: 0, chunks: 0, skipped: 0 };
  const pending = []; // returned (post-COMMIT) for the caller's queue when deferEmbedding
  try {
    await client.query('BEGIN');
    const repoId = await upsertRepo(client, rootPath);

    for await (const { abs, rel, mime, extract } of fileIterator) {
      // Per-file savepoint: a failed statement aborts the surrounding
      // transaction in Postgres, so without this one bad file would poison the
      // whole batch (every later file failing with "transaction is aborted").
      await client.query('SAVEPOINT doc');
      try {
        const buf = await readFile(abs);
        const hash = sha256(buf);
        const st = await stat(abs);
        const { docId, changed } = await upsertDocument(client, repoId, {
          relPath: rel, mime, size: st.size, mtime: st.mtime, hash,
        });
        counts.docs++;
        if (!changed) { await client.query('RELEASE SAVEPOINT doc'); continue; }
        const parsed = await extract(buf, rel);
        const result = await reindexDocument(client, docId, parsed);
        if (deferEmbedding) for (const p of result.pending) pending.push(p);
        else await embedInline(client, result.pending, generateEmbedding);
        counts.changed++;
        counts.sections += result.sectionCount;
        counts.chunks += result.chunkCount;
        await client.query('RELEASE SAVEPOINT doc');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT doc');
        counts.skipped++;
        logError(`[docgraph/pg] indexRepo: skipped ${rel}`, err, { repo: rootPath });
      }
    }
    await client.query(`UPDATE docgraph_repos SET last_indexed_at = now() WHERE id = $1`, [repoId]);
    await client.query('COMMIT');

    const { rows: dc } = await client.query(`SELECT COUNT(*)::int AS n FROM docgraph_documents WHERE repo_id=$1`, [repoId]);
    const { rows: cc } = await client.query(
      `SELECT COUNT(*)::int AS n FROM docgraph_chunks c JOIN docgraph_documents d ON d.id=c.document_id WHERE d.repo_id=$1`, [repoId]);
    return { ...counts, docCount: dc[0].n, chunkCount: cc[0].n, pending };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function indexOneFile(store, rootPath, relPath, { mime, extract, embedInlineFn = null } = {}) {
  const abs = path.join(rootPath, relPath);
  let buf, st;
  try { buf = await readFile(abs); st = await stat(abs); }
  catch { return { skipped: true, reason: 'file gone' }; }
  const hash = sha256(buf);

  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    const repoId = await upsertRepo(client, rootPath);
    const { docId, changed } = await upsertDocument(client, repoId, {
      relPath, mime, size: st.size, mtime: st.mtime, hash,
    });
    if (!changed) { await client.query('COMMIT'); return { skipped: true, reason: 'unchanged' }; }
    const parsed = await extract(buf, relPath);
    const result = await reindexDocument(client, docId, parsed);
    await embedInline(client, result.pending, embedInlineFn);
    await client.query('COMMIT');
    return { skipped: false, ...result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Backfill a single chunk's embedding (async chunk-embedding queue target).
export async function setChunkEmbedding(store, chunkId, embedding) {
  await store.pool.query(`UPDATE docgraph_chunks SET embedding=$1::vector WHERE id=$2`, [toVec(embedding), chunkId]);
}

export async function removeOneFile(store, rootPath, relPath) {
  const { rows } = await store.pool.query(`SELECT id FROM docgraph_repos WHERE root_path=$1`, [rootPath]);
  if (!rows[0]) return { removed: false };
  const { rowCount } = await store.pool.query(
    `DELETE FROM docgraph_documents WHERE repo_id=$1 AND rel_path=$2`, [rows[0].id, relPath]
  );
  return { removed: rowCount > 0 };
}

export async function sweepMissingFiles(store, rootPath, statFn) {
  const { rows: r } = await store.pool.query(`SELECT id FROM docgraph_repos WHERE root_path=$1`, [rootPath]);
  if (!r[0]) return { removed: 0 };
  const repoId = r[0].id;
  const { rows } = await store.pool.query(`SELECT rel_path FROM docgraph_documents WHERE repo_id=$1`, [repoId]);
  const gone = [];
  for (const row of rows) {
    try { await statFn(path.join(rootPath, row.rel_path)); }
    catch { gone.push(row.rel_path); }
  }
  if (gone.length) {
    await store.pool.query(`DELETE FROM docgraph_documents WHERE repo_id=$1 AND rel_path = ANY($2)`, [repoId, gone]);
  }
  return { removed: gone.length };
}

export async function deleteRepo(store, rootPath) {
  const { rowCount } = await store.pool.query(`DELETE FROM docgraph_repos WHERE root_path=$1`, [rootPath]);
  return { deleted: rowCount > 0 };
}

// ── Read-side query API ──────────────────────────────────────────────────────

async function resolveRepoId(pool, folder) {
  if (!folder) return null;
  const exact = await pool.query(`SELECT id FROM docgraph_repos WHERE root_path=$1`, [folder]);
  if (exact.rows.length === 1) return exact.rows[0].id;
  const { rows } = await pool.query(
    `SELECT id, root_path FROM docgraph_repos WHERE root_path ILIKE '%' || $1 || '%'`, [folder]
  );
  if (rows.length === 0) { const e = new Error(`No indexed folder matches '${folder}'.`); e.userFacing = true; throw e; }
  if (rows.length > 1)   { const e = new Error(`Ambiguous folder '${folder}' — matches: ${rows.map(r => r.root_path).join(', ')}`); e.userFacing = true; throw e; }
  return rows[0].id;
}

const toHit = (r, score, terms = []) => ({
  score,
  document: { rel_path: r.rel_path, title: r.title, mime: r.mime, repo: path.basename(r.root_path), root_path: r.root_path },
  section: { id: r.section_id, heading: r.heading, level: r.level },
  chunk_id: r.chunk_id,
  snippet: snippetOf(r.chunk_text, terms),
});

export async function search(store, { query, folder, mime, limit = 20 }, { generateEmbedding, vectorEnabled } = {}) {
  const pool = store.pool;
  const repoId = await resolveRepoId(pool, folder);
  const useVector = vectorEnabled?.() ?? false;
  const queryVec = useVector ? await generateEmbedding?.(query, 'query').catch(() => null) : null;

  // Prefix-match each token so search-as-you-type works ("introduc" → introduction).
  // tsFn is an internal constant (never user input), so interpolating it is safe.
  const tsq = tsPrefixQuery(query);
  const tsFn = tsq ? 'to_tsquery' : 'plainto_tsquery';
  const tsParam = tsq ?? query;
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  if (!queryVec) {
    const params = [tsParam];
    const conds = [`to_tsvector('simple', c.text) @@ ${tsFn}('simple', $1)`];
    if (repoId) { params.push(repoId); conds.push(`d.repo_id = $${params.length}`); }
    if (mime)   { params.push(mime);   conds.push(`d.mime = $${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT c.id AS chunk_id, c.section_id, c.text AS chunk_text,
              d.rel_path, d.title, d.mime, s.heading, s.level, r.root_path,
              ts_rank(to_tsvector('simple', c.text), ${tsFn}('simple', $1)) AS score
         FROM docgraph_chunks c
         JOIN docgraph_sections  s ON s.id = c.section_id
         JOIN docgraph_documents d ON d.id = c.document_id
         JOIN docgraph_repos     r ON r.id = d.repo_id
        WHERE ${conds.join(' AND ')} ORDER BY score DESC LIMIT $${params.length}`,
      params
    );
    return { matches: rows.map((r) => toHit(r, r.score, terms)), mode: 'fulltext' };
  }

  const params = [toVec(queryVec), tsParam];
  let idx = 3;
  const extra = [];
  if (repoId) { extra.push(`AND d.repo_id = $${idx++}`); params.push(repoId); }
  if (mime)   { extra.push(`AND d.mime = $${idx++}`);    params.push(mime); }
  const extras = extra.join(' ');
  params.push(limit);
  const { rows } = await pool.query(`
    WITH vector_ranked AS (
      SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
        FROM docgraph_chunks c JOIN docgraph_documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL ${extras}
       LIMIT 60
    ),
    fts_ranked AS (
      SELECT c.id, ROW_NUMBER() OVER (
               ORDER BY ts_rank(to_tsvector('simple', c.text), ${tsFn}('simple', $2)) DESC) AS rank
        FROM docgraph_chunks c JOIN docgraph_documents d ON d.id = c.document_id
       WHERE to_tsvector('simple', c.text) @@ ${tsFn}('simple', $2) ${extras}
       LIMIT 60
    ),
    fused AS (
      -- FTS (text) is authoritative; vector-only rows are kept only when there
      -- are no lexical hits at all, so a weak embedding model can't float an
      -- irrelevant chunk above (or alongside) real text matches.
      SELECT COALESCE(f.id, v.id) AS id, f.rank AS fts_rank, v.rank AS vec_rank
        FROM fts_ranked f FULL OUTER JOIN vector_ranked v ON v.id = f.id
    )
    SELECT c.id AS chunk_id, c.section_id, c.text AS chunk_text,
           d.rel_path, d.title, d.mime, s.heading, s.level, r.root_path,
           COALESCE(1.0/(60+fu.fts_rank), 0.0) + COALESCE(1.0/(60+fu.vec_rank), 0.0) AS score
      FROM fused fu
      JOIN docgraph_chunks    c ON c.id = fu.id
      JOIN docgraph_sections  s ON s.id = c.section_id
      JOIN docgraph_documents d ON d.id = c.document_id
      JOIN docgraph_repos     r ON r.id = d.repo_id
     WHERE fu.fts_rank IS NOT NULL OR NOT EXISTS (SELECT 1 FROM fts_ranked)
     ORDER BY (fu.fts_rank IS NULL), fu.fts_rank NULLS LAST, fu.vec_rank NULLS LAST
     LIMIT $${idx}
  `, params);
  return { matches: rows.map((r) => toHit(r, r.score, terms)), mode: 'hybrid' };
}

export async function outline(store, { path: docPath, folder }) {
  const pool = store.pool;
  const repoId = await resolveRepoId(pool, folder);
  const docParams = repoId ? [docPath, repoId] : [docPath];
  const { rows: docs } = await pool.query(
    `SELECT d.id, d.title, d.mime, d.summary, r.root_path
       FROM docgraph_documents d JOIN docgraph_repos r ON r.id = d.repo_id
      WHERE d.rel_path = $1 ${repoId ? 'AND d.repo_id = $2' : ''}
      ORDER BY r.root_path LIMIT 1`, docParams
  );
  if (!docs[0]) return null;
  const doc = docs[0];
  const { rows: sections } = await pool.query(
    `SELECT s.id, s.parent_id, s.ord, s.level, s.heading,
            (SELECT COUNT(*)::int FROM docgraph_chunks c WHERE c.section_id = s.id) AS chunks
       FROM docgraph_sections s WHERE s.document_id = $1 ORDER BY s.ord`, [doc.id]
  );
  return { path: docPath, title: doc.title, mime: doc.mime, summary: doc.summary,
           repo: path.basename(doc.root_path), root_path: doc.root_path, sections };
}

export async function context(store, { path: docPath, section_id, chunk_id, folder }) {
  const pool = store.pool;
  const repoId = await resolveRepoId(pool, folder);

  if (chunk_id != null) {
    const params = repoId ? [chunk_id, repoId] : [chunk_id];
    const { rows } = await pool.query(
      `SELECT c.text, c.ord, s.heading, d.rel_path, r.root_path
         FROM docgraph_chunks c
         JOIN docgraph_sections  s ON s.id = c.section_id
         JOIN docgraph_documents d ON d.id = c.document_id
         JOIN docgraph_repos     r ON r.id = d.repo_id
        WHERE c.id = $1 ${repoId ? 'AND d.repo_id = $2' : ''} LIMIT 1`, params
    );
    return rows[0] ? { mode: 'chunk', heading: rows[0].heading, rel_path: rows[0].rel_path, root_path: rows[0].root_path, text: rows[0].text } : null;
  }

  if (section_id == null) { const e = new Error('section_id or chunk_id is required'); e.userFacing = true; throw e; }
  const params = repoId ? [section_id, repoId] : [section_id];
  const { rows } = await pool.query(
    `SELECT s.heading, s.text, d.rel_path, r.root_path
       FROM docgraph_sections s
       JOIN docgraph_documents d ON d.id = s.document_id
       JOIN docgraph_repos     r ON r.id = d.repo_id
      WHERE s.id = $1 ${repoId ? 'AND d.repo_id = $2' : ''} LIMIT 1`, params
  );
  if (!rows[0]) return null;
  return { mode: 'section', heading: rows[0].heading, rel_path: rows[0].rel_path, root_path: rows[0].root_path, text: rows[0].text };
}

export async function repos(store) {
  const { rows } = await store.pool.query(`
    SELECT r.id, r.root_path, r.last_indexed_at,
           COUNT(DISTINCT d.id)::int AS docs,
           COUNT(c.id)::int          AS chunks,
           COALESCE(
             jsonb_object_agg(d.mime, 1) FILTER (WHERE d.mime IS NOT NULL), '{}'
           ) AS by_mime_raw
      FROM docgraph_repos r
      LEFT JOIN docgraph_documents d ON d.repo_id = r.id
      LEFT JOIN docgraph_chunks    c ON c.document_id = d.id
     GROUP BY r.id ORDER BY r.last_indexed_at DESC NULLS LAST
  `);
  // jsonb_object_agg collapses duplicate mimes, so recompute counts explicitly.
  const out = [];
  for (const r of rows) {
    const { rows: mimes } = await store.pool.query(
      `SELECT mime, COUNT(*)::int AS n FROM docgraph_documents WHERE repo_id=$1 GROUP BY mime ORDER BY n DESC`, [r.id]
    );
    out.push({
      id: r.id, root_path: r.root_path, last_indexed_at: r.last_indexed_at,
      docs: r.docs, chunks: r.chunks, repo: path.basename(r.root_path),
      by_mime: Object.fromEntries(mimes.map((m) => [m.mime, m.n])),
    });
  }
  return { repos: out };
}

export async function refs(store, { ref, folder, limit = 50 }) {
  const pool = store.pool;
  const repoId = await resolveRepoId(pool, folder);
  const params = repoId ? [ref, repoId, limit] : [ref, limit];
  const { rows } = await pool.query(
    `SELECT DISTINCT rf.kind, rf.value, rf.section_id, s.heading,
            d.rel_path, d.title, d.mime, r.root_path
       FROM docgraph_refs rf
       JOIN docgraph_documents d ON d.id = rf.document_id
       JOIN docgraph_repos     r ON r.id = d.repo_id
       LEFT JOIN docgraph_sections s ON s.id = rf.section_id
      WHERE lower(rf.value) = lower($1) ${repoId ? 'AND d.repo_id = $2' : ''}
      ORDER BY d.rel_path LIMIT $${repoId ? 3 : 2}`, params
  );
  return {
    ref,
    matches: rows.map((row) => ({
      kind: row.kind, value: row.value,
      document: { rel_path: row.rel_path, title: row.title, mime: row.mime, repo: path.basename(row.root_path), root_path: row.root_path },
      section: { id: row.section_id, heading: row.heading },
    })),
  };
}
