import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve } from "path";

// Static analysis of server.js (the production entrypoint). This file has no
// runtime exports — it runs side effects. We verify key wiring patterns by
// reading the source text instead of importing, which would start a server.

const SRC = readFileSync(resolve(import.meta.dirname, "../../server.js"), "utf8");

// =============================================================================
// server.js — production entrypoint (static analysis)
// =============================================================================
describe("server.js entrypoint structure", () => {
  test("dynamically imports createApp from lib/server.js and delegates to it", () => {
    assert.ok(SRC.includes("createApp"), "references createApp");
    assert.match(SRC, /createApp\s*\(/, "calls createApp()");
    assert.match(SRC, /import\s*\(/, "uses dynamic import");
    assert.match(SRC, /\.\/lib\/server\.js/, "references lib/server.js");
  });

  test("loads .env via dotenv", () => {
    assert.match(SRC, /dotenv/, "references dotenv");
    assert.match(SRC, /\.env/, "references .env");
  });

  test("registers uncaughtException handler", () => {
    assert.match(SRC, /uncaughtException/, "handles uncaught exceptions");
    assert.match(SRC, /process\.on\s*\(\s*["']uncaughtException["']/, "registers on process");
  });

  test("registers unhandledRejection handler", () => {
    assert.match(SRC, /unhandledRejection/, "handles unhandled rejections");
    assert.match(SRC, /process\.on\s*\(\s*["']unhandledRejection["']/, "registers on process");
  });

  test("configures crash breaker with threshold 5", () => {
    assert.match(SRC, /createCrashBreaker/, "imports crash breaker");
    assert.match(SRC, /threshold:\s*5/, "threshold is 5");
    assert.match(SRC, /windowMs:\s*60_000/, "window is 60s");
  });

  test("checks Ollama migration on boot", () => {
    assert.match(SRC, /checkOllamaMigrationOrExit/, "calls the migration shim");
  });

  test("uses APERIO_BENCHMARK_RUN env var to skip browser", () => {
    assert.match(SRC, /APERIO_BENCHMARK_RUN/, "references benchmark env var");
  });

  test("sets isShuttingDown flag for clean shutdown", () => {
    assert.match(SRC, /isShuttingDown/, "tracks shutdown state");
  });

  test("logs the version on startup", () => {
    assert.match(SRC, /version/, "references version");
    assert.match(SRC, /Starting Aperio server/, "logs startup message");
  });

  test("delegates skipBrowser option to createApp", () => {
    assert.match(SRC, /skipBrowser/, "references skipBrowser config");
    assert.match(SRC, /process\.env\.APERIO_BENCHMARK_RUN/, "reads from env");
  });

  test("loads package.json version via createRequire", () => {
    assert.match(SRC, /createRequire/, "uses createRequire for CommonJS interop");
    assert.match(SRC, /package\.json/, "reads package.json");
  });

  test("only loads real .env file, not .env.example", () => {
    // The code should resolve .env (not .env.example) or check existence first
    assert.ok(
      SRC.includes('".env"') || SRC.includes("'.env'"),
      "references .env in the import/resolve path",
    );
  });

  test("tightens .env file permissions to 600 on startup", () => {
    assert.match(SRC, /chmodSync/, "chmod is called on .env");
    assert.match(SRC, /ENV-01/, "has the ENV-01 sentinel comment");
    assert.match(SRC, /0o600/, "permission is 600");
  });
});
