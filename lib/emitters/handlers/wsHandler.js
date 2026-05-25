import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";

const HANDOFFS_DIR = join(process.cwd(), "var/handoffs");
import logger, { createSessionLogger } from "../../helpers/logger.js";
import { processAttachments } from "../../handlers/attachments/index.js";
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
  saveSessionPaths,
} from "../../helpers/sessions.js";
import { makeWsEmitter } from "../wsEmitter.js";
import { runWithPaths, clampToDefaults, DEFAULT_READ_PATHS, DEFAULT_WRITE_PATHS } from "../../routes/paths.js";
import { runRoundTable } from "../../workers/roundtable.js";

/**
 * Factory that returns a WebSocket "connection" handler.
 * Keeps all per-connection state (messages, abortController, initialized flag)
 * local to the closure — nothing leaks between connections.
 *
 * Usage in server.js:
 *   wss.on("connection", makeWsHandler({ agent, primaryRoundtable, verifier, roundtableAvailable, store, __dirname }));
 *
 * @param {object} opts
 * @param {object}      opts.agent              - Main chat agent (single-turn chat).
 * @param {object|null} [opts.primaryRoundtable] - Round-table answerer (independent of chat agent).
 * @param {object|null} [opts.verifier]         - Round-table reviewer agent.
 * @param {boolean}     [opts.roundtableAvailable] - Convenience flag; UI announces it to the client.
 * @param {object}      opts.store              - DB store instance from getStore()
 * @param {string}      opts.__dirname          - Server root directory (for resolving uploads)
 */
