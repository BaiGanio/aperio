// lib/handlers/wiki/wikiQueries.js
// Pure data-access for wiki articles. Delegates to store.wiki (SQLite) or
// store.pool (Postgres) depending on which backend is active.

export async function searchArticles(store, generateEmbedding, { query, tags, status, limit = 10, mode = 'auto' }) {
  if (!query || !query.trim()) throw new Error('query is required');
  if (store.wiki) {
    const queryEmbedding = mode === 'fulltext' ? null : await generateEmbedding(query);
    return store.wiki.search({ query, queryEmbedding, tags, status, limit, mode });
  }
  return _pgSearchArticles(store.pool, generateEmbedding, { query, tags, status, limit, mode });
}

export async function listArticles(store, { tag, status, updated_since, limit = 25, offset = 0 }) {
  if (store.wiki) return store.wiki.list({ tag, status, updated_since, limit, offset });
  return _pgListArticles(store.pool, { tag, status, updated_since, limit, offset });
}

export async function getArticle(store, slug) {
  if (store.wiki) {
    const article = await store.wiki.get(slug);
    if (!article) return null;
    // Resolve source memory titles from the in-memory cache.
    const sources = (article.source_memory_ids ?? []).map(id => {
      const mem = store.cache?.find(r => r.id === id && !r.valid_until);
      return mem ? { id, title: mem.title } : { id, title: id };
    });
    return { ...article, sources };
  }
  return _pgGetArticle(store.pool, slug);
}

// ── Postgres fallback (unchanged logic from original wikiQueries.js) ────────

const FTS_LANG   = 'simple';
const STALE_WEIGHT = 0.7;

function statusClause(status, params, idx) {
  if (status) { params.push(status); return { sql: `status = $${idx}`, next: idx + 1 }; }
  return { sql: `status <> 'archived'`, next: idx };
}

function searchTagsClause(tags, params, idx) {
  if (!tags?.length) return { sql: null, next: idx };
  params.push(tags);
  return { sql: `tags && $${idx}`, next: idx + 1 };
}

function listTagClause(tag, params, idx) {
  if (!tag) return { sql: null, next: idx };
  params.push(tag);
  return { sql: `$${idx} = ANY(tags)`, next: idx + 1 };
}

async function _pgSearchArticles(pool, generateEmbedding, { query, tags, status, limit = 10, mode = 'auto' }) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
  const queryEmbedding = mode === 'fulltext' ? null : await generateEmbedding(query);
  const useVector = !!queryEmbedding && mode !== 'fulltext';
  const useText   = mode !== 'semantic';

  if (useVector && useText) {
    const params = [`[${queryEmbedding.join(',')}]`, query];
    let idx = 3;
    const st = statusClause(status, params, idx); idx = st.next;
    const tg = searchTagsClause(tags, params, idx); idx = tg.next;
    const where = [st.sql, tg.sql].filter(Boolean).join(' AND ');
    params.push(cap);
    const { rows } = await pool.query(`
      WITH vector_ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
        FROM wiki_articles WHERE ${where} AND embedding IS NOT NULL LIMIT 60
      ),
      fts_ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          ORDER BY ts_rank(search_vector, plainto_tsquery('${FTS_LANG}', $2)) DESC
        ) AS rank
        FROM wiki_articles WHERE ${where} AND search_vector @@ plainto_tsquery('${FTS_LANG}', $2) LIMIT 60
      ),
      fused AS (
        SELECT COALESCE(v.id, f.id) AS id,
               COALESCE(1.0 / (60 + v.rank), 0.0) + COALESCE(1.0 / (60 + f.rank), 0.0) AS rrf_score
        FROM vector_ranked v FULL OUTER JOIN fts_ranked f ON v.id = f.id
      )
      SELECT a.id, a.slug, a.title, a.summary, a.tags, a.status,
             a.revision, a.generated_at,
             fu.rrf_score * CASE WHEN a.status = 'stale' THEN ${STALE_WEIGHT} ELSE 1.0 END AS score
      FROM fused fu JOIN wiki_articles a ON a.id = fu.id
      ORDER BY score DESC LIMIT $${idx}
    `, params);
    return rows;
  }

  if (useVector) {
    const params = [`[${queryEmbedding.join(',')}]`];
    let idx = 2;
    const st = statusClause(status, params, idx); idx = st.next;
    const tg = searchTagsClause(tags, params, idx); idx = tg.next;
    const where = ['embedding IS NOT NULL', st.sql, tg.sql].filter(Boolean).join(' AND ');
    params.push(cap);
    const { rows } = await pool.query(`
      SELECT id, slug, title, summary, tags, status, revision, generated_at,
             (1 - (embedding <=> $1::vector))
               * CASE WHEN status = 'stale' THEN ${STALE_WEIGHT} ELSE 1.0 END AS score
      FROM wiki_articles WHERE ${where} ORDER BY score DESC LIMIT $${idx}
    `, params);
    return rows;
  }

  const params = [query];
  let idx = 2;
  const st = statusClause(status, params, idx); idx = st.next;
  const tg = searchTagsClause(tags, params, idx); idx = tg.next;
  const where = [`search_vector @@ plainto_tsquery('${FTS_LANG}', $1)`, st.sql, tg.sql].filter(Boolean).join(' AND ');
  params.push(cap);
  const { rows } = await pool.query(`
    SELECT id, slug, title, summary, tags, status, revision, generated_at,
           ts_rank(search_vector, plainto_tsquery('${FTS_LANG}', $1))
             * CASE WHEN status = 'stale' THEN ${STALE_WEIGHT} ELSE 1.0 END AS score
    FROM wiki_articles WHERE ${where} ORDER BY score DESC LIMIT $${idx}
  `, params);
  return rows;
}

async function _pgListArticles(pool, { tag, status, updated_since, limit = 25, offset = 0 }) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const params = [];
  let idx = 1;
  const st = statusClause(status, params, idx); idx = st.next;
  const tg = listTagClause(tag, params, idx);   idx = tg.next;
  const where = [st.sql, tg.sql].filter(Boolean);
  if (updated_since) { where.push(`generated_at >= $${idx++}::timestamptz`); params.push(updated_since); }
  params.push(cap, off);
  const { rows } = await pool.query(`
    SELECT slug, title, summary, tags, status, revision, generated_at, generated_by
    FROM wiki_articles WHERE ${where.join(' AND ')}
    ORDER BY generated_at DESC LIMIT $${idx++} OFFSET $${idx}
  `, params);
  return rows;
}

async function _pgGetArticle(pool, slug) {
  const { rows } = await pool.query(
    `SELECT id, slug, title, summary, body_md, tags, status,
            generated_by, generated_at, revision
       FROM wiki_articles WHERE slug = $1`,
    [slug]
  );
  if (!rows.length) return null;
  const article = rows[0];
  const { rows: sources } = await pool.query(
    `SELECT m.id, m.title FROM wiki_article_sources s
       JOIN memories m ON m.id = s.memory_id WHERE s.article_id = $1`,
    [article.id]
  );
  return { ...article, sources };
}
