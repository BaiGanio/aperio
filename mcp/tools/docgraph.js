// mcp/tools/docgraph.js
import { z } from "zod";
import {
  searchHandler,
  reposHandler,
  manifestHandler,
  batchHandler,
  outlineHandler,
  contextHandler,
  refsHandler,
} from "../../lib/handlers/docgraph/docgraphHandlers.js";

const createBoundHandlers = (ctx) => ({
  search:  (args) => searchHandler(ctx, args),
  repos:   (args) => reposHandler(ctx, args),
  manifest:(args) => manifestHandler(ctx, args),
  // Only doc_batch's underlying retrieveInBatches() actually polls an abort
  // signal mid-request — thread the SDK's per-call `extra.signal` through so
  // cancelling/timing out a real doc_batch call stops retrieval instead of
  // running to completion after the caller has stopped listening.
  // `extra._meta.docSessionId` (set by lib/agent/index.js's callTool, see
  // llamacpp-multiturn-latency.md Step 3) identifies which conversation this
  // call belongs to, for session-scoped repeat-read dedup — it never reaches
  // the model, since it rides MCP's own request metadata channel, not the
  // Zod-validated `arguments`.
  batch:   (args, extra) => batchHandler(ctx, args, extra?.signal, extra?._meta?.docSessionId),
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
    name: "doc_manifest",
    description: "Build a deterministic, bounded manifest of indexed documents before reading content. Discovers all indexed folders at runtime, deduplicates content twins (see each candidate's `duplicates` list — merged copies, not dropped silently), and reports selection reasons and truncation. Each candidate carries `file_mtime` (filesystem timestamp — indexing/edit time, NOT a document date) separately from `filename_date_hint` (best-effort date parsed from the filename/title only, or null). Neither is the document's real date; for that, read the body with doc_batch and use its per-document `dates` field. Use this for document aggregation when the location is unknown.",
    schema: {
      query: z.string().describe("The user's document question or retrieval task."),
      folder: z.string().optional().describe("Optional indexed-folder substring; omit to discover across all folders."),
      mime: z.string().optional().describe("Optional MIME filter."),
      limit: z.number().int().min(1).max(48).optional().describe("Maximum candidates; the default is bounded."),
    },
    getHandler: (h) => h.manifest,
  },
  {
    name: "doc_batch",
    description: "Read a doc_manifest candidate list in bounded batches. Returns one entry per document with found/read/skipped coverage and per-file reasons. Each read document carries the raw `text` (for verification) plus structured evidence extracted from it: `dates` — an array of {role, raw, value, confidence}, where role is one of invoice_date/document_date/statement_date/receipt_date/payment_date/due_date/service_period_start/service_period_end/unlabeled_date, and `value` is ISO YYYY-MM-DD or null when the raw token's format is ambiguous; `amounts` — an array of {value, currency, raw, label}, where currency is a 3-letter code or null when undetectable, and label (e.g. amount_due/subtotal/total/paid) is null when no nearby money label was found in a known language. label can also be 'likely_total' — a best-effort, language-agnostic guess used when no known label word matched: either the amount on the line right after a tax/VAT percentage figure, or (when that doesn't apply) the last currency-bearing amount with no matched label, since most invoices print the amount actually owed after any breakdown/subtotal/tax lines. Can appear even when other amounts in the same document did get a real label (e.g. subtotal matched but the total's keyword isn't in a known language yet); treat it as lower-confidence than a real label, and still cross-check against `text` before reporting a figure to the user. Also includes a `highlights` field — a plain-text summary listing every document that has a terminal-labeled amount (amount_due / grand_total) with value, currency, label, and a filename-based category hint (utility/fuel/groceries/transport/internet/statement/tax_notice/commercial/travel). Use this to orient yourself before reading the full per-document entries. Category hints are filename-based and may be wrong — always verify against `text` and `amounts[].label`. An empty `dates`/`amounts` array means none were found — never treat a missing field as zero or as 'not present in the source', only as 'not detected by extraction'; fall back to `text` to check. Do not call once per file; pass the manifest candidates together. Also includes a deterministic `aggregate` field — the facts pipeline (issue #250) applied to the read documents: per-currency, per-category totals (with duplicates merged — e.g. a receipt and the statement row that records the same purchase — and documents that could not evidence a countable amount listed under `aggregate.excluded` with a reason), computed by application code, not by the model. Use it for spending-total questions instead of summing `amounts` yourself. The optional `aggregate_period` ('YYYY-MM') restricts those totals to one month; documents whose resolved period differs are reported under `aggregate.excluded` rather than counted.",
    schema: {
      candidates: z.array(z.object({
        id: z.number(),
        repo_id: z.number().optional(),
        root_path: z.string().optional(),
        rel_path: z.string(),
        mime: z.string().optional(),
        size: z.number().optional(),
        sha256: z.string().nullable().optional(),
      })).max(48),
      aggregate_period: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Optional 'YYYY-MM'. When set, the deterministic `aggregate` totals only documents whose resolved period is that month; all others are listed under aggregate.excluded."),
      batch_size: z.number().int().min(1).max(6).optional(),
      max_file_bytes: z.number().int().positive().max(120000).optional(),
      max_batch_bytes: z.number().int().positive().max(160000).optional(),
      max_total_bytes: z.number().int().positive().max(160000).optional(),
    },
    getHandler: (h) => h.batch,
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

// A doc_batch dedup-cache invalidation control channel used to live here as
// a "docgraph_clear_session_cache" tool. It was moved to a custom (non-tool)
// JSON-RPC method in mcp/index.js's startServer(): every MCP tool registered
// via server.registerTool() is visible through tools/list() to ANY connected
// client, including a subscription provider's own MCP client (Codex spawns
// and talks to its own separate instance of this mcp/index.js directly;
// runClaudeCodeLoop builds its tool list from the full mcpTools catalog, not
// the per-turn profile-filtered subset) — so it was a real, model-callable
// tool on both regardless of lib/agent/tool-profiles.js (llamacpp-multiturn-
// latency.md Step 3 review, round 5, P2). See lib/agent/index.js's
// clearDocSessionCache() for the only caller.

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
