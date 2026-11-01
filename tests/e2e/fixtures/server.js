// tests/e2e/fixtures/server.js
// Enhanced WebSocket fixture for E2E streaming tests.
// Supports configurable multi-token streams, delays, errors, and concurrent
// connections. Each connection has its own independent state.
//
// Prints "PORT:<n>\n" to stdout once the server is listening.

import { createServer } from "http";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

// Connection-specific configuration
const connState = new Map();

function defaultState() {
  return {
    // Tokenize the default response into individual words.
    responseTokens: ["pong"],
    delayMs: 0,
    errorOnNext: false,
    errorMsg: "Simulated provider error",
  };
}

wss.on("connection", (ws) => {
  const sessionId = randomUUID();
  const state = defaultState();
  connState.set(ws, state);

  const send = (type, payload = {}) => {
    ws.send(JSON.stringify({ type, ...payload }));
  };

  // Handshake
  send("status",          { text: "connected" });
  send("provider",        { name: "stub", model: "stub", db: "sqlite", thinks: false, contextWindow: 4096 });
  send("session_created", { id: sessionId });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    // ── Control messages ─────────────────────────────────────────────
    if (data.type === "set_stream") {
      // Configure the response text. Tokenized into space-separated words.
      const text = String(data.text ?? "pong");
      state.responseTokens = text.split(/(\s+)/).filter(Boolean);
      return;
    }
    if (data.type === "set_delay") {
      state.delayMs = Math.max(0, Math.min(5000, Number(data.ms) || 0));
      return;
    }
    if (data.type === "set_error") {
      state.errorOnNext = true;
      if (data.message) state.errorMsg = String(data.message);
      return;
    }
    if (data.type === "set_provider") {
      send("provider", {
        name: String(data.name || "stub"),
        model: String(data.model || "stub"),
        db: "sqlite",
        thinks: !!data.thinks,
        contextWindow: Number(data.contextWindow) || 4096,
      });
      return;
    }
    if (data.type === "disconnect") {
      ws.close(Number(data.code) || 1000, data.reason || "client requested");
      return;
    }

    // ── Chat messages ────────────────────────────────────────────────
    if (data.type === "chat") {
      if (state.errorOnNext) {
        state.errorOnNext = false;
        send("error", { message: state.errorMsg });
        return;
      }

      send("stream_start", { sessionId });

      const tokens = state.responseTokens;
      const streamContent = tokens.join("");

      // Send all tokens immediately (synchronous for zero delay).
      // Only defer via setTimeout when a delay is explicitly configured.
      if (state.delayMs > 0) {
        (async () => {
          for (let i = 0; i < tokens.length; i++) {
            await new Promise((r) => setTimeout(r, state.delayMs));
            send("token", { text: tokens[i] });
          }
          send("stream_end", { text: streamContent, usage: { input: 1, output: tokens.length } });
        })();
      } else {
        for (const t of tokens) send("token", { text: t });
        send("stream_end", { text: streamContent, usage: { input: 1, output: tokens.length } });
      }
      return;
    }
  });

  ws.on("close", () => {
    connState.delete(ws);
  });
});

httpServer.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT:${httpServer.address().port}\n`);
});
