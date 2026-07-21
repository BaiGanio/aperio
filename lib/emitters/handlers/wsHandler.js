import { join } from "path";
import logger, { createSessionLogger } from "../../helpers/logger.js";
import { processAttachments } from "../../handlers/attachments/index.js";
import { imageTokenEstimate } from "../../helpers/imageTokens.js";
import { machineCapacityPct, isLocalProvider, isSubscriptionProvider, providerDropsImages } from "../../providers/index.js";
import { isDockerAvailable } from "../../../db/index.js";
import {
  init as initSessions,
  createSession,
  setSessionTitle,
  finaliseSession,
  sessionScratchDir,
  updateSessionModel,
} from "../../helpers/sessions.js";
import { makeWsEmitter } from "../wsEmitter.js";
import { makeSinkEmitter } from "../sinkEmitter.js";
import { estimateTotalTokens, CTX_SUMMARIZE_TARGET } from "../../context/trim.js";
import { createRagStore } from "../../context/ragStore.js";
import { generateEmbedding } from "../../helpers/embeddings.js";
import { runWithPaths, setAllowlist, getAllowlist, getUserPaths } from "../../routes/paths.js";
import { runRoundTable } from "../../workers/roundtable.js";
import { parseSlashSkill } from "../../workers/skills.js";
import { getPricing } from "../../pricing.js";
import { onModelStatus, currentModelStatus } from "../../helpers/modelPreload.js";
import { normalizeMessages, isSummarizeIntent, tagLastAssistant } from "./ws/helpers.js";
import { sendMemories, sendSelfMemories, sendPendingInterrupts, handleDeleteMemory } from "./ws/memories.js";
import { handleSaveSuggestions } from "./ws/suggestions.js";
import { handleConfirmAction, handleInterruptDecision } from "./ws/interrupts.js";
import { handleHandoff } from "./ws/handoff.js";
import { handleBranchConversation, handleResumeSession } from "./ws/session.js";
import { handleSummarize, handleDiscussStart } from "./ws/summarize.js";

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
 *
 * Handlers for the more peripheral message types (handoff, branch/resume,
 * summarize/discuss, suggestions, interrupts, memory broadcasts) live in
 * ./ws/*.js and take their connection state as explicit parameters rather
 * than closing over it. `init`, the message router, and `handleChat` stay
 * here — they own the turn-interruption state machine (abortController,
 * activeTurn, activeChatTurn) and are the highest-risk, most timing-sensitive
 * part of this file.
 */
