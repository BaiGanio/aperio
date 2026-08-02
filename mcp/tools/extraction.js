// mcp/tools/extraction.js
// Document Intelligence WS3 (issue #250), Step 3 — MCP surface over the T-G4
// handlers (lib/handlers/extraction/). Recognizes and reuses learned document
// shapes on top of WS1's ad-hoc db_execute flow; never replaces it — a
// document that matches no template still falls through to WS1.
//
// extraction_template_propose is the only write path, and it is confirm-
// gated (reuses createInterruptService via templateHandlers.proposeTemplate/
// decideTemplateProposal — same "nothing persisted until confirmed" contract
// as db_execute). extraction_template_delete executes directly, protected
// only by DESTRUCTIVE_TOOLS' JSON-repair refusal (lib/tools/executor.js) —
// the same lighter-weight pattern `forget` uses for a single-row delete on an
// internal registry table, not a two-phase interrupt like db_execute/
// delete_file. extraction_apply is read/compute-only: the actual data write
// is still a separate, unchanged WS1 db_execute call.

import { z } from "zod";
import * as templateHandlers from "../../lib/handlers/extraction/templateHandlers.js";
import { matchTemplates, classifyMatch } from "../../lib/handlers/extraction/matchHandlers.js";
import { extractFromTemplate, getLogByHash, recordExtraction, matchOrPropose } from "../../lib/handlers/extraction/extractHandlers.js";
import { EXTRACTION_CONNECTION } from "../../lib/db-connect/extraction.js";
import { classify } from "../../lib/db-connect/classify.js";
import { complete } from "../../lib/helpers/completion.js";

function asText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
function errText(msg) {
  return { content: [{ type: "text", text: `❌ ${msg}` }], isError: true };
}
// fn is already bound to ctx by createBoundHandlers below — (args) => _x(ctx, args) —
// so this wrapper takes exactly the one argument the MCP SDK's ToolCallback passes
// as its tool arguments (args: ShapeOutput<Args>, extra: Extra); it never needs or
// reads `extra`. (Previously named its own single parameter `ctx` and forwarded a
// second, defaulted one to fn — harmless only because every fn here happens to
// declare a single parameter, so JS silently dropped the extra one; that was
// fragile and misleading rather than actually wrong, and is worth being exact
// about rather than relying on.)
function safeHandler(name, fn) {
  return async (args) => {
    try { return await fn(args); }
    catch (err) {
      if (err.userFacing) return errText(err.message);
      return errText(`extraction_${name} failed: ${err.message}`);
    }
  };
}

// Weaker models pass the document body under a near-miss key instead of
// `text` — mirrors database.js's pickSql() tolerance.
function pickText(args) {
  for (const k of ["text", "document_text", "content", "doc_text"]) {
    if (typeof args[k] === "string" && args[k].trim()) return args[k];
  }
  return args.text;
}
function readToken(args) {
  return args.confirmation_token ?? args.token ?? null;
}

// ─── reads ────────────────────────────────────────────────────────────────
async function _list(ctx) {
  return asText({ templates: await templateHandlers.list(ctx.store) });
}

async function _get(ctx, { id, name }) {
  if (id == null && !name) return errText("provide `id` or `name`.");
  const template = await templateHandlers.get(ctx.store, { id, name });
  if (!template) return errText(`no template found for ${name ? `name "${name}"` : `id ${id}`}.`);
  return asText({ template });
}

async function _match(ctx, args) {
  const text = pickText(args);
  if (!text || !text.trim()) return errText("`text` is required.");
  const ranked = await matchTemplates(ctx.store, { text });
  const classified = classifyMatch(ranked);
  return asText({
    status: classified.status, // "confident" | "ambiguous" | "none"
    top: classified.top ? { template: classified.top.template.name, score: classified.top.score } : null,
    ranked: ranked.map((r) => ({ template: r.template.name, score: r.score, matchedKeywords: r.matchedKeywords })),
  });
}

