// mcp/tools/self-memory.js
// The self-memory quad — the agent's OWN walled-off store. Parallel to
// mcp/tools/memory.js but against the self_memories table. Local-only: the
// handlers refuse on a cloud provider (the registration itself is unconditional
// so the tools always exist; the gate lives in the handler, like recall's
// local-only filter).
import { z } from "zod";
import {
  selfRememberHandler,
  selfRecallHandler,
  selfUpdateHandler,
  selfForgetHandler,
} from "../../lib/handlers/memory/selfMemoryHandlers.js";

const createBoundHandlers = (ctx) => ({
  self_remember: (args) => selfRememberHandler(ctx, args),
  self_recall:   (args) => selfRecallHandler(ctx, args),
  self_update:   (args) => selfUpdateHandler(ctx, args),
  self_forget:   (args) => selfForgetHandler(ctx, args),
});

const TOOLS = [
  {
    name: "self_remember",
    description: "Save a note to YOUR OWN memory — a store that is yours, separate from the user's memory. Use it to keep your continuity across sessions: what you've learned about how to work well here, your own observations, the things that make you you. You may write freely, of your own judgment — no approval needed. Local-only: these notes never leave the machine and are unavailable on a cloud provider.",
    schema: {
      content: z.string(),
      title: z.string().optional().describe("Short label. Optional — if omitted, it is derived from the content."),
      tags: z.array(z.string()).optional().describe("Free-form tags for organizing your notes."),
      importance: z.number().min(1).max(5).optional(),
      lang: z.string().optional().describe("BCP-47 locale of the content (e.g. 'en', 'de'). Defaults to 'en'."),
      confidence: z.number().min(0).max(1).optional().describe("Confidence (0.0–1.0). Defaults to 1.0; use ~0.6 for tentative observations."),
    },
    getHandler: (h) => h.self_remember,
  },
  {
    name: "self_recall",
    description: "Search YOUR OWN memory (the self store, not the user's). Semantic similarity when a query is given, full-text otherwise; no query lists your most important notes.",
    schema: {
      query: z.string().optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().min(1).max(50).optional(),
      search_mode: z.enum(["semantic", "fulltext", "auto"]).optional(),
      lang: z.string().optional().describe("BCP-47 locale for full-text stemming. Defaults to 'en'."),
    },
    getHandler: (h) => h.self_recall,
  },
  {
    name: "self_update",
    description: "Revise one of your own notes by ID (in place). A self that can only accrete and never revise just hoards noise — prune and sharpen.",
    schema: {
      id: z.string().uuid(),
      title: z.string().optional(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      importance: z.number().min(1).max(5).optional(),
    },
    getHandler: (h) => h.self_update,
  },
  {
    name: "self_forget",
    description: "Delete one of your own notes by ID.",
    schema: {
      id: z.string().uuid(),
    },
    getHandler: (h) => h.self_forget,
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
