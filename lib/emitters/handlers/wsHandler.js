import { makeWsEmitter } from "../wsEmitter.js";
import { processAttachments } from "../../attachments/index.js";
import { isDockerAvailable } from "../../../db/index.js";

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
  const {
    provider,
    callTool,
    runAgentLoop,
    handleRememberIntent,
    fetchMemories,
    buildGreeting,
    OLLAMA_NO_TOOLS,
  } = agent;

  return function onConnection(ws) {
    // ── Per-connection state ────────────────────────────────────────────────────
    const messages = [];
    let initialized = false;
    let abortController = null;

    const emitter = makeWsEmitter(ws);

    // ── Announce connection ─────────────────────────────────────────────────────
    send("status", { text: "connected" });
    send("provider", {
      name:  provider.name,
      model: provider.model,
      db:    isDockerAvailable() ? "postgres" : "lancedb",
    });

    // ── Initialisation (runs once on first "init" message) ─────────────────────
    async function init() {
      await sendMemories();

      messages.push({ role: "user", content: await buildGreeting() });

      await runAgentLoop(
        messages, emitter,
        provider.name === "ollama" ? { noTools: true } : {},
        () => abortController,
        (c) => { abortController = c; }
      );

      await sendMemories();
    }

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

      send("thinking");

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

    /** Push current memories to the sidebar. */
    async function sendMemories() {
      try {
        const { parsed } = await fetchMemories();
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