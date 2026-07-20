// lib/agent/tool-profiles.js — Tool-profile intent classification.
//
// Extracted from lib/agent/index.js to keep the agent factory focused on
// orchestration. Everything in this module is a pure function of its
// arguments (or module-level constants) — no closure, no side effects.

import { isCloudProvider } from "../providers/index.js";

// ── Tool category constants ──────────────────────────────────────────────────

export const WRITE_TOOLS = new Set(["write_file", "edit_file", "append_file"]);
// Tools whose result may carry a `Token:` confirm line that the tool-hook turns
// into a user confirm button. write/edit/append only emit one when their write
// needs confirmation (outside scratch or a tainted turn — see files.js WRITE-01).
export const CONFIRM_TOOLS = new Set([
  "create_github_issue", "update_github_issue", "delete_file",
  "write_file", "edit_file", "append_file", "db_execute", "index_folder",
]);

// Marker for the synthetic greeting message (pushed by wsHandler at session
// start). It's a real `user` message in the history, but its text is a
// system-authored instruction ("Greet me… Do not use any tools."), so it must
// not drive keyword skill matching or tool-profile classification — otherwise
// words like "tools" spuriously load tool-integration on the greeting and bleed
// into the next real turn's matching window. A Symbol keeps it off the wire:
// JSON.stringify ignores symbol keys, so providers never see it.
export const SYNTHETIC_USER = Symbol("aperio.synthetic_user");

// ── On-demand tool loading ────────────────────────────────────────────────────

// The agent's own walled-off memory quad. Offered alongside `memory` on local
// sessions, but stripped on cloud providers (self-memory is local-only) — see
// the provider gate in lib/agent/index.js.
export const SELF_MEMORY_TOOLS = new Set(["self_remember", "self_recall", "self_update", "self_forget"]);
// Self-wiki: synthesis over self-memories, same local-only wall (see
// agent-self-memory.md Phase 2).
export const SELF_WIKI_TOOLS = new Set(["self_wiki_write", "self_wiki_get"]);

export const TOOL_PROFILES = {
  memory:        new Set(["remember", "recall", "update_memory", "forget", "propose_memory", "backfill_embeddings", "deduplicate_memories"]),
  self:          new Set([...SELF_MEMORY_TOOLS, ...SELF_WIKI_TOOLS]),
  data:          new Set(["export_data", "import_data"]),
  wiki:          new Set(["wiki_write", "wiki_get", "wiki_search", "wiki_list", "propose_wiki"]),
  // file-* profiles are split by intent so a light "read this file" prompt
  // doesn't drag in xlsx generation or node script execution. Reads are
  // available alongside edits and project scans because almost every edit
  // benefits from reading first.
  "file-read":     new Set(["read_file", "read_docx"]),
  "file-edit":     new Set(["read_file", "write_file", "edit_file", "append_file", "syntax_check"]),
  // read_docx is included here so docx-mentioning prompts (which classify as
  // file-generate via the "docx"/"word document" keyword) can actually READ the
  // source .docx — read_file rejects the .docx extension, so without this the
  // model has no on-disk docx reader and fabricates content on a docx→xlsx
  // conversion (issue #125). The docx skill already promises read_docx is
  // "always available", so this makes that promise true.
  "file-generate": new Set(["write_file", "generate_xlsx", "generate_docx", "read_docx", "run_node_script", "run_python_script"]),
  "file-project":  new Set(["read_file", "grep_files", "scan_project"]),
  "file-delete":   new Set(["delete_file"]),
  // Code graph: symbol search, outlines, call graphs. Loaded whenever the user
  // asks about code structure, project paths, or where a symbol is defined.
  codegraph: new Set(["code_repos", "code_search", "code_outline", "code_context", "code_callers", "code_callees"]),
  // Document graph: semantic/keyword search over the user's indexed documents
  // (notes, reports, PDFs, markdown — NOT code). The prose sibling of codegraph.
  // Loaded when the user asks to search their documents or names a doc_* tool.
  docgraph: new Set(["doc_search", "doc_repos", "doc_outline", "doc_context", "doc_refs"]),
  // Shell access: a single gated tool for QA/inspection that needs real
  // binaries (soffice/pdftoppm visual QA, grep on extracted text, git status).
  // run_shell itself refuses to run unless APERIO_ENABLE_SHELL=1.
  shell:         new Set(["run_shell"]),
  web:           new Set(["fetch_url", "web_search"]),
  vision:        new Set(["read_image", "preprocess_image", "describe_image"]),
  // GitHub issues: read one, list the backlog for triage, record a triage
  // verdict, or (write) create/update one. The write tools are confirm-before-
  // write — they preview first and only post on confirm:true. list/record are
  // read-only/local and back the daily issue-triage job.
  github:        new Set(["fetch_github_issue", "list_github_issues", "record_issue_triage", "create_github_issue", "update_github_issue"]),
  // SQL over named connections (the user's external DBs + Aperio's own store).
  // db_query/db_schema/db_connections are read-only; db_execute is the
  // confirm-before-write path (writes + DDL).
  database:      new Set(["db_connections", "db_schema", "db_query", "db_execute"]),
};

