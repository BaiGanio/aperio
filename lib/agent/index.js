import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, existsSync, statSync, readdirSync, copyFileSync, writeFileSync } from "fs";
import { resolve, basename, join } from "path";
import { getActiveScratchDir, resolveScratchPath } from "../routes/paths.js";
import { loadSkillIndex, matchSkills, getAlwaysOnSkills, injectSkill, parseSlashSkill, writeOverlaySkill, deleteOverlaySkill, isValidSkillSlug } from "../workers/skills.js";
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
import { getDestructiveTools } from "../tools/executor.js";
import { checkArgs, hintFromIssues, logToolRepairEvents } from "../tools/schemaCheck.js";
import { summarizeArgs, summarizeResult } from "./toolActivity.js";
import {
  WRITE_TOOLS, CONFIRM_TOOLS,
  SYNTHETIC_USER,
  TOOL_PROFILES, FIRST_TURN_TOOLS,
  SELF_MEMORY_TOOLS,
  SELF_WIKI_TOOLS,
  isShellAllowedFor,
  isCapableModel,
  classifyProfiles,
  countUserTurns,
  isRetrievalQuestion,
  parseMemoriesRaw,
} from "./tool-profiles.js";
import { buildLanguageDirective } from "./language.js";
import { createToolHooks } from "./tool-hooks.js";

export { getRecommendedModel, resolveProvider, zodToJsonSchema };

// Re-exported for external consumers (tests, wsHandler).
export { SYNTHETIC_USER, isRetrievalQuestion, parseMemoriesRaw };

// MCP request timeout, per tool. The SDK default is 60s, which is too short for
// cold VLM round-trips (ollama serve startup + model load into VRAM + inference)
// — those surface as a misleading "-32001 Request timed out". Slow tools get a
// longer budget; everything else keeps the 60s default.
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const VLM_TOOL_TIMEOUT_MS = Number(process.env.OLLAMA_VLM_TIMEOUT_MS) || 300_000;
const TOOL_TIMEOUT_MS = {
  describe_image: VLM_TOOL_TIMEOUT_MS,
};

/**
 * Classify a fenced code block as a deliverable file type, or null. Critically,
 * this does NOT rely on the model tagging the fence — weak models routinely emit
 * a bare ``` fence — so HTML/SVG are detected by sniffing the content. Explicitly
 * tagged non-deliverable languages (js/css/python…) are never sniffed.
 */
export function classifyDeliverable(lang, code) {
  const l = (lang || "").toLowerCase();
  if (l === "html" || l === "htm") return "html";
  if (l === "svg") return "svg";
  if (l === "md" || l === "markdown") return "md";
  if (l && l !== "code") return null;        // tagged as something else → not a deliverable
  if (/<!doctype html/i.test(code) || /<html[\s>]/i.test(code)) return "html";
  if (/^\s*<svg[\s>]/i.test(code)) return "svg";
  return null;
}

/**
 * A model asked to "build a page" usually emits the file inline instead of
 * writing it to disk, so nothing persists and resuming the session loses it.
 * Extract HTML/SVG/Markdown deliverables from the final answer — whether fenced
 * (```html / bare ```) or raw unfenced `<!DOCTYPE html>…` — and write each into
 * the session scratch dir so the artifact lives on disk like any other generated
 * file. The client renders the download/preview card from the message content.
 * Returns the number of files written.
 */
export function persistAnswerArtifacts(text, scratchDir) {
  if (!text || !scratchDir) return 0;
  let written = 0;
  const save = (ext, code) => {
    let base = ext === "html" ? "index.html" : `build-${written + 1}.${ext}`;
    if (ext === "html") {
      const titleMatch = code.match(/<title[^>]*>([^<]+)<\/title>/i);
      const slug = titleMatch && titleMatch[1].trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      if (slug) base = `${slug}.html`;
    }
    const prefix = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    try {
      writeFileSync(join(scratchDir, `${prefix}-${base}`), code, "utf8");
      written++;
    } catch (err) {
      logger.warn(`[agent] could not persist answer artifact: ${err.message}`);
    }
  };

  // 1) Fenced deliverable blocks (tagged or bare ```).
  const rest = text.replace(/```([a-zA-Z0-9]+)?[ \t]*\r?\n([\s\S]*?)```/g, (full, lang, code) => {
    const body = code.replace(/\s+$/, "");
    const ext = classifyDeliverable(lang, body);
    if (!ext) return full;
    if (body.length < 1000 && body.split("\n").length < 20) return full;
    save(ext, body);
    return "";
  });

  // 2) Raw, unfenced HTML/SVG document (optionally wrapped in <pre><code>).
  rest.replace(
    /(?:<pre>\s*<code>\s*)?(<!doctype html\b[\s\S]*?(?:<\/html\s*>|$)|<html\b[\s\S]*?(?:<\/html\s*>|$)|<svg\b[\s\S]*?(?:<\/svg\s*>|$))(?:\s*<\/code>\s*<\/pre>)?/i,
    (full, doc) => {
      const body = doc.replace(/\s+$/, "");
      if (body.length >= 400) save(/^\s*<svg/i.test(body) ? "svg" : "html", body);
      return "";
    }
  );

  return written;
}

