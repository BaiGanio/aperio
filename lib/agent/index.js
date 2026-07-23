import { readFileSync, existsSync, statSync, readdirSync, copyFileSync } from "fs";
import { randomUUID } from "node:crypto";
import { resolve, basename, join, sep } from "path";
import { getActiveScratchDir, resolveScratchPath } from "../routes/paths.js";
import { createArtifactStore } from "../context/artifactStore.js";
import { createToolResultOffloader } from "../context/toolResultOffload.js";
import {
  ARTIFACT_READ_TOOL_NAME,
  appendArtifactReadTool,
  createArtifactReader,
} from "../context/artifactRetrieval.js";
import { loadSkillIndex, getAlwaysOnSkills, injectSkill } from "../workers/skills.js";
import { resolveReasoningAdapter } from "../workers/reasoning.js";
import logger from "../helpers/logger.js";
import { resolveProvider, getRecommendedModel, isLocalProvider } from "../providers/index.js";
import { zodToJsonSchema } from "../providers/schema.js";
import { runAnthropicLoop } from "./providers/anthropic.js";
import { runLlamaCppLoop, warmLlamaCppCache } from "./providers/llamacpp.js";
import { isModelLoaded } from "../helpers/modelProgress.js";
import { runGeminiLoop } from "./providers/gemini.js";
import { runDeepSeekLoop } from "./providers/deepseek.js";
import { runClaudeCodeLoop } from "./providers/claude-code.js";
import { runCodexLoop } from "./providers/codex.js";
import { validateWrittenFile } from "../tools/validateWrittenFile.js";
import { clearProviderSessionId, getProviderSessionId, updateProviderSessionId } from "../helpers/sessions.js";
import { getDestructiveTools } from "../tools/executor.js";
import { checkArgs, hintFromIssues, logToolRepairEvents } from "../tools/schemaCheck.js";
import { summarizeArgs, summarizeResult } from "./toolActivity.js";
import {
  WRITE_TOOLS, CONFIRM_TOOLS,
  SYNTHETIC_USER,
  TOOL_PROFILES,
  SELF_MEMORY_TOOLS,
  SELF_WIKI_TOOLS,
  isShellAllowedFor,
  isCapableModel,
  capToolsForProvider,
  computeSchemaTokenCosts,
  filterVisionTools,
  filterSelfMemoryTools,
  countUserTurns,
  isRetrievalQuestion,
  parseMemoriesRaw,
} from "./tool-profiles.js";
import { planTurnTools, extractUserText, recentUserText } from "./turn-planner.js";
import { buildWorkflowSuggestion } from "./workflow-detection.js";
import { buildLanguageDirective } from "./language.js";
import { createToolHooks } from "./tool-hooks.js";
import { createLifecycleRunner } from "./middleware.js";
import { normalizeAgentSpec } from "./spec.js";
import { loadAgentBundle } from "./bundle.js";
import { isStandaloneVisionRequest, isVisionModel } from "../helpers/imageBridge.js";
import {
  appendTailToMessages,
  createModelContextMiddleware,
  MODEL_CONTEXT_MIDDLEWARE_NAMES,
} from "./model-context-middleware.js";
import {
  createLifecycleTrace,
  DEFAULT_LIFECYCLE_TRACE_LIMIT,
} from "./lifecycle-trace.js";
import { createToolCatalog } from "./mcp-connect.js";
import { createArtifactGeneratorTools } from "./host-tools/artifact-generators.js";
import { createSkillAdmin } from "./skill-admin.js";
import { persistAnswerArtifacts } from "./deliverables.js";
import { checkNoToolUse, checkSlowTurn } from "./turn-diagnostics.js";
import { runPreflight } from "./preflight.js";

// Re-exported for external consumers (tests import these via the lib/agent.js
// barrel rather than reaching into lib/providers/ or lib/agent/tool-profiles.js
// directly — verified via grep against tests/integration/agent.test.js before
// removing any of these; classifyDeliverable was the one name in this group
// with zero real importers through the barrel, so it alone was dropped).
export { getRecommendedModel, resolveProvider, zodToJsonSchema };
export { SYNTHETIC_USER, isRetrievalQuestion, parseMemoriesRaw };
export { persistAnswerArtifacts };

