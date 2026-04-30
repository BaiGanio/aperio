// mcp/tools/memory.js
import { z } from "zod";
import {rememberHandler, recallHandler, updateMemoryHandler, forgetHandler, backfillHandler, dedupHandler} from "../../lib/handlers/memory/memoryHandlers.js";

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
    "deduplicate_memories",
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