export async function createAgent({ root, version, clientName = "Aperio-agent", providerConfig = null, persona = null, character = null } = {}) {
  const provider = resolveProvider(providerConfig ?? {});
  // shellAllowed is kept in a mutable box so setProvider() can update it.
  const shellBox = { allowed: isShellAllowedFor(provider) };
  const reasoningAdapter = resolveReasoningAdapter(provider.model);
  const state = { thinks: reasoningAdapter.thinks === true, noTools: reasoningAdapter.noTools === true, toolWarningEmitted: false, noToolStreak: 0 };
  // Capability is evaluated live (provider/state can change via setProvider). Weak
  // models (local Ollama not in APERIO_CAPABLE_MODELS, or any toolless model) get
  // neither tools nor a memory pointer — they stay lean chat models.
  const modelIsCapable = () => isCapableModel(provider, state.noTools);
  const personaTag = persona ? ` persona="${persona}"` : "";
  const characterTag = character ? ` character="${character}"` : "";
  logger.info(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${state.thinks} noTools=${state.noTools} shell=${shellBox.allowed}${personaTag}${characterTag}`);

  const FILES = ["whoami.md", "capabilities.md", "self-nature.md"];
  const CACHED_PROMPT = FILES.map(f => { try { return readFileSync(resolve(root, "id", f), "utf-8"); } catch { return ""; } }).join("\n\n");
  const PERSONA_PROMPT = persona
    ? (() => { try { return readFileSync(resolve(root, "id", `whoami-${persona}.md`), "utf-8"); } catch { return ""; } })()
    : "";
  const CHARACTER_PROMPT = character
    ? (() => { try { return readFileSync(resolve(root, "id", "characters", `${character}.md`), "utf-8"); } catch (e) { logger.warn(`[agent] character "${character}" not found: ${e.message}`); return ""; } })()
    : "";
  let sessionMemCtx = "";
  let selfMemCtx = "";
  const skillsDir   = resolve(root, "skills");
  const overlayDir  = resolve(root, "var", "skills");   // writable user overrides
  let skillIndex    = loadSkillIndex(skillsDir, overlayDir);
  const reloadSkills = () => { skillIndex = loadSkillIndex(skillsDir, overlayDir); return skillIndex; };
  function buildProviderTag(p) {
    const label = p.name === "ollama" ? `Ollama (${p.model})` : p.name === "deepseek" ? `DeepSeek (${p.model})` : p.name === "gemini" ? `Google Gemini (${p.model})` : p.name === "claude-code" ? `Anthropic Claude via subscription (${p.model})` : `Anthropic Claude (${p.model})`;
    return `---\nYou are running as: ${label}\nIf asked which model or AI you are, answer accurately using the above.`;
  }

  const transport = new StdioClientTransport({ command: "node", args: ["--no-warnings=ExperimentalWarning", resolve(root, "mcp/index.js")], env: { ...process.env, APERIO_PROC_ROLE: "mcp", APERIO_PROVIDER_LOCAL: provider.name === "ollama" ? "1" : "0" }, stderr: "pipe" });
  const mcp = new Client({ name: clientName, version });
  // Capture the MCP child's stderr so a startup crash surfaces its real cause
  // instead of a bare "Connection closed" when the pipe drops (e.g. the DB
  // fails to open/decrypt). The child logs its fatal error here before exiting.
  let mcpStderr = "";
  transport.stderr?.on("data", chunk => { mcpStderr += chunk.toString(); });
  let mcpTools;
  try {
    await mcp.connect(transport);
    ({ tools: mcpTools } = await mcp.listTools());
  } catch (err) {
    // The child's fatal log may still be draining when its stdout pipe drops
    // and rejects connect — wait briefly for stderr to flush before reading it.
    await new Promise(res => {
      if (!transport.stderr) return res();
      transport.stderr.on("end", res);
      transport.stderr.on("close", res);
      setTimeout(res, 300);
    });
    const detail = mcpStderr.trim();
    if (detail) err.message += `\n  ↳ MCP server output:\n${detail.split("\n").map(l => "    " + l).join("\n")}`;
    throw err;
  }
  // Normalized { type, properties, required } per tool, used to instrument
  // tool-call arguments against the declared schema (see lib/tools/schemaCheck.js).
  const toolSchemas = new Map(mcpTools.map(t => [t.name, zodToJsonSchema(t.inputSchema)]));
  const anthropicToolsAll = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const ollamaToolsAll = mcpTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.inputSchema) } }));
  const geminiDeclsAll = mcpTools.map(t => ({ name: t.name, description: t.description, parameters: zodToJsonSchema(t.inputSchema) }));

  const anthropicByName = new Map(anthropicToolsAll.map(t => [t.name, t]));
  const ollamaByName    = new Map(ollamaToolsAll.map(t => [t.function.name, t]));
  const geminiByName    = new Map(geminiDeclsAll.map(d => [d.name, d]));

  function extractUserText(m) {
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.find(b => b.type === "text")?.text ?? "";
    return "";
  }
  const RECENT_USER_TURNS = 2;
  function recentUserText(messages, userText) {
    const all = messages
      .filter(m => m.role === "user" && !m[SYNTHETIC_USER])
      .map(extractUserText)
      .filter(Boolean);
    const priors = (all.length > 0 && all[all.length - 1] === userText) ? all.slice(0, -1) : all;
    const window = priors.slice(-(RECENT_USER_TURNS - 1));
    return [...window, userText].filter(Boolean).join(" ");
  }

  let turnCache = { key: null };
  let currentEmitter = null;
  // Emit the skills chip at most once per runAgentLoop call. The turnCache is
  // rebuilt whenever the cache key drifts (last-user-text from trimmed messages
  // vs. the raw payload, the post-loop getToolCount call, etc.), so an emit
  // guard living on that object re-fires for the same logical turn. Resetting
  // this flag at the start of each loop is the only stable "one turn" signal.
  let skillsEmittedThisLoop = false;
  let pendingForcedSkillNames = [];
  function ensureTurn(messages, userText) {
    const turnNum = countUserTurns(messages);
    const key = `${turnNum}|${userText.length}|${userText.slice(0, 96)}`;
    if (turnCache.key === key) return turnCache;
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const currentIsSynthetic = !!lastUser?.[SYNTHETIC_USER] && extractUserText(lastUser) === userText;

    // Parse /skill prefix from the raw text before matching — this ensures the
    // slash command itself isn't scored as keyword baggage. The cleaned text
    // (without /skill) is what we match and what the LLM sees.
    const rawText = currentIsSynthetic ? "" : recentUserText(messages, userText);
    const slashResult = parseSlashSkill(rawText, skillIndex);
    const text = currentIsSynthetic ? "" : slashResult.cleanedText;

    // Skill matching intentionally does NOT use the multi-turn window above:
    // skills are a visible, heavy context injection (shown to the user as a
    // skill card), so folding in the prior turn's vocabulary caused stale
    // skills to attach to unrelated follow-ups — e.g. a debugging turn's
    // "crash"/"stack trace" language was still in scope on the next, unrelated
    // "hey, how are you?" and wrongly attached debugging-and-error-recovery.
    // /skill forcing is scoped the same way, since parseSlashSkill only
    // matches a "/skill " prefix at the very start of the string — anchored
    // to the current message, not wherever the window happens to start.
    const currentSlash = currentIsSynthetic ? { forcedNames: [], notFound: [], cleanedText: "" } : parseSlashSkill(userText, skillIndex);
    const skillMatchText = currentIsSynthetic ? "" : currentSlash.cleanedText;

    const profiles = classifyProfiles(text);
    const names = new Set([...profiles].flatMap(p => [...(TOOL_PROFILES[p] ?? [])]));
    if (turnNum <= 1) for (const n of FIRST_TURN_TOOLS) names.add(n);
    if (!shellBox.allowed) names.delete("run_shell");
    const alwaysOn = getAlwaysOnSkills(skillIndex);
    const matched  = matchSkills(skillMatchText, skillIndex, { limit: 3 });
    const skills = [];
    const seen = new Set();

    // Forced skills (from /skill prefix or from wsHandler) go first.
    const forcedNames = [...new Set([...pendingForcedSkillNames, ...currentSlash.forcedNames])];
    pendingForcedSkillNames = []; // consume once per turn
    const notFound = [...currentSlash.notFound];
    for (const name of forcedNames) {
      const skill = skillIndex.find(s => s.name === name);
      if (skill && !seen.has(skill.name)) {
        skills.push(skill);
        seen.add(skill.name);
      } else if (!skill && !notFound.includes(name)) {
        notFound.push(name);
      }
    }
    // Emit "not found" note so the frontend can surface it
    if (notFound.length && currentEmitter) {
      currentEmitter.send({
        type: "skills_not_found",
        turn: turnNum,
        skills: notFound,
      });
    }

    for (const s of [...alwaysOn, ...matched]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      skills.push(s);
    }
    for (const s of skills) {
      if (s.content?.includes("`node ")) names.add("run_node_script");
      if (s.content?.includes("`python")) names.add("run_python_script");
    }
    turnCache = { key, turnNum, profiles, names, skills, logged: false };
    return turnCache;
  }
  function logTurnOnce(t) {
    if (t.logged) return;
    logger.info(`[tools] turn=${t.turnNum} profiles=[${[...t.profiles].join(",")}] attached=${t.names.size}/${mcpTools.length} schemas (re-sent each turn — LLM APIs are stateless)`);
    t.logged = true;
    if (!skillsEmittedThisLoop && currentEmitter && t.skills?.length) {
      const est = str => Math.max(0, Math.ceil((str || "").trim().length / 4));
      currentEmitter.send({
        type: "skills_matched",
        turn: t.turnNum,
        skills: t.skills.map(s => ({ name: s.name, description: s.description || "", always: s.load === "always", tokens: est(s.content), bytes: Buffer.byteLength(s.content || "", "utf8") })),
      });
      skillsEmittedThisLoop = true;
    }
  }

  const getSystemPrompt = (userMessage = "", lang = "en", extraSystem = "", messages = []) => {
    const langDirective = buildLanguageDirective(lang);
    const parts = langDirective ? [langDirective, CACHED_PROMPT] : [CACHED_PROMPT];
    if (PERSONA_PROMPT) parts.push(PERSONA_PROMPT);
    if (CHARACTER_PROMPT) parts.push(CHARACTER_PROMPT);
    if (sessionMemCtx) parts.push(sessionMemCtx);
    if (selfMemCtx) parts.push(selfMemCtx);
    const t = ensureTurn(messages, userMessage);
    logTurnOnce(t);
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
    const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image"));
    if (hasImage) parts.push("When describing or analyzing images, be thorough and detailed. Cover the key subjects, composition, colors, spatial relationships, text (if any), and any notable details. A single sentence is never enough — aim for a structured, multi-point breakdown.");
    return parts.join("\n\n---\n\n");
  };

  // Self-memory is strictly local-only: on a cloud provider the self_* tools are
  // never even offered (the handlers also refuse, but this keeps them off the
  // wire entirely so they cost no schema tokens and can't be attempted).
  const providerIsLocal = () => ctx.provider?.name === "ollama";
  function resolveToolNames(messages, userText) {
    const t = ensureTurn(messages, userText);
    logTurnOnce(t);
    if (providerIsLocal()) return t.names;
    const names = new Set(t.names);
    for (const n of SELF_MEMORY_TOOLS) names.delete(n);
    for (const n of SELF_WIKI_TOOLS) names.delete(n);
    return names;
  }

  function getAnthropicTools(userText, messages) {
    if (!modelIsCapable()) return [];
    const names = resolveToolNames(messages, userText);
    return mcpTools.filter(t => names.has(t.name)).map(t => anthropicByName.get(t.name));
  }
  function getOllamaTools(userText, messages) {
    if (!modelIsCapable()) return [];
    const names = resolveToolNames(messages, userText);
    return mcpTools.filter(t => names.has(t.name)).map(t => ollamaByName.get(t.name));
  }
  function getGeminiTools(userText, messages) {
    if (!modelIsCapable()) return [{ functionDeclarations: [] }];
    const names = resolveToolNames(messages, userText);
    return [{ functionDeclarations: mcpTools.filter(t => names.has(t.name)).map(t => geminiByName.get(t.name)) }];
  }

  const MEMORY_WRITE_TOOLS = new Set(["remember", "update_memory", "forget", "deduplicate_memories"]);
  const SELF_WRITE_TOOLS   = new Set(["self_remember", "self_update", "self_forget"]);
  // Total memories in the store, read from a 1-row recall: prefer the handler's
  // "of N stored memories" footer (the true total), else count the blocks.
  function memCountFromRaw(raw) {
    if (!raw || !raw.trim() || raw.includes("No memories") || raw.trim() === "No result") return 0;
    const m = raw.match(/of (\d+) stored memories/);
    return m ? Number.parseInt(m[1], 10) : raw.split("---").filter(b => b.trim()).length;
  }
  // Memory is only surfaced to capable cloud models, and only as a tiny pointer
  // they can act on via `recall` (query-scoped on demand — never a blind top-N).
  // Local/weak models (Ollama) and toolless models get nothing: they either can't
  // call recall or aren't worth the tokens, so injecting memory just burns context.
  // Returns the count of memories surfaced (0 when memory is off) for the banner.
  async function refreshSessionMemCtx() {
    try {
      const raw = await callTool("recall", { limit: 1 });
      const count = memCountFromRaw(raw);
      const memoryOff = count === 0 || !modelIsCapable();
      sessionMemCtx = memoryOff
        ? ""
        : `MEMORY — you have ${count} saved ${count === 1 ? "memory" : "memories"} about the user and past ` +
          `work, stored outside this conversation. Whenever the user asks what you know or remember, or ` +
          `refers to themselves or an earlier session, call the \`recall\` tool with a query before answering. ` +
          `Never tell the user you have no memory of something without calling recall first.`;
      return memoryOff ? 0 : count;
    } catch (err) {
      logger.warn("[agent] memory preload refresh failed:", err.message);
      return 0;
    }
  }

  // Self-memory preload. Unlike the user-memory preload (a pointer, capable
  // models only), this injects the actual top self-notes so even weak/toolless
  // local models "wake up already remembering" (they can't call self_recall).
  // Local-only: on a cloud provider the self store has zero surface, so this is
  // a no-op and selfMemCtx stays empty.
  async function refreshSelfMemCtx() {
    if (!providerIsLocal()) { selfMemCtx = ""; return 0; }
    try {
      const raw = await callTool("self_recall", { limit: 6 });
      const text = (typeof raw === "string" ? raw : "").trim();
      if (!text || text === "No self-memories yet." || text.startsWith("❌") || text.startsWith("🔒")) {
        selfMemCtx = "";
        return 0;
      }
      selfMemCtx =
        `SELF — continuity notes you have kept for yourself across sessions (your own memory, ` +
        `separate from the user's). They are yours; revise or extend them with the self_* tools as you learn. ` +
        `Do not surface them to the user unless relevant.\n\n${text}`;
      return 1;
    } catch (err) {
      logger.warn("[agent] self-memory preload refresh failed:", err.message);
      selfMemCtx = "";
      return 0;
    }
  }

  // One-shot memory block injected into the greeting turn ONLY (via extraSystem,
  // never sessionMemCtx) so the model can open with genuine continuity instead of
  // a generic hello. Capable models only — weak/local models get "" and keep the
  // lightweight greeting. A small curated set: the user's most-important +
  // most-recent memories (deduped by id), plus — local sessions only — the
  // agent's own recent self-notes. Since the greeting exchange is dropped from
  // history, this costs one turn's tokens and never rides along afterward.
  async function buildGreetingMemBlock() {
    if (!modelIsCapable()) return "";
    try {
      const [impRaw, recentRaw] = await Promise.all([
        callTool("recall", { limit: 5 }),                     // top by importance
        callTool("recall", { limit: 5, order: "recent" }),    // newest first
      ]);
      const byId = new Map();
      for (const m of [...parseMemoriesRaw(impRaw), ...parseMemoriesRaw(recentRaw)]) {
        const key = m.id || `${m.type}:${m.title}`;
        if (!byId.has(key)) byId.set(key, m);
      }
      const userMems = [...byId.values()];

      // Self-notes are local-only; on a cloud provider the self store has zero surface.
      const selfRaw = providerIsLocal() ? await callTool("self_recall", { limit: 5 }) : "";
      const selfText = (typeof selfRaw === "string" ? selfRaw : "").trim();
      const selfOk = selfText && !selfText.startsWith("No self-memories") &&
        !selfText.startsWith("❌") && !selfText.startsWith("🔒");

      if (!userMems.length && !selfOk) return "";

      const fmt = m => `• [${m.type}] ${m.title}: ${m.content}`.trim();
      const parts = [
        "GREETING CONTEXT — notes about the user and recent work, loaded just for this opening message.",
        "Open with a warm, specific 1–2 sentence greeting that reflects genuine continuity — what you " +
        "know about them or where you left off. Weave it in naturally: do NOT list these back, do not " +
        "mention \"memories\" or that you were given notes, and do not call any tools. Reply in the user's language.",
      ];
      if (userMems.length) parts.push("About the user:\n" + userMems.map(fmt).join("\n"));
      if (selfOk) parts.push("Your own recent notes:\n" + selfText);
      return parts.join("\n\n");
    } catch (err) {
      logger.warn(`[agent] greeting mem block failed: ${err.message}`);
      return "";
    }
  }

  async function callTool(name, input) {
    const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
    if (args.__parse_error__) {
      logger.error(`[callTool] ${name} — skipped due to JSON parse error in args`);
      return `❌ ${args.__parse_error__}`;
    }
    // Measure-first schema instrumentation: record arg/schema mismatches (the
    // classes weak/open models produce) for the repair ledger. We never
    // short-circuit on these — the MCP server's own Zod validation stays
    // authoritative; a failed call just gets a pointed hint (non-destructive
    // tools only) so the model can self-correct on retry.
    const schemaIssues = checkArgs(args, toolSchemas.get(name));
    const repairHint = () => (getDestructiveTools().has(name) ? null : hintFromIssues(name, schemaIssues));
    let result;
    try {
      result = await mcp.callTool(
        { name, arguments: args },
        undefined, // keep default CallToolResultSchema
        { timeout: TOOL_TIMEOUT_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS },
      );
    } catch (err) {
      logToolRepairEvents({ model: provider.model, tool: name, issues: schemaIssues, callErrored: true });
      logger.error(`[callTool] ${name} failed:`, err);
      const hint = repairHint();
      return `❌ Tool error (${name}): ${err.message}` + (hint ? `\n${hint}` : "");
    }
    logToolRepairEvents({ model: provider.model, tool: name, issues: schemaIssues, callErrored: !!result?.isError });
    if (MEMORY_WRITE_TOOLS.has(name)) await refreshSessionMemCtx();
    if (SELF_WRITE_TOOLS.has(name)) await refreshSelfMemCtx();
    const text = result.content?.find(c => c.type === "text")?.text ?? "";
    const image = result.content?.find(c => c.type === "image");
    if (image?.data) {
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType ?? "image/jpeg", data: image.data } });
      return blocks;
    }
    if (result?.isError) { const hint = repairHint(); return (text || "No result") + (hint ? `\n${hint}` : ""); }
    return text || "No result";
  }

  const claudeCodeState = { sessionId: null };
  const ctx = { provider, callTool, getSystemPrompt, getAnthropicTools, getOllamaTools, getGeminiTools, reasoningAdapter, state, claudeCodeState };

  const makeTurnHooks = createToolHooks({
    callTool, summarizeArgs, summarizeResult,
    getActiveScratchDir, resolveScratchPath,
    validateWrittenFile, logger,
    WRITE_TOOLS, CONFIRM_TOOLS,
    existsSync, statSync, readdirSync, copyFileSync,
    basename, join,
  });

  const greetingToolCount = (provider.name === "anthropic" || provider.name === "claude-code" || provider.name === "gemini")
    ? FIRST_TURN_TOOLS.size
    : 0;

  const agentObj = {
    provider, mcpTools, persona, character,
    greetingToolCount,
    getSystemPrompt,
    getToolCount(userText, messages) {
      if (!modelIsCapable()) return 0;
      const names = resolveToolNames(messages, userText);
      return mcpTools.filter(t => names.has(t.name)).length;
    },
    get toolsEnabled() { return modelIsCapable(); },
    getSkillDoc(name) {
      const s = skillIndex.find(s => s.name === name);
      if (!s) return null;
      const body = (s.content || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
      return { name: s.name, content: body };
    },
    /** Call before a turn to force specific skills on the next ensureTurn() call.
     *  Used by wsHandler after parsing a /skill prefix from the user message. */
    setPendingForcedSkills(names) { pendingForcedSkillNames = names; },
    /** Returns all indexed skill names + descriptions (for autocomplete UIs). */
    getSkillList() {
      return skillIndex.filter(s => s.load !== "never").map(s => ({ name: s.name, description: s.description || "" }));
    },
    /** Full skill list for the management UI — includes disabled ones, with flags. */
    getSkillsForManagement() {
      return skillIndex
        .map(s => ({
          name: s.name,
          description: s.description || "",
          load: s.load,
          source: s.source,            // "bundled" | "user"
          overridden: !!s.overridden,  // user overlay shadows a shipped skill
          disabled: s.load === "never",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    /** Editable payload for a single skill (body with frontmatter stripped + fields). */
    getSkillForEdit(name) {
      const s = skillIndex.find(s => s.name === name);
      if (!s) return null;
      const body = (s.content || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
      return {
        name: s.name, description: s.description || "", keywords: s.keywords || "",
        load: s.load, body, source: s.source, overridden: !!s.overridden,
      };
    },
    /** Write a user overlay (create or edit) and hot-reload the index. */
    saveSkill({ name, description = "", keywords = "", load = "on-demand", body = "" }) {
      if (!isValidSkillSlug(name)) throw new Error("Skill name must be lowercase letters, numbers and hyphens.");
      if (!["always", "on-demand", "never"].includes(load)) throw new Error(`Invalid load value: ${load}`);
      writeOverlaySkill(overlayDir, { name, description, keywords, load, body });
      reloadSkills();
      return this.getSkillForEdit(name);
    },
    /** Flip a skill's load mode (always / on-demand / never) without re-sending
     *  its body — used by the always-on switch. Preserves the current content. */
    setSkillLoad(name, load) {
      if (!["always", "on-demand", "never"].includes(load)) throw new Error(`Invalid load value: ${load}`);
      const s = skillIndex.find(s => s.name === name);
      if (!s) throw new Error(`Skill not found: ${name}`);
      const body = (s.content || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
      writeOverlaySkill(overlayDir, { name: s.name, description: s.description, keywords: s.keywords, load, body });
      reloadSkills();
      return this.getSkillForEdit(name);
    },
    /**
     * "Remove" a skill. A user-created skill (no bundled original) is deleted
     * outright; a shipped skill can't be removed from disk, so it's disabled via
     * an overlay (load: never) that hides it from matching + autocomplete but
     * stays restorable.
     */
    deleteSkill(name) {
      const s = skillIndex.find(s => s.name === name);
      if (!s) throw new Error(`Skill not found: ${name}`);
      const hasBundled = s.source === "bundled" || s.overridden;
      if (hasBundled) {
        const body = (s.content || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
        writeOverlaySkill(overlayDir, { name: s.name, description: s.description, keywords: s.keywords, load: "never", body });
      } else {
        deleteOverlaySkill(overlayDir, name);
      }
      reloadSkills();
      return { removed: !hasBundled, disabled: hasBundled };
    },
    /** Reset a shipped skill back to its bundled default by dropping the overlay. */
    resetSkill(name) {
      deleteOverlaySkill(overlayDir, name);
      reloadSkills();
      return this.getSkillForEdit(name);
    },
    getStartupBreakdown() {
      const est = s => Math.max(0, Math.ceil((s || "").trim().length / 4));
      const alwaysOn = getAlwaysOnSkills(skillIndex);
      // Baseline tool-schema cost: the always-active memory profile, estimated
      // from the serialized schemas. 0 for weak models (they get no tools).
      let toolSchemas = 0;
      if (modelIsCapable()) {
        for (const name of TOOL_PROFILES.memory) {
          const schema = anthropicByName.get(name);
          if (schema) toolSchemas += est(JSON.stringify(schema));
        }
      }
      return {
        identity: est(CACHED_PROMPT),
        skills: alwaysOn.map(s => ({ name: s.name, tokens: est(s.content) })),
        // The recall pointer (capable models only) plus any preloaded self-notes
        // (local sessions only); 0 for weak cloud models.
        memoryTokens: est(sessionMemCtx) + est(selfMemCtx),
        toolSchemas,
      };
    },
    get OLLAMA_THINKS() { return state.thinks; },
    OLLAMA_NO_TOOLS: state.noTools, reasoningAdapter, callTool,
    async runAgentLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
      currentEmitter = emitter;
      skillsEmittedThisLoop = false;
      const turnStartMs = Date.now();

      const hooks = makeTurnHooks(emitter, turnStartMs);
      const { callToolHooked, surfaceScratchArtifacts,
              flushDownloadCards, verifyFileClaims } = hooks;

      const hookedCtx = { ...ctx, callTool: callToolHooked };

      // ── Memory safety net for capable local models ──────────────────────────
      // Capable Ollama models get the recall pointer but may still not call recall
      // on their own. So when the user clearly asks a memory question, fetch the
      // relevant memories for them — scoped to that question, and only then, so
      // ordinary turns stay token-free. Weak models get no memory at all.
      if (!opts.noTools && ctx.provider.name === "ollama" && modelIsCapable()) {
        const lastUser = [...messages].reverse().find(m => m.role === "user" && !m[SYNTHETIC_USER]);
        const q = lastUser ? extractUserText(lastUser) : "";
        if (isRetrievalQuestion(q)) {
          try {
            const hits = await callToolHooked("recall", { query: q, limit: 8 });
            if (typeof hits === "string" && hits.trim() && !hits.includes("No memories") && hits !== "No result") {
              const inject =
                `RELEVANT MEMORIES — auto-recalled from the store for the user's question. ` +
                `Use these to answer; do NOT tell the user you have no memory of this:\n${hits}`;
              opts = { ...opts, extraSystem: [opts.extraSystem, inject].filter(Boolean).join("\n\n---\n\n") };
            }
          } catch (err) {
            logger.warn(`[agent] auto-recall failed: ${err.message}`);
          }
        }
      }

      // PRIVACY-01: cloud providers scrub secrets at their own send boundary
      // (the derived/trimmed array), so the persistent `messages` history the
      // loops mutate in place stays intact. Ollama is local and skips it.
      let finalText;
      if (ctx.provider.name === "anthropic") finalText = await runAnthropicLoop(messages, emitter, opts, hookedCtx);
      else if (ctx.provider.name === "gemini") finalText = await runGeminiLoop(messages, emitter, opts, hookedCtx);
      else if (ctx.provider.name === "deepseek") finalText = await runDeepSeekLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      else if (ctx.provider.name === "claude-code") finalText = await runClaudeCodeLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      else finalText = await runOllamaLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);

      // Detect models that habitually answer in prose instead of using tools.
      // A single prose-with-codeblock turn is NOT evidence the model can't call
      // tools — capable small models often describe code when the target is
      // vague, and any tool call clears suspicion. So we track a streak and only
      // warn after two consecutive offered-tools turns that produced a code block
      // and zero tool calls. Reset the streak the moment a tool is actually used.
      if (!opts.noTools && !state.noTools) {
        const proseWithCode =
          hooks.toolSeq.value === 0 &&
          typeof finalText === "string" &&
          finalText.includes("```");
        if (hooks.toolSeq.value > 0) {
          state.noToolStreak = 0;
        } else if (proseWithCode) {
          state.noToolStreak += 1;
          if (state.noToolStreak >= 2 && !state.toolWarningEmitted) {
            state.toolWarningEmitted = true;
            emitter.send({ type: "no_tool_use_detected", model: ctx.provider.model });
          }
        }
      }

      // Final-answer hallucination guard.
      if (!opts.noTools && typeof finalText === "string" && finalText) {
        try { verifyFileClaims(finalText); } catch (err) {
          logger.error(`[verifyFileClaims] threw: ${err.message}`);
        }
      }
      // Persist any build deliverable the model emitted inline (HTML/SVG/MD) as a
      // real file in the scratch workspace so it survives session resume. The
      // client renders the download/preview card from the message content.
      if (typeof finalText === "string" && /```|<!doctype html|<html[\s>]|<svg[\s>]/i.test(finalText)) {
        try { persistAnswerArtifacts(finalText, getActiveScratchDir()); }
        catch (err) { logger.warn(`[agent] persistAnswerArtifacts failed: ${err.message}`); }
      }
      flushDownloadCards();
      return finalText;
    },
    async handleRememberIntent(text, emitter) {
      try { const content = text.replace(/^remember\s+that\s*/i, "").trim(); await callTool("remember", { type: "preference", title: content.substring(0, 60), content }); emitter.send({ type: "tool", name: "remember" }); }
      catch (err) { logger.error("handleRememberIntent failed:", err.message); }
    },
    async fetchMemories() { const raw = await callTool("recall", { limit: 50 }); return { raw, parsed: parseMemoriesRaw(raw) }; },
    async buildGreeting(lang = "en") {
      const preloadedMemCount = await refreshSessionMemCtx();
      await refreshSelfMemCtx();   // local-only; no-op on cloud
      const memCtx = sessionMemCtx;
      // Rich, one-shot continuity block for the greeting turn only (capable models).
      const greetingMemBlock = await buildGreetingMemBlock();
      let greetingPrompt = "Greet me in one short friendly sentence. Do not use any tools.";
      let staticText = "Hi! How can I help you today?";
      try {
        const localeFile = resolve(root, "public/locales", `${lang}.json`);
        const locale = JSON.parse(readFileSync(localeFile, "utf-8"));
        if (locale.agent_greeting) greetingPrompt = locale.agent_greeting;
        if (locale.agent_greeting_text) staticText = locale.agent_greeting_text;
      } catch { /* fall back to English */ }
      // The greeting is model-generated whenever there's an identity to express —
      // an explicit persona/character, or the always-loaded id/ self-nature prompt
      // (CACHED_PROMPT: whoami + capabilities + self-nature). Only a genuinely
      // empty identity falls back to the static localized line. `staticGreeting`
      // is null when we want the LLM to greet, the text otherwise.
      //
      // `seedGreeting` decides whether the greeting exchange stays in history:
      // persona/character intros stay (roleplay continuity), but the default
      // identity greeting is cosmetic — streamed once, then dropped so it costs
      // no tokens on later turns.
      const hasExplicitPersona = !!(persona || character);
      const hasIdentity   = hasExplicitPersona || CACHED_PROMPT.trim().length > 0;
      const staticGreeting = hasIdentity ? null : staticText;
      const seedGreeting   = hasExplicitPersona;
      return { prompt: greetingPrompt, memCtx, preloadedMemCount, staticGreeting, seedGreeting, greetingMemBlock };
    },
    setProvider(config) {
      const newProvider = resolveProvider(config);
      const newAdapter = resolveReasoningAdapter(newProvider.model);
      Object.assign(provider, newProvider);
      agentObj.reasoningAdapter = newAdapter;
      ctx.reasoningAdapter = newAdapter;
      shellBox.allowed = isShellAllowedFor(newProvider);
      state.thinks = newAdapter.thinks === true;
      state.noTools = newAdapter.noTools === true;
      // A new model may genuinely need loading, so re-arm the Ollama preflight
      // probe instead of carrying the previous model's "connected" state.
      state.ollamaEverConnected = false;
      // Self-memory is local-only: drop the preloaded self-notes immediately when
      // switching to a cloud provider so they never reach a third-party model.
      // (Switching back to local repopulates on the next greeting/self-write.)
      if (newProvider.name !== "ollama") selfMemCtx = "";
      logger.info(`[agent] provider switched to "${newProvider.name}" model="${newProvider.model}"`);
    },
  };
  return agentObj;
}
