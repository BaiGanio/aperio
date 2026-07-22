// tests/unit/real-app/char.test.js
//
// CHARACTERIZATION TESTS (post-extraction)
// ========================================
// These tests now document the NEW architecture after extracting the
// composition root from server.js into lib/server.js.
//
// Read the companion plan for context:
//   trash/plans/real-app-e2e/real-app-e2e.md
//   trash/plans/real-app-e2e/real-app-e2e-tests.md

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");  // tests/unit/real-app/../../../ = repo root
const SERVER = resolve(REPO_ROOT, "server.js");
const LIBSERVER = resolve(REPO_ROOT, "lib/server.js");

// ─── CHAR-1: Port-0 readiness (FIXED) ────────────────────────────────────────

test("CHAR-1: lib/server.js uses address().port for accurate URL", () => {
  const src = readFileSync(LIBSERVER, "utf8");

  // The listen callback now uses httpServer.address().port instead of the
  // configured PORT, so PORT=0 works correctly.
  assert.ok(
    src.includes("actualPort = httpServer.address().port"),
    "lib/server.js extracts the actual listening port from address()"
  );

  // The URL is constructed from actualPort, not the configured PORT
  assert.ok(
    src.includes("const url = `${scheme}://${HOST}:${actualPort}`"),
    "URL uses the actual OS-assigned port"
  );
});

// ─── CHAR-2: Path isolation (MOVED) ──────────────────────────────────────────

test("CHAR-2: lib/server.js holds hardcoded mutable paths", () => {
  const src = readFileSync(LIBSERVER, "utf8");

  // The mutable runtime paths are in lib/server.js (not server.js).
  // Runtime var/ data (uploads, scratch, roundtables) anchors to
  // process.cwd(), matching the writers, the path-guard floor, and the
  // SQLite default (#282). The bootstrap lock and agent artifacts use the
  // caller-provided runtime root so isolated fixtures cannot share state.
  const hardcodedPaths = [
    'resolve(RUNTIME_ROOT, "var/bootstrap.lock")',
    'resolve(process.cwd(), "var/uploads")',
    'resolve(process.cwd(), "var/scratch")',
    'resolve(process.cwd(), "var/roundtables")',
  ];

  for (const p of hardcodedPaths) {
    assert.ok(src.includes(p), `Path is in lib/server.js: ${p}`);
  }

  // server.js should NOT have these paths anymore
  const serverSrc = readFileSync(SERVER, "utf8");
  for (const p of hardcodedPaths) {
    assert.ok(!serverSrc.includes(p), `server.js does NOT contain ${p}`);
  }
});

// ─── CHAR-3: Route structure (MOVED to lib/server.js) ────────────────────────

test("CHAR-3: API router is mounted through createApp (lib/server.js)", () => {
  const src = readFileSync(LIBSERVER, "utf8");
  assert.ok(
    src.includes("apiRouter"),
    "lib/server.js imports and mounts apiRouter"
  );

  const serverSrc = readFileSync(SERVER, "utf8");
  assert.ok(
    !serverSrc.includes("apiRouter"),
    "server.js does NOT import apiRouter"
  );
  assert.ok(
    !serverSrc.includes('"/api"'),
    "server.js does NOT mount API routes"
  );
});

// ─── CHAR-4: turn_complete is the stable terminal event ──────────────────────

test("CHAR-4: turn_complete is the stable terminal event", () => {
  const wsHandler = readFileSync(
    resolve(REPO_ROOT, "lib/emitters/handlers/wsHandler.js"),
    "utf8"
  );
  assert.ok(
    wsHandler.includes("turn_complete"),
    "wsHandler emits turn_complete"
  );
});

// ─── CHAR-5: server.js is now a thin entrypoint ──────────────────────────────

test("CHAR-5: server.js is a thin production entrypoint (< 100 lines)", () => {
  const src = readFileSync(SERVER, "utf8");
  const lines = src.split("\n").length;
  assert.ok(lines < 100, `server.js has ${lines} lines — it is thin`);

  // Verify the thin entrypoint structure
  assert.ok(src.includes("createCrashBreaker"), "server.js has crash breaker");
  assert.ok(src.includes("dotenv.config"), "server.js loads .env");
  assert.ok(src.includes("createApp"), "server.js delegates to createApp");
  assert.ok(src.includes("__dirname"), "server.js passes __dirname as root");

  // These major sections should NOT be in server.js anymore
  assert.ok(!src.includes("helmet"), "server.js does NOT import helmet");
  assert.ok(!src.includes("WebSocketServer"), "server.js does NOT import WebSocketServer");
  assert.ok(!src.includes("function bootApp"), "server.js does NOT define bootApp");
  assert.ok(!src.includes("function gracefulShutdown"), "server.js does NOT define gracefulShutdown");
  assert.ok(!src.includes("function openBrowser"), "server.js does NOT define openBrowser");
  assert.ok(!src.includes("parseRoundtableAgents"), "server.js does NOT define parseRoundtableAgents");
  assert.ok(!src.includes("const app = express()"), "server.js does NOT create Express app");
});

// ─── CHAR-6: bootstrap.js creates ./var/ relative to CWD ─────────────────────

test("CHAR-6: bootstrap.js uses CWD-relative path for ./var/", () => {
  const src = readFileSync(resolve(REPO_ROOT, "bootstrap.js"), "utf8");

  assert.ok(
    src.includes("mkdirSync('./var'"),
    "bootstrap.js creates ./var/ relative to CWD"
  );
  assert.ok(
    !src.includes("__dirname"),
    "bootstrap.js does NOT use __dirname for its var/ path"
  );
});
