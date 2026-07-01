import logger from "../../helpers/logger.js";
import { localeToPgConfig } from "../../../db/postgres.js";
// mcp/handlers/memoryHandlers.js
// Pure async handler functions for all memory-related MCP tools.
//
// Each function accepts a "ctx" object as its first argument — containing
// the dependencies it needs (store, generateEmbedding, vectorEnabled) —
// followed by the tool's own input arguments.
//
// This makes every handler independently importable and testable without
// booting the MCP server or touching a real database.

export async function rememberHandler(ctx, { type, title, content, tags, importance, expires_at, lang, confidence }) {
  const { store, generateEmbedding } = ctx;

  const embedding = await generateEmbedding(`${title}. ${content}`);
  const source    = process.env.AI_PROVIDER === "ollama"
    ? (process.env.OLLAMA_MODEL    || "ollama")
    : (process.env.ANTHROPIC_MODEL || "claude");

  // Reject TTLs in the past or within the next hour — models sometimes send
  // today's date or a specific time that has already passed.
  let validExpiry = undefined;
  if (expires_at) {
    const expiryDate = new Date(expires_at);
    if (!Number.isNaN(expiryDate.getTime()) && expiryDate > new Date(Date.now() + 3600_000)) {
      validExpiry = expiryDate;
    } else {
      logger.warn(`[remember] ignoring expires_at "${expires_at}" — date is in the past or < 1h from now`);
    }
  }

  const mem = await store.insert(
    { type: type ?? "fact", title, content, tags: tags ?? [], importance: importance ?? 3,
      expires_at: validExpiry, source,
      lang: localeToPgConfig(lang), confidence: confidence ?? 1.0 },
    embedding
  );

  if (!embedding) {
    logger.warn(`⚠️  Embedding unavailable for memory id=${mem.id} — queued for retry`);
    ctx.embeddingQueue?.enqueue(mem.id, `${title}. ${content}`);
  }
  const embeddingNote = embedding ? " (with semantic embedding)" : " (no embedding — semantic search unavailable until backfill)";
  return {
    content: [{ type: "text", text: `✅ Memory saved [${mem.type}] "${mem.title}"${embeddingNote} (id: ${mem.id})` }],
  };
}

export async function recallHandler(ctx, { query, type, tags, limit: _limit, search_mode = "auto", lang, as_of, order = "importance" }) {
  const { store, generateEmbedding, vectorEnabled } = ctx;

  const limit = _limit !== undefined ? Number.parseInt(_limit, 10) : 10;

  const queryEmbedding = (query && vectorEnabled() && search_mode !== "fulltext")
    ? await generateEmbedding(query, "query")
    : null;

  const rawRows = await store.recall({ query, queryEmbedding, type, tags, limit, mode: search_mode, lang: localeToPgConfig(lang), asOf: as_of, order });

  // PRIVACY-01: on a cloud provider, never surface memories the user tagged
  // "local-only" — they'd otherwise be shipped to a third-party model. The
  // filter lives here so it applies to model-initiated recalls too, not just
  // the preload. Local (Ollama) sessions see everything.
  const rows = ctx.providerIsLocal === false
    ? rawRows.filter(m => !(m.tags || []).some(t => String(t).toLowerCase() === "local-only"))
    : rawRows;

  if (!rows.length)
    return { content: [{ type: "text", text: "No memories found." }] };

  const formatted = rows.map(m => {
    const simNote  = m.similarity  !== undefined ? ` [similarity: ${(m.similarity * 100).toFixed(1)}%]` : "";
    const confNote = m.confidence  !== undefined && m.confidence < 1.0
      ? ` [confidence: ${(m.confidence * 100).toFixed(0)}%]` : "";
    return `[${m.type.toUpperCase()}] ${m.title}${simNote}${confNote} (importance: ${m.importance})\n${m.content}\nTags: ${(m.tags||[]).join(", ")||"none"}\nID: ${m.id}`;
  }).join("\n---\n");

  // No-query recall lists the top-N by importance. When more memories exist than
  // were returned, make the truncation explicit so the model never mistakes this
  // listing for the user's entire memory and denies having more. (Footer carries
  // no "---" separator, so it stays attached to the last block and never parses
  // as a phantom memory.)
  let footer = "";
  if (!query) {
    try {
      const { current } = await store.counts();
      if (current > rows.length) {
        footer = `\n\n— Preview only: showing the ${rows.length} highest-priority of ${current} stored memories. Call recall with a query to search the rest.`;
      }
    } catch { /* count is best-effort — omit footer on failure */ }
  }

  return { content: [{ type: "text", text: formatted + footer }] };
}

