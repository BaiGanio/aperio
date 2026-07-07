// tests/lib/routes/api.test.js
//
// Routes that depend on module-level imports from sister modules
// ("sessions", "codegraph", "capabilities", "wiki", "paths") are tested
// in separate files (api.sessions.test.js, etc.) because those imports
// must be mocked via createRequire + mock.method BEFORE api.js is first
// imported.  This file tests routes whose deps can be injected through
// the makeRouter({ agent, store, watchdog }) pattern.

import { test, describe, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { apiRouter } from "../../../lib/routes/api.js";
import logger from "../../../lib/helpers/logger.js";

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});
});

after(() => mock.restoreAll());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function invoke(router, method, url, { body = {}, query = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, path: url, body, query, params,
      headers: {}, baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
    };
    const res = {
      _status: 200, headersSent: false, _headers: {},
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      // Shims so real Express middleware (e.g. express-rate-limit) can run.
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k)    { return this._headers[String(k).toLowerCase()]; },
      set()           { return this; },
      on()            { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

function makeRouter({ agent = {}, store = {}, watchdog = {} } = {}) {
  return apiRouter({
    agent: {
      version:  "1.2.3",
      provider: { name: "anthropic", model: "claude-haiku-4-5" },
      setProvider: () => {},
      getSkillDoc: () => null,
      ...agent,
    },
    store: { listAll: async () => [], ...store },
    watchdog: { heartbeat: () => {}, ...watchdog },
  });
}

function makeInterruptStore(rows = []) {
  const map = new Map(rows.map(row => [row.id, JSON.parse(JSON.stringify(row))]));
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  return {
    async getAgentInterrupt(id) {
      return clone(map.get(id) ?? null);
    },
    async listAgentInterrupts({ status = "pending", limit = 50 } = {}) {
      return [...map.values()]
        .filter(row => !status || row.status === status)
        .slice(0, limit)
        .map(clone);
    },
    async expireAgentInterrupts() {
      return 0;
    },
    async updateAgentInterruptStatus(id, status) {
      const row = map.get(id);
      if (!row) return null;
      row.status = status;
      return clone(row);
    },
    async decideAgentInterrupt(id, { decision, status, decisionPayload = null, now = new Date().toISOString() }) {
      const row = map.get(id);
      if (!row || row.status !== "pending") return null;
      row.decision = decision;
      row.decision_payload = clone(decisionPayload);
      row.status = status;
      row.decided_at = now;
      row.updated_at = now;
      return clone(row);
    },
  };
}

// =============================================================================
// GET /version
// =============================================================================

describe("GET /version", () => {
  test("returns the agent version", async () => {
    const router = makeRouter({ agent: { version: "2.0.0" } });
    const { status, body } = await invoke(router, "GET", "/version");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.version, "2.0.0");
  });
});

// =============================================================================
// GET /provider
// =============================================================================

describe("GET /provider", () => {
  test("returns provider name and model", async () => {
    const router = makeRouter({
      agent: { provider: { name: "ollama", model: "llama3.1" } },
    });
    const { status, body } = await invoke(router, "GET", "/provider");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.provider, "ollama");
    assert.strictEqual(body.model, "llama3.1");
  });
});

// =============================================================================
// GET /config
// =============================================================================

describe("GET /config", () => {
  test("defaults to sqlite when DB_BACKEND is not set", async () => {
    delete process.env.DB_BACKEND;
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/config");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.backend, "sqlite");
  });

  test("returns the value of DB_BACKEND env var", async (t) => {
    process.env.DB_BACKEND = "postgres";
    t.after(() => delete process.env.DB_BACKEND);
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/config");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.backend, "postgres");
  });
});

// =============================================================================
// GET /heartbeat
// =============================================================================

describe("GET /heartbeat", () => {
  test("calls watchdog.heartbeat() and returns ok:true", async () => {
    let called = false;
    const router = makeRouter({ watchdog: { heartbeat: () => { called = true; } } });
    const before = Date.now();
    const { status, body } = await invoke(router, "GET", "/heartbeat");
    const after  = Date.now();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.ok(typeof body.ts === "number");
    assert.ok(body.ts >= before && body.ts <= after);
    assert.ok(called);
  });
});

