import { join } from "path";
import { ensureSecureDir, writeSecureFile } from "../../helpers/secureFile.js";
import { redactSecrets } from "../../helpers/redactSecrets.js";

const HANDOFFS_DIR = join(process.cwd(), "var/handoffs");
import logger, { createSessionLogger } from "../../helpers/logger.js";
import { processAttachments } from "../../handlers/attachments/index.js";
import { imageTokenEstimate } from "../../helpers/imageTokens.js";
import { machineCapacityPct, isLocalProvider } from "../../providers/index.js";
import { isDockerAvailable } from "../../../db/index.js";
import {
  init as initSessions,
  createSession,
  setSessionTitle,
  appendSummary,
  finaliseSession,
  getSession,
  buildResumeContext,
  RESUME_SYSTEM_INSTRUCTIONS,
  sessionScratchDir,
  updateSessionModel,
} from "../../helpers/sessions.js";
import { makeWsEmitter } from "../wsEmitter.js";
import { makeSinkEmitter } from "../sinkEmitter.js";
import { SYNTHETIC_USER } from "../../agent/index.js";
import { estimateTotalTokens, CTX_SUMMARIZE_TARGET } from "../../context/trim.js";
import { createRagStore } from "../../context/ragStore.js";
import { generateEmbedding } from "../../helpers/embeddings.js";
import { runWithPaths, setAllowlist, getAllowlist, getUserPaths } from "../../routes/paths.js";
import { runRoundTable } from "../../workers/roundtable.js";
import { parseSlashSkill } from "../../workers/skills.js";
import { decideAndMaybeExecute, serializeInterrupt } from "../../routes/api-interrupts.js";

/**
 * Factory that returns a WebSocket "connection" handler.
 * Keeps all per-connection state (messages, abortController, initialized flag)
 * local to the closure — nothing leaks between connections.
 *
 * Usage in server.js:
 *   wss.on("connection", makeWsHandler({ agent, primaryRoundtable, verifier, roundtableAvailable, store, varRoot }));
 *
 * @param {object} opts
 * @param {object}      opts.agent              - Main chat agent (single-turn chat).
 * @param {object|null} [opts.primaryRoundtable] - Round-table answerer (independent of chat agent).
 * @param {object|null} [opts.verifier]         - Round-table reviewer agent.
 * @param {boolean}     [opts.roundtableAvailable] - Convenience flag; UI announces it to the client.
 * @param {string|null} [opts.roundtableUnavailableReason] - Why Discuss is disabled; shown as the button tooltip.
 * @param {object}      opts.store              - DB store instance from getStore()
 * @param {string}      [opts.varRoot]          - Root for runtime var/ data (sessions, logs, scratch, uploads).
 *                                                Defaults to process.cwd() so it matches the path-guard floor
 *                                                (lib/routes/paths.js BASE_DIR) and the SQLite default — the
 *                                                system prompt must never advertise a scratch workspace the
 *                                                allowlist forbids (issue #282).
 */
