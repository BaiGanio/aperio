import { makeWsEmitter } from "../wsEmitter.js";
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
} from "../../helpers/sessions.js";

/**
 * Factory that returns a WebSocket "connection" handler.
 * Keeps all per-connection state (messages, abortController, initialized flag)
 * local to the closure — nothing leaks between connections.
 *
 * Usage in server.js:
 *   wss.on("connection", makeWsHandler({ agent, store, __dirname }));
 *
 * @param {object} opts
 * @param {object} opts.agent       - Agent instance from createAgent()
 * @param {object} opts.store       - DB store instance from getStore()
 * @param {string} opts.__dirname   - Server root directory (for resolving uploads)
 */
export function makeWsHandler({ agent, store, __dirname }) {
  initSessions(__dirname);

  const {
    provider,
    callTool,
    runAgentLoop,
    handleRememberIntent,
    buildGreeting,
    OLLAMA_NO_TOOLS,
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
    // ── Per-connection state ────────────────────────────────────────────────────
    const messages = [];
    let initialized = false;
    let abortController = null;
    let titleSet = false;
    const sessionId = createSession({ model: provider.model, provider: provider.name });

    const emitter = makeWsEmitter(ws);

    // ── Announce connection ─────────────────────────────────────────────────────
    send("status", { text: "connected" });
    send("provider", {
      name:          provider.name,
      model:         provider.model,
      db:            isDockerAvailable() ? "postgres" : "lancedb",
      thinks:        agent.OLLAMA_THINKS,
      contextWindow: provider.contextWindow,
    });

    // ── Initialisation (runs once on first "init" message) ─────────────────────
    async function init() {
      await sendMemories();

      messages.push({ role: "user", content: await buildGreeting() });

      const thinksBefore = agent.OLLAMA_THINKS;
      await runAgentLoop(
        messages, emitter,
        provider.name !== "anthropic" ? { noTools: true } : {},
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
        });
      }

      await sendMemories();
    }

    // ── Session close ───────────────────────────────────────────────────────────
    ws.on("close", () => {
      try { finaliseSession(sessionId, messages); } catch { /* non-fatal */ }
    });

    // ── Message router ──────────────────────────────────────────────────────────
    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        switch (data.type) {
          case "init":
            if (initialized) return;
            initialized = true;
            await init();
            return;

          case "chat":
            await handleChat(data);
            return;

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

          case "save_suggestions":
            await handleSaveSuggestions(data.items);
            return;

          case "resume_session":
            await handleResumeSession(data.id);
            return;
        }
      } catch (err) {
        send("error", { text: err.message });
      }
    });

    // ── Handler: chat ───────────────────────────────────────────────────────────
    async function handleChat(data) {
      // Start with the user's text block
      const contentBlocks = [{ type: "text", text: data.text }];

      if (data.attachments?.length > 0) {
        const { contentBlocks: attBlocks, hint } = await processAttachments(
          data.attachments,
          __dirname
        );

        // Append all attachment blocks
        contentBlocks.push(...attBlocks);

        // Fold system hints back into the user text block
        contentBlocks[0].text += hint;
      }

      // Backward-compat: no attachments → plain string content
      const messagePayload = contentBlocks.length > 1 ? contentBlocks : data.text;
      messages.push({ role: "user", content: messagePayload });

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

      // Ollama-only fallback: handle "remember that …" without tool calls
      if (OLLAMA_NO_TOOLS && /^remember\s+that\b/i.test(data.text.trim())) {
        console.log("🧠 remember intent | text:", data.text.substring(0, 40));
        await handleRememberIntent(data.text, emitter);
      }

      await runAgentLoop(
        messages, emitter, {},
        () => abortController,
        (c) => { abortController = c; }
      );

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
          { noTools: true },
          () => null, () => {},
        );
      } catch (err) {
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
          importance: 3,
        });
        saved = true;
      } catch {
        // Non-fatal — history is compressed in RAM even if persistence fails
      }

      send("context_summarized", { ok: true, saved });
      await sendMemories();
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

      send("thinking");

      // Inject only the compact context — NOT the full transcript
      messages.push({ role: "user", content: buildResumeContext(session) });

      await runAgentLoop(
        messages, emitter,
        { noTools: true },
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
        } catch { /* non-fatal */ }
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
        send("error", { text: `Delete failed: ${err.message}` });
      }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    /** Push current memories to the sidebar. Queries the DB directly so both
     *  REST-imported and MCP-saved memories are always visible without restart. */
    async function sendMemories() {
      try {
        const { parsed } = await agent.fetchMemories();
        send("memories", { memories: parsed });
      } catch (err) {
        console.error("Failed to fetch memories:", err.message);
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
  };
}