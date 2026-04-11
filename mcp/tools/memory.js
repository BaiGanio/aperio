// mcp/tools/memory.js
// All memory-related tools: remember, recall, update_memory, forget,
// backfill_embeddings, dedup_memories.
//
// Each handler is exported as a plain async function that accepts the
// dependencies it needs (store, generateEmbedding, vectorEnabled) as the
// first argument — an explicit "ctx" object — followed by the tool's own
// input arguments.
//
// This makes every handler independently importable and testable without
// booting the MCP server or touching a real database.

import { z } from "zod";

// ─── Pure handler functions ───────────────────────────────────────────────────

export async function rememberHandler(ctx, { type, title, content, tags, importance, expires_at }) {
  const { store, generateEmbedding } = ctx;

  const embedding = await generateEmbedding(`${title}. ${content}`);
  const source    = process.env.AI_PROVIDER === "ollama"
    ? (process.env.OLLAMA_MODEL || "ollama")
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
  console.error(`🔍 recall: ${usedSemantic ? "semantic" : "full-text"} | results: ${rows.length}`);

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

// ─── MCP registration (unchanged behavior) ───────────────────────────────────
// register() just wires the pure handlers above to the MCP server.
// No logic lives here — only schema declarations and ctx forwarding.

export function register(server, ctx) {

  server.registerTool(
    "remember",
    {
      description: "Save a new memory to Aperio. Automatically generates embeddings for semantic search.",
      inputSchema: z.object({
        type:       z.enum(["fact","preference","project","decision","solution","source","person"]).describe("Category of memory"),
        title:      z.string().describe("Short label for this memory"),
        content:    z.string().describe("Full memory in plain English"),
        tags:       z.array(z.string()).optional().describe("Optional tags"),
        importance: z.number().min(1).max(5).optional().describe("1=low to 5=high, default 3"),
        expires_at: z.string().optional().describe("Optional ISO date when this memory expires"),
      }),
    },
    (args) => rememberHandler(ctx, args)
  );

  server.registerTool(
    "recall",
    {
      description: "Search memories. Uses semantic similarity when a query is provided, falls back to full-text.",
      inputSchema: z.object({
        query:       z.string().optional().describe("Natural language search — finds semantically related memories"),
        type:        z.enum(["fact","preference","project","decision","solution","source","person"]).optional().describe("Filter by type"),
        tags:        z.array(z.string()).optional().describe("Filter by tags"),
        limit:       z.number().min(1).max(50).optional().describe("Max results, default 10"),
        search_mode: z.enum(["semantic","fulltext","auto"]).optional().describe("Force search mode. Default: auto"),
      }),
    },
    (args) => recallHandler(ctx, args)
  );

  server.registerTool(
    "update_memory",
    {
      description: "Update an existing memory by ID. Regenerates embedding if content changes.",
      inputSchema: z.object({
        id:         z.string().uuid().describe("UUID of the memory to update"),
        title:      z.string().optional(),
        content:    z.string().optional(),
        tags:       z.array(z.string()).optional(),
        importance: z.number().min(1).max(5).optional(),
      }),
    },
    (args) => updateMemoryHandler(ctx, args)
  );

  server.registerTool(
    "forget",
    {
      description: "Delete a memory from Aperio by ID.",
      inputSchema: z.object({ id: z.string().uuid().describe("UUID of the memory to delete") }),
    },
    (args) => forgetHandler(ctx, args)
  );

  server.registerTool(
    "backfill_embeddings",
    {
      description: "Generate embeddings for all memories that don't have one yet.",
      inputSchema: z.object({
        limit: z.number().min(1).max(100).optional().describe("Max memories to backfill at once, default 20"),
      }),
    },
    (args) => backfillHandler(ctx, args)
  );

  server.registerTool(
    "dedup_memories",
    {
      description: "Find near-duplicate memories using cosine similarity. dry_run=true (default) only reports; false merges.",
      inputSchema: z.object({
        threshold: z.number().min(0.5).max(1.0).optional().describe("Similarity threshold 0-1, default 0.97"),
        dry_run:   z.boolean().optional().describe("If true, only report duplicates without merging. Default true."),
      }),
    },
    (args) => dedupHandler(ctx, args)
  );
}