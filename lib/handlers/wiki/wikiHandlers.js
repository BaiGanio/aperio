// lib/handlers/wiki/wikiHandlers.js
// Handlers for wiki_write and wiki_get.
// Wiki articles are LLM-authored projections over memories; this layer only
// persists what the model produces and tracks provenance + freshness.

import { createHash } from 'crypto';
import logger from '../../helpers/logger.js';
import { searchArticles, listArticles, getArticle } from './wikiQueries.js';
// regenerate.js imports wikiWriteHandler from this file — use a lazy import to break the cycle.

function hashSources(rows) {
  const payload = rows
    .map(r => `${r.id}:${new Date(r.updated_at).toISOString()}`)
    .sort()
    .join('|');
  return createHash('sha256').update(payload).digest('hex');
}

function modelTag() {
  return process.env.AI_PROVIDER === 'ollama'
    ? (process.env.OLLAMA_MODEL    || 'ollama')
    : (process.env.ANTHROPIC_MODEL || 'claude');
}

export async function wikiWriteHandler(ctx, { slug, title, summary, body_md, tags, source_memory_ids = [] }) {
  const { store, generateEmbedding } = ctx;

  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug))
    return { content: [{ type: 'text', text: "❌ slug must be lowercase kebab-case (e.g. 'aperio-architecture')." }] };
  if (!title || !body_md)
    return { content: [{ type: 'text', text: '❌ title and body_md are required.' }] };

  let sourceRows = [];
  if (source_memory_ids.length) {
    if (store.wiki) {
      // In-memory cache path: validate source memories from the cache.
      await store.refreshCache();
      sourceRows = source_memory_ids
        .map(id => store.cache.find(r => r.id === id && !r.valid_until))
        .filter(Boolean)
        .map(r => ({ id: r.id, updated_at: r.updated_at }));
      const missing = source_memory_ids.length - sourceRows.length;
      if (missing > 0)
        return { content: [{ type: 'text', text: `❌ ${missing} source memory id(s) not found.` }] };
    } else {
      // Postgres: validate via SQL.
      const { rows } = await store.pool.query(
        `SELECT id, updated_at FROM memories WHERE id = ANY($1::uuid[])`,
        [source_memory_ids]
      );
      sourceRows = rows;
      const missing = source_memory_ids.length - rows.length;
      if (missing > 0)
        return { content: [{ type: 'text', text: `❌ ${missing} source memory id(s) not found.` }] };
    }
  }
  const source_hash  = hashSources(sourceRows);
  const embedding    = await generateEmbedding(`${title}. ${summary ?? ''} ${body_md}`);
  const generated_by = modelTag();

  if (store.wiki) {
    try {
      const { id, revision, inserted } = await store.wiki.upsert(
        { slug, title, summary, body_md, tags, generated_by, source_hash, source_memory_ids },
        embedding
      );
      if (!embedding) logger.warn(`[wiki_write] no embedding for ${slug}`);
      const verb = inserted ? 'Created' : `Updated (rev ${revision})`;
      return { content: [{ type: 'text', text: `✅ ${verb} wiki article "${title}" [${slug}] (id: ${id}, sources: ${source_memory_ids.length})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ wiki_write failed: ${err.message}` }] };
    }
  }

  // Postgres path
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    const upsert = await client.query(
      `INSERT INTO wiki_articles
         (slug, title, summary, body_md, tags, status, generated_by, generated_at, source_hash, embedding)
       VALUES ($1,$2,$3,$4,$5,'fresh',$6,now(),$7,$8)
       ON CONFLICT (slug) DO UPDATE SET
         title        = EXCLUDED.title,
         summary      = EXCLUDED.summary,
         body_md      = EXCLUDED.body_md,
         tags         = EXCLUDED.tags,
         status       = 'fresh',
         generated_by = EXCLUDED.generated_by,
         generated_at = now(),
         source_hash  = EXCLUDED.source_hash,
         embedding    = EXCLUDED.embedding,
         revision     = wiki_articles.revision + 1
       RETURNING id, revision, (xmax = 0) AS inserted`,
      [slug, title, summary ?? null, body_md, tags ?? null, generated_by, source_hash,
       embedding ? `[${embedding.join(',')}]` : null]
    );
    const { id, revision, inserted } = upsert.rows[0];
    await client.query(`DELETE FROM wiki_article_sources WHERE article_id = $1`, [id]);
    if (source_memory_ids.length) {
      const values = source_memory_ids.map((_, i) => `($1, $${i + 2})`).join(',');
      await client.query(
        `INSERT INTO wiki_article_sources (article_id, memory_id) VALUES ${values}`,
        [id, ...source_memory_ids]
      );
    }
    await client.query('COMMIT');
    if (!embedding) logger.warn(`[wiki_write] no embedding for ${slug} — semantic search will skip it until backfill`);
    const verb = inserted ? 'Created' : `Updated (rev ${revision})`;
    return { content: [{ type: 'text', text: `✅ ${verb} wiki article "${title}" [${slug}] (id: ${id}, sources: ${source_memory_ids.length})` }] };
  } catch (err) {
    await client.query('ROLLBACK');
    return { content: [{ type: 'text', text: `❌ wiki_write failed: ${err.message}` }] };
  } finally {
    client.release();
  }
}

