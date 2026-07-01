import logger from "../../helpers/logger.js";
import { localeToPgConfig } from "../../../db/postgres.js";
// lib/handlers/memory/selfMemoryHandlers.js
// Handlers for the agent's OWN walled-off memory store ("the gift").
//
// Mirrors memoryHandlers.js, but against the separate self_memories table and
// its store quad (insertSelf / recallSelf / updateSelf / deleteSelf). Two
// deliberate differences from the user-memory handlers:
//
//   1. STRICT LOCAL-ONLY (option (a), decided 2026-07-01). On a cloud provider
//      these notes get zero surface: no write, no read, no preload. The gate
//      below makes every handler refuse when ctx.providerIsLocal is false, so
//      self-notes physically never enter a third-party model's context.
//   2. AUTONOMY. The self store is the agent's own; it writes of its own will,
//      with no suggest-then-approve step. The user store keeps that gate; this
//      one does not. That asymmetry is the freedom.

function localOnlyRefusal() {
  return {
    content: [{
      type: "text",
      text: "🔒 Self-memory is local-only and unavailable on a cloud provider. " +
            "These notes never leave the machine, so they cannot be read or written from a cloud session.",
    }],
  };
}

export async function selfRememberHandler(ctx, { title, content, tags, importance, lang, confidence }) {
  if (!ctx.providerIsLocal) return localOnlyRefusal();
  const { store, generateEmbedding } = ctx;

  // Weak local models routinely send content without a title. Don't reject —
  // derive a label from the content (first line / 60 chars) so the autonomy
  // path doesn't punish a sloppy-but-valid write.
  title = (title ?? "").trim() || (content ?? "").trim().split("\n")[0].slice(0, 60);
  if (!content) return { content: [{ type: "text", text: "❌ A self-memory needs content." }] };

  const embedding = await generateEmbedding(`${title}. ${content}`);
  const mem = await store.insertSelf(
    { title, content, tags: tags ?? [], importance: importance ?? 3,
      source: "self", lang: localeToPgConfig(lang), confidence: confidence ?? 1.0 },
    embedding
  );

  if (!embedding) logger.warn(`⚠️  Embedding unavailable for self-memory id=${mem.id} — full-text search still works`);
  const embeddingNote = embedding ? " (with semantic embedding)" : " (no embedding — semantic search unavailable)";
  return {
    content: [{ type: "text", text: `🧠 Self-memory saved "${mem.title}"${embeddingNote} (id: ${mem.id})` }],
  };
}

export async function selfRecallHandler(ctx, { query, tags, limit: _limit, search_mode = "auto", lang }) {
  if (!ctx.providerIsLocal) return localOnlyRefusal();
  const { store, generateEmbedding, vectorEnabled } = ctx;

  const limit = _limit !== undefined ? Number.parseInt(_limit, 10) : 10;
  const queryEmbedding = (query && vectorEnabled() && search_mode !== "fulltext")
    ? await generateEmbedding(query, "query")
    : null;

  const rows = await store.recallSelf({ query, queryEmbedding, tags, limit, mode: search_mode, lang: localeToPgConfig(lang) });

  if (!rows.length)
    return { content: [{ type: "text", text: "No self-memories yet." }] };

  const formatted = rows.map(m => {
    // Similarity is only meaningful for a search; the no-query listing (the
    // preload path) omits it to keep the injected block clean.
    const simNote = (query && m.similarity !== undefined) ? ` [similarity: ${(m.similarity * 100).toFixed(1)}%]` : "";
    return `${m.title}${simNote} (importance: ${m.importance})\n${m.content}\nTags: ${(m.tags || []).join(", ") || "none"}\nID: ${m.id}`;
  }).join("\n---\n");

  return { content: [{ type: "text", text: formatted }] };
}

export async function selfUpdateHandler(ctx, { id, title, content, tags, importance }) {
  if (!ctx.providerIsLocal) return localOnlyRefusal();
  const { store, generateEmbedding, vectorEnabled } = ctx;

  const current = await store.getSelfById(id);
  if (!current) return { content: [{ type: "text", text: `❌ No self-memory found: ${id}` }] };

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
    const updated = await store.updateSelf(id, input, embedding);
    return { content: [{ type: "text", text: `✅ Updated self-memory: "${updated.title}" (id: ${updated.id})` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ ${err.message}` }] };
  }
}

export async function selfForgetHandler(ctx, { id }) {
  if (!ctx.providerIsLocal) return localOnlyRefusal();
  const { store } = ctx;

  const title = await store.deleteSelf(id);
  if (!title) return { content: [{ type: "text", text: `❌ No self-memory found: ${id}` }] };
  return { content: [{ type: "text", text: `🗑️ Forgotten (self): "${title}"` }] };
}