export function makeWsHandler({ agent, primaryRoundtable = null, verifier = null, roundtableAvailable = false, store, __dirname }) {
  initSessions(__dirname);

  const {
    provider,
    callTool,
    runAgentLoop,
    handleRememberIntent,
    buildGreeting,
    OLLAMA_NO_TOOLS,
    greetingToolCount,
    getToolCount,
  } = agent;

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

  return function onConnection(ws) {
    try {
    // ── Per-connection state ────────────────────────────────────────────────────
    const messages = [];
    const msgAttachments = new WeakMap(); // message object → attachment meta[]
    let initialized = false;
    let abortController = null;
    // Promise for the turn currently generating (greeting or chat). Lets an
    // incoming chat interrupt an in-flight turn and wait for it to fully settle
    // before starting its own, so the shared messages[] is never mutated by two
    // turns at once.
    let activeTurn = null;
    let titleSet = false;
    // True once any message in this session carried file attachments.
    // Survives summarization (which clears messages[]) so finaliseSession
    // can preserve uploaded files even after context compression.
    let sessionHadAttachments = false;
    // User's interface language. Updated by `init` and `set_lang` messages.
    // Threaded into every runAgentLoop() call so the system prompt instructs
    // the model to reply in this language.
    let currentLang = "en";
    // Per-connection allowed paths — initialized from the process-level defaults.
    // Isolated via AsyncLocalStorage (runWithPaths) so tool calls in this
    // connection never see another connection's path updates.
    let connReadPaths  = [...DEFAULT_READ_PATHS];
    let connWritePaths = [...DEFAULT_WRITE_PATHS];
    const sessionId = createSession({ model: provider.model, provider: provider.name, source: "web" });
    const sessionLogger = createSessionLogger(sessionId, join(__dirname, "var/logs"));

    const emitter = makeWsEmitter(ws);

    // ── Announce connection ─────────────────────────────────────────────────────
    send("status", { text: "connected" });
    send("provider", {
      name:          provider.name,
      model:         provider.model,
      db:            isDockerAvailable() ? "postgres" : "lancedb",
      thinks:        agent.OLLAMA_THINKS,
      contextWindow: provider.contextWindow,
      toolCount:     greetingToolCount,
      roundtableAvailable,
      agents: roundtableAvailable
        ? [
            { id: "primary",  persona: primaryRoundtable.persona ?? "primary",  name: primaryRoundtable.provider.name, model: primaryRoundtable.provider.model },
            { id: "verifier", persona: verifier.persona ?? "verifier",          name: verifier.provider.name,          model: verifier.provider.model },
          ]
        : [{ id: "primary", persona: agent.persona ?? null, name: provider.name, model: provider.model }],
    });
    send("session_created", { id: sessionId });

    // ── Initialisation (runs once on first "init" message) ─────────────────────
    async function init() {
      await sendMemories();

      const { prompt: greetingPrompt, memCtx, preloadedMemCount } = await buildGreeting(currentLang);
      if (preloadedMemCount > 0) send("preload_mem_count", { count: preloadedMemCount });
      messages.push({ role: "user", content: greetingPrompt });

      const thinksBefore = agent.OLLAMA_THINKS;
      const greetOpts = provider.name !== "anthropic"
        ? { noTools: true, lang: currentLang }
        : { lang: currentLang };
      if (memCtx) greetOpts.extraSystem = memCtx;
      await runAgentLoop(
        messages, emitter,
        greetOpts,
        () => abortController,
        (c) => { abortController = c; }
      );

      // Re-announce provider if thinking was auto-detected during the greeting
      if (agent.OLLAMA_THINKS !== thinksBefore) {
        send("provider", {
          name:          provider.name,
          model:         provider.model,
          db:            isDockerAvailable() ? "postgres" : "lancedb",
          thinks:        agent.OLLAMA_THINKS,
          contextWindow: provider.contextWindow,
          toolCount:     agent.mcpTools.length,
        });
      }

      await sendMemories();
    }

    // ── Session close ───────────────────────────────────────────────────────────
    ws.on("close", () => {
      // Uploaded files are kept on disk until the session is pruned or deleted.
      try { finaliseSession(sessionId, messages, msgAttachments, sessionHadAttachments); } catch (err) {
        logger.error("[ws] finaliseSession error:", err.message);
      }
      try { sessionLogger.close(); } catch { /* non-fatal */ }
    });

    // ── Message router ──────────────────────────────────────────────────────────
    ws.on("message", async (raw) => {
      await runWithPaths(connReadPaths, connWritePaths, async () => {
        try {
          const data = JSON.parse(raw.toString());

          switch (data.type) {
            case "init":
              if (typeof data.lang === "string" && data.lang.length <= 8) currentLang = data.lang;
              if (initialized) return;
              initialized = true;
              activeTurn = init().finally(() => { activeTurn = null; });
              await activeTurn;
              return;

            case "set_lang":
              if (typeof data.lang === "string" && data.lang.length <= 8) currentLang = data.lang;
              return;

            case "set_paths": {
              const { readPaths, writePaths, sessionId: sid } = data;
              if (!Array.isArray(readPaths) || !Array.isArray(writePaths)) return;
              const valid = p => typeof p === "string" && p.trim().length > 0;
              if (!readPaths.every(valid) || !writePaths.every(valid)) return;
              const clamped = clampToDefaults({ readPaths, writePaths });
              connReadPaths  = clamped.readPaths;
              connWritePaths = clamped.writePaths;
              if (sid && typeof sid === "string") {
                try { saveSessionPaths(sid, { readPaths: connReadPaths, writePaths: connWritePaths }); } catch { /* non-fatal */ }
              }
              send("paths_updated", { readPaths: connReadPaths, writePaths: connWritePaths });
              return;
            }

            case "chat": {
              // If a turn is still generating, interrupt it: abort the model
              // call, wait for the old turn to unwind, then mark this chat so
              // the agent is told its previous response was cut off.
              const wasGenerating = !!abortController;
              if (abortController) { abortController.abort(); abortController = null; }
              if (activeTurn) { try { await activeTurn; } catch { /* aborted turn */ } }
              data.interrupted = wasGenerating; // server is authoritative, not the client flag
              activeTurn = handleChat(data).finally(() => { activeTurn = null; });
              await activeTurn;
              return;
            }

            case "stop":
              if (abortController) { abortController.abort(); abortController = null; }
              send("stream_end", { text: "" });
              return;

            case "get_memories":
              await sendMemories();
              return;

            case "delete_memory":
              await handleDeleteMemory(data.id);
              return;

            case "summarize":
              await handleSummarize();
              return;

            case "handoff":
              await handleHandoff(data.focus);
              return;

            case "save_suggestions":
              await handleSaveSuggestions(data.items);
              return;

            case "resume_session":
              await handleResumeSession(data.id);
              return;
          }
        } catch (err) {
          sessionLogger.error("ws message handler error", { err: err.message, stack: err.stack });
          logger.error("[ws] message handler error:", err);
          send("error", { text: err.message });
        }
      });
    });

    // ── Handler: chat ───────────────────────────────────────────────────────────
    async function handleChat(data) {
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
          __dirname
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
          await runRoundTable({
            primary:  primaryRoundtable,
            verifier,
            userText: data.text,
            userContent: messagePayload,
            sharedTranscript: messages,
            ws,
            lang: currentLang,
            getAbort: () => abortController,
            setAbort: (c) => { abortController = c; },
          });
        } catch (err) {
          sessionLogger.error("runRoundTable failed", { err: err.message, stack: err.stack });
          logger.error("[ws] round-table error:", err);
          send("error", { text: `Round-table failed: ${err.message}` });
        }
        await sendMemories();
        return;
      }

      // Ollama-only fallback: handle "remember that …" without tool calls
      if (OLLAMA_NO_TOOLS && /^remember\s+that\b/i.test(data.text.trim())) {
        logger.info(`🧠 remember intent | text: ${data.text.substring(0, 40)}`);
        await handleRememberIntent(data.text, emitter);
      }

      await runAgentLoop(
        messages, emitter, { lang: currentLang },
        () => abortController,
        (c) => { abortController = c; }
      );

      send("tool_count", { count: OLLAMA_NO_TOOLS ? 0 : getToolCount(data.text, messages) });
      await sendMemories();
    }

    // ── Handler: summarize ──────────────────────────────────────────────────────
    async function handleSummarize() {
      if (messages.length < 3) {
        send("context_summarized", { ok: false, reason: "Not enough history to summarize." });
        return;
      }

      send("thinking");

      const history = buildHistoryText(messages);
      const summaryMessages = [{
        role: "user",
        content: `Summarize the following conversation in 3-5 concise bullet points. Capture key topics, decisions, and any open questions. Skip pleasantries.\n\nConversation:\n${history}`,
      }];

      let summary = "";
      try {
        summary = await runAgentLoop(
          summaryMessages, emitter,
          { noTools: true, lang: currentLang },
          () => null, () => {},
        );
      } catch (err) {
        sessionLogger.error("handleSummarize runAgentLoop error", { err: err.message, stack: err.stack });
        logger.error("[ws] handleSummarize error:", err);
        send("context_summarized", { ok: false, reason: err.message });
        return;
      }

      // Checkpoint the full transcript + summary into the session file BEFORE wiping
      try { appendSummary(sessionId, { content: summary, messages }); } catch { /* non-fatal */ }

      // Compress the in-memory history to just the summary block
      const firstMsg = messages[0];
      messages.length = 0;
      messages.push(firstMsg);
      messages.push({ role: "assistant", content: `[Conversation summary]\n${summary}` });

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
        mkdirSync(HANDOFFS_DIR, { recursive: true });
        writeFileSync(path, doc, "utf-8");
      } catch (err) {
        sessionLogger.error("handleHandoff writeFile error", { err: err.message, path });
        send("handoff_written", { ok: false, reason: `Failed to write handoff: ${err.message}` });
        return;
      }

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

      // Restore saved paths clamped to .env defaults (prevents session-file privilege escalation).
      // Updates only this connection's local state — not the process-level globals.
      if (session.allowedPaths) {
        const clamped = clampToDefaults(session.allowedPaths);
        connReadPaths  = clamped.readPaths;
        connWritePaths = clamped.writePaths;
        send("paths_restored", { readPaths: connReadPaths, writePaths: connWritePaths });
      }

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
