import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE   = resolve(__dirname, "..", "fixtures/server.js");

test("WebSocket chat: server streams an assistant message for 'ping'", async (t) => {
  // ── 1. Start fixture server ────────────────────────────────────────────────
  const server = spawn(process.execPath, [FIXTURE], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill());

  // ── 2. Read the random port from stdout ────────────────────────────────────
  const port = await new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("fixture server did not print PORT within 5 s")), 5_000);
    let buf = "";
    server.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/PORT:(\d+)/);
      if (m) { clearTimeout(tid); resolve(Number(m[1])); }
    });
    server.on("exit", (code) => { clearTimeout(tid); reject(new Error(`fixture server exited early (code ${code})`)); });
  });

  // ── 3. Open WebSocket connection ───────────────────────────────────────────
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => { try { ws.close(); } catch { /* non-fatal */ } });

  await new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("WebSocket did not open within 5 s")), 5_000);
    ws.once("open",  () => { clearTimeout(tid); resolve(); });
    ws.once("error", (err) => { clearTimeout(tid); reject(err); });
  });

  // ── 4. Send chat and assert a streamed assistant message arrives ───────────
  const msg = await new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("no streamed message arrived within 10 s")), 10_000);

    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === "token" || parsed.type === "stream_end") {
        clearTimeout(tid);
        resolve(parsed);
      }
    });

    ws.send(JSON.stringify({ type: "chat", content: "ping" }));
  });

  assert.ok(
    msg.type === "token" || msg.type === "stream_end",
    `expected a streamed assistant message, got: ${JSON.stringify(msg)}`,
  );
});
