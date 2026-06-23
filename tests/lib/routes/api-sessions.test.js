// tests/lib/routes/api-sessions.test.js
// Tests for session CRUD endpoints.
//
// Sessions are read/written as plain JSON files on disk (APERIO_SESSION_KEY
// is not set in tests). We create a temp directory, call sessions.init() to
// point SESSIONS_DIR there, seed test files, and remove the temp dir after.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import logger from "../../../lib/helpers/logger.js";
import { init } from "../../../lib/helpers/sessions.js";
import { mountSessionRoutes } from "../../../lib/routes/api-sessions.js";

let tmpDir;
let router;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});

  tmpDir = mkdtempSync(join(tmpdir(), "aperio-sessions-test-"));
  init(tmpDir);

  router = Router();
  mountSessionRoutes(router);
});

after(() => {
  mock.restoreAll();
  // Clean up temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

// Clean all session files between tests
afterEach(() => {
  const dir = join(tmpDir, "var", "sessions");
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json")) {
        try { rmSync(join(dir, f)); } catch { /* non-fatal */ }
      }
    }
  } catch { /* dir may not exist yet */ }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Seed a single session file on disk. */
function seedSession(overrides = {}) {
  const id = overrides.id ?? "abc-123";
  const data = {
    id,
    title: "My Session",
    startedAt: "2026-06-01T00:00:00Z",
    endedAt: "2026-06-01T01:00:00Z",
    model: "claude-4-5-sonnet",
    provider: "anthropic",
    source: "web",
    pinned: false,
    summaries: [],
    messages: [],
    ...overrides,
  };
  const dir = join(tmpDir, "var", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(data), "utf8");
  return id;
}

/** Seed multiple sessions for list tests. */
function seedSessions(count = 2, startId = 0) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `sess-${startId + i}`;
    seedSession({
      id,
      title: `Session ${startId + i + 1}`,
      startedAt: new Date(2026, 5, startId + i + 1).toISOString(),
    });
    ids.push(id);
  }
  return ids;
}

function invoke(method, url, { body = {}, query = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, body, query, params,
      path: url,
      headers: {}, baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
    };
    const res = {
      _status: 200, headersSent: false, _headers: {},
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k)    { return this._headers[String(k).toLowerCase()]; },
      set()           { return this; },
      on()            { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

// =============================================================================
// GET /sessions
// =============================================================================

describe("GET /sessions", () => {
  test("returns paginated sessions list", async () => {
    seedSessions(3);
    const { status, body } = await invoke("GET", "/sessions", {
      query: { page: "1", limit: "10" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.total, 3);
    assert.strictEqual(body.sessions.length, 3);
    assert.strictEqual(body.page, 1);
    assert.strictEqual(body.pages, 1);
  });

  test("applies default page=1 and limit=10 when query params are omitted", async () => {
    seedSessions(15); // more than default limit
    const { status, body } = await invoke("GET", "/sessions", { query: {} });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.sessions.length, 10); // default limit
    assert.strictEqual(body.page, 1);
    assert.strictEqual(body.limit, 10);
  });

  test("falls back to default limit of 10 when limit is 0 (falsy short-circuit)", async () => {
    seedSessions(15);
    const { status, body } = await invoke("GET", "/sessions", { query: { limit: "0" } });
    assert.strictEqual(status, 200);
    // parseInt("0") → 0 → falsy → || 10 → 10 before Math.max(1, …) runs
    assert.strictEqual(body.limit, 10);
    assert.strictEqual(body.sessions.length, 10);
  });

  test("clamps limit to maximum 50", async () => {
    seedSessions(60);
    const { status, body } = await invoke("GET", "/sessions", { query: { limit: "100" } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.limit, 50);
    assert.strictEqual(body.sessions.length, 50);
  });

  test("accepts limit of 50", async () => {
    seedSessions(60);
    const { status, body } = await invoke("GET", "/sessions", { query: { limit: "50" } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.limit, 50);
    assert.strictEqual(body.sessions.length, 50);
  });

  test("returns sessions sorted by startedAt descending (newest first)", async () => {
    seedSession({ id: "c", title: "Newest", startedAt: "2026-01-10T00:00:00Z" });
    seedSession({ id: "b", title: "Middle", startedAt: "2026-01-05T00:00:00Z" });
    seedSession({ id: "a", title: "Oldest", startedAt: "2026-01-01T00:00:00Z" });

    const { status, body } = await invoke("GET", "/sessions", { query: { limit: "10" } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.sessions[0].title, "Newest");
    assert.strictEqual(body.sessions[1].title, "Middle");
    assert.strictEqual(body.sessions[2].title, "Oldest");
  });
});

// =============================================================================
// GET /sessions/:id
// =============================================================================

describe("GET /sessions/:id", () => {
  test("returns session for existing id", async () => {
    seedSession({ id: "abc-123", title: "My Session" });
    const { status, body } = await invoke("GET", "/sessions/abc-123");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, "abc-123");
    assert.strictEqual(body.title, "My Session");
    assert.strictEqual(body.model, "claude-4-5-sonnet");
  });

  test("returns 404 for non-existent id", async () => {
    const { status, body } = await invoke("GET", "/sessions/nonexistent");
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("Session not found"));
  });
});

// =============================================================================
// DELETE /sessions/:id
// =============================================================================

describe("DELETE /sessions/:id", () => {
  test("returns { ok: true } when deleted", async () => {
    seedSession({ id: "delete-me" });
    const { status, body } = await invoke("DELETE", "/sessions/delete-me");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });

  test("removes the session file from disk", async () => {
    seedSession({ id: "to-delete" });
    const dir = join(tmpDir, "var", "sessions");
    assert.ok(existsSync(join(dir, "to-delete.json")), "file exists before delete");

    await invoke("DELETE", "/sessions/to-delete");
    assert.ok(!existsSync(join(dir, "to-delete.json")), "file gone after delete");
  });

  test("returns 404 for non-existent id", async () => {
    const { status, body } = await invoke("DELETE", "/sessions/nonexistent");
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("Session not found"));
  });
});

// =============================================================================
// PATCH /sessions/:id/pin
// =============================================================================

describe("PATCH /sessions/:id/pin", () => {
  test("pins a session when pinned=true", async () => {
    seedSession({ id: "pin-me", pinned: false });
    const { status, body } = await invoke("PATCH", "/sessions/pin-me/pin", {
      body: { pinned: true },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.pinned, true);
  });

  test("unpins a session when pinned=false", async () => {
    seedSession({ id: "unpin-me", pinned: true });
    const { status, body } = await invoke("PATCH", "/sessions/unpin-me/pin", {
      body: { pinned: false },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.pinned, false);
  });

  test("persists pinned state to disk", async () => {
    seedSession({ id: "persist-test", pinned: false });

    await invoke("PATCH", "/sessions/persist-test/pin", { body: { pinned: true } });

    // Re-read the file directly
    const dir = join(tmpDir, "var", "sessions");
    const raw = readFileSync(join(dir, "persist-test.json"), "utf8");
    const data = JSON.parse(raw);
    assert.strictEqual(data.pinned, true);
  });

  test("handles missing body gracefully (defaults to false)", async () => {
    seedSession({ id: "no-body", pinned: false });
    // No body at all — handler defaults pinned to false
    const { status, body } = await invoke("PATCH", "/sessions/no-body/pin");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.pinned, false);
  });

  test("returns 404 for non-existent id", async () => {
    const { status, body } = await invoke("PATCH", "/sessions/nonexistent/pin", {
      body: { pinned: true },
    });
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("Session not found"));
  });
});
