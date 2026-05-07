// mcp/tools/memory.js
import { z } from "zod";
import {
  rememberHandler,
  recallHandler,
  updateMemoryHandler,
  forgetHandler,
  backfillHandler,
  dedupHandler,
} from "../../lib/handlers/memory/memoryHandlers.js";

// Pre-bind handlers to avoid recreating functions on every register call
const createBoundHandlers = (ctx) => ({
  remember: (args) => rememberHandler(ctx, args),
  recall: (args) => recallHandler(ctx, args),
  update: (args) => updateMemoryHandler(ctx, args),
  forget: (args) => forgetHandler(ctx, args),
  backfill: (args) => backfillHandler(ctx, args),
  dedup: (args) => dedupHandler(ctx, args),
});

// ─── Tool definitions (DRY schema + handler binding) ─────────────────────────
const TOOLS = [
  {
    name: "remember",
    description: "Save a new memory to Aperio. Automatically generates embeddings for semantic search.",
    schema: {
      type: z.enum(["fact", "preference", "project", "decision", "solution", "source", "person"]),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()).optional(),
      importance: z.number().min(1).max(5).optional(),
      expires_at: z.string().optional(),
    },
    getHandler: (handlers) => handlers.remember,
  },
  {
    name: "recall",
    description: "Search memories. Uses semantic similarity when a query is provided, falls back to full-text.",
    schema: {
      query: z.string().optional(),
      type: z.enum(["fact", "preference", "project", "decision", "solution", "source", "person"]).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().min(1).max(50).optional(),
      search_mode: z.enum(["semantic", "fulltext", "auto"]).optional(),
    },
    getHandler: (handlers) => handlers.recall,
  },
  {
    name: "update_memory",
    description: "Update an existing memory by ID. Regenerates embedding if content changes.",
    schema: {
      id: z.string().uuid(),
      title: z.string().optional(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      importance: z.number().min(1).max(5).optional(),
    },
    getHandler: (handlers) => handlers.update,
  },
  {
    name: "forget",
    description: "Delete a memory from Aperio by ID.",
    schema: {
      id: z.string().uuid(),
    },
    getHandler: (handlers) => handlers.forget,
  },
  {
    name: "backfill_embeddings",
    description: "Generate embeddings for all memories that don't have one yet.",
    schema: {
      limit: z.number().min(1).max(100).optional(),
    },
    getHandler: (handlers) => handlers.backfill,
  },
  {
    name: "deduplicate_memories",
    description: "Find near-duplicate memories using cosine similarity. dry_run=true (default) only reports; false merges.",
    schema: {
      threshold: z.number().min(0.5).max(1.0).optional(),
      dry_run: z.boolean().optional(),
    },
    getHandler: (handlers) => handlers.dedup,
  },
];

// Build Zod object schema from TOOLS definition
function buildInputSchema(tool) {
  return z.object(tool.schema);
}

// ─── MCP registration (factory pattern) ──────────────────────────────────────
export function register(server, ctx) {
  const handlers = createBoundHandlers(ctx);
  
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: buildInputSchema(tool),
      },
      tool.getHandler(handlers)
    );
  }
}