describe("durable interrupt API", () => {
  const pendingRow = {
    id: "wr_test01",
    session_id: "session-a",
    run_id: null,
    tool_name: "write_file",
    canonical_arguments: { path: "/tmp/example.txt", content: "hello", targetDigest: null },
    protected_payload_ref: null,
    digest: "sha256:abc",
    allowed_decisions: ["approve", "edit", "reject", "respond"],
    decision: null,
    decision_payload: null,
    status: "pending",
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    decided_at: null,
    claimed_at: null,
    completed_at: null,
    expires_at: null,
  };

  test("GET /interrupts returns redacted pending descriptors in API shape", async () => {
    const router = makeRouter({ store: makeInterruptStore([pendingRow]) });
    const { status, body } = await invoke(router, "GET", "/interrupts");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.interrupts.length, 1);
    assert.deepStrictEqual(body.interrupts[0], {
      id: "wr_test01",
      sessionId: "session-a",
      runId: null,
      tool: "write_file",
      status: "pending",
      decision: null,
      allowedDecisions: ["approve", "edit", "reject", "respond"],
      arguments: { path: "/tmp/example.txt", content: "hello", targetDigest: null },
      decisionPayload: null,
      digest: "sha256:abc",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      decidedAt: null,
      claimedAt: null,
      completedAt: null,
      expiresAt: null,
    });
  });

  test("POST /interrupts/:id/decision records reject decisions", async () => {
    const router = makeRouter({ store: makeInterruptStore([pendingRow]) });
    const { status, body } = await invoke(router, "POST", "/interrupts/wr_test01/decision", {
      body: { decision: "reject", response: "wrong target" },
      params: { id: "wr_test01" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.interrupt.status, "rejected");
    assert.strictEqual(body.interrupt.decision, "reject");
    assert.strictEqual(body.result, null);
  });

  test("POST /interrupts/:id/decision rejects conflicting replays", async () => {
    const row = { ...pendingRow, status: "rejected", decision: "reject", decision_payload: null };
    const router = makeRouter({ store: makeInterruptStore([row]) });
    const { status, body } = await invoke(router, "POST", "/interrupts/wr_test01/decision", {
      body: { decision: "respond", response: "do not run" },
      params: { id: "wr_test01" },
    });
    assert.strictEqual(status, 409);
    assert.match(body.error, /already been decided/);
  });
});

// =============================================================================
// GET /config/client
// =============================================================================

describe("GET /config/client", () => {
  test("defaults heartbeatIntervalSeconds to 60", async () => {
    delete process.env.HEARTBEAT_INTERVAL_SECONDS;
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/config/client");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.heartbeatIntervalSeconds, 60);
  });

  test("respects HEARTBEAT_INTERVAL_SECONDS env var", async (t) => {
    process.env.HEARTBEAT_INTERVAL_SECONDS = "30";
    t.after(() => delete process.env.HEARTBEAT_INTERVAL_SECONDS);
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/config/client");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.heartbeatIntervalSeconds, 30);
  });
});

// =============================================================================
// GET /memories
// =============================================================================

describe("GET /memories", () => {
  test("returns records from the store as { raw }", async () => {
    const records = [{ id: "1", title: "test", content: "hello" }];
    const router = makeRouter({ store: { listAll: async () => records } });
    const { status, body } = await invoke(router, "GET", "/memories");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.raw, records);
  });

  test("returns empty array when the store has no records", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/memories");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.raw, []);
  });

  test("returns 500 when the store query throws", async () => {
    const router = makeRouter({
      store: { listAll: async () => { throw new Error("db unreachable"); } },
    });
    const { status, body } = await invoke(router, "GET", "/memories");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db unreachable"));
  });
});

// =============================================================================
// DB browser
// =============================================================================

describe("GET /db/tables", () => {
  test("returns table metadata from the store", async () => {
    const tables = [{ name: "memories", label: "Memories", count: 67 }];
    const router = makeRouter({ store: { listTables: async () => tables } });
    const { status, body } = await invoke(router, "GET", "/db/tables");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.tables, tables);
  });
});