export async function updateMemoryHandler(ctx, { id, title, content, tags, importance }) {
  const { store, generateEmbedding, vectorEnabled } = ctx;

  const current = await store.getById(id);
  if (!current) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };
  if (current.valid_until) return { content: [{ type: "text", text: `❌ Memory ${id} has been superseded — use its replacement ID instead.` }] };

  const input = {};
  if (title      !== undefined) input.title      = title;
  if (content    !== undefined) input.content    = content;
  if (tags       !== undefined) input.tags       = tags;
  if (importance !== undefined) input.importance = importance;
  if (!Object.keys(input).length)
    return { content: [{ type: "text", text: "❌ No fields to update." }] };

  let embedding;
  if ((title || content) && vectorEnabled()) {
    embedding = await generateEmbedding(`${title ?? current.title}. ${content ?? current.content}`);
  }

  try {
    const updated = await store.update(id, input, embedding);
    if ((title || content) && !embedding) {
      ctx.embeddingQueue?.enqueue(updated.id, `${title ?? current.title}. ${content ?? current.content}`);
    }
    return { content: [{ type: "text", text: `✅ Updated: "${updated.title}" (new id: ${updated.id})` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ ${err.message}` }] };
  }
}

export async function forgetHandler(ctx, { id }) {
  const { store } = ctx;

  const title = await store.delete(id);
  if (!title) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };
  return { content: [{ type: "text", text: `🗑️ Forgotten: "${title}"` }] };
}

export async function backfillHandler(ctx, { limit = 20 }) {
  const { store, generateEmbedding, vectorEnabled } = ctx;

  if (!vectorEnabled()) return { content: [{ type: "text", text: "❌ Vector search not enabled." }] };

  const pending = (await store.listWithoutEmbeddings()).slice(0, limit);
  if (!pending.length)
    return { content: [{ type: "text", text: "✅ All memories already have embeddings!" }] };

  let success = 0, failed = 0;
  for (const row of pending) {
    const embedding = await generateEmbedding(`${row.title}. ${row.content}`);
    if (embedding) { await store.setEmbedding(row.id, embedding); success++; }
    else failed++;
  }

  return {
    content: [{ type: "text", text: `✅ Backfill complete: ${success} embedded, ${failed} failed. ${pending.length - success - failed} remaining.` }],
  };
}

export async function dedupHandler(ctx, { threshold = 0.97, dry_run = true }) {
  const { store, vectorEnabled } = ctx;

  if (!vectorEnabled())
    return { content: [{ type: "text", text: "❌ Vector search not enabled — dedup requires embeddings." }] };

  const pairs = await store.findDuplicates(threshold);
  if (!pairs.length)
    return { content: [{ type: "text", text: `✅ No duplicates found above ${(threshold * 100).toFixed(0)}% similarity.` }] };

  let report = `Found ${pairs.length} near-duplicate pair(s):\n\n`;
  let merged = 0;

  for (const row of pairs) {
    report += `[${(row.similarity * 100).toFixed(1)}% similar]\n`;
    report += `  A: [${row.type_a}] "${row.title_a}" (${row.id_a})\n`;
    report += `  B: [${row.type_b}] "${row.title_b}" (${row.id_b})\n\n`;
    if (!dry_run) { await store.mergeDuplicate(row.id_a, row.id_b); merged++; }
  }

  report += dry_run
    ? `Run with dry_run=false to merge these automatically.`
    : `\n🧹 Merged ${merged} duplicate(s).`;

  return { content: [{ type: "text", text: report }] };
}