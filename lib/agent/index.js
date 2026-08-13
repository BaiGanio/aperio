import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, copyFileSync } from "fs";
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
  MUTATION_FILE_TOOLS,
  SYNTHETIC_USER,
  TOOL_PROFILES,
  isShellAllowedFor,
  isCapableModel,
  capToolsForProvider,
  computeSchemaTokenCosts,
  filterVisionTools,
  filterSelfMemoryTools,
  filterPreExecutedTools,
  countUserTurns,
  isRetrievalQuestion,
  parseMemoriesRaw,
} from "./tool-profiles.js";
import { planTurnTools, extractUserText, recentUserText } from "./turn-planner.js";
import { createMemoryContext } from "./memory-context.js";
import { buildWorkflowSuggestion } from "./workflow-detection.js";
import { buildLanguageDirective } from "./language.js";
import { createToolHooks } from "./tool-hooks.js";
import { createLifecycleRunner } from "./middleware.js";
import { normalizeAgentSpec } from "./spec.js";
import { loadAgentBundle } from "./bundle.js";
import { isVisionModel, isTaskShapedVisionRequest } from "../helpers/imageBridge.js";
import {
  appendTailToMessages,
  createModelContextMiddleware,
  MODEL_CONTEXT_MIDDLEWARE_NAMES,
} from "./model-context-middleware.js";
import {
  createPlanningState,
  createPlanningContextMiddleware,
} from "./planning-middleware.js";
import {
  createLifecycleTrace,
  DEFAULT_LIFECYCLE_TRACE_LIMIT,
} from "./lifecycle-trace.js";
import { createToolCatalog } from "./mcp-connect.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
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
  // WS1 planning loop (agent-harness-epic): fail-safe and off by default —
  // see lib/agent/planning-middleware.js's header for why this is read once
  // here rather than per-turn (matches shellBox above).
  const planningEnabled = process.env.APERIO_AGENT_PLANNING === "on";
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
  const readIdFile = f => { try { return readFileSync(resolve(root, "id", f), "utf-8"); } catch { return ""; } };
  let whoamiContent = readIdFile("whoami.md");
  let CACHED_PROMPT = FILES.map(readIdFile).join("\n\n");
  // The "more..." identity modal lets the developer edit whoami.md from the UI;
  // CACHED_PROMPT is re-derived (not just whoamiContent alone) so a save takes
  // effect on the very next turn without a server restart.
  const reloadIdentity = () => {
    whoamiContent = readIdFile("whoami.md");
    CACHED_PROMPT = FILES.map(readIdFile).join("\n\n");
    return whoamiContent;
  };
  const SPEC_IDENTITY_PROMPT = agentSpec.identity.prompt || "";
  const PERSONA_PROMPT = persona
    ? (() => { try { return readFileSync(resolve(root, "id", `whoami-${persona}.md`), "utf-8"); } catch { return ""; } })()
    : "";
  const CHARACTER_PROMPT = character
    ? (() => { try { return readFileSync(resolve(root, "id", "characters", `${character}.md`), "utf-8"); } catch (e) { logger.warn(`[agent] character "${character}" not found: ${e.message}`); return ""; } })()
    : "";
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

  // Keyed by the caller's `messages` ARRAY REFERENCE, not a single shared
  // slot (P1 review finding): createAgent() runs once at server boot and the
  // resulting agent is shared by every WebSocket connection (lib/server.js →
  // makeWsHandler), while the sticky pin/carry fold (turn-planner.js) makes a
  // turn's plan depend on its FULL conversation history, not just turnNum +
  // the current text. A single `turnCache` keyed only by
  // `${turnNum}|${userText}` let two unrelated conversations that happened to
  // reach the same turn number with the same current text (e.g. both replying
  // "yes, do it") collide on the same key — the second one silently got back
  // the FIRST one's cached plan, pinning whatever tools ITS history had armed.
  // Each WebSocket connection allocates its own `messages` array once
  // (wsHandler's `const messages = []`) and mutates it in place for the
  // connection's whole lifetime, so that reference is already the right scope
  // to cache against — a WeakMap means no manual cleanup on disconnect either
  // (the entry is collected once the array itself is unreachable).
  const turnCacheByMessages = new WeakMap();
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
  function ensureTurn(messages, userText, imageMessages) {
    const turnNum = countUserTurns(messages);
    const key = `${turnNum}|${userText.length}|${userText.slice(0, 96)}`;
    const cached = turnCacheByMessages.get(messages);
    if (cached?.key === key) return cached;

    const planned = planTurnTools(messages, userText, {
      turnNum,
      skillIndex,
      shellAllowed: shellBox.allowed,
      pendingForcedSkillNames,
      pendingSemanticSkillNames,
      providerName: provider.name,
      imageMessages,
    });
    pendingForcedSkillNames = []; // consume once per turn
    pendingSemanticSkillNames = []; // consume once per turn
    // Emit "not found" note so the frontend can surface it
    if (planned.notFound.length && currentEmitter) {
      currentEmitter.send({
        type: "skills_not_found",
        turn: turnNum,
        skills: planned.notFound,
      });
    }

    // Cap attached tools to a schema-token budget at all context sizes —
    // the full schema set re-sent every model pass adds significant prompt
    // cost for local llama.cpp models. Small windows also get a tool-count cap.
    const schemaTokenCosts = computeSchemaTokenCosts(planned.names, openaiByName);
    const cappedNames = capToolsForProvider(planned.names, provider, { schemaTokenCosts, currentTurnNames: planned.currentTurnNames });
    if (cappedNames.size < planned.names.size) {
      logger.info(`[tools] schema budget (${provider.contextWindow} tok): capped tools ${planned.names.size}→${cappedNames.size}`);
    }
    const specNames = allowedToolNames
      ? new Set([...cappedNames].filter(name => allowedToolNames.has(name)))
      : cappedNames;
    const turn = {
      key, turnNum, profiles: planned.profiles, names: specNames, skills: planned.skills,
      hasInlineImage: planned.hasInlineImage, standaloneVision: planned.standaloneVision, logged: false,
    };
    turnCacheByMessages.set(messages, turn);
    return turn;
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
    if (hasImage && isVisionModel(provider.model) && isTaskShapedVisionRequest(messages.at(-1)?.content?.find?.(b => b.type === "text")?.text ?? "", { hasImage: true })) {
      parts.push("TASK-SHAPED NATIVE VISION: the requested image is already inline and visible to you. Extract the requested fields directly from the pixels. Do not call read_image, preprocess_image, or describe_image; return the fields with exact visible text and mark any unreadable field as uncertain.");
    }
    return parts.join("\n\n---\n\n");
  }

  const getSystemPrompt = (userMessage = "", lang = "en", extraSystem = "", messages = []) => {
    const parts = [...getBasePromptParts(lang), ...getMemoryPointers()];
    const turn = ensureTurn(messages, userMessage);
    logTurnOnce(turn);
    parts.push(...getSkillPrompts(turn));
    return finishSystemPrompt(parts, messages, extraSystem);
  };

  // Skill-injection content only — no base identity/persona/memory-pointer
  // prompt. For providers that carry their own identity (codex's AGENTS.md,
  // claude-code SDK's `claude_code` preset), appending the full getSystemPrompt
  // output would duplicate/conflict with that identity every turn; this gives
  // them the same skill match + `skills_matched` chip (via the shared
  // ensureTurn/logTurnOnce path every other provider uses) without it.
  const getSkillsBlock = (userMessage = "", lang = "en", messages = []) => {
    const turn = ensureTurn(messages, userMessage);
    logTurnOnce(turn);
    return getSkillPrompts(turn).join("\n\n---\n\n");
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
    const local = providerIsLocal();
    const visionFiltered = filterVisionTools(t.names, {
      hasInlineImage: t.hasInlineImage,
      standaloneVision: t.standaloneVision,
      providerIsLocal: local,
      modelHandlesInlineImage: isVisionModel(ctx.provider?.model) || isCapableModel(ctx.provider, state.noTools),
    });
    return filterSelfMemoryTools(visionFiltered, { providerIsLocal: local });
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

  function createPrepareModelContext(emitter, lifecycleTrace, planningState = null, onModelContextShed = null, untrimmedMessages = null) {
    // onModelContextShed (optional): fired by the context-trimming middleware
    // whenever the model-facing context sheds content (token-pressure trim or
    // the 20-message history cap). runAgentLoop wires it to
    // clearDocSessionCache() so the doc_batch dedup cache follows the
    // model-facing context, not the untrimmed conversation lifetime
    // (llamacpp-multiturn-latency.md Step 3 review, round 7, P1).
    //
    // untrimmedMessages (optional): runAgentLoop's own `messages` — the real,
    // untrimmed conversation the provider loops mutate in place — threaded
    // through so ensureTurn's tool/skill selection reconstructs the sticky
    // pin fold from what actually happened, not from whatever the
    // context-trimming stage left in `request.messages` (Step 2, round 9,
    // P1; see model-context-middleware.js's own header comment).
    const middleware = [
      ...createModelContextMiddleware({
        emitter,
        logger,
        getMemoryPointers,
        ensureTurn,
        logTurnOnce,
        getSkillPrompts,
        getSelectedTools,
        onModelContextShed,
        untrimmedMessages,
      }),
      ...(planningState
        ? [createPlanningContextMiddleware({
            state: planningState,
            emitter,
            logger,
            getToolNames: () => new Set(mcpTools.map(t => t.name)),
          })]
        : []),
    ];
    const runner = createLifecycleRunner(middleware, { trace: lifecycleTrace });
    return async function prepareModelContext({
      messages,
      observedInputTokens = 0,
      lang = "en",
      extraSystem = "",
      providerLabel = "",
      userTextRole = "user",
    }) {
      // Runs before beforeModel, on the SAME runner: reflects on drift the
      // tool middleware recorded since the previous model response (if any)
      // and threads its reflection into this request's tailAppend. A no-op
      // when planning is off (no middleware registers an afterModel hook) or
      // when nothing drifted.
      const afterModelResult = await runner.run("afterModel", { messages, tailAppend: [] });
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
        tailAppend: afterModelResult.request.tailAppend ?? [],
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
  // callTool is a hoisted function declaration (referenceable here); providerIsLocal
  // just above and modelIsCapable near the top of this closure are both already
  // initialized by this point in createAgent()'s synchronous execution order.
  const memoryCtx = createMemoryContext({ callTool, modelIsCapable, providerIsLocal, logger });
  function getMemoryPointers() {
    return [memoryCtx.getSessionMemCtx(), memoryCtx.getSelfMemCtx()].filter(Boolean);
  }

  // `meta` is explicit per-call data, never ambient/shared state — the only
  // current use is docgraph's session-scoped doc_batch dedup
  // (llamacpp-multiturn-latency.md Step 3). It must stay a plain parameter:
  // this `agent` object (and callTool with it) is a SINGLE shared instance
  // for the whole server's lifetime, reused across every concurrent
  // WebSocket connection's runAgentLoop call (lib/server.js creates one
  // `agent` at boot, not one per conversation) — a closure-level "current
  // session" variable set at the top of a turn would race: two turns
  // in flight at once (interleaved at any `await`) would stomp each other's
  // value, and a tool call could run under the wrong turn's session id.
  async function callTool(name, input, meta) {
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
        {
          name, arguments: args,
          ...(meta ? { _meta: meta } : {}),
        },
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
    if (SELF_WRITE_TOOLS.has(name)) await memoryCtx.refreshSelfMemCtx();
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

  // Invalidates one session's doc_batch dedup cache (lib/docgraph/retrieval.js's
  // sessionReadFacts) inside the MCP child process. Deliberately NOT a
  // callTool()/"tools/call" round trip: every registered MCP tool is
  // discoverable via tools/list() by ANY client connected to the child —
  // including runClaudeCodeLoop's own tool builder (which iterates the full
  // mcpTools catalog, not the per-turn profile-filtered subset) and Codex,
  // which spawns and talks to its OWN separate mcp/index.js child directly,
  // fully bypassing this app's tool-profile filtering. A tool named
  // "docgraph_clear_session_cache" would therefore be a real, model-callable
  // tool on both of those providers no matter what lib/agent/tool-profiles.js
  // says (llamacpp-multiturn-latency.md Step 3 review, round 5, P2). Using a
  // custom JSON-RPC method outside the Tools capability entirely (registered
  // on the low-level Server in mcp/index.js, called here via the SDK's
  // generic Protocol#request) makes it invisible to tools/list() for every
  // client, so no provider-specific filtering is needed anywhere.
  async function clearDocSessionCache(sessionId) {
    if (!sessionId) return;
    try {
      await mcp.request(
        { method: "aperio/clearDocSessionCache", params: { sessionId } },
        ResultSchema,
        { timeout: DEFAULT_TOOL_TIMEOUT_MS },
      );
    } catch (err) {
      logger.warn(`[agent] clearDocSessionCache(${sessionId}) failed:`, err.message);
    }
  }

  const claudeCodeState = { sessionId: null };
  const codexState = { sessionId: null };
  let lastLifecycleTrace = null;
  const ctx = {
    provider, callTool, getSystemPrompt, getSkillsBlock, getAnthropicTools, getOpenAiTools,
    getGeminiTools, reasoningAdapter, state, claudeCodeState, codexState,
    mcpTools, root, getActiveScratchDir, getProviderSessionId,
    updateProviderSessionId,
  };

  const makeTurnHooks = createToolHooks({
    callTool, offloadToolResult, readArtifact,
    artifactReadToolName: ARTIFACT_READ_TOOL_NAME,
    clearDocSessionCache,
    summarizeArgs, summarizeResult,
    getActiveScratchDir, resolveScratchPath,
    validateWrittenFile, logger,
    WRITE_TOOLS, CONFIRM_TOOLS,
    existsSync, statSync, readdirSync, copyFileSync,
    basename, join,
  });

  const agentObj = {
    provider, mcpTools, spec: agentSpec, bundle: bundleConfig.bundle, persona, character, artifactStore,
    getWhoamiContent() { return whoamiContent; },
    saveWhoamiContent(content) {
      writeFileSync(resolve(root, "id", "whoami.md"), content, "utf-8");
      return reloadIdentity();
    },
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
        memoryTokens: est(memoryCtx.getSessionMemCtx()) + est(memoryCtx.getSelfMemCtx()),
        toolSchemas,
      };
    },
    get THINKS() { return state.thinks; },
    NO_TOOLS: state.noTools, reasoningAdapter, callTool, clearDocSessionCache,
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
      // Local to this call — never a shared/module-level variable — so two
      // concurrent runAgentLoop calls (separate WebSocket connections sharing
      // this one agent instance) can never cross-contaminate each other's
      // tool-call metadata. Passed explicitly into makeTurnHooks below.
      const toolCallMeta = opts.docSessionId ? { docSessionId: opts.docSessionId } : null;

      const scratchDir = getActiveScratchDir();
      const sessionArtifactOwner = scratchDir ? basename(scratchDir) : opts.aperioSessionId;
      const artifactContext = {
        scope: opts.artifactScope ?? (sessionArtifactOwner ? "session" : "run"),
        ownerId: opts.artifactOwnerId ?? sessionArtifactOwner ?? randomUUID(),
        contextWindow: ctx.provider.contextWindow,
      };
      const lifecycleTrace = createLifecycleTrace();
      lastLifecycleTrace = lifecycleTrace;
      // Fresh each turn, shared between the model-facing and tool-facing
      // planning hooks (see planning-middleware.js's header). null when the
      // gate is off, so downstream wiring stays a true no-op.
      const planningState = planningEnabled ? createPlanningState() : null;
      const lastRealUser = [...messages].reverse()
        .find(message => message.role === "user" && !message[SYNTHETIC_USER]);
      const hooks = makeTurnHooks(
        emitter,
        turnStartMs,
        artifactContext,
        lifecycleTrace,
        { userText: lastRealUser ? extractUserText(lastRealUser) : "" },
        planningState,
        toolCallMeta,
      );
      const { callToolHooked, surfaceScratchArtifacts,
              flushDownloadCards, verifyFileClaims, workflowSequence } = hooks;

      const appendArtifactTool = (tools, kind) => {
        return appendArtifactReadTool(tools, kind, hooks.hasRetrievableOffloadedArtifacts());
      };
      const preExecutedTools = new Set();
      // Read `provider.name` at call time, not once here: setProvider mutates
      // the module-scoped provider object in place, so a mid-run switch is
      // reflected. See filterPreExecutedTools for why llama.cpp opts out.
      const omitPreExecutedTools = (tools, kind) =>
        filterPreExecutedTools(tools, kind, preExecutedTools, { keepStable: provider.name === "llamacpp" });
      const finalizeTurnTools = (tools, kind) => omitPreExecutedTools(appendArtifactTool(tools, kind), kind);
      // Doc_batch dedup-cache validity follows the model-facing context, not
      // the untrimmed conversation lifetime (llamacpp-multiturn-latency.md
      // Step 3 review, rounds 7 + 9, P1): when the context-trimming
      // middleware sheds or truncates tool results — token-pressure trim, the
      // 20-message history cap, or capToolResults truncating a large result —
      // a document read earlier on this connection may no longer be fully
      // reachable by the model, yet its entry survives in the dedup cache and
      // a later doc_batch would return an "already read" pointer for text the
      // model can't see. Clear this connection's dedup cache (keyed by
      // opts.docSessionId, the same namespace every doc_batch call on this
      // socket uses) on EVERY qualifying shed, with no per-loop latch: under
      // continuous token pressure a tool-calling turn sheds different content
      // hop after hop — trim.js pins only the freshest tool_use/result pair,
      // so a document read AFTER the first clear can itself be trimmed on a
      // later hop, and suppressing that second invalidation would leave a
      // stale "already read" entry for it. The callback is awaited by the
      // middleware so the MCP round trip lands before the trimmed request
      // reaches the model and any follow-up tool call can race ahead of it.
      // No-op when this loop has no docSessionId (non-WebSocket callers such
      // as the CLI/harness have no connection-scoped dedup cache to
      // invalidate).
      const prepareModelContext = createPrepareModelContext(
        emitter, lifecycleTrace, planningState,
        opts.docSessionId ? () => clearDocSessionCache(opts.docSessionId) : null,
        messages,
      );
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
      else if (ctx.provider.name === "mock") {
        // Deterministic loop-regression harness only (tests/harness/mock-provider.js).
        // resolveProvider() already refuses to resolve "mock" outside NODE_ENV=test,
        // so this branch is unreachable in a real boot; the implementation is kept
        // out of lib/'s static import graph (dynamic import) so it never ships as
        // part of the always-loaded production module set.
        const { runMockLoop } = await import("../../tests/harness/mock-provider.js");
        finalText = await runMockLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
      }
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

      // Checked against the turn's FINAL attached tool-NAME set (specNames —
      // post allowlist, post schema-budget cap), not the pre-cap profile plan:
      // a profile can be selected and then have every one of its tools capped
      // away by capToolsForProvider or filtered out by the agent's own
      // toolAllowlist, in which case the model never actually had a file-write
      // tool in hand this turn despite file-edit/file-generate being "active".
      // Also requires modelIsCapable(): for an incapable model (local, absent
      // from APERIO_CAPABLE_MODELS, or noTools), getSelectedTools()/
      // getAnthropicTools()/getOpenAiTools()/getGeminiTools() all short-
      // circuit to an empty tool list regardless of turn.names — turn.names
      // is the PLAN, computed from user text alone, independent of whether
      // this model ever gets tools at all. Without this, a weak model given
      // a file-edit-shaped prompt would still get flagged for "ignoring" a
      // tool it was never actually offered (P2 review finding).
      // Resolved through resolveToolNamesForTurn(), not read straight off
      // turn.names: that cached set is pre-vision-filter, and
      // filterVisionTools() can still drop tools from it — for a capable
      // local model on a standalone-vision turn it CLEARS the set entirely.
      // A pinned file profile from an earlier turn would otherwise leave
      // edit_file in turn.names while the model received no tools at all,
      // re-arming the very false warning this flag exists to suppress.
      const currentTurn = turnCacheByMessages.get(messages);
      const currentTurnNames = currentTurn ? resolveToolNamesForTurn(currentTurn) : null;
      const hadMutationToolOffered = modelIsCapable() &&
        !!currentTurnNames && [...MUTATION_FILE_TOOLS].some(name => currentTurnNames.has(name));
      checkNoToolUse({
        state, provider: ctx.provider, emitter, finalText,
        toolCallCount: hooks.toolSeq.value,
        answerArtifactCount: answerArtifacts.length,
        noTools: opts.noTools,
        hadMutationToolOffered,
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
      const preloadedMemCount = await memoryCtx.refreshSessionMemCtx();
      await memoryCtx.refreshSelfMemCtx();   // local-only; no-op on cloud
      const memCtx = memoryCtx.getSessionMemCtx();
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
      if (!isLocalProvider(newProvider.name)) memoryCtx.clearSelfMemCtx();
      logger.info(`[agent] provider switched to "${newProvider.name}" model="${newProvider.model}"`);
    },
  };
  return agentObj;
}
