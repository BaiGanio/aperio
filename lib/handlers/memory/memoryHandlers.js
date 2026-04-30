// mcp/handlers/memoryHandlers.js
// Pure async handler functions for all memory-related MCP tools.
//
// Each function accepts a "ctx" object as its first argument — containing
// the dependencies it needs (store, generateEmbedding, vectorEnabled) —
// followed by the tool's own input arguments.
//
// This makes every handler independently importable and testable without
// booting the MCP server or touching a real database.

export async function rememberHandler(ctx, { type, title, content, tags, importance, expires_at }) {
  const { store, generateEmbedding } = ctx;

  const embedding = await generateEmbedding(`${title}. ${content}`);
  const source    = process.env.AI_PROVIDER === "ollama"
    ? (process.env.OLLAMA_MODEL    || "ollama")
    : (process.env.ANTHROPIC_MODEL || "claude");

  const mem = await store.insert(
    { type, title, content, tags: tags ?? [], importance: importance ?? 3,
      expires_at: expires_at ? new Date(expires_at) : undefined, source },
    embedding
  );

  const embeddingNote = embedding ? " (with semantic embedding)" : "";
  return {
    content: [{ type: "text", text: `✅ Memory saved [${mem.type}] "${mem.title}"${embeddingNote} (id: ${mem.id})` }],
  };
}

export async function recallHandler(ctx, { query, type, tags, limit: _limit, search_mode = "auto" }) {
  const { store, generateEmbedding, vectorEnabled } = ctx;

  const limit = _limit !== undefined ? Number.parseInt(_limit, 10) : 10;

  const queryEmbedding = (query && vectorEnabled() && search_mode !== "fulltext")
    ? await generateEmbedding(query, "query")
    : null;

  const rows = await store.recall({ query, queryEmbedding, type, tags, limit, mode: search_mode });

  if (!rows.length)
    return { content: [{ type: "text", text: "No memories found." }] };

  const usedSemantic = rows[0]?.similarity !== undefined;
  // console.error(`🔍 recall: ${usedSemantic ? "semantic" : "full-text"} | results: ${rows.length}`);

  const formatted = rows.map(m => {
    const simNote = m.similarity !== undefined
      ? ` [similarity: ${(m.similarity * 100).toFixed(0)}%]` : "";
    return `[${m.type.toUpperCase()}] ${m.title}${simNote} (importance: ${m.importance})\n${m.content}\nTags: ${(m.tags||[]).join(", ")||"none"}\nID: ${m.id}`;
  }).join("\n---\n");

  return { content: [{ type: "text", text: formatted }] };
}

export async function updateMemoryHandler(ctx, { id, title, content, tags, importance }) {
  const { store, generateEmbedding, vectorEnabled } = ctx;

  const current = await store.getById(id);
  if (!current) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };

  const input = {};
  if (title)      input.title      = title;
  if (content)    input.content    = content;
  if (tags)       input.tags       = tags;
  if (importance) input.importance = importance;
  if (!Object.keys(input).length)
    return { content: [{ type: "text", text: "❌ No fields to update." }] };

  let embedding;
  if ((title || content) && vectorEnabled()) {
    embedding = await generateEmbedding(`${title ?? current.title}. ${content ?? current.content}`);
  }

  const updated = await store.update(id, input, embedding);
  return { content: [{ type: "text", text: `✅ Updated: "${updated.title}"` }] };
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