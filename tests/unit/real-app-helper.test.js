import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createChildStop, request } from "../e2e/helpers/real-app-helper.js";

class SlowExitChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.signals = [];
  }

  kill(signal) {
    this.killed = true;
    this.signals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }
}

test("fixture stop escalates when SIGTERM was sent but the child has not exited", async () => {
  const child = new SlowExitChild();
  const stop = createChildStop(child, { termTimeout: 10, killTimeout: 100 });

  const firstStop = stop();
  const repeatedStop = stop();

  assert.strictEqual(repeatedStop, firstStop, "concurrent cleanup shares one exit wait");
  await firstStop;
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("fixture stop resolves immediately only after the child has exited", async () => {
  const child = new SlowExitChild();
  child.exitCode = 0;
  const stop = createChildStop(child, { termTimeout: 10, killTimeout: 100 });

  await stop();
  assert.deepEqual(child.signals, []);
});

test("fixture requests reject when the server never sends a response", async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  const { port } = server.address();
  await assert.rejects(
    request({ port }, "/never-responds", { timeout: 20 }),
    /timed out after 20ms/
  );
});
