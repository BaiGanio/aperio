// tests/e2e/fixtures/real-app-server.js
//
// Child-process server fixture that imports the production composition root
// (lib/server.js) with test-friendly options. Prints a machine-readable
// READY line so the test helper can find the port and proceed.
//
// Used by tests/e2e/helpers/real-app-helper.js → startRealApp()
//
// The app skips bootApp (no agent, no embeddings, no WebSocket chat) so it
// starts quickly and serves the HTTP surface only — enough to test middleware,
// routes, static mounts, security guards, path isolation, and shutdown.

import { mkdirSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");  // tests/e2e/fixtures/../../.. = repo root

// Ensure the runtime root exists. All mutable paths will be created here
// when DB_BACKEND, SQLITE_PATH, and CWD point to it.
if (!process.env.APERIO_E2E_ROOT) {
  throw new Error("APERIO_E2E_ROOT is required; real-app fixtures must run in isolated scratch storage");
}
const RUNTIME_ROOT = resolve(process.env.APERIO_E2E_ROOT);
mkdirSync(RUNTIME_ROOT, { recursive: true });

// Print diagnostic info for the test harness
process.stdout.write(JSON.stringify({
  type: "booting",
  runtimeRoot: RUNTIME_ROOT,
  cwd: process.cwd(),
  nodeVersion: process.version,
}) + "\n");

// Import the production composition root
const { createApp } = await import(resolve(REPO_ROOT, "lib/server.js"));

try {
  // APERIO_E2E_SKIP_BOOT=0 runs the full bootApp (opens DB and mounts API).
  // Persistence/WebSocket suites pair it with APERIO_E2E_INJECT_AGENT=1 so
  // their readiness does not depend on a real MCP/model child.
  // Default: skip boot (lightweight HTTP-only for middleware tests).
  const skipBoot = process.env.APERIO_E2E_SKIP_BOOT !== "0";

  // APERIO_E2E_INJECT_AGENT=1 creates a contract-faithful test-agent stub
  // and injects it into createApp, so bootApp runs fully (DB + API + WebSocket)
  // without needing a real model provider.
  let injectAgent = null;
  if (process.env.APERIO_E2E_INJECT_AGENT === "1") {
    const { createTestAgent } = await import(resolve(REPO_ROOT, "tests/e2e/helpers/test-agent.js"));
    injectAgent = createTestAgent();
  }

  const app = await createApp({
    root: REPO_ROOT,
    skipBoot,
    skipBrowser: true,
    autoListen: false,
    injectAgent,
  });

  // Start listening. When skipBoot=false, we also call bootAppOnce() to mount
  // the API router (memories, settings, data export).
  app.httpServer.listen(0, "127.0.0.1", async () => {
    const actualPort = app.httpServer.address().port;

    if (!skipBoot) {
      // bootAppOnce is idempotent — safe to call even if previously tried
      try { await app.bootAppOnce(); } catch { /* agent failure expected */ }
    }

    process.stdout.write(JSON.stringify({
      type: "ready",
      port: actualPort,
      pid: process.pid,
      runtimeRoot: RUNTIME_ROOT,
    }) + "\n");
  });

  // Handle SIGTERM/SIGINT for test cleanup. For tests, a simple force exit
  // is sufficient — the OS cleans up file handles. Add a brief close attempt
  // for the HTTP server so port 0 (OS-assigned) is released promptly, but
  // don't block the whole teardown.
  process.on("SIGTERM", () => {
    try { app.httpServer.close(); } catch { /* non-fatal */ }
    process.exit(0);
  });
  process.on("SIGINT", () => {
    try { app.httpServer.close(); } catch { /* non-fatal */ }
    process.exit(0);
  });
} catch (err) {
  process.stderr.write(JSON.stringify({
    type: "error",
    message: err.message,
    stack: err.stack,
  }) + "\n");
  process.exit(1);
}