describe("GET /db/table/:name", () => {
  test("returns columns and rows for a whitelisted table", async () => {
    const data = { columns: ["id", "title"], rows: [{ id: "1", title: "hi" }] };
    const router = makeRouter({ store: { readTable: async () => data } });
    const { status, body } = await invoke(router, "GET", "/db/table/memories", {
      params: { name: "memories" },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, data);
  });

  test("returns 400 for a non-whitelisted table", async () => {
    const router = makeRouter({
      store: { readTable: async (n) => { throw new Error(`Unknown table: ${n}`); } },
    });
    const { status, body } = await invoke(router, "GET", "/db/table/memories_fts", {
      params: { name: "memories_fts" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("Unknown table"));
  });
});

// =============================================================================
// Settings
// =============================================================================

describe("settings routes", () => {
  function settingsRouter(initial = {}) {
    const data = { ...initial };
    return makeRouter({
      store: {
        getSettings:   async () => ({ ...data }),
        getSetting:    async (k) => (k in data ? data[k] : null),
        setSetting:    async (k, v) => { data[k] = v; return v; },
        deleteSetting: async (k) => { const had = k in data; delete data[k]; return had; },
      },
    });
  }

  test("GET /settings returns the full map", async () => {
    const router = settingsRouter({ theme: "dark", sound: false });
    const { status, body } = await invoke(router, "GET", "/settings");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { theme: "dark", sound: false });
  });

  test("GET /settings/:key returns value:null for an unset key", async () => {
    const router = settingsRouter();
    const { status, body } = await invoke(router, "GET", "/settings/theme");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { key: "theme", value: null });
  });

  test("PUT /settings/:key upserts and echoes the value", async () => {
    const router = settingsRouter();
    const { status, body } = await invoke(router, "PUT", "/settings/theme", { body: { value: "aurora" } });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { ok: true, key: "theme", value: "aurora" });
  });

  test("PUT /settings/:key accepts falsey values (false)", async () => {
    const router = settingsRouter();
    const { status, body } = await invoke(router, "PUT", "/settings/sound", { body: { value: false } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.value, false);
  });

  test("PUT /settings/:key rejects a body with no value field", async () => {
    const router = settingsRouter();
    const { status, body } = await invoke(router, "PUT", "/settings/theme", { body: {} });
    assert.strictEqual(status, 400);
    assert.ok(/value/.test(body.error));
  });

  test("DELETE /settings/:key returns 404 when the key is absent", async () => {
    const router = settingsRouter();
    const { status } = await invoke(router, "DELETE", "/settings/theme");
    assert.strictEqual(status, 404);
  });

  test("DELETE /settings/:key returns ok when the key existed", async () => {
    const router = settingsRouter({ theme: "dark" });
    const { status, body } = await invoke(router, "DELETE", "/settings/theme");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });
});

// =============================================================================
// GET /skill
// =============================================================================

describe("GET /skill", () => {
  test("returns 404 when skill is not found", async () => {
    const router = makeRouter({ agent: { getSkillDoc: () => null } });
    const { status, body } = await invoke(router, "GET", "/skill", { query: { name: "missing" } });
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error, "skill not found");
  });

  test("returns the skill doc when found", async () => {
    const doc = { name: "test-skill", body: "# Skill\n\nInstructions" };
    const router = makeRouter({ agent: { getSkillDoc: (name) => name === "test-skill" ? doc : null } });
    const { status, body } = await invoke(router, "GET", "/skill", { query: { name: "test-skill" } });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, doc);
  });
});

// =============================================================================
// PUT /provider
// =============================================================================

describe("PUT /provider", () => {
  test("returns 400 when provider name is missing", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "PUT", "/provider", { body: { model: "x" } });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("provider"));
  });

  test("returns 400 when model is missing", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "PUT", "/provider", { body: { provider: "ollama" } });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("model"));
  });

  test("calls agent.setProvider and returns ok on success", async () => {
    let captured = null;
    const router = makeRouter({ agent: { setProvider: (p) => { captured = p; } } });
    const { status, body } = await invoke(router, "PUT", "/provider", {
      body: { provider: "deepseek", model: "deepseek-v4-flash" },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { ok: true, provider: "deepseek", model: "deepseek-v4-flash" });
    assert.deepStrictEqual(captured, { name: "deepseek", model: "deepseek-v4-flash" });
  });

  test("returns 500 when agent.setProvider throws", async () => {
    const router = makeRouter({
      agent: { setProvider: () => { throw new Error("unknown provider"); } },
    });
    const { status, body } = await invoke(router, "PUT", "/provider", {
      body: { provider: "unknown", model: "x" },
    });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("unknown provider"));
  });
});

// =============================================================================
// GET /metrics
// =============================================================================

describe("GET /metrics", () => {
  test("returns the cached metrics object with numeric fields", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/metrics");
    assert.strictEqual(status, 200);
    assert.ok(typeof body.rss === "number");
    assert.ok(typeof body.heap === "number");
    assert.ok(typeof body.cpu === "number");
    assert.ok(typeof body.embedding_queue_size === "number");
  });
});

