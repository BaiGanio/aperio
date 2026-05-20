// lib/handlers/wiki/wikiHandlers.js
// Handlers for wiki_write and wiki_get.
// Wiki articles are LLM-authored projections over memories; this layer only
// persists what the model produces and tracks provenance + freshness.

import { createHash } from "crypto";
import logger from "../../helpers/logger.js";

function hashSources(rows) {
  // Sources frozen by (id, updated_at) so any change to a cited memory drifts the hash.
  const payload = rows
    .map(r => `${r.id}:${new Date(r.updated_at).toISOString()}`)
    .sort()
    .join("|");
  return createHash("sha256").update(payload).digest("hex");
}

function modelTag() {
  return process.env.AI_PROVIDER === "ollama"
    ? (process.env.OLLAMA_MODEL    || "ollama")
    : (process.env.ANTHROPIC_MODEL || "claude");
}

export async function wikiWriteHandler(ctx, { slug, title, summary, body_md, tags, source_memory_ids = [] }) {
  const { store, generateEmbedding } = ctx;
  const pool = store.pool;

  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug))
    return { content: [{ type: "text", text: "❌ slug must be lowercase kebab-case (e.g. 'aperio-architecture')." }] };
  if (!title || !body_md)
    return { content: [{ type: "text", text: "❌ title and body_md are required." }] };

  // Validate sources exist and freeze their (id, updated_at) for the hash.
  let sourceRows = [];
  if (source_memory_ids.length) {
    const { rows } = await pool.query(
      `SELECT id, updated_at FROM memories WHERE id = ANY($1::uuid[])`,
      [source_memory_ids]
    );
    sourceRows = rows;
    const missing = source_memory_ids.length - rows.length;
    if (missing > 0)
      return { content: [{ type: "text", text: `❌ ${missing} source memory id(s) not found.` }] };
  }
  const source_hash = hashSources(sourceRows);

  const embedding = await generateEmbedding(`${title}. ${summary ?? ""} ${body_md}`);
  const generated_by = modelTag();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert by slug. Bump revision on update; reset status to 'fresh'.
    const upsert = await client.query(
      `INSERT INTO wiki_articles
         (slug, title, summary, body_md, tags, status, generated_by, generated_at, source_hash, embedding)
       VALUES ($1,$2,$3,$4,$5,'fresh',$6, now(), $7, $8)
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
       embedding ? `[${embedding.join(",")}]` : null]
    );
    const { id, revision, inserted } = upsert.rows[0];

    // Replace provenance rows wholesale — cleanest way to keep it in sync.
    await client.query(`DELETE FROM wiki_article_sources WHERE article_id = $1`, [id]);
    if (source_memory_ids.length) {
      const values = source_memory_ids.map((_, i) => `($1, $${i + 2})`).join(",");
      await client.query(
        `INSERT INTO wiki_article_sources (article_id, memory_id) VALUES ${values}`,
        [id, ...source_memory_ids]
      );
    }

    await client.query("COMMIT");

    if (!embedding)
      logger.warn(`[wiki_write] no embedding for ${slug} — semantic search will skip it until backfill`);

    const verb = inserted ? "Created" : `Updated (rev ${revision})`;
    return {
      content: [{
        type: "text",
        text: `✅ ${verb} wiki article "${title}" [${slug}] (id: ${id}, sources: ${source_memory_ids.length})`,
      }],
    };
  } catch (err) {
    await client.query("ROLLBACK");
    return { content: [{ type: "text", text: `❌ wiki_write failed: ${err.message}` }] };
  } finally {
    client.release();
  }
}

export async function wikiGetHandler(ctx, { slug, allow_stale = true }) {
  const pool = ctx.store.pool;

  const { rows } = await pool.query(
    `SELECT id, slug, title, summary, body_md, tags, status,
            generated_by, generated_at, revision
       FROM wiki_articles WHERE slug = $1`,
    [slug]
  );
  if (!rows.length)
    return { content: [{ type: "text", text: `❌ No article with slug "${slug}". Use wiki_write to create it.` }] };

  const a = rows[0];

  if (a.status === "stale" && !allow_stale) {
    return {
      content: [{
        type: "text",
        text: `⚠️ Article "${a.slug}" is stale (cited memories changed). Regenerate via wiki_write before serving.`,
      }],
    };
  }

  const { rows: srcs } = await pool.query(
    `SELECT m.id, m.title FROM wiki_article_sources s
       JOIN memories m ON m.id = s.memory_id
      WHERE s.article_id = $1`,
    [a.id]
  );
  const sourceList = srcs.length
    ? srcs.map(s => `  - [[mem:${s.id}]] ${s.title}`).join("\n")
    : "  (none)";

  // Breadcrumb is the first line, on its own, with a stable prefix.
  // SKILL.md instructs the model to copy this line verbatim to the top of its user-facing reply
  // whenever it used this article — that's how users discover the wiki exists.
  const updated = new Date(a.generated_at).toISOString().slice(0, 10);
  const breadcrumb = `🔖 From wiki: [[${a.slug}]] (rev ${a.revision} · ${a.status} · updated ${updated})`;

  const header = `\n\n# ${a.title}\n`
    + (a.summary ? `> ${a.summary}\n\n` : "\n");

  const footer = `\n\n---\n**Sources**\n${sourceList}`;

  return { content: [{ type: "text", text: breadcrumb + header + a.body_md + footer }] };
}
