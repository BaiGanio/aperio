// Minimal WebSocket fixture server for E2E testing.
// Speaks the same message protocol as the real server but requires no DB or AI provider.
// Prints "PORT:<n>\n" to stdout once the server is listening so the test can connect.
import { createServer } from "http";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const sessionId = randomUUID();
  const send = (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload }));

  send("status",          { text: "connected" });
  send("provider",        { name: "stub", model: "stub", db: "lancedb", thinks: false, contextWindow: 4096, toolCount: 0 });
  send("session_created", { id: sessionId });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === "chat") {
      send("thinking");
      send("stream_start");
      send("token",      { text: "pong" });
      send("stream_end", { text: "pong", usage: { input: 1, output: 1 } });
    }
  });
});

httpServer.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT:${httpServer.address().port}\n`);
});
