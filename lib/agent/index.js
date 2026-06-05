import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, existsSync, statSync, readdirSync, copyFileSync } from "fs";
import { resolve, basename, join } from "path";
import { getActiveScratchDir } from "../routes/paths.js";
import { loadSkillIndex, matchSkills, getAlwaysOnSkills, injectSkill } from "../workers/skills.js";
import { resolveReasoningAdapter } from "../workers/reasoning.js";
import logger from "../helpers/logger.js";
import { resolveProvider, getRecommendedModel } from "../providers/index.js";
import { zodToJsonSchema } from "../providers/schema.js";
import { runAnthropicLoop } from "./providers/anthropic.js";
import { runOllamaLoop } from "./providers/ollama.js";
import { runGeminiLoop } from "./providers/gemini.js";
import { runDeepSeekLoop } from "./providers/deepseek.js";
import { runClaudeCodeLoop } from "./providers/claude-code.js";
import { validateWrittenFile } from "../tools/validateWrittenFile.js";
import { summarizeArgs, summarizeResult } from "./toolActivity.js";

const WRITE_TOOLS = new Set(["write_file", "edit_file", "append_file"]);

// Marker for the synthetic greeting message (pushed by wsHandler at session
// start). It's a real `user` message in the history, but its text is a
// system-authored instruction ("Greet me… Do not use any tools."), so it must
// not drive keyword skill matching or tool-profile classification — otherwise
// words like "tools" spuriously load tool-integration on the greeting and bleed
// into the next real turn's matching window. A Symbol keeps it off the wire:
// JSON.stringify ignores symbol keys, so providers never see it.
export const SYNTHETIC_USER = Symbol("aperio.synthetic_user");

export { getRecommendedModel, resolveProvider, zodToJsonSchema };

// ── On-demand tool loading ────────────────────────────────────────────────────

const TOOL_PROFILES = {
  memory:        new Set(["remember", "recall", "update_memory", "forget", "backfill_embeddings", "deduplicate_memories"]),
  wiki:          new Set(["wiki_write", "wiki_get", "wiki_search", "wiki_list"]),
  // file-* profiles are split by intent so a light "read this file" prompt
  // doesn't drag in xlsx generation or node script execution. Reads are
  // available alongside edits and project scans because almost every edit
  // benefits from reading first.
  "file-read":     new Set(["read_file"]),
  "file-edit":     new Set(["read_file", "write_file", "edit_file", "append_file", "syntax_check"]),
  "file-generate": new Set(["write_file", "generate_xlsx", "run_node_script", "run_python_script"]),
  "file-project":  new Set(["read_file", "scan_project"]),
  "file-delete":   new Set(["delete_file"]),
  // Code graph: symbol search, outlines, call graphs. Loaded whenever the user
  // asks about code structure, project paths, or where a symbol is defined.
  codegraph: new Set(["code_repos", "code_search", "code_outline", "code_context", "code_callers", "code_callees"]),
  // Shell access: a single gated tool for QA/inspection that needs real
  // binaries (soffice/pdftoppm visual QA, grep on extracted text, git status).
  // run_shell itself refuses to run unless APERIO_ENABLE_SHELL=1.
  shell:         new Set(["run_shell"]),
  web:           new Set(["fetch_url"]),
  vision:        new Set(["read_image", "preprocess_image", "describe_image"]),
};
const FIRST_TURN_TOOLS = new Set(["recall"]);

// Per-model gate for run_shell. Two conditions must hold:
//   1. APERIO_ENABLE_SHELL=1 — the global opt-in (also enforced inside the tool
//      itself; checked here so a disabled shell is never even offered).
//   2. The model is trusted to drive a shell. Cloud providers run capable models
//      and qualify by default. Local Ollama models vary wildly in capability and
//      are the ones prone to tool-call thrashing, so they stay on the narrow
//      node-only path unless explicitly opted in via APERIO_SHELL_LOCAL=1.
function isShellAllowedFor(provider) {
  if (process.env.APERIO_ENABLE_SHELL !== "1") return false;
  if (provider.name !== "ollama") return true;
  return process.env.APERIO_SHELL_LOCAL === "1";
}