async function _logCheck(ctx, { source_hash }) {
  if (!source_hash) return errText("`source_hash` is required.");
  const row = await getLogByHash(ctx.store, source_hash);
  return asText({ sourceHash: source_hash, alreadyExtracted: row ?? null });
}

// The other half of the dedup contract: extraction_apply only ever CHECKS
// extraction_log (getLogByHash) — nothing writes to it unless the calling
// agent takes this extra, deliberate step after its db_execute write is
// actually confirmed. Without this tool, no exposed flow ever calls
// recordExtraction and "already extracted" can never fire in practice.
//
// db_execute_token is not optional bookkeeping — it is the ONLY thing that
// makes this call trustworthy. Without server-side verification, an agent
// could call this before proposing the write, after the user declined it, or
// after it failed, and the source would be permanently (and silently) marked
// "already extracted" with no exposed way to undo it. The token must
// resolve to a REAL agent_interrupts row this server itself drove to
// "executed" — a model cannot fabricate that state, only reach it by going
// through the real db_execute propose → user-confirm → claimAndExecute path.
async function _logRecord(ctx, { source_hash, template_id, template_name, source_path, row_count, db_execute_token }) {
  if (!source_hash) return errText("`source_hash` is required.");
  if (!db_execute_token) {
    return errText("`db_execute_token` is required — the confirmation_token from the db_execute call that actually wrote this data. This tool refuses to record an extraction it cannot verify actually happened.");
  }

  const interrupt = await ctx.store.getAgentInterrupt(db_execute_token);
  if (!interrupt || interrupt.tool_name !== "db_execute") {
    return errText("db_execute_token does not correspond to a real db_execute confirmation.");
  }
  if (interrupt.status !== "executed") {
    return errText(`That db_execute write has status "${interrupt.status}", not "executed" — nothing was actually written yet, so nothing can be recorded as extracted.`);
  }
  const writtenConnection = interrupt.canonical_arguments?.connection;
  if (writtenConnection !== EXTRACTION_CONNECTION) {
    return errText(`That db_execute write was against connection "${writtenConnection}", not "${EXTRACTION_CONNECTION}" — refusing to record an extraction for an unrelated write.`);
  }

  // An executed db_execute token against the right connection still proves
  // nothing about WHICH source it wrote — a confirmed CREATE TABLE, or an
  // INSERT for a completely different document, would otherwise satisfy
  // every check above. Require the write to actually be an INSERT, and
  // require source_hash to appear literally among its bound params — the
  // one thing every db_execute write already carries in canonical_arguments
  // that this handler can check without knowing the model's chosen column
  // names (review finding, P1: "not tied to source_hash... or even an
  // INSERT"). extraction_apply's own tool description tells the model to
  // include sourceHash as a column value for exactly this reason.
  const sql = interrupt.canonical_arguments?.sql ?? "";
  const { keyword } = classify(sql);
  if (keyword !== "INSERT") {
    return errText(`That db_execute write was a ${keyword || "non-write"} statement, not an INSERT — refusing to record an extraction for a write that didn't insert any rows for this source.`);
  }
  const params = interrupt.canonical_arguments?.params ?? [];
  if (!params.some((p) => String(p) === String(source_hash))) {
    return errText(`source_hash "${source_hash}" was not found among that INSERT's bound parameters, so this write cannot be verified as belonging to this document. Include the sourceHash as a column value in your INSERT (see extraction_apply's description).`);
  }

  let templateId = template_id ?? null;
  if (templateId == null && template_name) {
    const template = await templateHandlers.get(ctx.store, { name: template_name });
    if (!template) return errText(`no template found for name "${template_name}".`);
    templateId = template.id;
  }
  const row = await recordExtraction(ctx.store, {
    sourceHash: source_hash, sourcePath: source_path ?? null,
    templateId, rowCount: row_count ?? 0,
  });
  return asText({ status: "recorded", log: row });
}

