// Pre-turn preflight: work that runs after the turn is set up but before the
// provider loop is handed the messages.
//
// Extracted from lib/agent/index.js:runAgentLoop. All four steps share a shape:
// look at the last real user message, conditionally call a tool, and fold the
// result into the request. Two of them do it by appending to opts.extraSystem,
// which is why runPreflight() RETURNS the new opts instead of mutating the
// caller's binding — the same pattern used for the wsHandler split. `messages`
// and `preExecutedTools` are containers mutated in place, so they need no
// return value.
//
// Step order is load-bearing: the doc_repos step appends to `messages`, so it
// must stay last or the earlier steps would read its synthetic tool_result as
// the "last user message".

import { randomUUID } from "node:crypto";
import logger from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { matchSkills, semanticRescue, parseSlashSkill } from "../workers/skills.js";
import { parseSearchScopes } from "./search-scopes.js";
import {
  SYNTHETIC_USER,
  needsRecallScaffold,
  isRetrievalQuestion,
  isDocRepoInventoryIntent,
  isDocumentAggregationIntent,
} from "./tool-profiles.js";

// Bounds the auto doc_batch shortcut below (not buildCandidateManifest's own
// output) to the top-scored candidates. Covers every documented T-R5
// scenario (household-epic corpus tops out around 10 relevant docs for the
// broadest multi-category prompt) while keeping a weak model's very first
// turn from being flooded with the whole indexed corpus.
const AUTO_BATCH_CANDIDATE_CAP = 16;

/** Append an injection block to opts.extraSystem, returning a new opts. */
function withExtraSystem(opts, inject) {
  return { ...opts, extraSystem: [opts.extraSystem, inject].filter(Boolean).join("\n\n---\n\n") };
}

/** A tool result that carries actual content (not an empty/"no hits" reply). */
function hasContent(raw) {
  return typeof raw === "string" && raw.trim() && !raw.includes("No memories") && raw !== "No result";
}

/**
 * Run every pre-turn step.
 *
 * @returns {Promise<{opts: object, semanticSkillNames: string[]}>} the possibly
 *   augmented opts, and any skills picked by semantic rescue for ensureTurn to
 *   merge into this turn.
 */