export function makeWsHandler({ agent, primaryRoundtable = null, verifier = null, roundtableAvailable = false, roundtableUnavailableReason = null, store, varRoot = process.cwd(), isShuttingDown = () => false }) {
  initSessions(varRoot);

  const {
    callTool,
    runAgentLoop: baseRunAgentLoop,
    handleRememberIntent,
    buildGreeting,
    NO_TOOLS,
    getStartupBreakdown,
    resetProviderSession,
  } = agent;
  // Read provider live from agent so it reflects any runtime setProvider() call.
  const provider = () => agent.provider;

  return function onConnection(ws) {
    try {
    // ── Per-connection state ────────────────────────────────────────────────────
    const messages = [];
    const msgAttachments = new WeakMap(); // message object → attachment meta[]
    let initialized = false;
    let abortController = null;
    // Separate from abortController: the prompt-cache warm-up is a
    // background, non-user-visible request. It must be abortable the
    // instant a real chat message arrives
    // (llama-server runs parallel=1), but it must NOT be folded into
    // abortController — that variable's truthiness drives the "was a real
    // turn interrupted" flag on the next chat message, and a warm-up is never
    // a real turn.
    let warmupAbortController = null;
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
    let sessionId = createSession({ model: provider().model, provider: provider().name, source: "web" });
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
      costRates:     ((p) => p ? { in: p.in, out: p.out } : null)(getPricing(provider().model)),
      imageTokens:   imageTokenEstimate(provider().name),
      toolEligible:  !NO_TOOLS,
      local:         isLocalProvider(provider().name),
      subscription:  isSubscriptionProvider(provider().name),
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
    sendPendingInterrupts({ store, send }).catch(err => {
      logger.warn("[ws] send pending interrupts failed:", err.message);
    });

    // App-wide model_status (boot preload, helpers/modelPreload.js): a browser
    // opened while the main model is still downloading/loading must show that
    // wait, not a ready-looking chat. Replay the latest status immediately,
    // then forward live updates until the socket closes.
    const bootStatus = currentModelStatus();
    if (bootStatus) send("model_status", bootStatus);
    const offModelStatus = onModelStatus(payload => {
      try { send("model_status", payload); } catch { /* socket gone */ }
    });

    // ── Initialisation (runs once on first "init" message) ─────────────────────
    async function init() {
      await sendMemories({ store, send, sessionLogger });

      const { staticGreeting } = await buildGreeting(currentLang);
      // Per-component startup cost so the banner can explain the total instead of
      // showing one opaque number. getStartupBreakdown already reflects the memory
      // pointer (cloud-capable models only; 0 for local/weak models), so the client
      // can render the banner immediately at startup from these estimates.
      try {
        send("startup_breakdown", getStartupBreakdown());
      } catch { /* non-fatal */ }
      // The greeting is always a static localized line — instant, zero provider
      // cost (prompt-cache hygiene). It is deliberately NOT seeded into
      // `messages` — leaving history empty means the first real user turn is
      // the first message the model sees. (memCtx is still persisted on the
      // agent by buildGreeting, so the preview is carried.)
      send("stream_end", { text: staticGreeting });
      await sendMemories({ store, send, sessionLogger });

      // Fire-and-forget prompt-cache warm-up: primes llama-server's KV cache with
      // the real system prompt so the user's first real message doesn't pay a
      // cold prefill. Gated inside agent.warmCache() on "local provider + model
      // already loaded" — when it isn't, there is no cache to warm and this is a
      // no-op, so the user's first message triggers loading exactly as it does
      // today. Uses its own abort controller (see warmupAbortController above),
      // aborted by the "chat" and socket-close handlers below.
      agent.warmCache(currentLang, () => warmupAbortController, (c) => { warmupAbortController = c; })
        .catch(err => logger.warn(`[ws] cache warm-up failed: ${err.message}`))
        .finally(() => { warmupAbortController = null; });
    }

    // ── Session close ───────────────────────────────────────────────────────────
    ws.on("close", () => {
      // A socket can close while a provider fetch is still streaming. Abort it
      // before shutdown tears down llama-server; otherwise undici reports the
      // engine socket disappearing as `TypeError: terminated`.
      socketClosed = true;
      offModelStatus();
      if (abortController) {
        try { abortController.abort(); } catch { /* best-effort */ }
        abortController = null;
      }
      if (warmupAbortController) {
        try { warmupAbortController.abort(); } catch { /* best-effort */ }
        warmupAbortController = null;
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
              // A real user message always wins over a background cache warm-up
              // (llama-server runs parallel=1 — the warm-up must never queue
              // ahead of the user). Abort it via its own controller, separate
              // from the "was a real turn interrupted" bookkeeping below.
              if (warmupAbortController) {
                try { warmupAbortController.abort(); } catch { /* best-effort */ }
                warmupAbortController = null;
              }
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
              await sendMemories({ store, send, sessionLogger });
              return;

            case "get_self_memories":
              await sendSelfMemories({ store, send, sessionLogger });
              return;

            case "delete_memory":
              await handleDeleteMemory(data.id, { callTool, send, sessionLogger });
              return;

            case "summarize":
              await handleSummarize({}, {
                messages, ragStore, runAgentLoop, currentLang, sessionId, providerSessionSourceId,
                provider, resetProviderSession, callTool, emitter, makeSinkEmitter, send, sessionLogger, store,
              });
              return;

            case "discuss_start": {
              const result = await handleDiscussStart({ messages, runAgentLoop, currentLang, makeSinkEmitter, send, sessionLogger });
              lastDiscussSummary = result.ok ? result.summary : null;
              return;
            }

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
              await handleHandoff(data.focus, { messages, sessionId, currentLang, runAgentLoop, emitter, sessionLogger, send });
              return;

            case "branch_conversation": {
              const result = await handleBranchConversation({
                messages, sessionId, msgAttachments, sessionHadAttachments, provider, send, sessionLogger,
              });
              if (result) {
                sessionId = result.sessionId;
                titleSet = result.titleSet;
                providerSessionSourceId = result.providerSessionSourceId;
              }
              return;
            }

            case "save_suggestions":
              await handleSaveSuggestions(data.items, { callTool, send, sessionLogger, store });
              return;

            case "confirm_action":
              await handleConfirmAction(data, { store, callTool, messages, send, sessionLogger });
              return;

            case "interrupt_decision":
              await handleInterruptDecision(data, { store, messages, send, sessionLogger });
              return;

            case "resume_session": {
              const result = await handleResumeSession(data.id, {
                messages, currentLang, runAgentLoop, emitter, send, sessionLogger,
                getAbort: () => abortController, setAbort: (c) => { abortController = c; },
              });
              if (result) {
                titleSet = result.titleSet;
                providerSessionSourceId = result.providerSessionSourceId;
              }
              return;
            }

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
                costRates:     ((p) => p ? { in: p.in, out: p.out } : null)(getPricing(provider().model)),
                imageTokens:   imageTokenEstimate(provider().name),
                toolEligible:  !NO_TOOLS,
                local:         isLocalProvider(provider().name),
                subscription:  isSubscriptionProvider(provider().name),
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

      // WS6/F1: codex and claude-code build their prompt from the last user
      // message's text only — an attached image would otherwise vanish with
      // no explanation. One notice per turn regardless of image count.
      if (providerDropsImages(provider().name) && contentBlocks.some(b => b.type === "image")) {
        send("capability_notice", { kind: "images_dropped", provider: provider().name });
      }

      send("thinking");

      // Explicit summarize intent — route through the same path as the banner button
      // so the result is saved to the session file and the memory DB.
      if (isSummarizeIntent(data.text)) {
        await handleSummarize({}, {
          messages, ragStore, runAgentLoop, currentLang, sessionId, providerSessionSourceId,
          provider, resetProviderSession, callTool, emitter, makeSinkEmitter, send, sessionLogger, store,
        });
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
        await sendMemories({ store, send, sessionLogger });
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
      abortController = null;
      tagLastAssistant(messages, provider());
      // Provider-owned MCP subprocesses (notably Codex) persist confirmation
      // requests directly to the shared interrupt store, bypassing tool-hooks.
      // Refresh here so those actions become real clickable UI cards.
      await sendPendingInterrupts({ store, send });

      // Auto-summarize when the estimated context crosses 80%. Runs silently
      // after the answer is delivered — the user sees a context_summarized event
      // but no extra spinner or chat bubble.
      const ctxWindow = provider().contextWindow;
      if (ctxWindow > 0 && estimateTotalTokens(messages) >= ctxWindow * CTX_SUMMARIZE_TARGET) {
        await handleSummarize({ auto: true }, {
          messages, ragStore, runAgentLoop, currentLang, sessionId, providerSessionSourceId,
          provider, resetProviderSession, callTool, emitter, makeSinkEmitter, send, sessionLogger, store,
        });
      }

      await sendMemories({ store, send, sessionLogger });
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