// One targeted completion for exactly the fields regex/label lookup left
// unresolved (plan §5 Step 2, point 2) — never a full re-extraction of the
// document. `completeFn` is injected (default: the real `complete()` from
// lib/helpers/completion.js, same helper lib/workers/infer.js's background
// loop uses) so tests can swap in a stub instead of a live model call — a
// genuine ESM function export can't be mocked in place (verified: node:test's
// mock.method throws "Cannot redefine property" on a real named export), so
// this follows infer.js's own `deps.complete` DI pattern instead.
function buildLlmFieldFallback(completeFn) {
  return async ({ text, fields }) => {
    const prompt = [
      `Extract ONLY these fields from the document text below: ${fields.join(", ")}.`,
      "Return ONLY a JSON object mapping each field name to the value found in the text — no markdown, no explanation.",
      "If a field's value genuinely is not present in the text, omit that key entirely. Never guess or invent a value.",
      "",
      "Document text:",
      text,
    ].join("\n");
    let raw;
    try {
      raw = await completeFn([{ role: "user", content: prompt }], { maxTokens: 300 });
    } catch {
      // A fallback failure (no provider configured, network error, ...) must
      // not crash extraction_apply — those fields simply stay "missing",
      // same as if no fallback had been offered at all.
      return {};
    }
    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try { return JSON.parse(match[0]); } catch { return {}; }
  };
}

// ─── extraction_apply (read/compute — the write is a separate db_execute) ──
async function _apply(ctx, args, { llmFallback } = {}) {
  const text = pickText(args);
  if (!text || !text.trim()) return errText("`text` is required.");
  const { template_id, template_name } = args;

  let template;
  if (template_id != null || template_name) {
    template = await templateHandlers.get(ctx.store, { id: template_id, name: template_name });
    if (!template) return errText(`no template found for ${template_name ? `name "${template_name}"` : `id ${template_id}`}.`);
  } else {
    const ranked = await matchTemplates(ctx.store, { text });
    const classified = classifyMatch(ranked);
    if (classified.status !== "confident") {
      return asText({
        status: classified.status,
        message: "No confident template match — pass template_name/template_id explicitly, or call extraction_template_propose to learn this shape.",
        ranked: ranked.map((r) => ({ template: r.template.name, score: r.score })),
      });
    }
    template = classified.top.template;
  }

  const result = await extractFromTemplate(ctx.store, { text, template, llmFallback });
  if (result.alreadyExtracted) return asText({ template: template.name, alreadyExtracted: result.alreadyExtracted });
  // A "missing" field (regex/label AND the LLM fallback both found nothing)
  // is reported honestly, not silently dropped or fabricated — the calling
  // model can still resolve it from its own reading of the same text before
  // proposing db_execute rows.
  return asText({
    template: template.name, sourceHash: result.sourceHash,
    confidence: result.confidence, fields: result.fields,
  });
}

// ─── extraction_template_propose (confirm-gated write) ──────────────────────
async function _propose(ctx, args) {
  const token = readToken(args);
  if (token) {
    const { row, template, error } = await templateHandlers.decideTemplateProposal(ctx, token, { decision: "approve" });
    if (error) return errText(error);
    return asText({ status: "saved", template, interruptStatus: row?.status });
  }

  const text = pickText(args);
  if (!text || !text.trim()) return errText("`text` is required.");
  const result = await matchOrPropose(ctx, { text, name: args.name });

  if (result.status === "matched") {
    return asText({ status: "matched", message: `This text already matches template "${result.template.name}" — call extraction_apply instead of proposing a new one.`, template: result.template.name });
  }
  if (result.status === "ambiguous") {
    return asText({
      status: "ambiguous",
      message: "This text scores close to more than one existing template — name one explicitly (extraction_apply's template_name) instead of guessing.",
      ranked: result.ranked.map((r) => ({ template: r.template.name, score: r.score })),
    });
  }
  if (result.status === "no-evidence") {
    return errText("No labeled amounts or dates were found in this text — nothing to propose a template from.");
  }

  return {
    content: [{ type: "text", text: [
      "📋 **New template proposed — pending your confirmation. Nothing has been saved yet.**",
      "",
      `**Name:** ${result.proposal.name}`,
      `**Keywords:** ${result.proposal.match_keywords.join(", ") || "(none)"}`,
      `**Fields:** ${result.proposal.fields.map((f) => `${f.name} (${f.amount_label ?? f.date_role})`).join(", ")}`,
      "",
      // The tool-hook (lib/agent/tool-hooks.js) extracts this exact "Action:"
      // line as the confirm card's label — same convention db_execute's own
      // proposeAction() summaryLines follow.
      `Action: Learn new template "${result.proposal.name}"`,
      `Token: ${result.token}`,
    ].join("\n") }],
  };
}