// =============================================================================
// Memory pin / expiry
// =============================================================================

describe("PATCH /memories/:id/pin", () => {
  test("pins a memory", async () => {
    const router = makeRouter({ store: { setPin: async () => true } });
    const { status, body } = await invoke(router, "PATCH", "/memories/42/pin", {
      params: { id: "42" }, body: { pinned: true },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.pinned, true);
  });

  test("unpins a memory", async () => {
    const router = makeRouter({ store: { setPin: async () => true } });
    const { status, body } = await invoke(router, "PATCH", "/memories/42/pin", {
      params: { id: "42" }, body: { pinned: false },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.pinned, false);
  });

  test("returns 404 when memory not found", async () => {
    const router = makeRouter({ store: { setPin: async () => false } });
    const { status, body } = await invoke(router, "PATCH", "/memories/99/pin", {
      params: { id: "99" }, body: { pinned: true },
    });
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error, "Memory not found");
  });

  test("returns 500 on store error", async () => {
    const router = makeRouter({ store: { setPin: async () => { throw new Error("db error"); } } });
    const { status, body } = await invoke(router, "PATCH", "/memories/42/pin", {
      params: { id: "42" }, body: { pinned: true },
    });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db error"));
  });
});

describe("PATCH /memories/:id/expiry", () => {
  test("sets an expiry date", async () => {
    const router = makeRouter({ store: { setExpiry: async () => true } });
    const { status, body } = await invoke(router, "PATCH", "/memories/42/expiry", {
      params: { id: "42" }, body: { expires_at: "2026-12-31" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });

  test("clears an expiry date when expires_at is null", async () => {
    let captured = null;
    const router = makeRouter({ store: { setExpiry: async (id, val) => { captured = val; return true; } } });
    const { status } = await invoke(router, "PATCH", "/memories/42/expiry", {
      params: { id: "42" }, body: { expires_at: null },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(captured, null);
  });

  test("returns 404 when memory not found", async () => {
    const router = makeRouter({ store: { setExpiry: async () => false } });
    const { status, body } = await invoke(router, "PATCH", "/memories/99/expiry", {
      params: { id: "99" }, body: { expires_at: "2026-12-31" },
    });
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error, "Memory not found");
  });
});

// =============================================================================
// GET /models — uses fetch + env vars
// =============================================================================

describe("GET /models", () => {
  function modelsRouter({ fetchImpl, envOverrides = {} } = {}) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl ?? (async () => ({
      ok: true,
      json: async () => ({ models: [] }),
    }));
    const saved = {};
    for (const [k, v] of Object.entries(envOverrides)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const router = makeRouter();
    return { router, cleanup: () => {
      globalThis.fetch = origFetch;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }};
  }

  test("returns ollama models from fetch", async () => {
    const { router, cleanup } = modelsRouter({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ models: [{ name: "llama3.1" }, { name: "qwen2.5" }] }),
      }),
    });
    const { body } = await invoke(router, "GET", "/models");
    cleanup();
    assert.deepStrictEqual(body.providers.ollama, ["llama3.1", "qwen2.5"]);
  });

  test("includes cloud providers when API keys are set", async () => {
    const { router, cleanup } = modelsRouter({
      envOverrides: {
        ANTHROPIC_API_KEY: "sk-ant-xxx",
        DEEPSEEK_API_KEY: "sk-ds-xxx",
        GEMINI_API_KEY:   "sk-gem-xxx",
      },
    });
    const { body } = await invoke(router, "GET", "/models");
    cleanup();
    assert.ok(body.providers.anthropic.length > 0);
    assert.ok(body.providers.deepseek.length > 0);
    // Gemini is intentionally hidden from the model picker (re-enable in lib/routes/api.js).
    assert.strictEqual(body.providers.gemini, undefined);
  });

  test("handles ollama fetch failure gracefully", async () => {
    const { router, cleanup } = modelsRouter({
      fetchImpl: async () => { throw new Error("connection refused"); },
    });
    const { body } = await invoke(router, "GET", "/models");
    cleanup();
    assert.strictEqual(body.providers.ollama, undefined);
  });

  test("returns current provider and model in top-level fields", async () => {
    const { router, cleanup } = modelsRouter();
    const { body } = await invoke(router, "GET", "/models");
    cleanup();
    assert.strictEqual(body.provider, "anthropic");
    assert.strictEqual(body.model, "claude-haiku-4-5");
  });
});

// =============================================================================
// POST /memories/import
// =============================================================================

describe("POST /memories/import", () => {
  function importRouter({ storeOverrides = {} } = {}) {
    return makeRouter({
      store: {
        bulkInsert:            async () => {},
        listWithoutEmbeddings: async () => [],
        setEmbedding:          async () => {},
        ...storeOverrides,
      },
    });
  }

  test("returns 400 when memories array is missing", async () => {
    const router = importRouter();
    const { status, body } = await invoke(router, "POST", "/memories/import", { body: {} });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("memories array"));
  });

  test("returns 400 when memories array is empty", async () => {
    const router = importRouter();
    const { status, body } = await invoke(router, "POST", "/memories/import", { body: { memories: [] } });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("memories array"));
  });

  test("returns 413 when too many memories", async () => {
    const router = importRouter();
    const memories = Array.from({ length: 501 }, (_, i) => ({ title: `m${i}`, content: "x" }));
    const { status, body } = await invoke(router, "POST", "/memories/import", { body: { memories } });
    assert.strictEqual(status, 413);
    assert.ok(body.error.includes("500"));
  });

  test("imports valid memories and reports errors for invalid ones", async () => {
    const router = importRouter();
    const memories = [
      { title: "good",     content: "valid memory" },
      { title: "",         content: "missing title" },
      { content: "no title key" },
    ];
    const { status, body } = await invoke(router, "POST", "/memories/import", { body: { memories } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.imported, 1);
    assert.strictEqual(body.errors.length, 2);
  });

  test("rejects title over 200 chars", async () => {
    const router = importRouter();
    const memories = [{ title: "x".repeat(201), content: "body" }];
    const { body } = await invoke(router, "POST", "/memories/import", { body: { memories } });
    assert.strictEqual(body.imported, 0);
    assert.ok(body.errors[0].reason.includes("200"));
  });

  test("rejects content over 10,000 chars", async () => {
    const router = importRouter();
    const memories = [{ title: "valid", content: "x".repeat(10_001) }];
    const { body } = await invoke(router, "POST", "/memories/import", { body: { memories } });
    assert.strictEqual(body.imported, 0);
    assert.ok(body.errors[0].reason.includes("10 000"));
  });

  test("defaults type to 'fact' for unknown types", async () => {
    let inserted = null;
    const router = importRouter({ storeOverrides: {
      bulkInsert: async (rows) => { inserted = rows; },
    }});
    const { body } = await invoke(router, "POST", "/memories/import", {
      body: { memories: [{ title: "test", content: "body", type: "unknown_type" }] },
    });
    assert.strictEqual(inserted[0].type, "fact");
  });

  test("clamps importance to 1-5 range", async () => {
    let inserted = null;
    const router = importRouter({ storeOverrides: {
      bulkInsert: async (rows) => { inserted = rows; },
    }});
    const memories = [
      { title: "t1", content: "c", importance: -5 },
      { title: "t2", content: "c", importance: 100 },
      { title: "t3", content: "c", importance: 3 },
    ];
    await invoke(router, "POST", "/memories/import", { body: { memories } });
    assert.strictEqual(inserted[0].importance, 1);
    assert.strictEqual(inserted[1].importance, 5);
    assert.strictEqual(inserted[2].importance, 3);
  });

  test("reports 500 on db error", async () => {
    const router = importRouter({ storeOverrides: {
      bulkInsert: async () => { throw new Error("db write failed"); },
    }});
    const { status, body } = await invoke(router, "POST", "/memories/import", {
      body: { memories: [{ title: "test", content: "body" }] },
    });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db write failed"));
  });
});