// Tools owned by the web process rather than the MCP child. Kept in a separate
// registry because MCP registration coverage intentionally rejects profile
// names that have no mcp/tools/*.js implementation.
export const HOST_TOOL_PROFILES = {
  // Main-process mutation that queues a code/document watcher. Kept separate
  // from graph search profiles so questions about existing indexes cannot
  // accidentally surface an indexing action.
  indexing: new Set(["index_folder"]),
};

export const FIRST_TURN_TOOLS = new Set(["recall"]);

// The per-turn tool-schema set is re-sent every model pass because LLM APIs
// are stateless. For local llama.cpp contexts this adds significant prompt-token
// cost. The schema-token budget applies at ALL context sizes: it keeps the
// recall floor and the turn's intent tools first, then includes as many core
// (memory/self/data) tools as fit within the budget ratio.
//
// Below SMALL_WINDOW_TOKENS, an additional tool-count cap prevents schema bloat
// from crowding out tool results — observed on gemma4:12b (~6k served window
// on 32 GB host) where the full schema set + a tool result exceeded the window,
// causing the model to re-issue the same call in a loop.
export const SMALL_WINDOW_TOKENS    = Number(process.env.APERIO_SMALL_WINDOW_TOKENS)    || 32768;
export const SMALL_WINDOW_MAX_TOOLS = Number(process.env.APERIO_SMALL_WINDOW_MAX_TOOLS) || 10;
export const TOOL_SCHEMA_BUDGET_RATIO = 0.20;

const CORE_PROFILE_NAMES = new Set([...TOOL_PROFILES.memory, ...TOOL_PROFILES.self, ...TOOL_PROFILES.data]);

// Priority when capping: the recall floor first (so a weak model can always look
// up what it knows), then the turn's intent tools, then the remaining baseline.
// The schema-token budget applies at ALL context sizes to limit prompt-cost
// inflation from re-sent tool schemas on every model pass. Small windows also
// get a per-turn tool-count cap.
export function capToolsForWindow(names, contextWindow, { schemaTokenCosts } = {}) {
  if (!contextWindow || contextWindow <= 0) return names;
  const arr = [...names];
  const first  = arr.filter(n => FIRST_TURN_TOOLS.has(n));
  const intent = arr.filter(n => !FIRST_TURN_TOOLS.has(n) && !CORE_PROFILE_NAMES.has(n));
  const core   = arr.filter(n => !FIRST_TURN_TOOLS.has(n) && CORE_PROFILE_NAMES.has(n));
  const ordered = [...first, ...intent, ...core];
  const isSmall = contextWindow <= SMALL_WINDOW_TOKENS;
  const maxTools = isSmall ? Math.max(SMALL_WINDOW_MAX_TOOLS, Math.floor(contextWindow / 1024)) : ordered.length;
  const schemaBudget = Math.floor(contextWindow * TOOL_SCHEMA_BUDGET_RATIO);
  const selected = [];
  let usedSchemaTokens = 0;
  for (const name of ordered) {
    if (selected.length >= maxTools) break;
    const cost = schemaTokenCosts?.get(name);
    if (Number.isFinite(cost) && cost > 0 && usedSchemaTokens + cost > schemaBudget) continue;
    selected.push(name);
    if (Number.isFinite(cost) && cost > 0) usedSchemaTokens += cost;
  }
  return selected.length === names.size ? names : new Set(selected);
}