// ─── extraction_template_delete (destructive, direct — DESTRUCTIVE_TOOLS) ───
async function _delete(ctx, { id, name }) {
  if (id == null && !name) return errText("provide `id` or `name`.");
  const removed = await templateHandlers.remove(ctx.store, { id, name });
  if (!removed) return errText(`no template found for ${name ? `name "${name}"` : `id ${id}`}.`);
  return asText({ status: "deleted", id: id ?? null, name: name ?? null });
}

// completeFn: injectable override for extraction_apply's LLM fallback, same
// DI shape as lib/workers/infer.js's `deps.complete` — defaults to the real
// shared completion helper, never wired via ctx (ctx's field set is a T-G5.1
// invariant checked elsewhere; this is a tool-file-local, backward-compatible
// optional 3rd argument to register()/createBoundHandlers instead).
const createBoundHandlers = (ctx, { completeFn = complete } = {}) => {
  const llmFallback = buildLlmFieldFallback(completeFn);
  return {
    list:      safeHandler("template_list", (args) => _list(ctx, args)),
    get:       safeHandler("template_get", (args) => _get(ctx, args)),
    match:     safeHandler("template_match", (args) => _match(ctx, args)),
    propose:   safeHandler("template_propose", (args) => _propose(ctx, args)),
    delete:    safeHandler("template_delete", (args) => _delete(ctx, args)),
    apply:     safeHandler("apply", (args) => _apply(ctx, args, { llmFallback })),
    logCheck:  safeHandler("log_check", (args) => _logCheck(ctx, args)),
    logRecord: safeHandler("log_record", (args) => _logRecord(ctx, args)),
  };
};

