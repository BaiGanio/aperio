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
const RUNTIME_ROOT = process.env.APERIO_E2E_ROOT || resolve(REPO_ROOT, "var", "e2e-scratch");
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
  const app = await createApp({
    root: REPO_ROOT,
    // IMPORTANT: skipBoot = true means the app only serves its HTTP surface
    // (Express + middleware + static files + setup routes). No agent, no
    // embeddings, no WebSocket, no llama.cpp, no background workers.
    skipBoot: true,
    skipBrowser: true,
    autoListen: false,  // We'll start listening ourselves
  });

  // Start listening on the configured port (or OS-assigned if PORT=0)
  app.httpServer.listen(0, "127.0.0.1", () => {
    const actualPort = app.httpServer.address().port;
    process.stdout.write(JSON.stringify({
      type: "ready",
      port: actualPort,
      pid: process.pid,
      runtimeRoot: RUNTIME_ROOT,
    }) + "\n");

    // Flush stdout so the test harness sees the ready line immediately
    process.stdout.on("drain", () => {});
  });

  // Handle SIGTERM for graceful shutdown in tests
  process.on("SIGTERM", async () => {
    await app.httpServer.close();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await app.httpServer.close();
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