// =============================================================================
// Background agents — /api/agents CRUD + history (Phase 4)
// =============================================================================
describe("GET /agents", () => {
  test("lists jobs each with its most recent run", async () => {
    const router = makeRouter({ store: {
      listAgentJobs: async () => [{ id: "a", enabled: true }, { id: "b", enabled: false }],
      listAgentRuns: async (id) => id === "a" ? [{ verdict: "ok" }] : [],
    } });
    const { status, body } = await invoke(router, "GET", "/agents");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.jobs.length, 2);
    assert.deepStrictEqual(body.jobs[0].lastRun, { verdict: "ok" });
    assert.strictEqual(body.jobs[1].lastRun, null);
    assert.strictEqual(typeof body.enabled, "boolean");
  });

  test("returns 500 when the store throws", async () => {
    const router = makeRouter({ store: { listAgentJobs: async () => { throw new Error("db down"); } } });
    const { status } = await invoke(router, "GET", "/agents");
    assert.strictEqual(status, 500);
  });
});

describe("GET /agents/:id", () => {
  test("returns the job", async () => {
    const router = makeRouter({ store: { getAgentJob: async () => ({ id: "a", prompt: "x" }) } });
    const { status, body } = await invoke(router, "GET", "/agents/a");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, "a");
  });

  test("404 when missing", async () => {
    const router = makeRouter({ store: { getAgentJob: async () => null } });
    const { status } = await invoke(router, "GET", "/agents/nope");
    assert.strictEqual(status, 404);
  });
});