// Schema budgeting addresses the measured llama.cpp context-window failures.
// Other providers have distinct prompt/tool contracts and must keep the full
// tool set selected by their profiles.
export function capToolsForProvider(names, provider, options = {}) {
  if (provider?.name !== "llamacpp") return names;
  return capToolsForWindow(names, provider.contextWindow, options);
}

// Per-model gate for run_shell. Two conditions must hold:
//   1. APERIO_ENABLE_SHELL=1 — the global opt-in (also enforced inside the tool
//      itself; checked here so a disabled shell is never even offered).
//   2. The model is trusted to drive a shell. Cloud providers run capable models
//      and qualify by default. Local llama.cpp models vary wildly in capability
//      and are the ones prone to tool-call thrashing, so they stay on the narrow
//      node-only path unless explicitly opted in via APERIO_SHELL_LOCAL=1.
export function isShellAllowedFor(provider) {
  if (process.env.APERIO_ENABLE_SHELL !== "1") return false;
  if (isCloudProvider(provider.name)) return true;
  return process.env.APERIO_SHELL_LOCAL === "1";
}

// Whether a model is capable enough to be offered tools and a memory pointer.
// Cloud providers run capable models and qualify by default. Toolless models
// never qualify (they can't act on tools or a recall pointer). Local llama.cpp
// models vary wildly, so a local model qualifies only when its exact name is
// listed in APERIO_CAPABLE_MODELS (comma-separated) — everything else is treated
// as weak and gets neither tools nor memory, keeping its context lean.
export function isCapableModel(provider, noTools = false) {
  if (noTools) return false;
  if (isCloudProvider(provider.name)) return true;
  const model = (provider.model || "").toLowerCase();
  return (process.env.APERIO_CAPABLE_MODELS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    .includes(model);
}

// Whether a model needs the forced-recall scaffold — a behavior *override* that
// injects memories into the system prompt regardless of the model's own choice,
// as opposed to the neutral recall pointer above that a model may act on or not.
// This is a separate, finer gate below isCapableModel, so promoting a local model
// to "capable" (tools + pointer) doesn't automatically saddle it with the
// override too. Three tiers: weak (nothing), capable (tools + pointer, trusted
// to act), needs-scaffold (capable plus the override). Backed by its own env list
// so a model can be graduated out of the scaffold — falls back to
// APERIO_CAPABLE_MODELS when unset, so default behavior is unchanged. Cloud
// providers never need it: they're already fully trusted at the capable tier.
export function needsRecallScaffold(provider) {
  if (isCloudProvider(provider.name)) return false;
  const model = (provider.model || "").toLowerCase();
  const raw = process.env.APERIO_RECALL_SCAFFOLD_MODELS ?? process.env.APERIO_CAPABLE_MODELS ?? "";
  return raw
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    .includes(model);
}

export function isDocRepoInventoryIntent(text = "") {
  const t = String(text).toLowerCase();
  if (/\bdoc(?:_|[\s-])repos?\b/.test(t)) return true;

  // Code repositories have their own inventory tool. Do not let the generic
  // word "indexed" redirect an explicitly code-scoped question to doc_repos.
  if (/\b(code|codebase|repos?|repositories|symbols?)\b/.test(t) &&
      !/\b(docs?|documents|notes|reports)\b/.test(t)) return false;

  const asksForInventory = /\b(what|which|list|show|tell|give|where|how many)\b/.test(t);
  const folderAndIndexed =
    /\b(folders?|directories|locations?)\b[\s\S]{0,80}\bindexed\b/.test(t) ||
    /\bindexed\b[\s\S]{0,80}\b(folders?|directories|locations?)\b/.test(t);
  return asksForInventory && folderAndIndexed;
}

function hasDocumentGraphIntent(text = "") {
  const t = String(text).toLowerCase();
  const explicitDocTool = /\bdoc(?:_|[\s-])(search|repos?|outline|context|refs)\b/.test(t);
  const explicitWeb = /\b(web|website|internet|online|https?|url)\b/.test(t);
  const corpusRetrieval =
    /\b(search|find|locate|query|look through|look in)\b[\s\S]{0,100}\b(docs?|documents|notes|reports|pdfs?|records)\b/.test(t) ||
    /\b(my (docs?|documents|notes)|indexed (docs?|documents|files|folders?)|document graph|docgraph|(?:find (?:me )?)?similar (docs?|documents|files|records))\b/.test(t);
  return explicitDocTool || isDocRepoInventoryIntent(t) || (corpusRetrieval && !explicitWeb);
}

export function classifyProfiles(text) {
  const t = text.toLowerCase();
  const docGraphIntent = hasDocumentGraphIntent(t);
  const docRepoInventoryIntent = isDocRepoInventoryIntent(t);
  const active = new Set(["memory", "self", "data"]);
  const indexingIntent =
    /\b(?:index(?:ing)?|reindex(?:ing)?)\b[\s\S]{0,100}\b(?:folder|directory|repo|repository|codebase|documents?|notes?|pdfs?|path)\b/.test(t) ||
    /\b(?:folder|directory|repo|repository|codebase|documents?|notes?|pdfs?|path)\b[\s\S]{0,100}\b(?:index(?:ing)?|reindex(?:ing)?)\b/.test(t);
  if (indexingIntent) active.add("indexing");
  if (/\b(wiki|article|articles)\b/.test(t)) active.add("wiki");

  // Heavy generators: xlsx/pptx/docx/budget/template — only load the
  // generation tools when the user actually references one of these.
  // CSV/TSV is excluded from the main pattern: plain CSV uses file-edit
  // (write_file) instead. CSV/TSV only loads file-generate when paired with
  // explicit Excel/workbook/spreadsheet intent. "generate" alone also does
  // not activate file-generate when the target is CSV/TSV.
  const hasRichFormatIntent = /\b(xlsx|spreadsheet|excel|budget|template|pptx|slide|slides|presentation|deck|powerpoint|slideshow|chart|docx|word doc|word document)\b/.test(t);
  const hasCsvOrTsv = /\b(csv|tsv)\b/.test(t);
  const hasGenerateIntent = /\bgenerate\b/.test(t);
  const hasExcelIntentForCsv = /\b(xlsx|spreadsheet|excel|workbook|worksheet|formula|pivot)\b/.test(t);
  if (hasRichFormatIntent ||
      (hasGenerateIntent && !hasCsvOrTsv) ||
      (hasCsvOrTsv && hasExcelIntentForCsv)) {
    active.add("file-generate");
  }
  // Project-wide ops (scanning, codebase traversal).
  if (/\b(project|projects|codebase|repo|repository|scan|folder|directory|tree)\b/.test(t)) {
    active.add("file-project");
  }
  if (/\bgrep_files\b/.test(t) ||
      /\b(find|search|locate|grep)\b[\s\S]{0,80}\b(bug|code|files?|folders?|paths?|project|repo|repository|function|class)\b/.test(t)) {
    active.add("file-project");
  }
  // Code graph: symbol/function/class lookup, call graph, code structure. Kept
  // narrow — the bare words "project"/"codebase"/"repo" no longer trigger it
  // (they already load file-project), so a generic "scan this project" prompt
  // doesn't drag in 6 extra code-graph tool schemas it won't use.
  if (/\b(function|class|method|symbol|where is|where are|defined|callers|callees|call graph|code graph|outline|code search|project path)\b/.test(t) ||
      (/\bindexed\b[\s\S]{0,60}\b(code|codebase|repos?|repositories|symbols?)\b/.test(t) ||
       /\b(code|codebase|repos?|repositories|symbols?)\b[\s\S]{0,60}\bindexed\b/.test(t))) {
    active.add("codegraph");
  }
  // Document graph: search over the user's indexed document corpus (notes,
  // reports, PDFs, markdown — NOT code). Triggered by an explicit doc_* tool
  // name or document-corpus retrieval phrasing ("search my documents/notes",
  // "across my indexed docs", "find similar documents"). Kept narrow so a
  // generic "search" only loads web.
  if (docGraphIntent) active.add("docgraph");
  // Edits / writes / creation.
  const explicitFileTarget = /\b(file|files|path|folder|directory|disk|locally|markdown|\.md|csv|tsv|\.csv|\.tsv)\b/.test(t);
  const fileEditIntent =
    /\b(write|edit|modify|append|save|create|new file|rename)\b/.test(t) ||
    (explicitFileTarget && /\b(export|generate|convert)\b/.test(t));
  if (fileEditIntent && (!active.has("wiki") || explicitFileTarget)) {
    active.add("file-edit");
  }
  // Destructive file ops — kept in a separate narrow set so delete_file is not
  // offered on every edit turn.
  if (/\b(delete|remove|unlink|trash|erase|wipe|clean up)\b/.test(t)) {
    active.add("file-delete");
  }
  // Plain reads — keep narrow so "read this" doesn't unlock writes.
  if (/\b(read|open|view|show|cat|look at|inspect|file|files)\b/.test(t) && !active.has("file-edit") && !active.has("file-generate")) {
    active.add("file-read");
  }

  // Shell: explicit run/QA verbs, plus deck/spreadsheet work (whose QA steps —
  // soffice/pdftoppm render, grep for placeholders — need real binaries).
  if (/\b(run|command|terminal|shell|execute|test|tests|verify|render|convert|qa|grep|libreoffice|soffice|pdftoppm|thumbnail|pptx|slide|slides|presentation|powerpoint|deck|xlsx|spreadsheet)\b/.test(t)) {
    active.add("shell");
  }

  if (/\b(image|photo|picture|screenshot|vision|see|look at)\b/.test(t)) active.add("vision");
  if (/\b(url|http|fetch|web|website|search|browse|visit|link)\b/.test(t)) active.add("web");
  // GitHub issues — explicit github/issue intent. "issue" alone is included even
  // though it sometimes means "problem"; a false positive only attaches 3 tool
  // schemas, whereas missing it leaves the model unable to act at all.
  if (/\b(github|gh|issue|issues)\b/.test(t)) active.add("github");
  // Database tools — SQL/connection intent. Loaded when the user references a
  // database, an engine, SQL, or the act of querying/inserting rows.
  if (/\b(sql|database|databases|postgres|postgresql|sqlite|mysql|db|schema|tables?|columns?|rows?|connection|query|insert into|select from)\b/.test(t)) {
    active.add("database");
  }

  // Corpus requests should not make a small model choose among semantically
  // adjacent web/code/filesystem tools. Preserve those profiles only when the
  // user names that scope explicitly; an inventory question is otherwise a
  // doc_repos-only read among the search families.
  if (docGraphIntent) {
    if (!/\b(web|website|internet|online|https?|url)\b/.test(t)) active.delete("web");
    if (!/\b(code|codebase|repos?|repositories|symbols?|functions?|classes?|methods?)\b/.test(t)) active.delete("codegraph");
    if (docRepoInventoryIntent && !/\b(project|codebase|repos?|repositories|scan|tree|grep)\b/.test(t)) {
      active.delete("file-project");
      active.delete("file-read");
    }
    if (!/\b(run|execute|command|shell|test|tests|verify|render|convert|qa)\b/.test(t)) active.delete("shell");
  }
  return active;
}

// A direct user instruction to create/update a wiki article authorizes the
// mutation itself. `propose_wiki` is the review path for agent-initiated
// synthesis (or when the user explicitly asks for a proposal), and offering it
// beside `wiki_write` on an imperative write turn gives smaller models two
// semantically plausible but contractually different exits.
export function isExplicitWikiWriteIntent(text = "") {
  const t = String(text).toLowerCase();
  if (!/\bwiki(?:\s+article)?\b/.test(t)) return false;
  return /\b(write|create|author|update|publish|save)\b[\s\S]{0,100}\bwiki(?:\s+article)?\b/.test(t) ||
    /\bwiki(?:\s+article)?\b[\s\S]{0,100}\b(write|create|author|update|publish|save)\b/.test(t);
}

export function filterToolsForIntent(names, text = "") {
  if (!names?.has?.("propose_wiki") || !isExplicitWikiWriteIntent(text)) return names;
  const selected = new Set(names);
  selected.delete("propose_wiki");
  return selected;
}

export function countUserTurns(messages) {
  return messages.filter(m => {
    // The synthetic greeting prompt must not count as a turn, or the first real
    // user message becomes "turn 2" and loses the FIRST_TURN_TOOLS recall floor
    // — leaving the model unable to look up what it knows about the user.
    if (m.role !== "user" || m[SYNTHETIC_USER]) return false;
    const c = m.content;
    if (Array.isArray(c)) return c.some(b => b.type === "text");
    return typeof c === "string";
  }).length;
}

// Heuristic: is the user's message a memory-retrieval question? Drives the
// deterministic auto-recall in runAgentLoop (Layer 2) so weak local models don't
// answer "I have no memory of that" from the small preloaded preview without ever
// searching. Tuned to the observed QWEN3 failures ("do I have any meeting today",
// "do you recall any memories"). A false positive only costs one extra recall, so
// the patterns lean inclusive.
const RETRIEVAL_RE = /\b(do you (remember|recall)|what do you (know|remember)|do i have (any|a |an )|did i (tell|say|mention|ask)|have we (discuss|talk|spoke|cover|mention)|recall (any|my|the|some|memor)|remember (any|that|when|my|if|what)|any (memor|notes?|reminders?|records?)|what(?:'s| is| are) (stored|saved|in (memory|your memory)))\b/i;

export function isRetrievalQuestion(text) {
  if (!text || text.length > 400) return false;
  return RETRIEVAL_RE.test(text);
}

export function parseMemoriesRaw(raw) {
  if (!raw || raw.trim() === "No memories found." || raw.trim() === "No result") return [];
  return raw.split("---").filter(b => b.trim()).map(block => {
    const lines = block.trim().split("\n");
    const header = lines[0] || "";
    const typeMatch = header.match(/\[(\w+)\]/);
    const titleMatch = header.match(/\] (.+?) \(importance:/) || header.match(/\] (.+)/);
    const importanceMatch = header.match(/importance: (\d)/);
    const contentLine = lines[1] || "";
    const tagsLine = lines.find(l => l.startsWith("Tags:")) || "";
    const tags = tagsLine.replace("Tags:", "").trim().split(",").map(t => t.trim()).filter(Boolean);
    const idLine = lines.find(l => l.startsWith("ID:")) || "";
    const id = idLine.replace("ID:", "").trim() || null;
    const dateLine = lines.find(l => l.startsWith("Created:") || l.startsWith("Saved:")) || "";
    const createdAt = dateLine.split(":").slice(1).join(":").trim() || null;
    const type = typeMatch?.[1]?.toLowerCase() || "fact";
    const title = titleMatch?.[1] || "Untitled";
    return { type, title, content: contentLine, tags: tags[0] === "none" ? [] : tags, importance: Number.parseInt(importanceMatch?.[1] || "3"), id, createdAt };
  });
}