export function makeWsHandler({ agent, primaryRoundtable = null, verifier = null, roundtableAvailable = false, roundtableUnavailableReason = null, store, varRoot = process.cwd(), isShuttingDown = () => false }) {
  initSessions(varRoot);

  const {
    callTool,
    runAgentLoop: baseRunAgentLoop,
    handleRememberIntent,
    buildGreeting,
    NO_TOOLS,
    greetingToolCount,
    getToolCount,
    getStartupBreakdown,
    resetProviderSession,
  } = agent;
  // Read provider live from agent so it reflects any runtime setProvider() call.
  const provider = () => agent.provider;

  // Collapse any provider-specific content blocks (Anthropic tool_use/tool_result,
  // image blocks, etc.) to plain text in-place. Called before a cross-provider
  // model switch so the history survives the format change without losing context.
  function normalizeMessages(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!Array.isArray(m.content)) continue; // already a string — leave it
      const text = m.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim();
      if (text) {
        msgs[i] = { role: m.role, content: text };
      } else {
        // Message was purely tool_use / tool_result with no text — drop it so
        // the new provider doesn't see an empty or structurally invalid entry.
        msgs.splice(i, 1);
      }
    }
  }

  const SUMMARIZE_RE = /\b(summarize|summarise|summarization|summary|recap)\b.*\b(our|this|the)?\s*(conversation|chat|discussion|session|history|we('ve| have) (discussed|talked|covered))\b|\bsummarize\s+(it|this|everything|all)\b|\b(tl;?dr|tldr)\b/i;

  function isSummarizeIntent(text) {
    return SUMMARIZE_RE.test(text?.trim() ?? "");
  }

  function buildHistoryText(msgs) {
    return msgs
      .filter(m =>
        m.role !== "tool" &&
        !(Array.isArray(m.content) && m.content[0]?.type === "tool_result")
      )
      .map(m => {
        const role = m.role === "user" ? "User" : "Assistant";
        const text = Array.isArray(m.content)
          ? m.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim()
          : String(m.content || "").trim();
        return text ? `${role}: ${text}` : null;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  function tagLastAssistant(msgs, p) {
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant") {
      last._model    = p.model;
      last._provider = p.name;
    }
  }

  return function onConnection(ws) {
    try {
    // ── Per-connection state ────────────────────────────────────────────────────
    const messages = [];
    const msgAttachments = new WeakMap(); // message object → attachment meta[]
    let initialized = false;
    let abortController = null;
    let socketClosed = false;
    // Promise for the turn currently generating (greeting or chat). Lets an
    // incoming chat interrupt an in-flight turn and wait for it to fully settle
    // before starting its own, so the shared messages[] is never mutated by two
    // turns at once.
    let activeTurn = null;
    let activeChatTurn = null;
    let titleSet = false;
    // True once any message in this session carried file attachments.
    // Survives summarization (which clears messages[]) so finaliseSession
    // can preserve uploaded files even after context compression.
    let sessionHadAttachments = false;
    // Discuss-flow summaries. `lastDiscussSummary` is the candidate produced by
    // discuss_start (awaiting the user's Use/Skip choice); `pendingDiscussionSummary`
    // is the confirmed one, consumed once on the next round-table turn.
    let lastDiscussSummary = null;
    let pendingDiscussionSummary = null;
    // User's interface language. Updated by `init` and `set_lang` messages.
    // Threaded into every runAgentLoop() call so the system prompt instructs
    // the model to reply in this language.
    let currentLang = "en";
    const ragStore = createRagStore();
    const sessionId = createSession({ model: provider().model, provider: provider().name, source: "web" });
    let providerSessionSourceId = sessionId;
    const runAgentLoop = (messages, emitter, opts = {}, getAbort, setAbort) =>
      baseRunAgentLoop(
        messages,
        emitter,
        {
          ...opts,
          ...(provider().name === "codex" ? { aperioSessionId: providerSessionSourceId } : {}),
          ...(provider().name === "llamacpp" ? { llamaLogSessionId: sessionId } : {}),
        },
        getAbort,
        setAbort,
      );
    const sessionLogger = createSessionLogger(sessionId, join(varRoot, "var/logs"));
    // Per-session scratch workspace for skill-generated artifacts. Threaded into
    // runWithPaths so in-process tools (generate_xlsx) write here, and injected
    // into the chat turn's system prompt so the model writes generator scripts
    // and output here instead of the shared, never-pruned skills/*/scratch dir.
    const scratchDir = sessionScratchDir(sessionId);
    const workspaceDirective = (() => {
      const projectRoot = process.cwd();
      const allowedPaths = getAllowlist();
      const pathList = allowedPaths.map(p => `- \`${p}\``).join("\n");
      return (
        `## File system context\n` +
        `**Project root:** \`${projectRoot}\`\n` +
        `When the user refers to project files (e.g. "the README", "the config"), use absolute paths ` +
        `under the project root above. Never guess paths like \`/home/user/...\` or \`~/...\` — ` +
        `always construct paths from the project root.\n\n` +
        `**Session scratch workspace:** \`${scratchDir}\`\n` +
        `Write generated artifacts here — generator scripts (e.g. pptx/xlsx builder .js), ` +
        `intermediate files, and final output files (pptx, xlsx, etc.). Create the directory if it ` +
        `does not exist. Do NOT write into \`skills/*/scratch/\`. Scripts run as ES modules ` +
        `(the project is \`type: module\`): use \`import x from 'pkg'\`, not \`require()\`. Files here are retained with the ` +
        `session and cleaned up automatically when it expires.\n\n` +
        `**Allowed paths** (read and write freely within these):\n${pathList}\n` +
        `The scratch workspace is only for generated output — it is not the only place you can write.`
      );
    })();

    const emitter = makeWsEmitter(ws);

    // ── Announce connection ─────────────────────────────────────────────────────
    send("status", { text: "connected" });
    send("provider", {
      name:          provider().name,
      model:         provider().model,
      db:            isDockerAvailable() ? "postgres" : "sqlite",
      thinks:        agent.THINKS,
      contextWindow: provider().contextWindow,
      contextCapacityPct: isLocalProvider(provider().name) ? machineCapacityPct(provider().model) : null,
      imageTokens:   imageTokenEstimate(provider().name),
      toolCount:     greetingToolCount,
      toolEligible:  !NO_TOOLS,
      roundtableAvailable,
      roundtableReason: roundtableAvailable ? null : roundtableUnavailableReason,
      agents: roundtableAvailable
        ? [
            { id: "primary",  persona: primaryRoundtable.persona ?? "primary",  character: primaryRoundtable.character ?? null, name: primaryRoundtable.provider.name, model: primaryRoundtable.provider.model },
            { id: "verifier", persona: verifier.persona ?? "verifier",          character: verifier.character ?? null,          name: verifier.provider.name,          model: verifier.provider.model },
          ]
        : [{ id: "primary", persona: agent.persona ?? null, name: provider().name, model: provider().model }],
    });
    send("session_created", { id: sessionId });
    sendPendingInterrupts().catch(err => {
      logger.warn("[ws] send pending interrupts failed:", err.message);
    });

    // ── Initialisation (runs once on first "init" message) ─────────────────────
    async function init() {
      await sendMemories();

      const { prompt: greetingPrompt, staticGreeting, seedGreeting, greetingMemBlock } = await buildGreeting(currentLang);
      // Per-component startup cost so the banner can explain the total instead of
      // showing one opaque number. getStartupBreakdown already reflects the memory
      // pointer (cloud-capable models only; 0 for local/weak models), so the client
      // can render the banner immediately at startup from these estimates.
      try {
        send("startup_breakdown", getStartupBreakdown());
      } catch { /* non-fatal */ }
      // Default assistant: skip the greeting inference entirely and render a
      // static localized line. The greeting exchange is deliberately NOT seeded
      // into `messages` — leaving history empty means the first real user turn
      // is the first message the model sees, so we save both the greeting call
      // and the greeting pair's tokens on every later turn. (memCtx is still
      // persisted on the agent by buildGreeting, so the preview is carried.)
      if (staticGreeting) {
        send("stream_end", { text: staticGreeting });
        await sendMemories();
        return;
      }

      // Model-generated greeting. The identity (CACHED_PROMPT) and preloaded
      // memories (sessionMemCtx) already live in the system prompt, so the model
      // greets as itself and aware of what it knows. Seed the exchange into real
      // history only for persona/character (roleplay continuity); the default
      // identity greeting runs on a throwaway array, so it streams once and leaves
      // history empty — later turns don't re-send its tokens.
      // Mark synthetic so skill/profile matching ignores the greeting instruction
      // text (see SYNTHETIC_USER). The symbol is invisible to JSON.stringify, so
      // providers still receive a plain user message.
      const greetHistory = seedGreeting ? messages : [];
      greetHistory.push({ role: "user", content: greetingPrompt, [SYNTHETIC_USER]: true });

      const thinksBefore = agent.THINKS;
      // The greeting asks only for "one short friendly sentence", so thinking is
      // pure latency here — a local reasoning model (ornith, qwen3) would ruminate
      // for many seconds-to-minutes before a trivial hello. Suppress it for the
      // greeting turn on the llama.cpp path (harmless/ignored elsewhere). Anthropic
      // keeps its extended-thinking continuity greeting.
      const greetOpts = provider().name !== "anthropic"
        ? { noTools: true, lang: currentLang, suppressThinking: true }
        : { lang: currentLang };
      // Richer continuity block (capable models only), injected into the greeting
      // turn's system prompt only — never persisted onto later turns.
      if (greetingMemBlock) greetOpts.extraSystem = greetingMemBlock;
      await runAgentLoop(
        greetHistory, emitter,
        greetOpts,
        () => abortController,
        (c) => { abortController = c; }
      );
      if (seedGreeting) tagLastAssistant(messages, provider());

      // Re-announce provider if thinking was auto-detected during the greeting
      if (agent.THINKS !== thinksBefore) {
        send("provider", {
          name:          provider().name,
          model:         provider().model,
          db:            isDockerAvailable() ? "postgres" : "sqlite",
          thinks:        agent.THINKS,
          contextWindow: provider().contextWindow,
          contextCapacityPct: isLocalProvider(provider().name) ? machineCapacityPct(provider().model) : null,
          imageTokens:   imageTokenEstimate(provider().name),
          toolCount:     agent.toolsEnabled ? agent.mcpTools.length : 0,
          toolEligible:  !NO_TOOLS,
        });
      }

      await sendMemories();
    }

    // ── Session close ───────────────────────────────────────────────────────────
    ws.on("close", () => {
      // A socket can close while a provider fetch is still streaming. Abort it
      // before shutdown tears down llama-server; otherwise undici reports the
      // engine socket disappearing as `TypeError: terminated`.
      socketClosed = true;
      if (abortController) {
        try { abortController.abort(); } catch { /* best-effort */ }
        abortController = null;
      }
      // Uploaded files are kept on disk until the session is pruned or deleted.
      // onShutdown: this close may be the server terminating the socket during
      // Ctrl+C rather than the user closing their tab — in that case the session
      // was interrupted, so finaliseSession must keep it instead of judging it
      // trivial and deleting mid-conversation work.
      try { finaliseSession(sessionId, messages, msgAttachments, sessionHadAttachments, { onShutdown: isShuttingDown() }); } catch (err) {
        logger.error("[ws] finaliseSession error:", err.message);
      }
      try { sessionLogger.close(); } catch { /* non-fatal */ }
    });

    // ── Message router ──────────────────────────────────────────────────────────
    ws.on("message", async (raw) => {
      // Paths come from the app-wide allowlist (getAllowlist); only the scratch
      // dir is per-session. Re-read the allowlist each message so updates apply live.
      await runWithPaths(getAllowlist(), getAllowlist(), scratchDir, async () => {
        let turnId = null;
        try {
          const data = JSON.parse(raw.toString());

          switch (data.type) {
            case "init":
              if (typeof data.lang === "string" && data.lang.length <= 8) currentLang = data.lang;
              if (initialized) return;
              initialized = true;
              const initPromise = init();
              activeTurn = initPromise;
              initPromise.then(
                () => { if (activeTurn === initPromise) activeTurn = null; },
                () => { if (activeTurn === initPromise) activeTurn = null; },
              );
              await activeTurn;
              return;

            case "set_lang":
              if (typeof data.lang === "string" && data.lang.length <= 8) currentLang = data.lang;
              return;

            case "set_paths": {
              const { paths } = data;
              if (!Array.isArray(paths)) return;
              const valid = p => typeof p === "string" && p.trim().length > 0;
              if (!paths.every(valid)) return;
              await setAllowlist(paths);
              send("paths_updated", { paths: getUserPaths() });
              return;
            }

            case "chat": {
              turnId = typeof data.turnId === "string" && data.turnId.length <= 128
                ? data.turnId
                : null;
              // If a turn is still generating, interrupt it: abort the model
              // call, wait for the old turn to unwind, then mark this chat so
              // the agent is told its previous response was cut off.
              const wasGenerating = !!abortController;
              const interruptedTurn = activeChatTurn;
              if (interruptedTurn) interruptedTurn.interrupted = true;
              if (abortController) { abortController.abort(); abortController = null; }
              if (activeTurn) { try { await activeTurn; } catch { /* aborted turn */ } }
              data.interrupted = wasGenerating; // server is authoritative, not the client flag
              const turn = { id: turnId, interrupted: false, promise: null };
              turn.promise = handleChat(data);
              activeChatTurn = turn;
              activeTurn = turn.promise;
              try {
                await turn.promise;
                send("turn_complete", { turnId, status: turn.interrupted ? "interrupted" : "completed" });
              } catch (err) {
                if (turn.interrupted) {
                  send("turn_complete", { turnId, status: "interrupted" });
                  return;
                }
                throw err;
              } finally {
                if (activeTurn === turn.promise) activeTurn = null;
                if (activeChatTurn === turn) activeChatTurn = null;
              }
              return;
            }

            case "stop":
              if (abortController) { abortController.abort(); abortController = null; }
              send("stream_end", { text: "" });
              return;

            case "get_memories":
              await sendMemories();
              return;

            case "get_self_memories":
              await sendSelfMemories();
              return;

            case "delete_memory":
              await handleDeleteMemory(data.id);
              return;

            case "summarize":
              await handleSummarize();
              return;

            case "discuss_start":
              await handleDiscussStart();
              return;

            case "discuss_confirm":
              if (data.accepted) {
                pendingDiscussionSummary = lastDiscussSummary;
                send("discuss_staged");
              } else {
                pendingDiscussionSummary = null;
                send("discuss_declined");
              }
              return;

            case "handoff":
              await handleHandoff(data.focus);
              return;

            case "branch_conversation":
              await handleBranchConversation();
              return;

            case "save_suggestions":
              await handleSaveSuggestions(data.items);
              return;

            case "confirm_action":
              await handleConfirmAction(data);
              return;

            case "interrupt_decision":
              await handleInterruptDecision(data);
              return;

            case "resume_session":
              await handleResumeSession(data.id);
              return;

            case "switch_model": {
              const { provider: pName, model: pModel } = data;
              if (typeof pName !== "string" || typeof pModel !== "string") return;
              const prevName = provider().name;
              agent.setProvider({ name: pName, model: pModel });
              // On cross-provider switch, message formats differ (Anthropic uses
              // structured content blocks; llama.cpp/Gemini/DeepSeek expect plain
              // strings). Normalise in-place so conversation history survives the
              // switch without either side seeing malformed blocks.
              if (prevName !== pName) normalizeMessages(messages);
              updateSessionModel(sessionId, { model: provider().model, provider: provider().name });
              // Re-announce so the badge and reasoning toggle update immediately.
              send("provider", {
                name:          provider().name,
                model:         provider().model,
                db:            isDockerAvailable() ? "postgres" : "sqlite",
                thinks:        agent.THINKS,
                contextWindow: provider().contextWindow,
                contextCapacityPct: isLocalProvider(provider().name) ? machineCapacityPct(provider().model) : null,
                imageTokens:   imageTokenEstimate(provider().name),
                toolCount:     agent.toolsEnabled ? agent.mcpTools.length : 0,
                toolEligible:  !NO_TOOLS,
              });
              return;
            }
          }
        } catch (err) {
          // Closing a browser tab or shutting down Aperio intentionally aborts
          // in-flight provider requests. Do not turn that expected cancellation
          // into a user-visible error or an alarming server log entry.
          if (socketClosed || isShuttingDown()) return;
          sessionLogger.error("ws message handler error", { err: err.message, stack: err.stack });
          logger.error("[ws] message handler error:", err);
          send("error", { text: err.message });
          if (turnId !== null) send("turn_complete", { turnId, status: "error" });
        }
      });
    });

    // ── Handler: chat ───────────────────────────────────────────────────────────
    async function handleChat(data) {
      // Parse a skill-forcing prefix ("/skill a,b" or direct "/skill-name")
      // from the user message. Strip it so the LLM never sees the command; the
      // forced skills are injected via setPendingForcedSkills → ensureTurn
      // below (which re-validates and emits skills_not_found for bad names).
      const skillList = typeof agent.getSkillList === "function" ? agent.getSkillList() : [];
      const { forcedNames, notFound, cleanedText } = parseSlashSkill(data.text || "", skillList);
      const cleanedUserText = cleanedText;

      // One-shot picks from the Skills panel ride in as data.forcedSkills.
      // Validate shape here; unknown names surface via ensureTurn's not-found path.
      const NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;
      const oneShotNames = (Array.isArray(data.forcedSkills) ? data.forcedSkills : [])
        .filter(n => typeof n === "string" && NAME_RE.test(n))
        .slice(0, 16);

      const forcedSkillNames = [...new Set([...oneShotNames, ...forcedNames, ...notFound])];
      if (forcedSkillNames.length) {
        logger.info(`[ws] forced skills — slash: [${forcedNames.join(",")}] one-shot: [${oneShotNames.join(",")}] not-found: [${notFound.join(",")}]`);
        agent.setPendingForcedSkills(forcedSkillNames);
      }

      // Replace data.text so all downstream consumers (roundtable, remember
      // intent, RAG, summarise check) see the cleaned text.
      data.text = cleanedUserText;

      // Start with the user's text block
      const contentBlocks = [{ type: "text", text: data.text }];

      // The user sent this while the previous turn was still generating, so it
      // was aborted mid-stream. Prefix a note so the model understands its last
      // response was cut off — the user may have changed their mind, navigated
      // away, or have something to add — and should focus on the new message.
      if (data.interrupted) {
        contentBlocks[0].text =
          "[Note: you were interrupted — the user stopped your previous response before it finished and sent this instead. " +
          "Treat the message below as the current priority; don't assume your prior answer was seen or completed.]\n\n" +
          contentBlocks[0].text;
      }

      let attachmentMeta = [];
      if (data.attachments?.length > 0) {
        const { contentBlocks: attBlocks, hint, attachmentMeta: meta } = await processAttachments(
          data.attachments,
          varRoot
        );

        // Append all attachment blocks
        contentBlocks.push(...attBlocks);

        // Fold system hints back into the user text block
        contentBlocks[0].text += hint;
        attachmentMeta = meta;
      }

      // Backward-compat: no attachments → plain string content
      const messagePayload = contentBlocks.length > 1 ? contentBlocks : data.text;
      const userMsg = { role: "user", content: messagePayload };
      if (attachmentMeta.length > 0) {
        msgAttachments.set(userMsg, attachmentMeta);
        sessionHadAttachments = true;
      }
      messages.push(userMsg);

      if (!titleSet && data.text?.trim()) {
        setSessionTitle(sessionId, data.text.trim());
        titleSet = true;
      }

      send("thinking");

      // Explicit summarize intent — route through the same path as the banner button
      // so the result is saved to the session file and the memory DB.
      if (isSummarizeIntent(data.text)) {
        await handleSummarize();
        return;
      }

      // ── Round-table mode ───────────────────────────────────────────────────
      // Opt-in per turn via `roundtable: true`. Only honoured when the server
      // booted a verifier (ROUNDTABLE_AGENTS set with two pairs).
      //
      // The user's message (incl. attachment content blocks) stays in the
      // shared transcript — the orchestrator only appends the assistant turn.
      // `userContent` carries the full content blocks (or plain string) so
      // both agents see images/files just like the single-agent path does.
      if (data.roundtable === true && roundtableAvailable && primaryRoundtable && verifier) {
        try {
          // Consume any staged Discuss summary exactly once.
          const discussionContext = pendingDiscussionSummary;
          pendingDiscussionSummary = null;
          const rtResult = await runRoundTable({
            primary:  primaryRoundtable,
            verifier,
            userText: data.text,
            userContent: messagePayload,
            discussionContext,
            sharedTranscript: messages,
            ws,
            sessionId,
            lang: currentLang,
            getAbort: () => abortController,
            setAbort: (c) => { abortController = c; },
          });
          if (rtResult?.manifesto?.path) {
            send("roundtable_manifesto", {
              path: `/roundtables/${rtResult.manifesto.path.split("/").pop()}`,
              primaryText: rtResult.manifesto.primaryManifesto,
              verifierText: rtResult.manifesto.verifierManifesto,
            });
          }
        } catch (err) {
          sessionLogger.error("runRoundTable failed", { err: err.message, stack: err.stack });
          logger.error("[ws] round-table error:", err);
          send("error", { text: `Round-table failed: ${err.message}` });
        }
        await sendMemories();
        return;
      }

      // Toolless-model fallback: handle "remember that …" without tool calls
      if (NO_TOOLS && /^remember\s+that\b/i.test(data.text.trim())) {
        logger.info(`🧠 remember intent | text: ${data.text.substring(0, 40)}`);
        await handleRememberIntent(data.text, emitter);
      }

      // Inject semantically relevant past exchanges from the RAG store when
      // context has been compressed at least once. Gives the model access to
      // specific details that were dropped from the live messages array.
      let extraSystem = workspaceDirective;
      if (ragStore.size > 0 && data.text?.trim()) {
        const retrieved = await ragStore.retrieve(data.text, generateEmbedding);
        if (retrieved.length > 0) {
          const ragBlock =
            "## Relevant earlier context\n" +
            "The following exchanges from earlier in this conversation were compressed but are relevant to the current question:\n\n" +
            retrieved.join("\n\n---\n\n");
          extraSystem = extraSystem ? `${extraSystem}\n\n${ragBlock}` : ragBlock;
        }
      }

      await runAgentLoop(
        messages, emitter, { lang: currentLang, extraSystem },
        () => abortController,
        (c) => { abortController = c; }
      );
      tagLastAssistant(messages, provider());
      // Provider-owned MCP subprocesses (notably Codex) persist confirmation
      // requests directly to the shared interrupt store, bypassing tool-hooks.
      // Refresh here so those actions become real clickable UI cards.
      await sendPendingInterrupts();

      // Auto-summarize when the estimated context crosses 80%. Runs silently
      // after the answer is delivered — the user sees a context_summarized event
      // but no extra spinner or chat bubble.
      const ctxWindow = provider().contextWindow;
      if (ctxWindow > 0 && estimateTotalTokens(messages) >= ctxWindow * CTX_SUMMARIZE_TARGET) {
        await handleSummarize({ auto: true });
      }

      // Use the full message text (including any attachment hint appended by processAttachments)
      // so getToolCount resolves the same turn-cache key the provider loop already used.
      // Using raw data.text here would produce a different key and re-trigger skills_matched.
      const fullUserText = typeof messagePayload === "string"
        ? messagePayload
        : messagePayload?.find?.(b => b.type === "text")?.text ?? data.text;
      send("tool_count", { count: NO_TOOLS ? 0 : getToolCount(fullUserText, messages) });
      await sendMemories();
    }

    // ── Handler: discuss_start ──────────────────────────────────────────────────
    // The Discuss button was armed: produce a short framing summary of the
    // conversation so far and offer it to the user as the prompt for the two
    // round-table agents. Unlike handleSummarize, this never compresses or wipes
    // history — it only generates text for the confirmation card.
    async function handleDiscussStart() {
      lastDiscussSummary = null;
      // Nothing meaningful to summarize yet — let the client just arm the toggle.
      if (messages.length < 3) {
        send("discuss_summary", { ok: false });
        return;
      }

      const history = buildHistoryText(messages);
      const summaryMessages = [{
        role: "user",
        content: `Summarize the conversation below into a single tight paragraph (3-4 sentences) that frames the topic for two other AI agents who will debate it. State what is being discussed and what needs resolving. No bullet points, no pleasantries.\n\nConversation:\n${history}`,
      }];

      // Stream through a sink emitter so this never renders as a chat bubble —
      // the client shows it in a dedicated confirmation card instead.
      let summary = "";
      try {
        summary = await runAgentLoop(
          summaryMessages, makeSinkEmitter().emitter,
          { noTools: true, lang: currentLang },
          () => null, () => {},
        );
      } catch (err) {
        sessionLogger.error("handleDiscussStart runAgentLoop error", { err: err.message, stack: err.stack });
        logger.error("[ws] handleDiscussStart error:", err);
        send("discuss_summary", { ok: false });
        return;
      }

      summary = String(summary || "").trim();
      if (!summary) { send("discuss_summary", { ok: false }); return; }
      lastDiscussSummary = summary;
      send("discuss_summary", { ok: true, text: summary });
    }

    // ── Handler: summarize ──────────────────────────────────────────────────────
    async function handleSummarize({ auto = false } = {}) {
      if (messages.length < 3) {
        send("context_summarized", { ok: false, reason: "Not enough history to summarize." });
        return;
      }

      // In auto mode the answer was just delivered — don't restart the spinner.
      if (!auto) send("thinking");

      const history = buildHistoryText(messages);

      // Index the full transcript into RAG before it gets compressed.
      // Runs concurrently with summary generation to minimise latency.
      const ragIndexPromise = ragStore.index(messages, generateEmbedding).catch(err =>
        logger.warn("[ws] ragStore.index failed:", err.message)
      );

      const summaryMessages = [{
        role: "user",
        content: `Summarize the following conversation in 3-5 concise bullet points. Capture key topics, decisions, and any open questions. Skip pleasantries.\n\nConversation:\n${history}`,
      }];

      // Auto-summary must stay silent: stream the summary through a sink emitter
      // so it never renders as an assistant bubble. The user already received
      // their answer and only sees the context_summarized banner. A leaked
      // summary bubble reads like a broken third-person reply and carries no
      // suggestion chips, making the model look like it stopped responding.
      const summaryEmitter = auto ? makeSinkEmitter().emitter : emitter;

      let summary = "";
      try {
        summary = await runAgentLoop(
          summaryMessages, summaryEmitter,
          { noTools: true, lang: currentLang, isolatedProviderSession: provider().name === "codex" },
          () => null, () => {},
        );
      } catch (err) {
        sessionLogger.error("handleSummarize runAgentLoop error", { err: err.message, stack: err.stack });
        logger.error("[ws] handleSummarize error:", err);
        send("context_summarized", { ok: false, reason: err.message });
        return;
      }

      // Ensure RAG indexing finishes before we wipe the messages array
      await ragIndexPromise;

      // Checkpoint the full transcript + summary into the session file BEFORE wiping
      try { appendSummary(sessionId, { content: summary, messages }); } catch { /* non-fatal */ }

      // Compress the in-memory history to just the summary block
      const firstMsg = messages[0];
      messages.length = 0;
      messages.push(firstMsg);
      messages.push({ role: "assistant", content: `[Conversation summary]\n${summary}` });
      if (provider().name === "codex") {
        resetProviderSession?.(providerSessionSourceId, "codex");
      }

      // Persist to the memory store so it survives reconnects and is recallable
      let saved = false;
      try {
        const title = `Conversation — ${new Date().toLocaleDateString("en-GB", {
          day: "2-digit", month: "short", year: "numeric",
        })}`;
        await callTool("remember", {
          type: "project",
          title,
          content: summary,
          tags: ["conversation-summary"],
          importance: 3        });
        saved = true;
      } catch (err) {
        // Non-fatal — history is compressed in RAM even if persistence fails
        sessionLogger.error("handleSummarize callTool(remember) error", { err: err.message });
        logger.warn("[ws] handleSummarize: failed to persist summary to memory:", err.message);
      }

      send("context_summarized", { ok: true, saved });
      await sendMemories();
    }

    // ── Handler: handoff ────────────────────────────────────────────────────────
    // Generate a handoff document (per the `handoff` skill) and write it to the
    // OS tmp directory so a fresh agent can pick the work up cold.
    async function handleHandoff(focus) {
      if (messages.length < 2) {
        send("handoff_written", { ok: false, reason: "Not enough conversation to hand off yet." });
        return;
      }

      send("thinking");

      const focusLine = (focus && typeof focus === "string" && focus.trim())
        ? focus.trim()
        : "Continue the current task from where this session left off.";

      const history = buildHistoryText(messages);
      const handoffPrompt = [
        "Produce a handoff document for a fresh agent to continue this work.",
        `Next session focus: ${focusLine}`,
        "",
        "Follow exactly this structure (omit empty sections, do not pad):",
        "",
        "# Handoff — <one-line title>",
        "**Created:** <ISO timestamp>",
        "**Next session focus:** <one sentence>",
        "",
        "## Active task",
        "## State of play",
        "## Key decisions made this session",
        "## Open questions",
        "## Artifacts",
        "## Suggested skills for the next agent",
        "## Gotchas",
        "",
        "Rules: link by absolute path/URL, do not duplicate artifacts. Redact secrets.",
        "Be terse. No narration. No recap after the document.",
        "",
        "Conversation transcript:",
        history,
      ].join("\n");

      let doc = "";
      try {
        doc = await runAgentLoop(
          [{ role: "user", content: handoffPrompt }],
          emitter,
          { noTools: true, lang: currentLang },
          () => null, () => {},
        );
      } catch (err) {
        sessionLogger.error("handleHandoff runAgentLoop error", { err: err.message, stack: err.stack });
        logger.error("[ws] handleHandoff error:", err);
        send("handoff_written", { ok: false, reason: err.message });
        return;
      }

      // Write under <project>/var/handoffs/ — matches the var/sessions, var/logs pattern.
      const iso = new Date().toISOString().replace(/[:.]/g, "-");
      const slug = focusLine.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
      const path = join(HANDOFFS_DIR, `aperio-handoff-${iso}-${slug}.md`);

      try {
        // DATA-01: scrub secrets and write 0600 (the handoff doc is a shareable brief).
        ensureSecureDir(HANDOFFS_DIR);
        writeSecureFile(path, redactSecrets(doc));
      } catch (err) {
        sessionLogger.error("handleHandoff writeFile error", { err: err.message, path });
        send("handoff_written", { ok: false, reason: `Failed to write handoff: ${err.message}` });
        return;
      }

      // Record the handoff as a session summary BEFORE the rotation wipes
      // messages[]. Two reasons, mirroring handleSummarize: it preserves the
      // rotated-away history as resumable context (buildResumeContext reads the
      // latest summary), and it marks the session as substantial so finalisation
      // on socket close keeps it — without this, a handed-off session whose
      // compressed messages[] falls under the trivial threshold would be
      // deleted (the same data-loss the wasSummarized guard fixes for summaries).
      try { appendSummary(sessionId, { content: doc, messages }); } catch { /* non-fatal */ }

      // ── In-session rotation ─────────────────────────────────────────────────
      // The whole point of a handoff is to escape the dumb zone. Replace the
      // bloated in-memory history with the handoff doc itself, so the current
      // agent picks up cold with a small, dense brief — same idea as
      // handleSummarize, but anchored on the handoff document.
      const firstMsg = messages[0];
      messages.length = 0;
      if (firstMsg) messages.push(firstMsg);
      messages.push({
        role: "assistant",
        content: `[Handoff brief — rotated from prior context]\n\n${doc}\n\n[End handoff]`,
      });

      logger.info(`[ws] handoff written + context rotated: ${path}`);
      send("handoff_written", { ok: true, path, rotated: true });
    }

    // ── Handler: branch_conversation ─────────────────────────────────────────────
    // Creates a child session that inherits the current conversation context
    // as a summary, so the user can explore a tangent without polluting the
    // main thread. The current session is finalised and a fresh session starts.
    async function handleBranchConversation() {
      if (messages.length < 2) {
        send("session_branched", { ok: false, reason: "Not enough conversation to branch yet." });
        return;
      }

      // Finalise current session so it's saved with its current title.
      finaliseSession(sessionId, messages, msgAttachments, sessionHadAttachments);

      // Create a child session.
      const parentTitle = getSession(sessionId)?.title ?? "Untitled";
      const childId = createSession({
        model: provider().model,
        provider: provider().name,
        source: "web",
        parentId: sessionId,
      });

      // Build a compact context from the parent.
      const parent = getSession(sessionId);
      const context = parent ? buildResumeContext(parent) : `Continued from: ${parentTitle}`;

      // Switch to the child session.
      const oldSessionId = sessionId;
      sessionId = childId;
      messages.length = 0;
      titleSet = true;
      providerSessionSourceId = null;

      // Inject the parent context as a system note.
      messages.push({
        role: "user",
        content: `[Branched from: ${parentTitle}]\n\n${context}\n\n[End branch context — continue exploring the tangent below]`,
      });

      setSessionTitle(childId, `↳ ${parentTitle}`);

      send("session_branched", {
        ok: true,
        id: childId,
        parentId: oldSessionId,
        title: `↳ ${parentTitle}`,
      });

      logger.info(`[ws] conversation branched: ${oldSessionId} → ${childId}`);
    }

    // ── Handler: resume_session ─────────────────────────────────────────────────
    async function handleResumeSession(id) {
      const session = getSession(id);
      if (!session) {
        send("error", { text: "Session not found." });
        return;
      }

      // Reset in-memory state for the fresh resume
      messages.length = 0;
      titleSet = true; // don't overwrite title from resume message
      // Continue the provider thread attached to the selected history item.
      // Subsequent turns in this connection keep using that same stored thread.
      providerSessionSourceId = id;

      send("thinking");

      // Inject only the compact context — NOT the full transcript
      messages.push({ role: "user", content: buildResumeContext(session) });

      await runAgentLoop(
        messages, emitter,
        { noTools: true, lang: currentLang, extraSystem: RESUME_SYSTEM_INSTRUCTIONS },
        () => abortController,
        (c) => { abortController = c; },
      );

      send("session_resumed", { id, title: session.title });
    }

    // ── Handler: save_suggestions ───────────────────────────────────────────────
    async function handleSaveSuggestions(items) {
      const list = Array.isArray(items) ? items : [];
      let saved = 0;
      for (const { text } of list) {
        if (!text?.trim()) continue;
        try {
          const { type, title, content } = parseSuggestionItem(text);
          await callTool("remember", {
            type,
            title,
            content,
            tags: ["memory-suggestion"],
            importance: 3,
          });
          saved++;
        } catch (err) {
          sessionLogger.error("handleSaveSuggestions item failed", { err: err.message, text: text?.slice(0, 80) });
          logger.warn("[ws] save_suggestion failed:", err.message);
        }
      }
      send("suggestions_saved", { saved, total: list.length });
      await sendMemories();
    }

    // Parses structured agent output: "[fact] **User prefers X** — summary"
    function parseSuggestionItem(raw) {
      const text = raw.trim();
      const VALID_TYPES = new Set(["fact","preference","decision","project","solution","source","person"]);

      const typeMatch = text.match(/^\[(\w+)\]\s*/);
      const type = typeMatch && VALID_TYPES.has(typeMatch[1].toLowerCase())
        ? typeMatch[1].toLowerCase()
        : null;
      const rest = (typeMatch ? text.slice(typeMatch[0].length) : text)
        .replace(/\*\*/g, "").trim();

      const dash = rest.indexOf(" — ");
      if (dash > -1) {
        const title = rest.slice(0, dash).trim();
        const content = rest.slice(dash + 3).trim();
        return { type: type ?? guessSuggestionType(rest), title, content };
      }

      return {
        type: type ?? guessSuggestionType(rest),
        title: rest.length > 70 ? `${rest.slice(0, 67)}…` : rest,
        content: rest,
      };
    }

    function guessSuggestionType(text) {
      const t = text.toLowerCase();
      if (/\bprefer|dislike\b/.test(t)) return "preference";
      if (/\bdecid|chose|agreed|resolved\b/.test(t)) return "decision";
      if (/\bproject|using|stack|tech\b/.test(t)) return "project";
      return "fact";
    }

    // ── Handler: confirm_action ─────────────────────────────────────────────────
    // A confirm-before-write button (GitHub issue create/update, file write, or a
    // db_execute database write) was clicked. The action is already fully resolved
    // and stashed server-side under the token, so we execute it straight through
    // the MCP tool — no model round-trip — and show the result. Pushed into
    // messages[] so it persists in the session transcript.
    const CONFIRMABLE_TOOLS = new Set([
      "create_github_issue", "update_github_issue", "delete_file",
      "write_file", "edit_file", "append_file", "db_execute",
    ]);
    async function handleConfirmAction(data) {
      const { token, tool } = data;
      if (!CONFIRMABLE_TOOLS.has(tool) || typeof token !== "string" || !/^(?:iss|del|wr|db)_[a-z0-9]+$/.test(token)) {
        send("error", { text: "Invalid confirmation request." });
        return;
      }
      try {
        send("thinking");
        const { status, body } = await decideAndMaybeExecute({
          store,
          id: token,
          body: { decision: "approve" },
        });
        let text;
        if (status === 404 && typeof callTool === "function") {
          const result = await callTool(tool, { confirmation_token: token });
          text = typeof result === "string"
            ? result
            : (Array.isArray(result) ? result.find(b => b.type === "text")?.text ?? "Done." : "Done.");
        } else {
          if (status >= 400) throw new Error(body?.error || "Confirmation failed");
          text = body?.result || "Done.";
        }
        messages.push({ role: "assistant", content: text });
        await sendPendingInterrupts();
        send("stream_end", { text });
      } catch (err) {
        sessionLogger.error("handleConfirmAction error", { tool, err: err.message });
        logger.error("[ws] handleConfirmAction error:", err);
        send("error", { text: `Confirmation failed: ${err.message}` });
      }
    }

    async function handleInterruptDecision(data) {
      const id = data.id ?? data.token;
      const decision = data.decision;
      if (typeof id !== "string" || !["approve", "edit", "reject", "respond"].includes(decision)) {
        send("error", { text: "Invalid interrupt decision." });
        return;
      }
      try {
        if (decision === "approve" || decision === "edit") send("thinking");
        const { status, body } = await decideAndMaybeExecute({
          store,
          id,
          body: {
            decision,
            editedArguments: data.editedArguments,
            response: data.response,
          },
        });
        if (status >= 400) throw new Error(body?.error || "Interrupt decision failed");
        await sendPendingInterrupts();
        const text = body?.result || (
          decision === "reject"
            ? "Action rejected. Nothing was executed."
            : decision === "respond"
              ? "Response recorded. Nothing was executed."
              : "Done."
        );
        messages.push({ role: "assistant", content: text });
        send("interrupt_decided", { interrupt: body.interrupt, result: body.result, decision });
        send("stream_end", { text });
      } catch (err) {
        sessionLogger.error("handleInterruptDecision error", { id, decision, err: err.message });
        logger.error("[ws] handleInterruptDecision error:", err);
        send("error", { text: `Interrupt decision failed: ${err.message}` });
      }
    }

    // ── Handler: delete_memory ──────────────────────────────────────────────────
    async function handleDeleteMemory(id) {
      try {
        await callTool("forget", { id });
        send("deleted", { id });
      } catch (err) {
        sessionLogger.error("handleDeleteMemory error", { id, err: err.message });
        logger.error("[ws] handleDeleteMemory error:", err);
        send("error", { text: `Delete failed: ${err.message}` });
      }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    /** Push current memories to the sidebar via store.listAll() so the pinned
     *  field and full memory list are always fresh without text-parsing overhead. */
    async function sendMemories() {
      try {
        const rows = await store.listAll();
        const memories = rows.map(m => ({
          id:         m.id,
          type:       m.type,
          title:      m.title,
          content:    m.content,
          tags:       m.tags ?? [],
          importance: m.importance ?? 3,
          createdAt:  m.created_at instanceof Date ? m.created_at.toISOString() : (m.created_at ?? null),
          pinned:     m.pinned ?? false,
        }));
        send("memories", { memories });
      } catch (err) {
        sessionLogger.error("sendMemories error", { err: err.message });
        logger.error(`[ws] Failed to fetch memories: ${err.message}`);
      }
    }

    /** Oversight read of the agent's own walled-off store. Goes straight to
     *  store.listSelf() — NOT through the local-only handler gate — because this
     *  is the *user* auditing the store, not a model reading it. So it works
     *  regardless of the active provider. */
    async function sendSelfMemories() {
      try {
        const rows = await store.listSelf(200);
        const memories = rows.map(m => ({
          id:         m.id,
          title:      m.title,
          content:    m.content,
          tags:       m.tags ?? [],
          importance: m.importance ?? 3,
          createdAt:  m.created_at instanceof Date ? m.created_at.toISOString() : (m.created_at ?? null),
        }));
        send("self_memories", { memories });
      } catch (err) {
        sessionLogger.error("sendSelfMemories error", { err: err.message });
        logger.error(`[ws] Failed to fetch self-memories: ${err.message}`);
      }
    }

    async function sendPendingInterrupts() {
      if (!store?.listAgentInterrupts) return;
      const rows = await store.listAgentInterrupts({ status: "pending", limit: 100 });
      send("interrupts", { interrupts: rows.map(serializeInterrupt) });
    }

    /**
     * Thin wrapper so callers don't have to JSON.stringify everywhere.
     * @param {string} type
     * @param {object} [payload]
     */
    function send(type, payload = {}) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
    } catch (err) {
      logger.error("[ws] connection setup error:", err);
      try { sessionLogger.error("[ws] connection setup error", { err: err.message, stack: err.stack }); } catch { /* non-fatal */ }
      try { ws.close(1011, "Server error"); } catch { /* non-fatal */ }
    }
 };
}