// MCP request timeout, per tool. The SDK default is 60s, which is too short for
// cold VLM round-trips (llama-server model load into VRAM + inference) —
// those surface as a misleading "-32001 Request timed out". Slow tools get a
// longer budget; everything else keeps the 60s default.
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const VLM_TOOL_TIMEOUT_MS = Number(process.env.LLAMACPP_VLM_TIMEOUT_MS) || 300_000;
const TOOL_TIMEOUT_MS = {
  describe_image: VLM_TOOL_TIMEOUT_MS,
};

function buildCompatibilityAgentSpec({ clientName, providerConfig, persona, character }) {
  return normalizeAgentSpec({
    id: clientName,
    provider: {
      name: providerConfig?.name,
      model: providerConfig?.model,
    },
    identity: { persona },
    character,
    // Legacy createAgent() calls preserve current behavior: all dynamically
    // selected MCP tools remain eligible until callers pass an explicit spec.
    toolAllowlist: null,
  });
}

function resolveCreateAgentSpec({ spec, clientName, providerConfig, persona, character }) {
  if (spec) return normalizeAgentSpec(spec);
  return buildCompatibilityAgentSpec({ clientName, providerConfig, persona, character });
}


export async function createAgent({ root, version, clientName = "Aperio-agent", providerConfig = null, persona = null, character = null, spec = null, bundleDir = null, hostTools = [] } = {}) {
  const baseAgentSpec = resolveCreateAgentSpec({ spec, clientName, providerConfig, persona, character });
  const bundleConfig = loadAgentBundle({
    root,
    bundleDir,
    baseSpec: baseAgentSpec,
    adminSpec: spec ? baseAgentSpec : null,
  });
  const agentSpec = bundleConfig.spec;
  const providerOverrides = {
    ...(providerConfig ?? {}),
    ...(agentSpec.provider.name ? { name: agentSpec.provider.name } : {}),
    ...(agentSpec.provider.model ? { model: agentSpec.provider.model } : {}),
  };
  const provider = resolveProvider(providerOverrides);
  persona = agentSpec.identity.persona;
  character = agentSpec.character;
  // shellAllowed is kept in a mutable box so setProvider() can update it.
  const shellBox = { allowed: isShellAllowedFor(provider) };
  const reasoningAdapter = resolveReasoningAdapter(provider.model);
  const state = { thinks: reasoningAdapter.thinks === true, noTools: reasoningAdapter.noTools === true, toolWarningEmitted: false, noToolStreak: 0, slowTurnStreak: 0, slowTurnWarningEmitted: false };
  // Capability is evaluated live (provider/state can change via setProvider). Weak
  // models (local Ollama not in APERIO_CAPABLE_MODELS, or any toolless model) get
  // neither tools nor a memory pointer — they stay lean chat models.
  const modelIsCapable = () => isCapableModel(provider, state.noTools);
  const personaTag = persona ? ` persona="${persona}"` : "";
  const characterTag = character ? ` character="${character}"` : "";
  logger.info(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${state.thinks} noTools=${state.noTools} shell=${shellBox.allowed}${personaTag}${characterTag}`);

  const FILES = ["whoami.md", "capabilities.md", "self-nature.md"];
  const CACHED_PROMPT = FILES.map(f => { try { return readFileSync(resolve(root, "id", f), "utf-8"); } catch { return ""; } }).join("\n\n");
  const SPEC_IDENTITY_PROMPT = agentSpec.identity.prompt || "";
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
  const agentSkillDirs = bundleConfig.skillDirs;
  let skillIndex    = loadSkillIndex(skillsDir, overlayDir, agentSkillDirs);
  const reloadSkills = () => { skillIndex = loadSkillIndex(skillsDir, overlayDir, agentSkillDirs); return skillIndex; };
  const skillAdmin = createSkillAdmin({
    getSkillIndex: () => skillIndex,
    reloadSkills,
    overlayDir,
  });
  const artifactStore = createArtifactStore({
    rootDir: resolve(root || process.cwd(), "var", "agent-artifacts"),
  });
  const offloadToolResult = createToolResultOffloader({
    artifactStore,
    tokenLimit: process.env.APERIO_TOOL_RESULT_OFFLOAD_TOKENS,
    byteLimit: process.env.APERIO_TOOL_RESULT_OFFLOAD_BYTES,
  });
  const readArtifact = createArtifactReader({ artifactStore });
  function buildProviderTag(p) {
    const label = p.name === "llamacpp" ? `llama.cpp (${p.model})` : p.name === "deepseek" ? `DeepSeek (${p.model})` : p.name === "gemini" ? `Google Gemini (${p.model})` : p.name === "claude-code" ? `Anthropic Claude via subscription (${p.model})` : `Anthropic Claude (${p.model})`;
    return `---\nYou are running as: ${label}\nIf asked which model or AI you are, answer accurately using the above.`;
  }

  const {
    mcp, mcpTools, hostToolHandlers, toolSchemas, allowedToolNames,
    anthropicByName, openaiByName, geminiByName,
  } = await createToolCatalog({
    root, clientName, version, provider,
    hostTools: [...createArtifactGeneratorTools(), ...hostTools],
    toolAllowlist: agentSpec.toolAllowlist,
  });

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
  // Skills chosen by the semantic rescue tier (embedding fallback), computed in
  // the async runAgentLoop when keyword matching finds nothing, then merged into
  // the turn by ensureTurn like a normal keyword match. Consumed once per turn.
  let pendingSemanticSkillNames = [];
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
    let names = new Set([...profiles].flatMap((p) => [
      ...(TOOL_PROFILES[p] ?? []),
      ...(HOST_TOOL_PROFILES[p] ?? []),
    ]));
    if (turnNum <= 1) for (const n of FIRST_TURN_TOOLS) names.add(n);
    if (!shellBox.allowed) names.delete("run_shell");
    names = filterToolsForIntent(names, text);
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

    // Semantic-rescue picks (embedding fallback) behave like keyword matches.
    // They are only ever non-empty when matchSkills found nothing this turn
    // (see runAgentLoop), so they fill the blank rather than override anything.
    const semanticMatched = pendingSemanticSkillNames
      .map(n => skillIndex.find(s => s.name === n))
      .filter(Boolean);
    pendingSemanticSkillNames = []; // consume once per turn
    for (const s of [...alwaysOn, ...matched, ...semanticMatched]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      skills.push(s);
    }
    for (const s of skills) {
      if (s.content?.includes("`node ")) names.add("run_node_script");
      if (s.content?.includes("`python")) names.add("run_python_script");
    }
    // Cap attached tools to a schema-token budget at all context sizes —
    // the full schema set re-sent every model pass adds significant prompt
    // cost for local llama.cpp models. Small windows also get a tool-count cap.
    const schemaTokenCosts = new Map([...names].map(name => {
      const schema = openaiByName.get(name);
      // Deliberately conservative: local tokenizers often split JSON/tool
      // schemas more densely than the usual four-characters-per-token rule.
      return [name, Math.max(1, Math.ceil(JSON.stringify(schema ?? name).length / 3))];
    }));
    const cappedNames = capToolsForProvider(names, provider, { schemaTokenCosts });
    if (cappedNames.size < names.size) {
      logger.info(`[tools] schema budget (${provider.contextWindow} tok): capped tools ${names.size}→${cappedNames.size}`);
    }
    const specNames = allowedToolNames
      ? new Set([...cappedNames].filter(name => allowedToolNames.has(name)))
      : cappedNames;
    const hasInlineImage = messages.some(m =>
      m.role === "user" && Array.isArray(m.content) &&
      m.content.some(b => b?.type === "image" && b.source?.data),
    );
    const standaloneVision = hasInlineImage && isStandaloneVisionRequest(userText, { hasImage: true });
    turnCache = { key, turnNum, profiles, names: specNames, skills, hasInlineImage, standaloneVision, logged: false };
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

  function getBasePromptParts(lang = "en") {
    const langDirective = buildLanguageDirective(lang);
    const parts = langDirective ? [langDirective, CACHED_PROMPT] : [CACHED_PROMPT];
    if (SPEC_IDENTITY_PROMPT) parts.push(SPEC_IDENTITY_PROMPT);
    if (PERSONA_PROMPT) parts.push(PERSONA_PROMPT);
    if (CHARACTER_PROMPT) parts.push(CHARACTER_PROMPT);
    return parts;
  }

  function getMemoryPointers() {
    return [sessionMemCtx, selfMemCtx].filter(Boolean);
  }

  function getSkillPrompts(turn) {
    const parts = [];
    const injected = new Set();
    for (const s of turn.skills ?? []) {
      if (injected.has(s.name)) continue;
      if (s.dependsOn && injected.has(s.dependsOn)) {
        parts.push(s.content);
      } else {
        parts.push(injectSkill(s, skillIndex));
        if (s.dependsOn) injected.add(s.dependsOn);
      }
      injected.add(s.name);
    }
    return parts;
  }

  function finishSystemPrompt(parts, messages, extraSystem = "") {
    // Uses the module-scoped `provider` (not `ctx.provider`) deliberately: `ctx`
    // isn't declared until further down this closure, so referencing `ctx.provider`
    // here only worked because every real call happens after createAgent() returns.
    // `provider` is the same object `ctx.provider` points at (setProvider mutates
    // it in place via Object.assign), so this is behavior-identical without the
    // hidden TDZ ordering dependency.
    parts.push(buildProviderTag(provider));
    if (extraSystem) parts.push(extraSystem);
    const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image"));
    if (hasImage) parts.push("When describing or analyzing images, be thorough and detailed. Cover the key subjects, composition, colors, spatial relationships, text (if any), and any notable details. A single sentence is never enough — aim for a structured, multi-point breakdown.");
    return parts.join("\n\n---\n\n");
  }

  const getSystemPrompt = (userMessage = "", lang = "en", extraSystem = "", messages = []) => {
    const parts = [...getBasePromptParts(lang), ...getMemoryPointers()];
    const turn = ensureTurn(messages, userMessage);
    logTurnOnce(turn);
    parts.push(...getSkillPrompts(turn));
    return finishSystemPrompt(parts, messages, extraSystem);
  };

  // Self-memory is strictly local-only: on a cloud provider the self_* tools are
  // never even offered (the handlers also refuse, but this keeps them off the
  // wire entirely so they cost no schema tokens and can't be attempted).
  const providerIsLocal = () => isLocalProvider(ctx.provider?.name);
  function resolveToolNames(messages, userText) {
    const t = ensureTurn(messages, userText);
    logTurnOnce(t);
    return resolveToolNamesForTurn(t);
  }

  function resolveToolNamesForTurn(t) {
    const names = new Set(t.names);
    // Native-vision/capable local models receive an inline upload directly on
    // their main request. Do not offer image-reading tools for that same image:
    // otherwise the model can call read_image/describe_image itself and force a
    // costly extra round trip or model swap despite already seeing the image.
    if (providerIsLocal() && t.hasInlineImage &&
        (isVisionModel(ctx.provider?.model) || isCapableModel(ctx.provider, state.noTools))) {
      names.delete("read_image");
      names.delete("preprocess_image");
      names.delete("describe_image");
      // A standalone visual request is, by the definition of
      // isStandaloneVisionRequest, one that carries no memory/recall/lookup or
      // mutation intent — any such keyword flips it to non-standalone. The
      // answer therefore lives entirely in the already-inlined pixels, so offer
      // no tools at all. Weak multimodal models (e.g. gemma-4-E4B) will grab
      // whatever tool is on the table — a lone "describe the image" was firing
      // self_recall and stalling the turn — so leaving even retrieval tools
      // available is a net negative here.
      if (t.standaloneVision) {
        names.clear();
        return names;
      }
    }
    if (providerIsLocal()) return names;
    for (const n of SELF_MEMORY_TOOLS) names.delete(n);
    for (const n of SELF_WIKI_TOOLS) names.delete(n);
    return names;
  }

  function getSelectedTools(turn) {
    if (!modelIsCapable()) return [];
    const names = resolveToolNamesForTurn(turn);
    const byName = new Map(mcpTools.map(tool => [tool.name, tool]));
    return [...names].map(name => byName.get(name)).filter(Boolean);
  }

  function getAnthropicTools(userText, messages) {
    if (!modelIsCapable()) return [];
    const names = resolveToolNames(messages, userText);
    return mcpTools.filter(t => names.has(t.name)).map(t => anthropicByName.get(t.name));
  }
  function getOpenAiTools(userText, messages) {
    if (!modelIsCapable()) return [];
    const names = resolveToolNames(messages, userText);
    return mcpTools.filter(t => names.has(t.name)).map(t => openaiByName.get(t.name));
  }
  function getGeminiTools(userText, messages) {
    if (!modelIsCapable()) return [{ functionDeclarations: [] }];
    const names = resolveToolNames(messages, userText);
    return [{ functionDeclarations: mcpTools.filter(t => names.has(t.name)).map(t => geminiByName.get(t.name)) }];
  }

  function createPrepareModelContext(emitter, lifecycleTrace) {
    const middleware = createModelContextMiddleware({
      emitter,
      logger,
      getMemoryPointers,
      ensureTurn,
      logTurnOnce,
      getSkillPrompts,
      getSelectedTools,
    });
    const runner = createLifecycleRunner(middleware, { trace: lifecycleTrace });
    return async function prepareModelContext({
      messages,
      observedInputTokens = 0,
      lang = "en",
      extraSystem = "",
      providerLabel = "",
      userTextRole = "user",
    }) {
      const prepared = await runner.run("beforeModel", {
        messages,
        observedInputTokens,
        contextWindow: ctx.provider.contextWindow,
        providerLabel,
        userTextRole,
        promptParts: getBasePromptParts(lang),
        // Later stages (clock/skill relocation) push onto this instead of
        // promptParts — it lands in the request's newest message, which was
        // never going to be a cache hit anyway, instead of the cached prefix.
        tailAppend: [],
      });
      const request = prepared.request;
      const selected = await runner.run("selectTools", {
        messages: request.messages,
        userText: request.userText,
        turn: request.turn,
        tools: [],
      });
      return {
        messages: appendTailToMessages(request.messages, request.tailAppend, request.lastUser),
        userText: request.userText,
        systemPrompt: finishSystemPrompt([...request.promptParts], request.messages, extraSystem),
        // Skill-free variant, used by small-context providers as a preflight
        // fallback when the full request would exceed the context window:
        // the unspliced messages, i.e. without the tail's skill content.
        messagesNoSkills: request.tailAppend?.length ? request.messages : null,
        tools: selected.request.tools,
        hwm: request.hwm,
        pct: request.pct,
        dropped: request.dropped,
        middlewareNames: MODEL_CONTEXT_MIDDLEWARE_NAMES,
      };
    };
  }

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
  // Called once per session (from buildGreeting) so sessionMemCtx — and therefore
  // the system prompt — stays byte-stable for the rest of the session: the count
  // is intentionally bucketed, not exact, so a remember/forget mid-session can't
  // change this text (prompt-cache hygiene).
  // Returns the count of memories surfaced (0 when memory is off) for the banner.
  async function refreshSessionMemCtx() {
    try {
      const raw = await callTool("recall", { limit: 1 });
      const count = memCountFromRaw(raw);
      const memoryOff = count === 0 || !modelIsCapable();
      sessionMemCtx = memoryOff
        ? ""
        : `MEMORY — you have saved memories about the user and past work, stored outside this ` +
          `conversation. Whenever the user asks what you know or remember, or refers to themselves or an ` +
          `earlier session, call the \`recall\` tool with a query before answering. Never tell the user you ` +
          `have no memory of something without calling recall first.`;
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
      const hostHandler = hostToolHandlers.get(name);
      if (hostHandler) {
        result = await hostHandler(args);
        logToolRepairEvents({ model: provider.model, tool: name, issues: schemaIssues, callErrored: false });
        return typeof result === "string" ? result : JSON.stringify(result);
      }
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
    // Deliberately NOT refreshing sessionMemCtx here on remember/forget: the memory
    // pointer is computed once per session (buildGreeting → refreshSessionMemCtx)
    // and must stay byte-stable for the rest of the session so it doesn't rewrite
    // the system prompt mid-session (prompt-cache hygiene). The next session
    // picks up the new count.
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
  const codexState = { sessionId: null };
  let lastLifecycleTrace = null;
  const ctx = {
    provider, callTool, getSystemPrompt, getAnthropicTools, getOpenAiTools,
    getGeminiTools, reasoningAdapter, state, claudeCodeState, codexState,
    mcpTools, root, getActiveScratchDir, getProviderSessionId,
    updateProviderSessionId,
  };

  const makeTurnHooks = createToolHooks({
    callTool, offloadToolResult, readArtifact,
    artifactReadToolName: ARTIFACT_READ_TOOL_NAME,
    summarizeArgs, summarizeResult,
    getActiveScratchDir, resolveScratchPath,
    validateWrittenFile, logger,
    WRITE_TOOLS, CONFIRM_TOOLS,
    existsSync, statSync, readdirSync, copyFileSync,
    basename, join,
  });

  const agentObj = {
    provider, mcpTools, spec: agentSpec, bundle: bundleConfig.bundle, persona, character, artifactStore,
    getSystemPrompt,
    getAnthropicTools,
    getOpenAiTools,
    getGeminiTools,
    getToolCount(userText, messages) {
      if (!modelIsCapable()) return 0;
      const names = resolveToolNames(messages, userText);
      return mcpTools.filter(t => names.has(t.name)).length;
    },
    get toolsEnabled() { return modelIsCapable(); },
    getLifecycleTrace() {
      if (!lastLifecycleTrace) {
        return {
          entries: Object.freeze([]),
          stats: Object.freeze({
            retained: 0,
            dropped: 0,
            limit: DEFAULT_LIFECYCLE_TRACE_LIMIT,
          }),
        };
      }
      return {
        entries: lastLifecycleTrace.entries(),
        stats: lastLifecycleTrace.stats(),
      };
    },
    ...skillAdmin,
    /** Call before a turn to force specific skills on the next ensureTurn() call.
     *  Used by wsHandler after parsing a /skill prefix from the user message. */
    setPendingForcedSkills(names) { pendingForcedSkillNames = names; },
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
    get THINKS() { return state.thinks; },
    NO_TOOLS: state.noTools, reasoningAdapter, callTool,
    resetProviderSession(aperioSessionId, key = "codex") {
      if (key === "codex") codexState.sessionId = null;
      return clearProviderSessionId(aperioSessionId, key);
    },
    async runAgentLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
      // No provider, no turn (#252): surface the not-configured state where the
      // user is looking instead of failing deep inside a provider loop.
      if (ctx.provider.notConfigured) {
        emitter.send({
          type: "error",
          text: "No AI provider is configured. Open Settings → Provider & Models to pick one " +
                "(llamacpp runs free on this machine), or set AI_PROVIDER in .env and restart.",
        });
        return "";
      }
      currentEmitter = emitter;
      skillsEmittedThisLoop = false;
      const turnStartMs = Date.now();

      const scratchDir = getActiveScratchDir();
      const sessionArtifactOwner = scratchDir ? basename(scratchDir) : opts.aperioSessionId;
      const artifactContext = {
        scope: opts.artifactScope ?? (sessionArtifactOwner ? "session" : "run"),
        ownerId: opts.artifactOwnerId ?? sessionArtifactOwner ?? randomUUID(),
        contextWindow: ctx.provider.contextWindow,
      };
      const lifecycleTrace = createLifecycleTrace();
      lastLifecycleTrace = lifecycleTrace;
      const lastRealUser = [...messages].reverse()
        .find(message => message.role === "user" && !message[SYNTHETIC_USER]);
      const hooks = makeTurnHooks(
        emitter,
        turnStartMs,
        artifactContext,
        lifecycleTrace,
        { userText: lastRealUser ? extractUserText(lastRealUser) : "" },
      );
      const { callToolHooked, surfaceScratchArtifacts,
              flushDownloadCards, verifyFileClaims, workflowSequence } = hooks;

      const appendArtifactTool = (tools, kind) => {
        return appendArtifactReadTool(tools, kind, hooks.hasRetrievableOffloadedArtifacts());
      };
      const preExecutedTools = new Set();
      const omitPreExecutedTools = (tools, kind) => {
        if (!preExecutedTools.size) return tools;
        if (kind === "gemini") {
          return tools.map(group => ({
            ...group,
            functionDeclarations: (group.functionDeclarations ?? []).filter(tool => !preExecutedTools.has(tool.name)),
          }));
        }
        return tools.filter(tool => {
          const name = kind === "openai" ? tool.function?.name : tool.name;
          return !preExecutedTools.has(name);
        });
      };
      const finalizeTurnTools = (tools, kind) => omitPreExecutedTools(appendArtifactTool(tools, kind), kind);
      const prepareModelContext = createPrepareModelContext(emitter, lifecycleTrace);
      const hookedCtx = {
        ...ctx,
        callTool: callToolHooked,
        nextToolSeq: hooks.nextToolSeq,
        prepareModelContext: async request => {
          const prepared = await prepareModelContext(request);
          return {
            ...prepared,
            tools: finalizeTurnTools(prepared.tools, "mcp"),
          };
        },
        getAnthropicTools: (...args) => finalizeTurnTools(ctx.getAnthropicTools(...args), "anthropic"),
        getOpenAiTools: (...args) => finalizeTurnTools(ctx.getOpenAiTools(...args), "openai"),
        getGeminiTools: (...args) => finalizeTurnTools(ctx.getGeminiTools(...args), "gemini"),
        get mcpTools() { return finalizeTurnTools(ctx.mcpTools, "mcp"); },
      };

      ({ opts, semanticSkillNames: pendingSemanticSkillNames } = await runPreflight({
        messages, opts, provider: ctx.provider, mcpTools, skillIndex,
        callTool, callToolHooked,
        setActiveSearchScopes: hooks.setActiveSearchScopes,
        extractUserText, modelIsCapable, preExecutedTools,
      }));

      // PRIVACY-01: cloud providers scrub secrets at their own send boundary
      // (the derived/trimmed array), so the persistent `messages` history the
      // loops mutate in place stays intact. The local provider (llama.cpp)
      // skips it.
      let finalText;
      if (ctx.provider.name === "anthropic") finalText = await runAnthropicLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      else if (ctx.provider.name === "gemini") finalText = await runGeminiLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      else if (ctx.provider.name === "deepseek") finalText = await runDeepSeekLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      else if (ctx.provider.name === "claude-code") finalText = await runClaudeCodeLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      else if (ctx.provider.name === "codex") finalText = await runCodexLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      else if (ctx.provider.name === "llamacpp") finalText = await runLlamaCppLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      else throw new Error(`Unknown AI_PROVIDER "${ctx.provider.name}"`);

      // Persist any build deliverable the model emitted inline (HTML/SVG/MD) as a
      // real file in the scratch workspace so it survives session resume, and tell
      // the client where each one landed so its build card can offer the same
      // actions as a tool-written file. Runs BEFORE the no-tool warning below,
      // which consults the result.
      let answerArtifacts = [];
      if (typeof finalText === "string" && /```|<!doctype html|<html[\s>]|<svg[\s>]/i.test(finalText)) {
        try { answerArtifacts = persistAnswerArtifacts(finalText, getActiveScratchDir()); }
        catch (err) { logger.warn(`[agent] persistAnswerArtifacts failed: ${err.message}`); }
      }
      if (answerArtifacts.length && emitter) {
        emitter.send({ type: "answer_artifacts", files: answerArtifacts });
      }

      checkNoToolUse({
        state, provider: ctx.provider, emitter, finalText,
        toolCallCount: hooks.toolSeq.value,
        answerArtifactCount: answerArtifacts.length,
        noTools: opts.noTools,
      });
      checkSlowTurn({ state, provider: ctx.provider, emitter });

      // Final-answer hallucination guard.
      if (!opts.noTools && typeof finalText === "string" && finalText) {
        try { verifyFileClaims(finalText); } catch (err) {
          logger.error(`[verifyFileClaims] threw: ${err.message}`);
        }
      }
      // ── Workflow detection ──────────────────────────────────────────────
      // If the model successfully used 2+ non-trivial tools this turn, suggest
      // saving the sequence as a repeatable workflow memory.
      const workflowSuggestion = !opts.noTools && emitter
        ? buildWorkflowSuggestion(workflowSequence)
        : null;
      if (workflowSuggestion) {
        logger.info(`[agent] workflow detected: ${workflowSuggestion.names.join(" → ")}`);
        emitter.send(workflowSuggestion);
      }
      flushDownloadCards();
      return finalText;
    },
    async handleRememberIntent(text, emitter) {
      try {
        const content = text.replace(/^remember\s+that\s*/i, "").trim();
        const model = process.env.AI_PROVIDER === "llamacpp"
          ? (process.env.LLAMACPP_MODEL || "llamacpp")
          : (process.env.ANTHROPIC_MODEL || "claude");
        await callTool("remember", { type: "preference", title: content.substring(0, 60), content, source: `user · ${model}` });
        emitter.send({ type: "tool", name: "remember" });
      }
      catch (err) { logger.error("handleRememberIntent failed:", err.message); }
    },
    async fetchMemories() { const raw = await callTool("recall", { limit: 50 }); return { raw, parsed: parseMemoriesRaw(raw) }; },
    async buildGreeting(lang = "en") {
      const preloadedMemCount = await refreshSessionMemCtx();
      await refreshSelfMemCtx();   // local-only; no-op on cloud
      const memCtx = sessionMemCtx;
      // Always a static, locale-aware line — instant, zero provider cost
      // (prompt-cache hygiene). This replaces the old model-generated,
      // continuity-aware greeting entirely,
      // for every session including persona/character ones; warmCache() below
      // fires a background request instead, to warm the KV cache rather than
      // to greet.
      let staticGreeting = "Hi! How can I help you today?";
      try {
        const localeFile = resolve(root, "public/locales", `${lang}.json`);
        const locale = JSON.parse(readFileSync(localeFile, "utf-8"));
        if (locale.agent_greeting_text) staticGreeting = locale.agent_greeting_text;
      } catch { /* fall back to English */ }
      return { memCtx, preloadedMemCount, staticGreeting };
    },
    // Prompt-cache warm-up (WS2): fires an invisible, minimal chat-completion
    // carrying the real (stable-prefix) system prompt so llama-server prefills
    // and caches it before the user's first real message arrives. Local
    // llama.cpp only, and — for per-session warm-ups — only when the model is
    // already loaded: firing mid-request would race the model-load a user's
    // message is about to trigger cleanly. The boot preload
    // (helpers/modelPreload.js) passes force: true because at boot there is no
    // user request to race — triggering the router's download+load is exactly
    // its purpose. Fire-and-forget; never throws.
    async warmCache(lang = "en", getAbort = () => null, setAbort = () => {}, { force = false } = {}) {
      if (!providerIsLocal()) return false;
      const modelId = provider.requestModel || provider.model;
      if (!force && !(await isModelLoaded(modelId, provider.llamacppBaseURL))) return false;
      const systemPrompt = getSystemPrompt("", lang, "", []);
      await warmLlamaCppCache(provider, systemPrompt, getAbort, setAbort);
      return true;
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
      // A new model may genuinely need loading, so re-arm the local-engine
      // preflight probe instead of carrying the previous model's "connected"
      // state.
      state.llamacppEverConnected = false;
      // Self-memory is local-only: drop the preloaded self-notes immediately when
      // switching to a cloud provider so they never reach a third-party model.
      // (Switching back to local repopulates on the next greeting/self-write.)
      if (!isLocalProvider(newProvider.name)) selfMemCtx = "";
      logger.info(`[agent] provider switched to "${newProvider.name}" model="${newProvider.model}"`);
    },
  };
  return agentObj;
}