const TOOLS = [
  {
    name: "extraction_template_list",
    description: "List every learned document-extraction template: name, match_keywords, fields, and the template's rolling confidence. Read-only.",
    schema: {},
    getHandler: (h) => h.list,
  },
  {
    name: "extraction_template_get",
    description: "Get one template's full field/keyword definition by id or name. Read-only.",
    schema: {
      id: z.number().optional().describe("Template id."),
      name: z.string().optional().describe("Template name (either id or name is required)."),
    },
    getHandler: (h) => h.get,
  },
  {
    name: "extraction_template_match",
    description: "Rank a document's text against every known template by keyword overlap. Returns the FULL ranked list with a status: 'confident' (top match is reliable — call extraction_apply), 'ambiguous' (two templates score too close to guess between — name one explicitly), or 'none' (no learned shape fits — consider extraction_template_propose, or fall back to the ad-hoc CREATE TABLE flow). Read-only, no embedding call.",
    schema: {
      text: z.string().optional().describe("Document text already read via doc_batch."),
    },
    getHandler: (h) => h.match,
  },
  {
    name: "extraction_template_propose",
    description: "Propose a NEW template learned from this document's own labeled amounts/dates, OR (if the text already confidently matches or is ambiguous with an existing template) report that instead of proposing a duplicate. SAFETY: confirm-before-save — call ONCE without confirmation_token to propose; the user confirms and the SERVER saves it. Do NOT fabricate confirmation_token and do NOT call again yourself — just propose, then end your turn.",
    schema: {
      text: z.string().optional().describe("Document text already read via doc_batch."),
      name: z.string().optional().describe("Proposed template name (lowercase-kebab-case). Auto-generated if omitted."),
      confirmation_token: z.string().optional().describe("RESERVED for the confirm flow — leave empty when proposing."),
      token: z.string().optional().describe("Alias for confirmation_token."),
    },
    getHandler: (h) => h.propose,
  },
  {
    name: "extraction_template_delete",
    description: "Permanently remove a learned template by id or name. Does not touch any already-extracted data in the extraction connection or extraction_log — only the template definition itself. Irreversible.",
    schema: {
      id: z.number().optional().describe("Template id."),
      name: z.string().optional().describe("Template name (either id or name is required)."),
    },
    getHandler: (h) => h.delete,
  },
  {
    name: "extraction_apply",
    description: "Extract fields from a document's text against a matched (or explicitly named) template: regex/label-first from the document's own evidence, then one targeted LLM lookup for any field regex/label couldn't resolve — never a full re-extraction, and a field is only ever reported 'missing' if BOTH steps found nothing (never fabricated). Returns per-field {value, provenance: 'label'|'fallback'|'llm'|'missing'}, an overall confidence, and a sourceHash. Read/compute only — writing the resulting rows is still a separate db_execute call. IMPORTANT: when you write the extracted row(s) via db_execute, include this result's sourceHash as one of your INSERT's column values (e.g. a source_hash column) — extraction_log_record can only verify and record the write if the sourceHash it's given actually appears in the confirmed INSERT's parameters. If the source text was already extracted before, returns the prior extraction_log entry instead of re-running — but that dedup only works if you call extraction_log_record with this result's sourceHash AND the db_execute confirmation_token AFTER your db_execute write is confirmed; nothing does that automatically.",
    schema: {
      text: z.string().optional().describe("Document text already read via doc_batch."),
      template_id: z.number().optional().describe("Explicit template id (skips matching)."),
      template_name: z.string().optional().describe("Explicit template name (skips matching)."),
    },
    getHandler: (h) => h.apply,
  },
  {
    name: "extraction_log_check",
    description: "Look up a source_hash (as returned by extraction_apply) in extraction_log to see if/when/how it was already extracted. Read-only.",
    schema: {
      source_hash: z.string().optional().describe("The sha256 source_hash from a prior extraction_apply result."),
    },
    getHandler: (h) => h.logCheck,
  },
  {
    name: "extraction_log_record",
    description: "Record a source as extracted. Requires db_execute_token — the SAME confirmation_token your db_execute call for this data used. The server verifies, before recording anything: the token reached status 'executed' against the extraction connection, the confirmed statement was actually an INSERT (not e.g. a CREATE TABLE), and source_hash appears among that INSERT's own bound parameters — so a write for an unrelated or nonexistent source can never be used to falsely mark this one done. Call this exactly once, right after your db_execute write is confirmed. This is what makes extraction_apply's duplicate-prevention work — skipping this step means the same document can be silently re-extracted later.",
    schema: {
      source_hash: z.string().optional().describe("The sourceHash from the extraction_apply result you just wrote."),
      db_execute_token: z.string().optional().describe("REQUIRED. The confirmation_token from the db_execute call that wrote this data — the server verifies it actually executed before recording anything."),
      template_id: z.number().optional().describe("The template id used, if known."),
      template_name: z.string().optional().describe("The template name used (resolved to an id if template_id is omitted)."),
      source_path: z.string().optional().describe("Best-effort provenance path — never used as the dedup key on its own."),
      row_count: z.number().optional().describe("How many rows the db_execute write inserted. Default 0."),
    },
    getHandler: (h) => h.logRecord,
  },
];

export function register(server, ctx, opts) {
  const handlers = createBoundHandlers(ctx, opts);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: z.object(tool.schema).passthrough() },
      tool.getHandler(handlers)
    );
  }
}
