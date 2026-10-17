// mcp/tools/wiki.js
import { z } from "zod";
import { wikiWriteHandler, wikiGetHandler, wikiSearchHandler, wikiListHandler, proposeWikiHandler } from "../../lib/handlers/wiki/wikiHandlers.js";

const createBoundHandlers = (ctx) => ({
  write:   (args) => wikiWriteHandler(ctx, args),
  get:     (args) => wikiGetHandler(ctx, args),
  search:  (args) => wikiSearchHandler(ctx, args),
  list:    (args) => wikiListHandler(ctx, args),
  propose: (args) => proposeWikiHandler(ctx, args),
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
      // Keep source ids as strings here so wikiWriteHandler can tolerate one
      // malformed or expired citation without rejecting the entire article.
      // The handler resolves live memories and drops unrecognized ids.
      source_memory_ids: z.array(z.string()).optional()
        .describe("Memory ids the article is grounded in. Invalid or expired ids are omitted."),
    },
    getHandler: (h) => h.write,
  },
  {
    name: "wiki_search",
    description:
      "Search wiki articles by topic before writing a new one — hybrid FTS + semantic over title/summary/body. " +
      "Returns a ranked list of {slug, title, summary, status, revision, score}; no bodies. " +
      "Call this first when a topic might already have an article; only fall back to wiki_write if nothing relevant comes back. " +
      "Stale articles are included but down-weighted; archived articles are excluded unless status='archived' is passed explicitly.",
    schema: {
      query:  z.string().describe("Free-text topic, e.g. 'aperio architecture' or 'deployment pipeline'."),
      tags:   z.array(z.string()).optional().describe("Restrict to articles tagged with any of these."),
      status: z.enum(["fresh", "stale", "draft", "archived"]).optional()
                .describe("Restrict to a single status. Default excludes 'archived'."),
      limit:  z.number().int().min(1).max(25).optional().describe("Max results (default 10)."),
      mode:   z.enum(["auto", "semantic", "fulltext"]).optional()
                .describe("'auto' (default) = hybrid RRF, 'semantic' = vector only, 'fulltext' = FTS only."),
    },
    getHandler: (h) => h.search,
  },
  {
    name: "wiki_list",
    description:
      "List wiki articles, newest first. No query — for browsing or surfacing recent activity. " +
      "Filters: tag (single tag, exact match), status (defaults to excluding 'archived'), updated_since (ISO timestamp). " +
      "Returns slugs, titles, summaries, status, revision — no bodies. Use wiki_search when you have a topic in mind.",
    schema: {
      tag:           z.string().optional().describe("Restrict to articles carrying this tag."),
      status:        z.enum(["fresh", "stale", "draft", "archived"]).optional()
                       .describe("Restrict to a single status. Default excludes 'archived'."),
      updated_since: z.string().optional().describe("ISO timestamp; only return articles updated at or after this."),
      limit:         z.number().int().min(1).max(100).optional().describe("Max results (default 25)."),
      offset:        z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
    },
    getHandler: (h) => h.list,
  },
  {
    name: "wiki_get",
    description:
      "Fetch a wiki article by slug. The first line of the result is a breadcrumb of the form " +
      "`🔖 From wiki: [[slug]] (rev N · status · updated YYYY-MM-DD)` — if you use this article to answer " +
      "the user, copy that breadcrumb verbatim to the top of your reply so the user knows the wiki was consulted. " +
      "If allow_stale=false, refuses to serve stale articles so the caller knows to regenerate via wiki_write. " +
      "If refresh=true AND the article is stale AND WIKI_REFRESH_PROVIDER is configured, the server will rewrite " +
      "the article via the configured cheap/local model before returning it.",
    schema: {
      slug:        z.string(),
      allow_stale: z.boolean().optional(),
      refresh:     z.boolean().optional().describe(
        "If true and the article is stale, attempt server-side regeneration via WIKI_REFRESH_PROVIDER before returning."),
    },
    getHandler: (h) => h.get,
  },
  {
    name: "propose_wiki",
    description:
      "Propose a wiki article drafted from related memories for user review. " +
      "The article is saved as a draft and the user can publish it from the UI. " +
      "Workflow: (1) call `recall` to gather related memories on a topic, " +
      "(2) draft body_md citing them as [[mem:<uuid>]], " +
      "(3) call propose_wiki with slug, title, summary, body_md, and source_memory_ids. " +
      "Use this when you notice a pattern across multiple memories that warrants a structured article.",
    schema: {
      slug: z.string().describe("URL-safe slug (lowercase letters, numbers, hyphens)."),
      title: z.string(),
      summary: z.string().optional().describe("One-line summary."),
      body_md: z.string().describe("Markdown body citing memories as [[mem:<uuid>]]."),
      tags: z.array(z.string()).optional(),
      source_memory_ids: z.array(z.string().uuid()).optional()
        .describe("Memory ids this article is grounded in. Required for provenance and freshness tracking."),
    },
    getHandler: (h) => h.propose,
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
