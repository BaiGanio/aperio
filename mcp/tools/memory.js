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
    description: "Save a new memory to Aperio. Automatically generates embeddings for semantic search. For time-sensitive information, propose a TTL via expires_at: 1–7 days for session/today context (current task, meeting agenda, temp credentials), 7–30 days for sprint or phase info, 30–90 days for temporary project decisions. Omit expires_at for stable facts, long-term preferences, and permanent knowledge.",
    schema: {
      type: z.enum(["fact", "preference", "project", "decision", "solution", "source", "person", "inference", "workflow"]).optional().describe("Category of the memory. Defaults to 'fact' when omitted — don't interrogate the user for it; pick the best fit or let it default."),
      title: z.string(),
      content: z.string(),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Sensitivity tier: 1=normal (default, always shared), 2=sensitive (withheld or redacted on cloud providers), 3=private (never leaves the machine). The legacy tag \"local-only\" also maps to tier 2 when no explicit tier is given."),
      tags: z.array(z.string()).optional().describe("Free-form tags. The legacy tag \"local-only\" marks a memory as private (maps to tier 2 if no explicit tier is given)."),
      importance: z.number().min(1).max(5).optional(),
      expires_at: z.string().optional().describe("ISO 8601 expiry datetime for ephemeral memories. Suggest a TTL when the information is time-bound: e.g. new Date(Date.now() + 7*86400000).toISOString() for 7 days. Omit for permanent memories."),
      lang: z.string().optional().describe("BCP-47 locale of the content (e.g. 'en', 'de', 'fr'). Defaults to 'en'."),
      confidence: z.number().min(0).max(1).optional().describe("Confidence in this memory (0.0–1.0). Defaults to 1.0 for stated facts; use ~0.6 for inferred patterns."),
    },
    getHandler: (handlers) => handlers.remember,
  },
  {
    name: "recall",
    description: "Search memories. Uses semantic similarity when a query is provided, falls back to full-text.",
    schema: {
      query: z.string().optional(),
      type: z.enum(["fact", "preference", "project", "decision", "solution", "source", "person", "inference", "workflow"]).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().min(1).max(50).optional(),
      search_mode: z.enum(["semantic", "fulltext", "auto"]).optional(),
      lang: z.string().optional().describe("BCP-47 locale for full-text search stemming (e.g. 'en', 'de', 'fr'). Defaults to 'en'."),
      maxTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Maximum sensitivity tier to return. Defaults to 3 (all tiers). Use 1 to retrieve only normal memories, 2 for normal + sensitive, 3 for everything."),
      as_of: z.string().optional().describe("ISO 8601 timestamp for point-in-time recall, e.g. '2025-01-15T10:00:00Z'. Omit to get current memories only."),
      order: z.enum(["importance", "recent"]).optional().describe("Ordering for the no-query listing: 'importance' (default, highest-priority first) or 'recent' (newest first). Ignored when a query is provided."),
    },
    getHandler: (handlers) => handlers.recall,
  },
  {
    name: "update_memory",
    description: "Update an existing memory by ID. Creates a new version and tombstones the old one so history is preserved.",
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