// lib/handlers/wiki/selfWikiHandlers.js
// Handlers for self_wiki_write / self_wiki_get — synthesized notes over the
// agent's own self_memories ("searchable synthesis over self-notes", see
// agent-self-memory.md Phase 2). Mirrors wikiHandlers.js's write/get shape,
// but:
//
//   1. STRICT LOCAL-ONLY, same gate as selfMemoryHandlers.js — refuses on a
//      cloud provider so self-wiki content never leaves the machine.
//   2. Only two tools exist (no self_wiki_search/self_wiki_list): the wiki's
//      RRF search machinery has no self-wiki equivalent, so this file never
//      touches embeddings or full-text indices.
//   3. No refresh-via-cheap-model: wiki_get's `refresh` regenerates a stale
//      article through WIKI_REFRESH_PROVIDER, which may be a cloud model —
//      wiring that into self-wiki would leak self-notes to a third party on
//      every refresh. self_wiki_get only reports staleness; the agent
//      re-synthesizes by calling self_wiki_write again.
//
// The SQLite storage engine (upsert/get) is fully shared with the user-facing
// wiki via the parameterized SqliteWiki class in db/sqlite.js (store.selfWiki
// vs store.wiki, same code). Postgres has no such sub-store for either wiki —
// wikiHandlers.js's Postgres path is a small, self-contained inline
// transaction, and this file's Postgres path is deliberately its own
// similarly-small block rather than a shared abstraction: source validation
// differs (self_memories has no store.cache) and there's no embedding column,
// so a "shared" version would need as many branches as it saves lines. This
// mirrors the existing precedent of recallSelf vs recall in db/postgres.js.

import { hashSources, modelTag } from "./wikiHandlers.js";
import { localOnlyRefusal } from "../memory/selfMemoryHandlers.js";

export async function selfWikiWriteHandler(ctx, { slug, title, summary, body_md, tags, source_self_memory_ids = [] }) {
  if (!ctx.providerIsLocal) return localOnlyRefusal();
  const { store } = ctx;

  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug))
    return { content: [{ type: "text", text: "❌ slug must be lowercase kebab-case (e.g. 'how-i-work-here')." }] };
  if (!title || !body_md)
    return { content: [{ type: "text", text: "❌ title and body_md are required." }] };

  let sourceRows = [];
  if (source_self_memory_ids.length) {
    for (const id of source_self_memory_ids) {
      const mem = await store.getSelfById(id);
      if (mem) sourceRows.push({ id: mem.id, updated_at: mem.updated_at });
    }
    const missing = source_self_memory_ids.length - sourceRows.length;
    if (missing > 0)
      return { content: [{ type: "text", text: `❌ ${missing} source self-memory id(s) not found.` }] };
  }

  const source_hash  = hashSources(sourceRows);
  const generated_by = modelTag();

  if (store.selfWiki) {
    try {
      const { id, revision, inserted } = await store.selfWiki.upsert({
        slug, title, summary, body_md, tags, generated_by, source_hash,
        source_memory_ids: source_self_memory_ids,
      });
      const verb = inserted ? "Created" : `Updated (rev ${revision})`;
      return { content: [{ type: "text", text: `✅ ${verb} self-wiki article "${title}" [${slug}] (id: ${id}, sources: ${source_self_memory_ids.length})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ self_wiki_write failed: ${err.message}` }] };
    }
  }

  // Postgres path
  const client = await store.pool.connect();
  try {
    await client.query("BEGIN");
    const upsert = await client.query(
      `INSERT INTO self_wiki_articles
         (slug, title, summary, body_md, tags, status, generated_by, generated_at, source_hash)
       VALUES ($1,$2,$3,$4,$5,'fresh',$6,now(),$7)
       ON CONFLICT (slug) DO UPDATE SET
         title        = EXCLUDED.title,
         summary      = EXCLUDED.summary,
         body_md      = EXCLUDED.body_md,
         tags         = EXCLUDED.tags,
         status       = 'fresh',
         generated_by = EXCLUDED.generated_by,
         generated_at = now(),
         source_hash  = EXCLUDED.source_hash,
         revision     = self_wiki_articles.revision + 1
       RETURNING id, revision, (xmax = 0) AS inserted`,
      [slug, title, summary ?? null, body_md, tags ?? null, generated_by, source_hash]
    );
    const { id, revision, inserted } = upsert.rows[0];
    await client.query(`DELETE FROM self_wiki_article_sources WHERE article_id = $1`, [id]);
    if (source_self_memory_ids.length) {
      const values = source_self_memory_ids.map((_, i) => `($1, $${i + 2})`).join(",");
      await client.query(
        `INSERT INTO self_wiki_article_sources (article_id, memory_id) VALUES ${values}`,
        [id, ...source_self_memory_ids]
      );
    }
    await client.query("COMMIT");
    const verb = inserted ? "Created" : `Updated (rev ${revision})`;
    return { content: [{ type: "text", text: `✅ ${verb} self-wiki article "${title}" [${slug}] (id: ${id}, sources: ${source_self_memory_ids.length})` }] };
  } catch (err) {
    await client.query("ROLLBACK");
    return { content: [{ type: "text", text: `❌ self_wiki_write failed: ${err.message}` }] };
  } finally {
    client.release();
  }
}

export async function selfWikiGetHandler(ctx, { slug }) {
  if (!ctx.providerIsLocal) return localOnlyRefusal();
  const { store } = ctx;

  let a;
  if (store.selfWiki) {
    a = await store.selfWiki.get(slug);
    if (a) {
      const sources = [];
      for (const id of (a.source_memory_ids ?? [])) {
        const mem = await store.getSelfById(id);
        sources.push(mem ? { id, title: mem.title } : { id, title: id });
      }
      a = { ...a, sources };
    }
  } else {
    const { rows } = await store.pool.query(
      `SELECT id, slug, title, summary, body_md, tags, status, generated_by, generated_at, revision
         FROM self_wiki_articles WHERE slug = $1`,
      [slug]
    );
    if (rows.length) {
      const { rows: sources } = await store.pool.query(
        `SELECT m.id, m.title FROM self_wiki_article_sources s
           JOIN self_memories m ON m.id = s.memory_id WHERE s.article_id = $1`,
        [rows[0].id]
      );
      a = { ...rows[0], sources };
    }
  }

  if (!a)
    return { content: [{ type: "text", text: `❌ No self-wiki article with slug "${slug}". Use self_wiki_write to create it.` }] };

  const sourceList = a.sources.length
    ? a.sources.map(s => `  - [[self-mem:${s.id}]] ${s.title}`).join("\n")
    : "  (none)";

  const updated = new Date(a.generated_at).toISOString().slice(0, 10);
  const meta    = `🗂️ Self-wiki: [[${a.slug}]] (rev ${a.revision} · ${a.status} · updated ${updated})` +
                  (a.status === "stale" ? " — a cited self-memory changed; call self_wiki_write again to refresh." : "");
  const header  = `\n\n# ${a.title}\n` + (a.summary ? `> ${a.summary}\n\n` : "\n");
  const footer  = `\n\n---\n**Sources**\n${sourceList}`;

  return { content: [{ type: "text", text: meta + header + a.body_md + footer }] };
}
