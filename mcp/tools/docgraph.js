// mcp/tools/docgraph.js
import { z } from "zod";
import {
  searchHandler,
  reposHandler,
  outlineHandler,
  contextHandler,
  refsHandler,
} from "../../lib/handlers/docgraph/docgraphHandlers.js";

const createBoundHandlers = (ctx) => ({
  search:  (args) => searchHandler(ctx, args),
  repos:   (args) => reposHandler(ctx, args),
  outline: (args) => outlineHandler(ctx, args),
  context: (args) => contextHandler(ctx, args),
  refs:    (args) => refsHandler(ctx, args),
});

const TOOLS = [
  {
    name: "doc_search",
    description: "Search the pre-indexed document graph (notes, reports, plain text — NOT code; use code_search for code) for passages by meaning or keyword. Hybrid FTS + semantic when embeddings are available. Returns ranked hits, each with {document, section, snippet, score}; use the document path + section.id with doc_context to fetch the surrounding text. Prefer this over read_file for 'where did I write about X' across an indexed folder.",
    schema: {
      query:  z.string().describe("What to look for — natural language or keywords."),
      folder: z.string().optional().describe("Substring of an indexed folder's path. Omit to search all. Call doc_repos to see what's indexed."),
      mime:   z.string().optional().describe("Restrict to one document type, e.g. 'text/markdown', 'text/plain'."),
      limit:  z.number().min(1).max(50).optional(),
    },
    getHandler: (h) => h.search,
  },
  {
    name: "doc_repos",
    description: "List every folder indexed in the document graph, with document + chunk counts, a by-mime breakdown, and last index time. Call this first when you don't know where something lives or what's available.",
    schema: {},
    getHandler: (h) => h.repos,
  },
  {
    name: "doc_outline",
    description: "Return the section tree (table of contents) for one document: each section's id, heading, level, parent, and chunk count, in document order. Cheap map to scan before fetching full text with doc_context.",
    schema: {
      path:   z.string().describe("Folder-relative path of the document, e.g. 'notes/q3-budget.md'."),
      folder: z.string().optional().describe("Substring of an indexed folder's path. Disambiguates when the same relative path exists in more than one folder."),
    },
    getHandler: (h) => h.outline,
  },
  {
    name: "doc_context",
    description: "Fetch the text of one section (by section_id from doc_outline/doc_search) or one chunk (by chunk_id from doc_search) of a document. The analog of code_context — pull only the slice you need instead of read_file on the whole document.",
    schema: {
      path:       z.string().describe("Folder-relative path of the document."),
      section_id: z.number().optional().describe("Section id from doc_outline or doc_search. One of section_id / chunk_id is required."),
      chunk_id:   z.number().optional().describe("Chunk id from a doc_search hit. Returns just that passage."),
      folder:     z.string().optional().describe("Substring of an indexed folder's path. Disambiguates duplicate relative paths."),
    },
    getHandler: (h) => h.context,
  },
  {
    name: "doc_refs",
    description: "Find every indexed document that mentions a specific reference — an ID (e.g. 'INV-204871', 'JIRA-1234'), URL, email, citation key, or wikilink. Cross-document lookup: returns each {document, section, kind, value}. Use this for 'which of my files reference X' questions; use doc_search for free-text topics.",
    schema: {
      ref:    z.string().describe("The exact reference to look up, e.g. 'INV-204871' or 'https://example.com/x'."),
      folder: z.string().optional().describe("Substring of an indexed folder's path. Omit to search all indexed folders."),
      limit:  z.number().min(1).max(200).optional(),
    },
    getHandler: (h) => h.refs,
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
