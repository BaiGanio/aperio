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
    };
    const res = {
      _status: 200, headersSent: false,
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
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

// =============================================================================
// GET /config/client
// =============================================================================

describe("GET /config/client", () => {
  test("defaults heartbeatIntervalSeconds to 10", async () => {
    delete process.env.HEARTBEAT_INTERVAL_SECONDS;
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/config/client");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.heartbeatIntervalSeconds, 10);
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
