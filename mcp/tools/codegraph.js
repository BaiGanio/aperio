// mcp/tools/codegraph.js
import { z } from "zod";
import {
  searchHandler,
  outlineHandler,
  contextHandler,
  callersHandler,
  calleesHandler,
  reposHandler,
} from "../../lib/handlers/codegraph/codegraphHandlers.js";

const createBoundHandlers = (ctx) => ({
  search:   (args) => searchHandler(ctx, args),
  outline:  (args) => outlineHandler(ctx, args),
  context:  (args) => contextHandler(ctx, args),
  callers:  (args) => callersHandler(ctx, args),
  callees:  (args) => calleesHandler(ctx, args),
  repos:    (args) => reposHandler(ctx, args),
});

const TOOLS = [
  {
    name: "code_search",
    description: "Search the pre-indexed code graph for symbols (functions, classes, methods, consts) by name or doc text. Hybrid FTS + semantic when embeddings are available. Returns ranked matches with qualified names — use those with code_context to fetch source.",
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
    description: "List every symbol declared in a file with line ranges. Cheap map to scan before fetching context.",
    schema: {
      path: z.string().describe("Repo-relative path, e.g. 'lib/agent/index.js'."),
    },
    getHandler: (h) => h.outline,
  },
  {
    name: "code_context",
    description: "Fetch the source slice for a symbol by its qualified name (from code_search). Includes leading comment, signature, and a small line padding.",
    schema: {
      qualified: z.string().describe("Qualified symbol name, e.g. 'lib/agent/index.js::Agent.run'."),
      padding:   z.number().min(0).max(20).optional().describe("Extra lines above/below the symbol body. Default 2."),
    },
    getHandler: (h) => h.context,
  },
  {
    name: "code_callers",
    description: "Find symbols that call the given target. Returns one hop by default; depth>1 walks the reverse call graph (capped at 5).",
    schema: {
      qualified: z.string(),
      depth:     z.number().min(1).max(5).optional(),
    },
    getHandler: (h) => h.callers,
  },
  {
    name: "code_callees",
    description: "Find symbols called by the given target (one hop by default; depth walks the forward call graph, capped at 5).",
    schema: {
      qualified: z.string(),
      depth:     z.number().min(1).max(5).optional(),
    },
    getHandler: (h) => h.callees,
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
