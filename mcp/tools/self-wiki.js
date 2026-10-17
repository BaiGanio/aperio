// mcp/tools/self-wiki.js
// Self-wiki quad (write/get) — synthesized notes over YOUR OWN self-memories.
// Parallel to mcp/tools/wiki.js but against the self_wiki_articles table.
// Local-only: the handlers refuse on a cloud provider (registration is
// unconditional, like self-memory.js, so the gate lives in the handler).
import { z } from "zod";
import {
  selfWikiWriteHandler,
  selfWikiGetHandler,
} from "../../lib/handlers/wiki/selfWikiHandlers.js";

const createBoundHandlers = (ctx) => ({
  self_wiki_write: (args) => selfWikiWriteHandler(ctx, args),
  self_wiki_get:   (args) => selfWikiGetHandler(ctx, args),
});

const TOOLS = [
  {
    name: "self_wiki_write",
    description:
      "Create or update an article in YOUR OWN wiki — a synthesis you write over several of your own self-memories, so you don't have to re-derive the same understanding every session. " +
      "Workflow: (1) call `self_recall` to gather relevant self-notes, (2) draft body_md, (3) call self_wiki_write with the cited self-memory ids in source_self_memory_ids. " +
      "Upserts by slug; bumps revision on update. This is YOUR private synthesis — not something to show the user. Local-only, autonomous (no approval needed).",
    schema: {
      slug:    z.string().describe("Stable lowercase-kebab slug, e.g. 'how-i-work-here'. Immutable once written."),
      title:   z.string(),
      summary: z.string().optional().describe("1–2 sentence hook."),
      body_md: z.string().describe("Markdown body of your synthesis."),
      tags:    z.array(z.string()).optional(),
      source_self_memory_ids: z.array(z.string().uuid()).optional()
        .describe("Your own self-memory ids this article is grounded in — used for staleness tracking (the article is marked stale if a cited self-memory changes)."),
    },
    getHandler: (h) => h.self_wiki_write,
  },
  {
    name: "self_wiki_get",
    description:
      "Fetch one of your own wiki articles by slug. Reports 'stale' in the status line if a cited self-memory changed since last write — " +
      "if so, call self_wiki_write again to refresh it. Private to you; not meant to be shown to the user.",
    schema: {
      slug: z.string(),
    },
    getHandler: (h) => h.self_wiki_get,
  },
];

export function register(server, ctx) {
  const handlers = createBoundHandlers(ctx);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: z.object(tool.schema) },
      tool.getHandler(handlers)
    );
  }
}