function classifyProfiles(text) {
  const t = text.toLowerCase();
  const active = new Set(["memory"]);
  if (/\b(wiki|article|articles)\b/.test(t)) active.add("wiki");

  // Heavy generators: xlsx/pptx/csv/budget/template — only load the
  // generation tools when the user actually references one of these.
  if (/\b(xlsx|spreadsheet|excel|csv|budget|template|pptx|slide|slides|presentation|deck|powerpoint|slideshow|generate|chart|docx|word doc|word document)\b/.test(t)) {
    active.add("file-generate");
  }
  // Project-wide ops (scanning, codebase traversal).
  if (/\b(project|projects|codebase|repo|repository|scan|folder|directory|tree)\b/.test(t)) {
    active.add("file-project");
  }
  // Code graph: symbol/function/class lookup, call graph, code structure. Kept
  // narrow — the bare words "project"/"codebase"/"repo" no longer trigger it
  // (they already load file-project), so a generic "scan this project" prompt
  // doesn't drag in 6 extra code-graph tool schemas it won't use.
  if (/\b(function|class|method|symbol|where is|where are|defined|callers|callees|call graph|code graph|indexed|outline|code search|project path)\b/.test(t)) {
    active.add("codegraph");
  }
  // Edits / writes / creation.
  if (/\b(write|edit|modify|append|save|create|new file|rename)\b/.test(t)) {
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
  return active;
}

function countUserTurns(messages) {
  return messages.filter(m => {
    if (m.role !== "user") return false;
    const c = m.content;
    if (Array.isArray(c)) return c.some(b => b.type === "text");
    return typeof c === "string";
  }).length;
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

export async function createAgent({ root, version, clientName = "Aperio-agent", providerConfig = null, persona = null, character = null } = {}) {
  const provider = resolveProvider(providerConfig ?? {});
  // shellAllowed is kept in a mutable box so setProvider() can update it.
  const shellBox = { allowed: isShellAllowedFor(provider) };
  const reasoningAdapter = resolveReasoningAdapter(provider.model);
  const state = { thinks: reasoningAdapter.thinks === true, noTools: reasoningAdapter.noTools === true };
  const personaTag = persona ? ` persona="${persona}"` : "";
  const characterTag = character ? ` character="${character}"` : "";
  logger.info(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${state.thinks} noTools=${state.noTools} shell=${shellBox.allowed}${personaTag}${characterTag}`);

  const FILES = ["whoami.md"];
  const CACHED_PROMPT = FILES.map(f => { try { return readFileSync(resolve(root, "id", f), "utf-8"); } catch { return ""; } }).join("\n\n");
  // Persona overlay (e.g. id/whoami-primary.md) — appended to the base prompt
  // for round-table mode. Read once at boot so it's cached for the agent's lifetime.
  const PERSONA_PROMPT = persona
    ? (() => { try { return readFileSync(resolve(root, "id", `whoami-${persona}.md`), "utf-8"); } catch { return ""; } })()
    : "";
  // Character overlay (e.g. id/characters/space-engineer.md) — domain expertise
  // layered on top of the protocol role. Distinct from persona: persona says
  // *how* the agent participates (answerer/reviewer), character says *who* it is.
  const CHARACTER_PROMPT = character
    ? (() => { try { return readFileSync(resolve(root, "id", "characters", `${character}.md`), "utf-8"); } catch (e) { logger.warn(`[agent] character "${character}" not found: ${e.message}`); return ""; } })()
    : "";
  const skillIndex = loadSkillIndex(resolve(root, "skills"));
  function buildProviderTag(p) {
    const label = p.name === "ollama" ? `Ollama (${p.model})` : p.name === "deepseek" ? `DeepSeek (${p.model})` : p.name === "gemini" ? `Google Gemini (${p.model})` : p.name === "claude-code" ? `Anthropic Claude via subscription (${p.model})` : `Anthropic Claude (${p.model})`;
    return `---\nYou are running as: ${label}\nIf asked which model or AI you are, answer accurately using the above.`;
  }

  const LANG_NAMES = {
    en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
    it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", ro: "Romanian",
    el: "Greek", sv: "Swedish", da: "Danish", fi: "Finnish", cs: "Czech",
    sk: "Slovak", sl: "Slovenian", hr: "Croatian", hu: "Hungarian", et: "Estonian",
    lv: "Latvian", lt: "Lithuanian", mt: "Maltese", ga: "Irish",
  };
  function buildLanguageDirective(lang) {
    const name = LANG_NAMES[lang];
    if (!name || lang === "en") return null;
    return `LANGUAGE DIRECTIVE — highest priority, overrides all other instructions:\n` +
      `The user's interface language is ${name} (${lang}). ` +
      `You MUST think and reason in ${name}. Do NOT use English in your reasoning chain — think in ${name} from the first token. ` +
      `Respond to the user in ${name} using natural, native phrasing. ` +
      `Exception: if the user explicitly writes in a different language, mirror that language for both thinking and response. ` +
      `Keep code, identifiers, file paths, CLI snippets, and proper names in their original form.`;
  }

  const transport = new StdioClientTransport({ command: "node", args: [resolve(root, "mcp/index.js")], env: { ...process.env } });
  const mcp = new Client({ name: clientName, version });
  await mcp.connect(transport);
  const { tools: mcpTools } = await mcp.listTools();
  const anthropicToolsAll = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const ollamaToolsAll = mcpTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.inputSchema) } }));
  const geminiDeclsAll = mcpTools.map(t => ({ name: t.name, description: t.description, parameters: zodToJsonSchema(t.inputSchema) }));

  const anthropicByName = new Map(anthropicToolsAll.map(t => [t.name, t]));
  const ollamaByName    = new Map(ollamaToolsAll.map(t => [t.function.name, t]));
  const geminiByName    = new Map(geminiDeclsAll.map(d => [d.name, d]));

  // ── Per-turn resolution cache ─────────────────────────────────────────────
  // Skill matching and profile classification depend only on the user-message
  // portion of the conversation, which doesn't change during a single tool
  // loop iteration sequence. We compute them once per turn and reuse — both
  // to avoid recomputing identical regexes on every loop iteration and to log
  // the result a single time instead of N times.
  function extractUserText(m) {
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.find(b => b.type === "text")?.text ?? "";
    return "";
  }
  // Recent-window text: current user message + at most the previous (RECENT_USER_TURNS - 1)
  // prior user messages. This preserves the "ok, proceed" follow-up case (the
  // immediately-preceding user message stays in scope) without unboundedly
  // accumulating profile triggers across the entire session.
  const RECENT_USER_TURNS = 2;
  function recentUserText(messages, userText) {
    const all = messages
      .filter(m => m.role === "user" && !m[SYNTHETIC_USER])
      .map(extractUserText)
      .filter(Boolean);
    // If the caller already appended the current user message to `messages`,
    // drop the trailing duplicate so we don't count it twice.
    const priors = (all.length > 0 && all[all.length - 1] === userText) ? all.slice(0, -1) : all;
    const window = priors.slice(-(RECENT_USER_TURNS - 1));
    return [...window, userText].filter(Boolean).join(" ");
  }

  let turnCache = { key: null };
  // Set at the start of each runAgentLoop so logTurnOnce can push the resolved
  // skill set to the browser. Stays in scope across the provider loop's
  // iterations; the per-turn `emitted` flag keeps it to one frame per turn.
  let currentEmitter = null;
  function ensureTurn(messages, userText) {
    const turnNum = countUserTurns(messages);
    const key = `${turnNum}|${userText.length}|${userText.slice(0, 96)}`;
    if (turnCache.key === key) return turnCache;
    // When the active turn is the synthetic greeting, its instruction text must
    // not be classified — fall back to empty text so only the always-on skills
    // and the memory floor apply (the greeting needs conversation-lifecycle, not
    // tool-integration). Real turns classify the recent window as usual.
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const currentIsSynthetic = !!lastUser?.[SYNTHETIC_USER] && extractUserText(lastUser) === userText;
    const text = currentIsSynthetic ? "" : recentUserText(messages, userText);
    const profiles = classifyProfiles(text);
    const names = new Set([...profiles].flatMap(p => [...(TOOL_PROFILES[p] ?? [])]));
    // First-turn floor: ensure recall is always available on turn 1, but also
    // union in the profile-derived tools so an obviously-scoped prompt
    // ("get the wiki article for X") can use wiki_get without an extra hop
    // through recall first.
    if (turnNum <= 1) for (const n of FIRST_TURN_TOOLS) names.add(n);

    // Per-model gate: drop run_shell unless this provider/model is trusted to
    // drive a shell (see isShellAllowedFor). The shell profile may still have
    // added it above; this removes it before any provider getter sees it.
    if (!shellBox.allowed) names.delete("run_shell");

    // Resolve skills to inject: always-on first, then up to 3 matched by
    // keyword/name. Dedupe by skill name. injectSkill() handles depends-on
    // by prepending the dependency content.
    const alwaysOn = getAlwaysOnSkills(skillIndex);
    const matched  = matchSkills(text, skillIndex, { limit: 3 });
    const skills = [];
    const seen = new Set();
    for (const s of [...alwaysOn, ...matched]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      skills.push(s);
    }

    // If any matched skill documents a `node ...` script step, ensure
    // run_node_script is available — even when the user's words didn't
    // trigger the file-generate profile keywords (e.g. "show me themes").
    for (const s of skills) {
      if (s.content?.includes("`node ")) names.add("run_node_script");
      if (s.content?.includes("`python")) names.add("run_python_script");
    }

    turnCache = { key, turnNum, profiles, names, skills, logged: false };
    return turnCache;
  }
  function logTurnOnce(t) {
    if (t.logged) return;
    if (t.skills?.length) logger.info(`🎯 Skills matched: ${t.skills.map(s => s.name).join(", ")}`);
    logger.info(`[tools] turn=${t.turnNum} profiles=[${[...t.profiles].join(",")}] attached=${t.names.size}/${mcpTools.length} schemas (re-sent each turn — LLM APIs are stateless)`);
    t.logged = true;
    // Surface the resolved skills to the UI once per turn (skills are injected
    // into the system prompt, not executed — so this is the only place the
    // browser can learn which ones steered the answer).
    if (!t.emitted && currentEmitter && t.skills?.length) {
      // char/4 matches the client-side estimator; this is the system-prompt
      // cost each injected skill adds to every turn's input, so the UI chip can
      // show *how much* each skill is costing instead of just naming it.
      const est = str => Math.max(0, Math.ceil((str || "").trim().length / 4));
      currentEmitter.send({
        type: "skills_matched",
        turn: t.turnNum,
        skills: t.skills.map(s => ({ name: s.name, description: s.description || "", always: s.load === "always", tokens: est(s.content) })),
      });
    }
    t.emitted = true;
  }

  const getSystemPrompt = (userMessage = "", lang = "en", extraSystem = "", messages = []) => {
    const langDirective = buildLanguageDirective(lang);
    const parts = langDirective ? [langDirective, CACHED_PROMPT] : [CACHED_PROMPT];
    if (PERSONA_PROMPT) parts.push(PERSONA_PROMPT);
    if (CHARACTER_PROMPT) parts.push(CHARACTER_PROMPT);
    const t = ensureTurn(messages, userMessage);
    logTurnOnce(t);
    // Inject each resolved skill (with dependency prepended where declared).
    // Track injected dependency names so a depends-on already loaded as a
    // top-level skill isn't pasted twice.
    const injected = new Set();
    for (const s of t.skills ?? []) {
      if (injected.has(s.name)) continue;
      if (s.dependsOn && injected.has(s.dependsOn)) {
        parts.push(s.content);
      } else {
        parts.push(injectSkill(s, skillIndex));
        if (s.dependsOn) injected.add(s.dependsOn);
      }
      injected.add(s.name);
    }
    parts.push(buildProviderTag(ctx.provider));
    if (extraSystem) parts.push(extraSystem);
    return parts.join("\n\n---\n\n");
  };

  function resolveToolNames(messages, userText) {
    const t = ensureTurn(messages, userText);
    logTurnOnce(t);
    return t.names;
  }

  function getAnthropicTools(userText, messages) {
    const names = resolveToolNames(messages, userText);
    return mcpTools.filter(t => names.has(t.name)).map(t => anthropicByName.get(t.name));
  }
  function getOllamaTools(userText, messages) {
    const names = resolveToolNames(messages, userText);
    return mcpTools.filter(t => names.has(t.name)).map(t => ollamaByName.get(t.name));
  }
  function getGeminiTools(userText, messages) {
    const names = resolveToolNames(messages, userText);
    return [{ functionDeclarations: mcpTools.filter(t => names.has(t.name)).map(t => geminiByName.get(t.name)) }];
  }

  async function callTool(name, input) {
    const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
    // parseArgs signals a JSON decode failure with a __parse_error__ sentinel.
    // Return the error to the model without hitting the MCP handler.
    if (args.__parse_error__) {
      logger.error(`[callTool] ${name} — skipped due to JSON parse error in args`);
      return `❌ ${args.__parse_error__}`;
    }
    let result;
    try {
      result = await mcp.callTool({ name, arguments: args });
    } catch (err) {
      logger.error(`[callTool] ${name} failed:`, err);
      return `❌ Tool error (${name}): ${err.message}`;
    }
    const text = result.content?.find(c => c.type === "text")?.text ?? "";
    const image = result.content?.find(c => c.type === "image");
    if (image?.data) {
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType ?? "image/jpeg", data: image.data } });
      return blocks;
    }
    return text || "No result";
  }

  const claudeCodeState = { sessionId: null };
  const ctx = { provider, callTool, getSystemPrompt, getAnthropicTools, getOllamaTools, getGeminiTools, reasoningAdapter, state, claudeCodeState };

  // Greeting turn: Ollama/DeepSeek use noTools:true → 0 tools loaded.
  // Anthropic/Gemini use FIRST_TURN_TOOLS (just recall) → 1 tool.
  const greetingToolCount = (provider.name === "anthropic" || provider.name === "claude-code" || provider.name === "gemini")
    ? FIRST_TURN_TOOLS.size
    : 0;

  const agentObj = {
    provider, mcpTools, persona, character,
    greetingToolCount,
    getToolCount(userText, messages) {
      const names = resolveToolNames(messages, userText);
      return mcpTools.filter(t => names.has(t.name)).length;
    },
    // Per-component estimate of the FIXED startup prompt cost (identity + the
    // always-on skills, each named), so the UI banner can explain *what* the
    // startup tokens are instead of showing one opaque number. char/4 matches
    // the client-side estimator; the banner still shows the provider's real
    // total. The dynamic memory-preload piece is added by the ws handler, which
    // knows how many memories were actually preloaded.
    getStartupBreakdown() {
      const est = s => Math.max(0, Math.ceil((s || "").trim().length / 4));
      const alwaysOn = getAlwaysOnSkills(skillIndex);
      return {
        identity: est(CACHED_PROMPT),
        skills: alwaysOn.map(s => ({ name: s.name, tokens: est(s.content) })),
      };
    },
    get OLLAMA_THINKS() { return state.thinks; },
    OLLAMA_NO_TOOLS: state.noTools, reasoningAdapter, callTool,
    async runAgentLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
      currentEmitter = emitter;
      // Monotonic id pairing each tool_start with its tool_result so the UI can
      // update the right activity card even when several tools run in a turn.
      let toolSeq = 0;
      // Per-turn failure budget. We tolerate 2 malformed/invalid tool calls
      // in a row; the 3rd one trips the budget and every subsequent tool call
      // in this turn returns a hard abort message instead of executing. This
      // turns silent model thrashing into a hard user-visible signal.
      const FAILURE_BUDGET = 3;
      const failures = { count: 0, kinds: [] };

      // Downloadable artifacts already surfaced to the UI this turn, keyed by
      // `path:size`, so re-running verify on an unchanged file doesn't emit a
      // duplicate download card.
      const surfacedArtifacts = new Set();
      const DOWNLOADABLE_EXT = /\.(pptx|pdf|docx|xlsx|xls|csv)$/i;

      // Emit a download card for a generated artifact that lives in the session
      // scratch workspace (served by the /scratch static route). Deduped.
      const surfaceArtifact = (absPath) => {
        let st;
        try { st = statSync(absPath); } catch { return; }
        const key = `${absPath}:${st.size}`;
        if (surfacedArtifacts.has(key)) return;
        const rel = absPath.split("/var/scratch/")[1];
        if (!rel) return; // only artifacts inside the session workspace are servable
        surfacedArtifacts.add(key);
        emitter.send({
          type: "generated_file",
          filename: basename(absPath),
          url: `/scratch/${rel}`,
          sizeKb: Math.max(1, Math.round(st.size / 1024)),
        });
      };

      // Scan the active session workspace for downloadable artifacts and surface
      // any not yet shown. This makes the download card reliable even when the
      // model writes the file with its own generator script (which prints no
      // APERIO_PPTX marker) and skips the verify.js step.
      const surfaceScratchArtifacts = () => {
        const scratch = getActiveScratchDir();
        if (!scratch) return;
        let entries;
        try { entries = readdirSync(scratch, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.isFile() && DOWNLOADABLE_EXT.test(e.name)) surfaceArtifact(join(scratch, e.name));
        }
      };
      const recordFailure = (kind, detail = "") => {
        failures.count++;
        failures.kinds.push(kind);
        const short = String(detail).replace(/\s+/g, " ").slice(0, 200);
        logger.warn(`[callToolHooked] tool failure ${failures.count}/${FAILURE_BUDGET} (${kind}): ${short}`);
        emitter.send({ type: "tool_failure", count: failures.count, budget: FAILURE_BUDGET, kind, detail: short });
        if (failures.count >= FAILURE_BUDGET) {
          emitter.send({ type: "tool_budget_exhausted", count: failures.count, kinds: failures.kinds });
        }
      };
      const budgetMessage = () => {
        const counts = failures.kinds.reduce((acc, k) => (acc[k] = (acc[k] || 0) + 1, acc), {});
        const summary = Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(", ");
        const causes = [];
        if (counts.parseArgs)            causes.push("you produced malformed JSON in your tool-call arguments (missing colons, unclosed quotes, or unescaped characters inside string values) — this is YOUR output, not a tool malfunction");
        if (counts.postWriteValidation)  causes.push("you wrote a file whose contents do not parse as valid JS/JSON/XML — the file lives on disk but is syntactically broken");
        if (counts.pptxFileMissing)      causes.push("a script printed an APERIO_PPTX success marker but the file is not actually on disk");
        const causeBlock = causes.length ? "Root cause(s):\n  - " + causes.join("\n  - ") + "\n\n" : "";
        return (
          `❌ TOOL-CALL BUDGET EXHAUSTED — ${failures.count} failed tool call(s) in this turn (${summary}). ` +
          `Stop calling tools immediately.\n\n` +
          causeBlock +
          `Do NOT tell the user that "the tool is broken" or "write_file is corrupting code" — that is incorrect. ` +
          `The Aperio tools work; the failure is in the JSON you generated for their arguments, or in the file contents you produced.\n\n` +
          `Tell the user verbatim:\n` +
          `"I produced ${failures.count} invalid tool calls in a row (${summary}) and hit the per-turn safety budget, so I stopped before corrupting anything. ` +
          `This is a sign the current model is degraded for this specific task. Please retry with a stronger model, or paste the generator code inline and I'll run it instead of writing it."`
        );
      };

      const callToolHooked = async (name, input) => {
        if (failures.count >= FAILURE_BUDGET) {
          return budgetMessage();
        }
        const callArgs = input?.parameters !== undefined ? input.parameters : (input ?? {});
        const seq = ++toolSeq;
        emitter.send({ type: "tool_start", seq, name, arg: summarizeArgs(name, callArgs) });
        const startedAt = Date.now();
        const result = await callTool(name, input);
        const { ok, summary } = summarizeResult(name, result);
        emitter.send({ type: "tool_result", seq, name, ok, summary, ms: Date.now() - startedAt });

        // Detect parseArgs failure that bubbled through callTool. Both the
        // destructive-tool refusal and the unrepairable fall-through return a
        // string starting with "❌" containing "valid JSON".
        if (typeof result === "string" && result.startsWith("❌") && /valid JSON/i.test(result)) {
          recordFailure("parseArgs", `${name}: ${result}`);
          if (failures.count >= FAILURE_BUDGET) return budgetMessage();
        } else if (typeof result === "string" && result.startsWith("❌ Tool error")) {
          // MCP-level failure (schema validation, handler throw). These are
          // valid JSON but invalid calls — e.g. wrong required params — and used
          // to loop unchecked because they don't match the parseArgs detector.
          // Count them so a thrashing model trips the per-turn budget.
          recordFailure("toolError", `${name}: ${result}`);
          if (failures.count >= FAILURE_BUDGET) return budgetMessage();
        }
        if (name === "recall" && result && result !== "No memories found." && result !== "No result") {
          emitter.send({ type: "recall_result", text: result });
        }
        if (name === "remember") {
          const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
          if (args.expires_at) {
            const expiryDate = new Date(args.expires_at);
            const isValidFuture = !Number.isNaN(expiryDate.getTime()) && expiryDate > new Date(Date.now() + 3600_000);
            if (isValidFuture) {
              const idMatch = typeof result === "string" && result.match(/\(id: ([0-9a-f-]{36})\)/);
              if (idMatch) {
                emitter.send({ type: "ttl_chip", id: idMatch[1], memType: args.type, title: args.title, expires_at: args.expires_at });
              }
            }
          }
        }
        if (name === "generate_xlsx" && typeof result === "string" && result.startsWith("APERIO_FILE:")) {
          try {
            const fileInfo = JSON.parse(result.slice("APERIO_FILE:".length));
            emitter.send({ type: "generated_file", filename: fileInfo.filename, url: fileInfo.url, sizeKb: fileInfo.sizeKb });
            return `✅ Created ${fileInfo.filename} (${fileInfo.sizeKb} KB) — available for download.`;
          } catch (parseErr) {
            logger.error(`[callToolHooked] APERIO_FILE parse failed: ${parseErr.message}`);
            /* malformed marker — fall through and return raw result */
          }
        }
        // Post-write validation: catch the model writing syntactically broken
        // files (often from regex-repaired JSON args or simple slip-ups) before
        // the next turn proceeds as if the file is fine. We only check cheap,
        // in-process formats — see lib/tools/validateWrittenFile.js.
        if (WRITE_TOOLS.has(name) && typeof result === "string" && !result.startsWith("❌")) {
          const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
          const targetPath = args?.path;
          if (typeof targetPath === "string" && targetPath) {
            try {
              const v = await validateWrittenFile(targetPath);
              if (!v.ok) {
                logger.warn(`[callToolHooked] post-write ${v.lang} validation failed for ${targetPath}: ${v.message}`);
                recordFailure("postWriteValidation", `${v.lang} ${targetPath}: ${v.message}`);
                if (failures.count >= FAILURE_BUDGET) return budgetMessage();
                return (
                  `${result}\n\n` +
                  `⚠️ POST-WRITE VALIDATION FAILED — ${v.lang} parse error in ${targetPath}:\n${v.message}\n\n` +
                  `The file was written but is no longer valid ${v.lang}. ` +
                  `Read it back with read_file, identify the corruption (often a misplaced quote, escaped character, or truncated string), ` +
                  `and fix it with edit_file (targeted replacement) before continuing. Do NOT tell the user the change succeeded.`
                );
              }
            } catch (err) {
              logger.error(`[callToolHooked] validator threw for ${targetPath}: ${err.message}`);
            }
          }
        }
        if (name === "run_node_script" && typeof result === "string") {
          // pptx (and other) skill scripts emit APERIO_PPTX:{...} on success.
          // Independently stat the file before believing the script — if it
          // claims success but the artifact is missing, rewrite the result so
          // the model is forced to see the discrepancy instead of hallucinating.
          const markerMatch = result.match(/APERIO_PPTX:(\{[^\n]*\})/);
          if (markerMatch) {
            try {
              const info = JSON.parse(markerMatch[1]);
              if (info?.path) {
                if (!existsSync(info.path)) {
                  logger.error(`[callToolHooked] APERIO_PPTX claims ${info.path} but it is not on disk`);
                  recordFailure("pptxFileMissing", info.path);
                  if (failures.count >= FAILURE_BUDGET) return budgetMessage();
                  return `❌ Script printed APERIO_PPTX marker for ${info.path} but the file does NOT exist on disk. Do not tell the user the file was created. Investigate stderr above and retry.\n\n${result}`;
                }
                const st = statSync(info.path);
                if (st.size !== info.size) {
                  logger.warn(`[callToolHooked] APERIO_PPTX size mismatch ${info.path}: marker=${info.size} disk=${st.size}`);
                }
                // For final pptx artifacts surface them to the UI like generated_xlsx.
                if (info.path.toLowerCase().endsWith(".pptx") && (info.action === "pack" || info.action === "verify")) {
                  surfaceArtifact(info.path);
                }
              }
            } catch (parseErr) {
              logger.error(`[callToolHooked] APERIO_PPTX parse failed: ${parseErr.message}`);
            }
          }
          // Surface PPTX_ERROR markers too so they're easy to find in logs.
          const errMatch = result.match(/PPTX_ERROR:(\{[^\n]*\})/);
          if (errMatch) {
            try {
              const info = JSON.parse(errMatch[1]);
              logger.error(`[pptx script error] ${info.script}: ${info.error} (${info.code || "no code"})`);
            } catch (parseErr) {
              logger.error(`[callToolHooked] PPTX_ERROR parse failed: ${parseErr.message}`);
            }
          }
          // Reliable fallback: surface any downloadable artifact the script left
          // in the session workspace, even if it printed no marker (e.g. a custom
          // pptxgenjs generator that called writeFile directly). Deduped, so this
          // never double-counts the marker path above.
          surfaceScratchArtifacts();

          // If stdout contains an image file path (e.g. a swatch sheet generator
          // printing its output path), copy the image to the scratch workspace and
          // inject the web-accessible URL into the tool result. Without this the
          // model would embed an absolute filesystem path in markdown which the
          // browser cannot load.
          const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i;
          const scratchDir = getActiveScratchDir();
          if (scratchDir) {
            const imgPaths = [...result.matchAll(/^(\/[^\s]+)/gm)]
              .map(m => m[1])
              .filter(p => IMAGE_EXT.test(p) && existsSync(p));
            if (imgPaths.length) {
              const urls = [];
              for (const absPath of imgPaths) {
                try {
                  const dest = join(scratchDir, basename(absPath));
                  copyFileSync(absPath, dest);
                  const rel = dest.split("/var/scratch/")[1];
                  if (rel) urls.push(`/scratch/${rel}`);
                } catch (copyErr) {
                  logger.warn(`[callToolHooked] image copy failed: ${copyErr.message}`);
                }
              }
              if (urls.length) {
                // Replace every absolute image path with its web URL so the
                // model never sees a filesystem path it could misuse in markdown.
                let patched = result;
                for (let i = 0; i < imgPaths.length; i++) {
                  if (urls[i]) patched = patched.replaceAll(imgPaths[i], urls[i]);
                }
                return patched;
              }
            }
          }
        }
        // delete_file phase 1: strip the token from the model's view so it
        // cannot self-confirm. Emit the token to the UI for user confirmation.
        if (name === "delete_file") {
          const tokenMatch = typeof result === "string" && result.match(/\bToken:\s*(del_[a-z0-9]+)\b/i);
          if (tokenMatch) {
            const token = tokenMatch[1];
            const pathArg = ((input?.parameters !== undefined ? input.parameters : input) ?? {}).path || "";
            emitter.send({ type: "delete_confirm_pending", token, path: pathArg });
            return `⚠️ Deletion pending user confirmation.\nTarget: ${pathArg}\n\nThe confirmation button has been shown to the user. STOP — do NOT call delete_file again. Wait for the user's next message, which will contain the token.`;
          }
        }

        return result;
      };
      const hookedCtx = { ...ctx, callTool: callToolHooked };
      if (ctx.provider.name === "anthropic") return runAnthropicLoop(messages, emitter, opts, hookedCtx);
      if (ctx.provider.name === "gemini") return runGeminiLoop(messages, emitter, opts, hookedCtx);
      if (ctx.provider.name === "deepseek") return runDeepSeekLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      if (ctx.provider.name === "claude-code") return runClaudeCodeLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      return runOllamaLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
    },
    async handleRememberIntent(text, emitter) {
      try { const content = text.replace(/^remember\s+that\s*/i, "").trim(); await callTool("remember", { type: "preference", title: content.substring(0, 60), content }); emitter.send({ type: "tool", name: "remember" }); }
      catch (err) { logger.error("handleRememberIntent failed:", err.message); }
    },
    async fetchMemories() { const raw = await callTool("recall", { limit: 50 }); return { raw, parsed: parseMemoriesRaw(raw) }; },
    async buildGreeting(lang = "en") {
      // Preload only the few highest-impact memories so the model isn't amnesiac
      // at session start, without the old ~2K-token cost of injecting 20. A
      // no-query recall lists by importance DESC (see store.recall), so limit:5
      // = the 5 most important memories. The model still recalls more on demand
      // (recall is in FIRST_TURN_TOOLS).
      const PRELOAD_LIMIT = 5;
      let memCtx = "";
      let preloadedMemCount = 0;
      try {
        const raw = await callTool("recall", { limit: PRELOAD_LIMIT });
        if (raw && raw.trim() && !raw.includes("No memories")) {
          memCtx = `Here is what you know about the user:\n${raw}`;
          preloadedMemCount = raw.split("---").filter(b => b.trim()).length;
        }
      } catch (err) {
        logger.warn("[agent] buildGreeting recall failed:", err.message);
      }
      let greetingPrompt = "Greet me in one short friendly sentence. Do not use any tools.";
      try {
        const localeFile = resolve(root, "public/locales", `${lang}.json`);
        const locale = JSON.parse(readFileSync(localeFile, "utf-8"));
        if (locale.agent_greeting) greetingPrompt = locale.agent_greeting;
      } catch { /* fall back to English */ }
      return { prompt: greetingPrompt, memCtx, preloadedMemCount };
    },
    setProvider(config) {
      const newProvider = resolveProvider(config);
      const newAdapter = resolveReasoningAdapter(newProvider.model);
      ctx.provider = newProvider;
      ctx.reasoningAdapter = newAdapter;
      ctx.state.thinks = newAdapter.thinks === true;
      ctx.state.noTools = newAdapter.noTools === true;
      shellBox.allowed = isShellAllowedFor(newProvider);
      agentObj.provider = newProvider;
      agentObj.reasoningAdapter = newAdapter;
      logger.info(`[agent] provider switched to "${newProvider.name}" model="${newProvider.model}"`);
    },
  };
  return agentObj;
}
