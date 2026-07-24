// mcp/tools/codegraph.js
import { z } from "zod";
import {
  searchHandler,
  outlineHandler,
  contextHandler,
  callersHandler,
  calleesHandler,
  reposHandler,
  neighborsHandler,
  pathHandler,
  insightsHandler,
} from "../../lib/handlers/codegraph/codegraphHandlers.js";

const createBoundHandlers = (ctx) => ({
  search:    (args) => searchHandler(ctx, args),
  outline:   (args) => outlineHandler(ctx, args),
  context:   (args) => contextHandler(ctx, args),
  callers:   (args) => callersHandler(ctx, args),
  callees:   (args) => calleesHandler(ctx, args),
  repos:     (args) => reposHandler(ctx, args),
  neighbors: (args) => neighborsHandler(ctx, args),
  path:      (args) => pathHandler(ctx, args),
  insights:  (args) => insightsHandler(ctx, args),
});

const TOOLS = [
  {
    name: "code_search",
    description: "Search the pre-indexed code graph for symbols (functions, classes, methods, consts) by name or doc text. Hybrid FTS + semantic when embeddings are available. Returns ranked matches; each carries its repo (name + absolute root_path) plus the qualified name — use those with code_context to fetch source, and never guess which repo a relative path belongs to.",
    schema: {
      query: z.string().describe("Search terms — matched against symbol name and leading comment/JSDoc."),
      kind:  z.enum(["function","class","method","const","type"]).optional(),
      repo:  z.string().optional().describe("Substring of an indexed repo's root path. Omit to search across all repos. Call code_repos to see what's indexed."),
      limit: z.number().min(1).max(50).optional(),
    },
    getHandler: (h) => h.search,
  },
  {
    name: "code_repos",
    description: "List every repo currently indexed in the code graph, with file/symbol counts and last index time. Call this first when you don't know which repo a symbol lives in.",
    schema: {},
    getHandler: (h) => h.repos,
  },
  {
    name: "code_outline",
    description: "List every symbol declared in a file with line ranges. Cheap map to scan before fetching context. Each symbol carries its repo. If the same relative path exists in multiple indexed repos, pass repo to disambiguate.",
    schema: {
      path: z.string().describe("Repo-relative path, e.g. 'lib/agent/index.js'."),
      repo: z.string().optional().describe("Substring of an indexed repo's root path (e.g. its name). Disambiguates when the path exists in more than one repo."),
    },
    getHandler: (h) => h.outline,
  },
  {
    name: "code_context",
    description: "Fetch the source slice for a symbol by its qualified name (from code_search). Includes leading comment, signature, and a small line padding. Qualified names can collide across repos — pass repo (from the search result) to fetch from the intended one.",
    schema: {
      qualified: z.string().describe("Qualified symbol name, e.g. 'lib/agent/index.js::Agent.run'."),
      padding:   z.number().min(0).max(20).optional().describe("Extra lines above/below the symbol body. Default 2."),
      repo:      z.string().optional().describe("Substring of an indexed repo's root path (e.g. its name). Disambiguates when the same qualified name exists in more than one repo."),
    },
    getHandler: (h) => h.context,
  },
  {
    name: "code_callers",
    description: "Find symbols that call the given target. Returns one hop by default; depth>1 walks the reverse call graph (capped at 5). Each result carries its repo.",
    schema: {
      qualified: z.string(),
      depth:     z.number().min(1).max(5).optional(),
      repo:      z.string().optional().describe("Substring of an indexed repo's root path (e.g. its name). Disambiguates the target when the same qualified name exists in more than one repo."),
    },
    getHandler: (h) => h.callers,
  },
  {
    name: "code_callees",
    description: "Find symbols called by the given target (one hop by default; depth walks the forward call graph, capped at 5). Each result carries its repo.",
    schema: {
      qualified: z.string(),
      depth:     z.number().min(1).max(5).optional(),
      repo:      z.string().optional().describe("Substring of an indexed repo's root path (e.g. its name). Disambiguates the target when the same qualified name exists in more than one repo."),
    },
    getHandler: (h) => h.callees,
  },
  {
    name: "code_neighbors",
    description: "Explore the neighborhood around a symbol across all relation kinds (calls, imports, extends, references) — not just calls. BFS out to depth 3, with per-node hop numbers, edge confidence metadata, and honest truncation. Use direction to follow outgoing (out), incoming (in), or both.",
    schema: {
      qualified: z.string().describe("Qualified symbol name, e.g. 'lib/agent/index.js::Agent.run'. A file node's qualified name is its repo-relative path."),
      repo:      z.string().optional().describe("Substring of an indexed repo's root path. Required only when the symbol exists in more than one repo."),
      direction: z.enum(["in", "out", "both"]).optional().describe("Edge direction to follow. Default 'both'."),
      kinds:     z.array(z.enum(["calls", "imports", "extends", "references"])).optional().describe("Restrict to these relation kinds. Omit for all."),
      depth:     z.number().min(1).max(3).optional().describe("Hops to expand (1–3). Default 1."),
      limit:     z.number().min(1).max(100).optional().describe("Max neighbor nodes returned (1–100). Default 50; truncated=true when more were eligible."),
    },
    getHandler: (h) => h.neighbors,
  },
  {
    name: "code_path",
    description: "Find a bounded shortest relationship path between two symbols. Undirected by default (set directed=true to respect edge orientation). Returns the ordered nodes/edges and hop_count, or a distinct { found:false } when the endpoints are known but unreachable.",
    schema: {
      from:      z.string().describe("Source qualified symbol name."),
      to:        z.string().describe("Target qualified symbol name."),
      repo:      z.string().optional().describe("Substring of an indexed repo's root path. Required only when either endpoint is ambiguous across repos."),
      directed:  z.boolean().optional().describe("Respect edge direction. Default false (traverse either way)."),
      kinds:     z.array(z.enum(["calls", "imports", "extends", "references"])).optional().describe("Restrict to these relation kinds. Omit for all."),
      max_depth: z.number().min(1).max(10).optional().describe("Maximum path length (1–10). Default 6."),
    },
    getHandler: (h) => h.path,
  },
  {
    name: "code_insights",
    description: "Architecture insights for an indexed repo: community structure, hotspots (highest-connectivity symbols), cross-community bridges, and import cycles. Analysis is computed once per graph revision and reused. Pick a view; results are bounded.",
    schema: {
      repo:  z.string().describe("Substring of an indexed repo's root path (required). Call code_repos to see what's indexed."),
      view:  z.enum(["summary", "communities", "hotspots", "bridges", "cycles"]).optional().describe("Which insight to return. Default 'summary'."),
      limit: z.number().min(1).max(50).optional().describe("Max items in the collection (1–50). Default 20."),
    },
    getHandler: (h) => h.insights,
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