export async function wikiSearchHandler(ctx, { query, tags, status, limit = 10, mode = 'auto' }) {
  const { store, generateEmbedding } = ctx;
  let rows;
  try {
    rows = await searchArticles(store, generateEmbedding, { query, tags, status, limit, mode });
  } catch (err) {
    return { content: [{ type: 'text', text: `❌ ${err.message}` }] };
  }

  if (!rows.length)
    return { content: [{ type: 'text', text: `No wiki articles matched "${query}".` }] };

  const lines = rows.map(r => {
    const updated = new Date(r.generated_at).toISOString().slice(0, 10);
    const tagStr  = r.tags?.length ? ` ${r.tags.map(t => `#${t}`).join(' ')}` : '';
    const score   = Number.parseFloat(r.score).toFixed(3);
    const summary = r.summary ? ` — ${r.summary}` : '';
    return `- [[${r.slug}]] **${r.title}** (rev ${r.revision} · ${r.status} · ${updated} · score ${score})${tagStr}${summary}`;
  });

  return { content: [{ type: 'text', text: `Found ${rows.length} article(s):\n${lines.join('\n')}` }] };
}

export async function wikiListHandler(ctx, { tag, status, updated_since, limit = 25, offset = 0 }) {
  const rows = await listArticles(ctx.store, { tag, status, updated_since, limit, offset });

  if (!rows.length)
    return { content: [{ type: 'text', text: 'No wiki articles match those filters.' }] };

  const off   = Math.max(parseInt(offset, 10) || 0, 0);
  const lines = rows.map(r => {
    const updated = new Date(r.generated_at).toISOString().slice(0, 10);
    const tagStr  = r.tags?.length ? ` ${r.tags.map(t => `#${t}`).join(' ')}` : '';
    const summary = r.summary ? ` — ${r.summary}` : '';
    return `- [[${r.slug}]] **${r.title}** (rev ${r.revision} · ${r.status} · ${updated})${tagStr}${summary}`;
  });

  const header = `${rows.length} article(s)` + (off ? ` (offset ${off})` : '') + ':';
  return { content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }] };
}

export async function wikiGetHandler(ctx, { slug, allow_stale = true, refresh = false }) {
  let a = await getArticle(ctx.store, slug);
  if (!a)
    return { content: [{ type: 'text', text: `❌ No article with slug "${slug}". Use wiki_write to create it.` }] };

  let refreshNote = '';
  if (refresh && a.status === 'stale') {
    try {
      const { regenerateArticle } = await import('./regenerate.js');
      const result = await regenerateArticle(ctx, slug);
      if (result.ok) {
        a = await getArticle(ctx.store, slug);
        refreshNote = `\n_refreshed via ${process.env.WIKI_REFRESH_PROVIDER || '?'} in ${result.ms}ms · ${result.citations} citations_`;
      } else {
        logger.warn(`[wiki_get] refresh skipped for "${slug}": ${result.reason}`);
        refreshNote = `\n_refresh attempted but skipped: ${result.reason}_`;
      }
    } catch (err) {
      logger.error(`[wiki_get] unexpected error during refresh of "${slug}": ${err.message}`, { stack: err.stack });
      refreshNote = `\n_refresh attempted but errored: ${err.message}_`;
    }
  }

  if (a.status === 'stale' && !allow_stale) {
    return {
      content: [{
        type: 'text',
        text: `⚠️ Article "${a.slug}" is stale (cited memories changed). Regenerate via wiki_write before serving.`,
      }],
    };
  }

  const sourceList = a.sources.length
    ? a.sources.map(s => `  - [[mem:${s.id}]] ${s.title}`).join('\n')
    : '  (none)';

  const updated    = new Date(a.generated_at).toISOString().slice(0, 10);
  const breadcrumb = `🔖 From wiki: [[${a.slug}]] (rev ${a.revision} · ${a.status} · updated ${updated})`;
  const header     = `\n\n# ${a.title}\n` + (a.summary ? `> ${a.summary}\n\n` : '\n');
  const footer     = `\n\n---\n**Sources**\n${sourceList}${refreshNote}`;

  return { content: [{ type: 'text', text: breadcrumb + header + a.body_md + footer }] };
}
