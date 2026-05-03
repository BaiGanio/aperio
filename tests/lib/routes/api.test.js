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

/**
 * Invoke a route on the router with a mock req/res pair and return the
 * captured { status, body } when res.json() is called.
 */
function invoke(router, method, url, { body = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url,
      path: url,
      body,
      query:       {},
      headers:     {},
      params:      {},
      baseUrl:     "",
      originalUrl: url,
    };
    const res = {
      _status: 200,
      headersSent: false,
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

/** Build a router with sensible defaults; individual properties can be overridden. */
function makeRouter({ agent = {}, store = {}, watchdog = {} } = {}) {
  return apiRouter({
    agent: {
      version:  "1.2.3",
      provider: { name: "anthropic", model: "claude-haiku-4-5" },
      ...agent,
    },
    store: {
      table: {
        query: () => ({ limit: () => ({ toArray: async () => [] }) }),
      },
      ...store,
    },
    watchdog: {
      heartbeat: () => {},
      ...watchdog,
    },
  });
}

// ─── GET /version ─────────────────────────────────────────────────────────────

describe("GET /version", () => {
  test("returns the agent version", async () => {
    const router = makeRouter({ agent: { version: "2.0.0" } });
    const { status, body } = await invoke(router, "GET", "/version");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.version, "2.0.0");
  });
});

// ─── GET /provider ────────────────────────────────────────────────────────────

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

// ─── GET /config ──────────────────────────────────────────────────────────────

describe("GET /config", () => {
  test("defaults to lancedb when DB_BACKEND is not set", async (t) => {
    delete process.env.DB_BACKEND;
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/config");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.backend, "lancedb");
  });

  test("returns the value of DB_BACKEND env var when set", async (t) => {
    process.env.DB_BACKEND = "postgres";
    t.after(() => delete process.env.DB_BACKEND);
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/config");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.backend, "postgres");
  });
});

// ─── GET /heartbeat ───────────────────────────────────────────────────────────

describe("GET /heartbeat", () => {
  test("calls watchdog.heartbeat() and returns ok:true with a numeric ts", async () => {
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

// ─── GET /config/client ───────────────────────────────────────────────────────

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

// ─── GET /memories ────────────────────────────────────────────────────────────

describe("GET /memories", () => {
  test("returns records from the store as { raw }", async () => {
    const records = [{ id: "1", title: "test", content: "hello" }];
    const router  = makeRouter({
      store: {
        table: { query: () => ({ limit: () => ({ toArray: async () => records }) }) },
      },
    });
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
      store: {
        table: {
          query: () => ({
            limit: () => ({ toArray: async () => { throw new Error("db unreachable"); } }),
          }),
        },
      },
    });
    const { status, body } = await invoke(router, "GET", "/memories");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db unreachable"));
  });
});

// ─── POST /chat ───────────────────────────────────────────────────────────────

describe("POST /chat", () => {
  test("returns 400 when messages body is missing", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/chat", { body: {} });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("messages array is required"));
  });

  test("returns 400 when messages is not an array", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/chat", {
      body: { messages: "not-an-array" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("messages array is required"));
  });

  test("proxies to Ollama and returns reply + stats on success", async (t) => {
    t.mock.method(globalThis, "fetch", async () => ({
      ok:   true,
      json: async () => ({
        message:           { content: "Hello there!" },
        prompt_eval_count: 10,
        eval_count:        5,
      }),
    }));

    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(body.reply, "Hello there!");
    assert.strictEqual(body.stats.inputTokens,  10);
    assert.strictEqual(body.stats.outputTokens,  5);
    assert.strictEqual(body.stats.totalTokens,  15);
  });

  test("returns 502 when Ollama returns a non-ok response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => ({
      ok:   false,
      text: async () => "model not found",
    }));

    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
    });

    assert.strictEqual(status, 502);
    assert.ok(body.error.includes("Ollama error"));
    assert.ok(body.error.includes("model not found"));
  });

  test("returns 500 when the fetch to Ollama throws", async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("connection refused"); });

    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
    });

    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("connection refused"));
  });

  test("sends the model from the agent provider to Ollama", async (t) => {
    let capturedBody;
    t.mock.method(globalThis, "fetch", async (_, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok:   true,
        json: async () => ({
          message:           { content: "ok" },
          prompt_eval_count: 1,
          eval_count:        1,
        }),
      };
    });

    const router = makeRouter({
      agent: { provider: { name: "ollama", model: "llama3.1:8b" } },
    });
    await invoke(router, "POST", "/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
    });

    assert.strictEqual(capturedBody.model, "llama3.1:8b");
    assert.strictEqual(capturedBody.stream, false);
  });
});