describe("GET /agents/:id/runs", () => {
  test("returns run history", async () => {
    const router = makeRouter({ store: {
      listAgentRuns: async (id, limit) => [{ id: 42, verdict: "ok", limit }],
      listAgentInterrupts: async ({ runId, status, includeExpired }) => {
        assert.strictEqual(runId, "42");
        assert.strictEqual(status, null);
        assert.strictEqual(includeExpired, true);
        return [{
          id: "db_done1",
          tool_name: "db_execute",
          status: "executed",
          decision: "approve",
          updated_at: "2026-07-07T00:00:00.000Z",
        }];
      },
    } });
    const { status, body } = await invoke(router, "GET", "/agents/a/runs", { query: { limit: "5" } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.runs[0].limit, 5);
    assert.deepStrictEqual(body.runs[0].interrupts, [{
      id: "db_done1",
      tool: "db_execute",
      status: "executed",
      decision: "approve",
      updated_at: "2026-07-07T00:00:00.000Z",
    }]);
  });
});

describe("DELETE /agents/:id/runs/:runId", () => {
  test("204-style ok when a run is removed", async () => {
    let deletedId = null;
    const router = makeRouter({ store: { deleteAgentRun: async (id) => { deletedId = id; return true; } } });
    const { status, body } = await invoke(router, "DELETE", "/agents/a/runs/42");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(deletedId, 42); // coerced to a number
  });

  test("404 when the run does not exist", async () => {
    const router = makeRouter({ store: { deleteAgentRun: async () => false } });
    const { status } = await invoke(router, "DELETE", "/agents/a/runs/999");
    assert.strictEqual(status, 404);
  });
});

describe("POST /agents", () => {
  test("creates a new job", async () => {
    let saved = null;
    const router = makeRouter({ store: {
      getAgentJob: async () => null,
      upsertAgentJob: async (j) => { saved = j; return j; },
    } });
    const { status, body } = await invoke(router, "POST", "/agents", {
      body: { id: "new", prompt: "do a thing" },
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(body.id, "new");
    assert.strictEqual(saved.prompt, "do a thing");
    assert.strictEqual(saved.spec.id, "background.new");
  });

  test("creates legacy provider jobs as AgentSpec-backed definitions", async () => {
    let saved = null;
    const router = makeRouter({ store: {
      getAgentJob: async () => null,
      upsertAgentJob: async (j) => { saved = j; return j; },
    } });
    const { status } = await invoke(router, "POST", "/agents", {
      body: {
        id: "legacy",
        prompt: "do a thing",
        provider: { name: "deepseek", model: "deepseek-chat" },
        persona: "reviewer",
        character: "security",
      },
    });
    assert.strictEqual(status, 201);
    assert.deepStrictEqual(saved.spec.provider, { name: "deepseek", model: "deepseek-chat" });
    assert.strictEqual(saved.spec.identity.persona, "reviewer");
    assert.strictEqual(saved.spec.character, "security");
    assert.strictEqual(Object.hasOwn(saved, "provider"), false);
  });

  test("400 for invalid job spec", async () => {
    const router = makeRouter({ store: {
      getAgentJob: async () => null,
      upsertAgentJob: async (j) => j,
    } });
    const { status, body } = await invoke(router, "POST", "/agents", {
      body: { id: "bad", prompt: "x", spec: { id: "bad", provider: { name: "unknown" } } },
    });
    assert.strictEqual(status, 400);
    assert.match(body.error, /Invalid AgentSpec/);
  });

  test("400 without an id", async () => {
    const router = makeRouter();
    const { status } = await invoke(router, "POST", "/agents", { body: { prompt: "x" } });
    assert.strictEqual(status, 400);
  });

  test("400 without steps or prompt", async () => {
    const router = makeRouter();
    const { status } = await invoke(router, "POST", "/agents", { body: { id: "bad" } });
    assert.strictEqual(status, 400);
  });

  test("409 when the id already exists", async () => {
    const router = makeRouter({ store: { getAgentJob: async () => ({ id: "dup" }) } });
    const { status } = await invoke(router, "POST", "/agents", { body: { id: "dup", prompt: "x" } });
    assert.strictEqual(status, 409);
  });
});

describe("PUT /agents/:id", () => {
  test("updates an existing job", async () => {
    const router = makeRouter({ store: {
      getAgentJob: async () => ({ id: "a" }),
      upsertAgentJob: async (j) => j,
    } });
    const { status, body } = await invoke(router, "PUT", "/agents/a", { body: { prompt: "updated" } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, "a");        // id comes from the path, not the body
    assert.strictEqual(body.prompt, "updated");
    assert.strictEqual(body.spec.id, "background.a");
  });

  test("404 when the job does not exist", async () => {
    const router = makeRouter({ store: { getAgentJob: async () => null } });
    const { status } = await invoke(router, "PUT", "/agents/nope", { body: { prompt: "x" } });
    assert.strictEqual(status, 404);
  });
});

describe("DELETE /agents/:id", () => {
  test("deletes a job", async () => {
    const router = makeRouter({ store: { deleteAgentJob: async () => true } });
    const { status, body } = await invoke(router, "DELETE", "/agents/a");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });

  test("404 when nothing was deleted", async () => {
    const router = makeRouter({ store: { deleteAgentJob: async () => false } });
    const { status } = await invoke(router, "DELETE", "/agents/nope");
    assert.strictEqual(status, 404);
  });
});

describe("POST /agents/:id/run gating", () => {
  test("403 when APERIO_AGENT_JOBS is off", async () => {
    const prev = process.env.APERIO_AGENT_JOBS;
    delete process.env.APERIO_AGENT_JOBS;
    const router = makeRouter();
    const { status } = await invoke(router, "POST", "/agents/a/run");
    assert.strictEqual(status, 403);
    if (prev !== undefined) process.env.APERIO_AGENT_JOBS = prev;
  });

  test("404 for an unknown id when enabled", async () => {
    const prev = process.env.APERIO_AGENT_JOBS;
    process.env.APERIO_AGENT_JOBS = "on";
    const router = apiRouter({
      agent: { version: "1", provider: { name: "x", model: "y" }, setProvider: () => {}, getSkillDoc: () => null },
      store: { listAll: async () => [], getAgentJob: async () => null },
      watchdog: { heartbeat: () => {} },
      scheduler: { runJob: async () => ({ verdict: "ok" }) },
    });
    const { status } = await invoke(router, "POST", "/agents/nope/run");
    assert.strictEqual(status, 404);
    if (prev === undefined) delete process.env.APERIO_AGENT_JOBS;
    else process.env.APERIO_AGENT_JOBS = prev;
  });

  test("409 'already running' when the job is in flight (does not call runJob)", async () => {
    const prev = process.env.APERIO_AGENT_JOBS;
    process.env.APERIO_AGENT_JOBS = "on";
    let ran = false;
    const router = apiRouter({
      agent: { version: "1", provider: { name: "x", model: "y" }, setProvider: () => {}, getSkillDoc: () => null },
      store: { listAll: async () => [], getAgentJob: async () => ({ id: "a", prompt: "go" }) },
      watchdog: { heartbeat: () => {} },
      scheduler: { isRunning: () => true, runJob: async () => { ran = true; return { verdict: "ok" }; } },
    });
    const { status, body } = await invoke(router, "POST", "/agents/a/run");
    assert.strictEqual(status, 409);
    assert.match(body.error, /already running/);
    assert.strictEqual(ran, false);
    if (prev === undefined) delete process.env.APERIO_AGENT_JOBS;
    else process.env.APERIO_AGENT_JOBS = prev;
  });
});

describe("GET /agents (running flag)", () => {
  test("marks a job running when the scheduler reports it in flight", async () => {
    const router = apiRouter({
      agent: { version: "1", provider: { name: "x", model: "y" }, setProvider: () => {}, getSkillDoc: () => null },
      store: {
        listAll: async () => [],
        listAgentJobs: async () => [{ id: "busy" }, { id: "idle" }],
        listAgentRuns: async () => [],
      },
      watchdog: { heartbeat: () => {} },
      scheduler: { isRunning: (id) => id === "busy" },
    });
    const { status, body } = await invoke(router, "GET", "/agents");
    assert.strictEqual(status, 200);
    const byId = Object.fromEntries(body.jobs.map((j) => [j.id, j.running]));
    assert.strictEqual(byId.busy, true);
    assert.strictEqual(byId.idle, false);
  });
});

describe("PUT /agents/enabled", () => {
  test("flips the env var and calls scheduler.setEnabled", async () => {
    const prev = process.env.APERIO_AGENT_JOBS;
    let toggled = null;
    const router = apiRouter({
      agent: { version: "1", provider: { name: "x", model: "y" }, setProvider: () => {}, getSkillDoc: () => null },
      store: { listAll: async () => [] },
      watchdog: { heartbeat: () => {} },
      scheduler: { setEnabled: (on) => { toggled = on; } },
    });

    const r1 = await invoke(router, "PUT", "/agents/enabled", { body: { enabled: true } });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.enabled, true);
    assert.strictEqual(toggled, true);
    assert.strictEqual(process.env.APERIO_AGENT_JOBS, "on");

    const r2 = await invoke(router, "PUT", "/agents/enabled", { body: { enabled: false } });
    assert.strictEqual(r2.body.enabled, false);
    assert.strictEqual(toggled, false);
    assert.strictEqual(process.env.APERIO_AGENT_JOBS, "off");

    if (prev === undefined) delete process.env.APERIO_AGENT_JOBS;
    else process.env.APERIO_AGENT_JOBS = prev;
  });

  test("persists the choice to the DB settings store, never to .env", async () => {
    const prev = process.env.APERIO_AGENT_JOBS;
    const saved = {};
    const router = apiRouter({
      agent: { version: "1", provider: { name: "x", model: "y" }, setProvider: () => {}, getSkillDoc: () => null },
      store: { listAll: async () => [], setSetting: async (k, v) => { saved[k] = v; } },
      watchdog: { heartbeat: () => {} },
      scheduler: { setEnabled: () => {} },
    });

    await invoke(router, "PUT", "/agents/enabled", { body: { enabled: true } });
    assert.strictEqual(saved["config.APERIO_AGENT_JOBS"], "on");

    await invoke(router, "PUT", "/agents/enabled", { body: { enabled: false } });
    assert.strictEqual(saved["config.APERIO_AGENT_JOBS"], "off");

    if (prev === undefined) delete process.env.APERIO_AGENT_JOBS;
    else process.env.APERIO_AGENT_JOBS = prev;
  });

  test("400 when enabled is not a boolean", async () => {
    const router = makeRouter();
    const { status } = await invoke(router, "PUT", "/agents/enabled", { body: { enabled: "yes" } });
    assert.strictEqual(status, 400);
  });
});

describe("CRUD live rescheduling", () => {
  test("POST /agents reloads the scheduler with the fresh DB list", async () => {
    let reloaded = null;
    const router = apiRouter({
      agent: { version: "1", provider: { name: "x", model: "y" }, setProvider: () => {}, getSkillDoc: () => null },
      store: {
        listAll: async () => [],
        getAgentJob: async () => null,
        upsertAgentJob: async (j) => j,
        listAgentJobs: async () => [{ id: "new" }],
      },
      watchdog: { heartbeat: () => {} },
      scheduler: { reload: (jobs) => { reloaded = jobs; } },
    });
    const { status } = await invoke(router, "POST", "/agents", { body: { id: "new", prompt: "x" } });
    assert.strictEqual(status, 201);
    assert.deepStrictEqual(reloaded, [{ id: "new" }]);
  });

  test("DELETE /agents/:id reloads the scheduler", async () => {
    let reloadCalls = 0;
    const router = apiRouter({
      agent: { version: "1", provider: { name: "x", model: "y" }, setProvider: () => {}, getSkillDoc: () => null },
      store: { listAll: async () => [], deleteAgentJob: async () => true, listAgentJobs: async () => [] },
      watchdog: { heartbeat: () => {} },
      scheduler: { reload: () => { reloadCalls++; } },
    });
    const { status } = await invoke(router, "DELETE", "/agents/gone");
    assert.strictEqual(status, 200);
    assert.strictEqual(reloadCalls, 1);
  });
});