export async function runPreflight({
  messages, opts, provider, mcpTools, skillIndex,
  callTool, callToolHooked, setActiveSearchScopes,
  extractUserText, modelIsCapable, preExecutedTools,
}) {
  const lastUserText = () => {
    const lastUser = [...messages].reverse().find(m => m.role === "user" && !m[SYNTHETIC_USER]);
    return lastUser ? extractUserText(lastUser) : "";
  };
  let semanticSkillNames = [];

  // ── Memory safety net for scaffolded local models ───────────────────────
  // Capable Ollama models get the recall pointer but may still not call recall
  // on their own. So when the user clearly asks a memory question, fetch the
  // relevant memories for them — scoped to that question, and only then, so
  // ordinary turns stay token-free. This is a behavior *override*, gated
  // separately from tools/pointer (needsRecallScaffold, not modelIsCapable):
  // a local model can graduate to capable and keep memory while losing this
  // crutch, instead of the two riding the same threshold (issue #188). Weak
  // models and cloud providers never reach here.
  if (!opts.noTools && needsRecallScaffold(provider)) {
    const q = lastUserText();
    if (isRetrievalQuestion(q)) {
      try {
        const hits = await callToolHooked("recall", { query: q, limit: 8 });
        if (hasContent(hits)) {
          opts = withExtraSystem(opts,
            `RELEVANT MEMORIES — auto-recalled from the store for the user's question. ` +
            `Use these to answer; do NOT tell the user you have no memory of this:\n${hits}`);
        }
      } catch (err) {
        logger.warn(`[agent] auto-recall failed: ${err.message}`);
      }
    }
  }

  // ── Scope preference detection ──────────────────────────────────────
  // Recall preference-type memories matching the current query. If any have
  // a `scope:<term>` tag, they define a search scope: "when the user says X,
  // search path Y first." We inject the scope hint into the system prompt
  // AND store active scopes for tool-arg injection.
  if (!opts.noTools && modelIsCapable()) {
    const q = lastUserText();
    if (q) {
      try {
        const raw = await callTool("recall", { query: q, type: "preference", limit: 8 });
        if (hasContent(raw)) {
          const scopes = parseSearchScopes(raw);
          setActiveSearchScopes(scopes, q);
          const scopeHints = scopes.map(scope => `• "${scope.trigger}": search ${scope.path}`);
          if (scopeHints.length > 0) {
            opts = withExtraSystem(opts, [
              `SEARCH SCOPE PREFERENCES — You have stored preferences about where to search for certain topics. Respect them:`,
              ...scopeHints,
              `When calling grep_files (or similar search tools) with a query matching one of these triggers, restrict the search to the specified path.`,
            ].join("\n"));
            logger.info(`[agent] scope preferences active: ${scopeHints.map(s => s.split(":")[0]).join(", ")}`);
          }
        }
      } catch (err) {
        logger.warn(`[agent] scope preference check failed: ${err.message}`);
      }
    }
  }

  // ── Semantic skill-match rescue (opt-in) ────────────────────────────────
  // When keyword matching finds no skill for this turn, fall back to
  // embedding similarity so paraphrases ("present this to the board" → pptx)
  // still attach the right skill. Runs here — before the provider builds the
  // system prompt — and hands the result back for ensureTurn to merge. Fills
  // blanks only: it never fires when a keyword match exists, so it cannot
  // regress the deterministic matcher. Off unless APERIO_SKILL_SEMANTIC=on
  // and an embedder is available.
  if (process.env.APERIO_SKILL_SEMANTIC === "on" && !opts.noTools) {
    const raw = lastUserText();
    const q = raw ? parseSlashSkill(raw, skillIndex).cleanedText : "";
    if (q && matchSkills(q, skillIndex, { limit: 3 }).length === 0) {
      try {
        const rescued = await semanticRescue(q, skillIndex, { generateEmbedding });
        if (rescued.length) {
          semanticSkillNames = rescued.map(s => s.name);
          logger.info(`[skills] semantic rescue matched: ${semanticSkillNames.join(", ")}`);
        }
      } catch (err) {
        logger.warn(`[skills] semantic rescue failed: ${err.message}`);
      }
    }
  }

  // ── Deterministic document-index inventory ────────────────────────────
  // This is a zero-argument, read-only lookup with one correct execution
  // path. Small local models otherwise choose the adjacent code_repos or
  // answer from imagination. Execute it once, record a canonical tool
  // exchange in history, then withhold its schema for the provider turn so
  // the model formats the real result instead of calling it again.
  if (!opts.noTools && modelIsCapable() && mcpTools.some(tool => tool.name === "doc_repos")) {
    if (isDocRepoInventoryIntent(lastUserText())) {
      const toolUseId = `auto_doc_repos_${randomUUID()}`;
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "doc_repos", input: {} }],
      });
      const inventory = await callToolHooked("doc_repos", {});
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: inventory }],
      });
      preExecutedTools.add("doc_repos");
    }
  }

  // A bare expense question is still a corpus retrieval task. Run the bounded
  // manifest → batch contract before the model turn so a small local model does
  // not have to discover the inventory tool, choose among adjacent profiles,
  // and issue one read per file. The model receives the evidence and coverage,
  // never the withheld oracle; both tool schemas are withheld for this turn.
  if (!opts.noTools && modelIsCapable() && isDocumentAggregationIntent(lastUserText()) &&
      mcpTools.some(tool => tool.name === "doc_manifest") && mcpTools.some(tool => tool.name === "doc_batch")) {
    const query = lastUserText();
    const manifestId = `auto_doc_manifest_${randomUUID()}`;
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: manifestId, name: "doc_manifest", input: { query } }] });
    // Unhooked call: the manifest contract caps output at RETRIEVAL_LIMITS.maxCandidates
    // lightweight metadata rows (no document text), so it's always small by
    // design — but callToolHooked's result-offload middleware doesn't know
    // that and can still replace an oversized reply with a truncated preview,
    // which breaks the JSON.parse below and silently drops doc_batch. Using
    // callTool keeps this internal parsing path immune to offload regardless
    // of cause; the same value is pushed to the model since it's bounded anyway.
    const manifestRaw = await callTool("doc_manifest", { query });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: manifestId, content: manifestRaw }] });
    preExecutedTools.add("doc_manifest");

    let manifest;
    try { manifest = JSON.parse(typeof manifestRaw === "string" ? manifestRaw : ""); } catch { manifest = null; }
    if (Array.isArray(manifest?.candidates) && manifest.candidates.length > 0) {
      const batchId = `auto_doc_batch_${randomUUID()}`;
      // manifest.candidates is already score-sorted by buildCandidateManifest.
      // Forwarding it whole used to hand a small model every indexed document
      // in one turn — travel receipts, trade docs, tax notices included —
      // before it ever saw the question, and it never converged on an answer
      // (#313 follow-up red run). Bounding only this no-model-involved
      // shortcut, not buildCandidateManifest's own output, keeps #312/#313's
      // fix intact: an interactively-reasoning model (or T-R5.3's steered
      // path) still gets the full, honest candidate pool via its own
      // doc_manifest/doc_batch calls.
      const forwarded = manifest.candidates.slice(0, AUTO_BATCH_CANDIDATE_CAP);
      const input = { candidates: forwarded };
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: batchId, name: "doc_batch", input }] });
      const batchRaw = await callToolHooked("doc_batch", input);
      const remaining = manifest.candidates.length - forwarded.length;
      const batchContent = remaining > 0
        ? `${String(batchRaw)}\n\n[doc_batch note: auto-read the top ${forwarded.length} of ${manifest.candidates.length} discovered candidates by relevance. ${remaining} more were found but not auto-read — call doc_manifest/doc_batch yourself if the answer still looks incomplete.]`
        : batchRaw;
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: batchId, content: batchContent }] });
      preExecutedTools.add("doc_batch");
    }
  }

  return { opts, semanticSkillNames };
}
