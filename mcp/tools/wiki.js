// mcp/tools/wiki.js
import { z } from "zod";
import { wikiWriteHandler, wikiGetHandler } from "../../lib/handlers/wiki/wikiHandlers.js";

const createBoundHandlers = (ctx) => ({
  write: (args) => wikiWriteHandler(ctx, args),
  get:   (args) => wikiGetHandler(ctx, args),
});

const TOOLS = [
  {
    name: "wiki_write",
    description:
      "Create or update a wiki article — an LLM-authored, cited synthesis of related memories. " +
      "Workflow: (1) call `recall` to gather relevant memories, (2) draft body_md citing them inline as [[mem:<uuid>]] and " +
      "linking sibling articles as [[other-slug]], (3) call wiki_write with the cited memory ids. " +
      "Upserts by slug; bumps revision on update. Use for repeated/composite topics — not single facts.",
    schema: {
      slug:     z.string().describe("Stable lowercase-kebab slug, e.g. 'aperio-architecture'. Immutable once linked."),
      title:    z.string(),
      summary:  z.string().optional().describe("1–2 sentence hook for list views."),
      body_md:  z.string().describe("Markdown body. Cite sources inline as [[mem:<uuid>]]; link siblings as [[slug]]."),
      tags:     z.array(z.string()).optional(),
      source_memory_ids: z.array(z.string().uuid()).optional()
        .describe("Memory ids the article is grounded in. Required for provenance and freshness tracking."),
    },
    getHandler: (h) => h.write,
  },
  {
    name: "wiki_get",
    description:
      "Fetch a wiki article by slug. The first line of the result is a breadcrumb of the form " +
      "`🔖 From wiki: [[slug]] (rev N · status · updated YYYY-MM-DD)` — if you use this article to answer " +
      "the user, copy that breadcrumb verbatim to the top of your reply so the user knows the wiki was consulted. " +
      "If allow_stale=false, refuses to serve stale articles so the caller knows to regenerate via wiki_write.",
    schema: {
      slug:        z.string(),
      allow_stale: z.boolean().optional(),
    },
    getHandler: (h) => h.get,
  },
];

function buildInputSchema(tool) {
  return z.object(tool.schema);
}

export function register(server, ctx) {
  const handlers = createBoundHandlers(ctx);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: buildInputSchema(tool) },
      tool.getHandler(handlers)
    );
  }
}
