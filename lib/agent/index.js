import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, existsSync, statSync, readdirSync, copyFileSync, writeFileSync } from "fs";
import { resolve, basename, join } from "path";
import { getActiveScratchDir, resolveScratchPath } from "../routes/paths.js";
import { loadSkillIndex, matchSkills, getAlwaysOnSkills, injectSkill, parseSlashSkill } from "../workers/skills.js";
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
import {
  WRITE_TOOLS, CONFIRM_TOOLS,
  SYNTHETIC_USER,
  TOOL_PROFILES, FIRST_TURN_TOOLS,
  isShellAllowedFor,
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
  const personaTag = persona ? ` persona="${persona}"` : "";
  const characterTag = character ? ` character="${character}"` : "";
  logger.info(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${state.thinks} noTools=${state.noTools} shell=${shellBox.allowed}${personaTag}${characterTag}`);

  const FILES = ["whoami.md", "capabilities.md"];
  const CACHED_PROMPT = FILES.map(f => { try { return readFileSync(resolve(root, "id", f), "utf-8"); } catch { return ""; } }).join("\n\n");
  const PERSONA_PROMPT = persona
    ? (() => { try { return readFileSync(resolve(root, "id", `whoami-${persona}.md`), "utf-8"); } catch { return ""; } })()
    : "";
  const CHARACTER_PROMPT = character
    ? (() => { try { return readFileSync(resolve(root, "id", "characters", `${character}.md`), "utf-8"); } catch (e) { logger.warn(`[agent] character "${character}" not found: ${e.message}`); return ""; } })()
    : "";
  let sessionMemCtx = "";
  const skillIndex = loadSkillIndex(resolve(root, "skills"));
  function buildProviderTag(p) {
    const label = p.name === "ollama" ? `Ollama (${p.model})` : p.name === "deepseek" ? `DeepSeek (${p.model})` : p.name === "gemini" ? `Google Gemini (${p.model})` : p.name === "claude-code" ? `Anthropic Claude via subscription (${p.model})` : `Anthropic Claude (${p.model})`;
    return `---\nYou are running as: ${label}\nIf asked which model or AI you are, answer accurately using the above.`;
  }

  const transport = new StdioClientTransport({ command: "node", args: ["--no-warnings=ExperimentalWarning", resolve(root, "mcp/index.js")], env: { ...process.env, APERIO_PROC_ROLE: "mcp", APERIO_PROVIDER_LOCAL: provider.name === "ollama" ? "1" : "0" } });
  const mcp = new Client({ name: clientName, version });
  await mcp.connect(transport);
  const { tools: mcpTools } = await mcp.listTools();
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

    const profiles = classifyProfiles(text);
    const names = new Set([...profiles].flatMap(p => [...(TOOL_PROFILES[p] ?? [])]));
    if (turnNum <= 1) for (const n of FIRST_TURN_TOOLS) names.add(n);
    if (!shellBox.allowed) names.delete("run_shell");
    const alwaysOn = getAlwaysOnSkills(skillIndex);
    const matched  = matchSkills(text, skillIndex, { limit: 3 });
    const skills = [];
    const seen = new Set();

    // Forced skills (from /skill prefix or from wsHandler) go first.
    const forcedNames = [...new Set([...pendingForcedSkillNames, ...slashResult.forcedNames])];
    pendingForcedSkillNames = []; // consume once per turn
    const notFound = [...slashResult.notFound];
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

  const PRELOAD_LIMIT = 5;
  const MEMORY_WRITE_TOOLS = new Set(["remember", "update_memory", "forget", "deduplicate_memories"]);
  async function refreshSessionMemCtx() {
    try {
      const raw = await callTool("recall", { limit: PRELOAD_LIMIT });
      if (raw && raw.trim() && !raw.includes("No memories")) {
        sessionMemCtx =
          `MEMORY PREVIEW — these are only the few highest-priority memories, not your full store. ` +
          `When the user asks what you remember, whether something is stored, or about any topic this ` +
          `preview does not fully answer, you MUST call the \`recall\` tool to search the full store ` +
          `before answering. Never tell the user you have no memory of something without calling recall first.\n\n${raw}`;
        return raw.split("---").filter(b => b.trim()).length;
      }
      sessionMemCtx = "";
      return 0;
    } catch (err) {
      logger.warn("[agent] memory preload refresh failed:", err.message);
      return 0;
    }
  }

  async function callTool(name, input) {
    const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
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
    if (MEMORY_WRITE_TOOLS.has(name)) await refreshSessionMemCtx();
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
      const names = resolveToolNames(messages, userText);
      return mcpTools.filter(t => names.has(t.name)).length;
    },
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
      skillsEmittedThisLoop = false;
      const turnStartMs = Date.now();

      const hooks = makeTurnHooks(emitter, turnStartMs);
      const { callToolHooked, surfaceScratchArtifacts,
              flushDownloadCards, verifyFileClaims } = hooks;

      const hookedCtx = { ...ctx, callTool: callToolHooked };

      // ── Layer 2: deterministic recall for retrieval-shaped questions ────────
      if (!opts.noTools && ctx.provider.name === "ollama") {
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
      const memCtx = sessionMemCtx;
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
      Object.assign(provider, newProvider);
      agentObj.reasoningAdapter = newAdapter;
      ctx.reasoningAdapter = newAdapter;
      shellBox.allowed = isShellAllowedFor(newProvider);
      state.thinks = newAdapter.thinks === true;
      state.noTools = newAdapter.noTools === true;
      logger.info(`[agent] provider switched to "${newProvider.name}" model="${newProvider.model}"`);
    },
  };
  return agentObj;
}
