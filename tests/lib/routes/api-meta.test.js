// tests/lib/routes/api-meta.test.js
// Tests for meta/info routes NOT already covered in api.test.js.
//
// api.test.js via apiRouter() already tests: /version, /provider (GET),
// /config, /heartbeat, /config/client.
//
// This file tests the remaining routes: skills CRUD, files, paths,
// models, provider PUT, metrics, system.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";

import logger from "../../../lib/helpers/logger.js";
import { mountMetaRoutes } from "../../../lib/routes/api-meta.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});
});

after(() => mock.restoreAll());

// ─── Invoke helper ────────────────────────────────────────────────────────────

function invoke(router, method, url, { body = {}, query = {}, params = {} } = {}) {
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

// ─── Factory ─────────────────────────────────────────────────────────────────

function makeRouter(agentOverrides = {}, storeOverrides = {}, watchdogOverrides = {}) {
  const router = Router();
  mountMetaRoutes(router, {
    agent: {
      version:  "1.2.3",
      provider: { name: "anthropic", model: "claude-haiku-4-5" },
      setProvider: () => {},
      getSkillDoc:    () => null,
      getSkillList:   () => [],
      getSkillsForManagement: () => [],
      getSkillForEdit: () => null,
      saveSkill:      () => { throw new Error("not implemented"); },
      setSkillLoad:   () => { throw new Error("not implemented"); },
      deleteSkill:    () => { throw new Error("not implemented"); },
      resetSkill:     () => { throw new Error("not implemented"); },
      ...agentOverrides,
    },
    store: {
      counts: async () => ({ total: 0, embedded: 0 }),
      ...storeOverrides,
    },
    watchdog: {
      heartbeat: () => {},
      ...watchdogOverrides,
    },
  });
  return router;
}

// =============================================================================
// Skills endpoints
// =============================================================================

describe("GET /skill", () => {
  test("returns skill doc when found", async () => {
    const doc = { name: "test-skill", description: "A test", body: "# Hello" };
    const router = makeRouter({ getSkillDoc: (name) => name === "test-skill" ? doc : null });
    const { status, body } = await invoke(router, "GET", "/skill", { query: { name: "test-skill" } });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, doc);
  });

  test("returns 404 when skill not found", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/skill", { query: { name: "nonexistent" } });
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("skill not found"));
  });
});

describe("GET /skills", () => {
  test("returns skill list from agent", async () => {
    const skills = [{ name: "s1" }, { name: "s2" }];
    const router = makeRouter({ getSkillList: () => skills });
    const { status, body } = await invoke(router, "GET", "/skills");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.skills, skills);
  });

  test("returns 500 when getSkillList throws", async () => {
    const router = makeRouter({ getSkillList: () => { throw new Error("bad"); } });
    const { status, body } = await invoke(router, "GET", "/skills");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("bad"));
  });
});

describe("GET /skills/manage", () => {
  test("returns management data from agent", async () => {
    const mgmt = [{ name: "s1", load: "always" }];
    const router = makeRouter({ getSkillsForManagement: () => mgmt });
    const { status, body } = await invoke(router, "GET", "/skills/manage");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.skills, mgmt);
  });

  test("returns 500 on error", async () => {
    const router = makeRouter({ getSkillsForManagement: () => { throw new Error("fail"); } });
    const { status, body } = await invoke(router, "GET", "/skills/manage");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("fail"));
  });
});

describe("GET /skill/edit", () => {
  test("returns editable skill payload when found", async () => {
    const skill = { name: "editable", body: "content" };
    const router = makeRouter({ getSkillForEdit: (name) => name === "my-skill" ? skill : null });
    const { status, body } = await invoke(router, "GET", "/skill/edit", { query: { name: "my-skill" } });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, skill);
  });

  test("returns 404 when skill not found", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/skill/edit", { query: { name: "ghost" } });
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("skill not found"));
  });
});

describe("POST /skill (create)", () => {
  test("creates a new skill", async () => {
    const saved = { name: "new-skill", description: "A new skill" };
    const router = makeRouter({
      getSkillForEdit: () => null,         // no conflict
      saveSkill: (data) => ({ ...data, ...saved }),
    });
    const { status, body } = await invoke(router, "POST", "/skill", {
      body: { name: "new-skill", description: "A new skill", body: "# Content" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.skill.name, "new-skill");
  });

  test("returns 409 when skill name already exists", async () => {
    const router = makeRouter({
      getSkillForEdit: () => ({ name: "existing" }),
    });
    const { status, body } = await invoke(router, "POST", "/skill", {
      body: { name: "existing", body: "x" },
    });
    assert.strictEqual(status, 409);
    assert.ok(body.error.includes("already exists"));
  });

  test("returns 400 when saveSkill throws", async () => {
    const router = makeRouter({
      getSkillForEdit: () => null,
      saveSkill: () => { throw new Error("invalid body"); },
    });
    const { status, body } = await invoke(router, "POST", "/skill", {
      body: { name: "broken", body: "" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("invalid body"));
  });
});

describe("PUT /skill (edit)", () => {
  test("updates an existing skill", async () => {
    const saved = { name: "updated-skill" };
    const router = makeRouter({
      saveSkill: (data) => ({ ...data, ...saved }),
    });
    const { status, body } = await invoke(router, "PUT", "/skill", {
      body: { name: "updated-skill", description: "Updated" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.skill.name, "updated-skill");
  });

  test("returns 400 when saveSkill throws", async () => {
    const router = makeRouter({
      saveSkill: () => { throw new Error("save failed"); },
    });
    const { status, body } = await invoke(router, "PUT", "/skill", {
      body: { name: "broken" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("save failed"));
  });
});

describe("PATCH /skill/load", () => {
  test("toggles skill load mode", async () => {
    const router = makeRouter({
      setSkillLoad: (name, load) => ({ name, load }),
    });
    const { status, body } = await invoke(router, "PATCH", "/skill/load", {
      body: { name: "my-skill", load: "always" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.skill.load, "always");
  });

  test("returns 400 on error", async () => {
    const router = makeRouter({
      setSkillLoad: () => { throw new Error("bad name"); },
    });
    const { status, body } = await invoke(router, "PATCH", "/skill/load", {
      body: { name: "unknown", load: "never" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("bad name"));
  });
});

describe("DELETE /skill", () => {
  test("deletes a skill", async () => {
    const router = makeRouter({
      deleteSkill: (name) => ({ deleted: true, name }),
    });
    const { status, body } = await invoke(router, "DELETE", "/skill", {
      query: { name: "to-delete" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.name, "to-delete");
  });

  test("returns 400 on error", async () => {
    const router = makeRouter({
      deleteSkill: () => { throw new Error("not found"); },
    });
    const { status, body } = await invoke(router, "DELETE", "/skill", {
      query: { name: "ghost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("not found"));
  });
});

describe("POST /skill/reset", () => {
  test("resets a shipped skill", async () => {
    const router = makeRouter({
      resetSkill: (name) => ({ name, reset: true }),
    });
    const { status, body } = await invoke(router, "POST", "/skill/reset", {
      body: { name: "built-in" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.skill.name, "built-in");
  });

  test("returns 400 on error", async () => {
    const router = makeRouter({
      resetSkill: () => { throw new Error("cannot reset"); },
    });
    const { status, body } = await invoke(router, "POST", "/skill/reset", {
      body: { name: "protected" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("cannot reset"));
  });
});

// =============================================================================
// PUT /provider
// =============================================================================

describe("PUT /provider", () => {
  test("sets the provider and model", async () => {
    let captured;
    const router = makeRouter({
      setProvider: (p) => { captured = p; },
    });
    const { status, body } = await invoke(router, "PUT", "/provider", {
      body: { provider: "ollama", model: "llama3.1" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.provider, "ollama");
    assert.deepStrictEqual(captured, { name: "ollama", model: "llama3.1" });
  });

  test("returns 400 when provider is missing", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "PUT", "/provider", {
      body: { model: "llama3.1" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("provider and model are required"));
  });

  test("returns 400 when model is missing", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "PUT", "/provider", {
      body: { provider: "ollama" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("provider and model are required"));
  });

  test("returns 500 when setProvider throws", async () => {
    const router = makeRouter({
      setProvider: () => { throw new Error("provider unavailable"); },
    });
    const { status, body } = await invoke(router, "PUT", "/provider", {
      body: { provider: "ollama", model: "llama3.1" },
    });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("provider unavailable"));
  });
});

// =============================================================================
// GET /paths  /  POST /paths
// =============================================================================

describe("GET /paths", () => {
  test("returns the current allowed paths", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/paths");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.paths));
  });
});

describe("POST /paths", () => {
  test("accepts valid path array", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/paths", {
      body: { paths: ["/tmp"] },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.ok(Array.isArray(body.paths));
  });

  test("returns 400 when paths is not an array", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/paths", {
      body: { paths: "not-an-array" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("must be an array"));
  });

  test("returns 400 when paths contains empty strings", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/paths", {
      body: { paths: ["/valid", ""] },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("non-empty strings"));
  });
});

// =============================================================================
// GET /files
// =============================================================================

describe("GET /files", () => {
  let __savedPaths;

  before(async () => {
    const { getUserPaths, setAllowlist } = await import("../../../lib/routes/paths.js");
    __savedPaths = getUserPaths();
    // Ensure the project root is in the allowlist — other tests (e.g. shell.test.js)
    // may have mutated the global state via setAllowlist().
    await setAllowlist([process.cwd()]);
  });

  after(async () => {
    if (__savedPaths) {
      const { setAllowlist } = await import("../../../lib/routes/paths.js");
      await setAllowlist(__savedPaths);
    }
  });
  test("returns empty array when query is too short", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/files", { query: { q: "a" } });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.files, []);
  });

  test("returns empty array when query is empty", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/files", { query: { q: "" } });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.files, []);
  });

  test("searches allowed paths with a valid query", async () => {
    const router = makeRouter();
    // Query for something that should exist in the project root
    const { status, body } = await invoke(router, "GET", "/files", { query: { q: "package" } });
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.files));
    // Should find at least package.json
    assert.ok(body.files.some(f => f.name === "package.json"), "should find package.json");
  });

  test("returns empty array when no files match", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/files", { query: { q: "zzzznonexistent" } });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.files, []);
  });
});

// =============================================================================
// GET /models
// =============================================================================

describe("GET /models", () => {
  test("returns providers with Ollama results and API keys", () => {
    // Save env vars
    const origAnthropic = process.env.ANTHROPIC_API_KEY;
    const origDeepSeek = process.env.DEEPSEEK_API_KEY;
    const origOllama = process.env.OLLAMA_BASE_URL;

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.DEEPSEEK_API_KEY = "sk-ds-test";
    delete process.env.OLLAMA_BASE_URL; // use default

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "llama3.1:8b" }] }),
        };
      }
      return { ok: false, status: 404 };
    };

    const router = makeRouter();

    return invoke(router, "GET", "/models")
      .then(({ status, body }) => {
        assert.strictEqual(status, 200);
        assert.strictEqual(body.provider, "anthropic");
        assert.strictEqual(body.model, "claude-haiku-4-5");
        assert.ok(Array.isArray(body.providers.ollama));
        assert.ok(body.providers.ollama.includes("llama3.1:8b"));
        assert.ok(Array.isArray(body.providers.anthropic));
        assert.ok(Array.isArray(body.providers.deepseek));
      })
      .finally(() => {
        globalThis.fetch = originalFetch;
        if (origAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = origAnthropic;
        if (origDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = origDeepSeek;
        if (origOllama === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = origOllama;
      });
  });

  test("returns providers with llama.cpp results", () => {
    const origLlamaCpp = process.env.LLAMACPP_BASE_URL;
    delete process.env.LLAMACPP_BASE_URL; // use default

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes("/v1/models")) {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M" }] }),
        };
      }
      return { ok: false, status: 404 };
    };

    const router = makeRouter();

    return invoke(router, "GET", "/models")
      .then(({ status, body }) => {
        assert.strictEqual(status, 200);
        assert.ok(Array.isArray(body.providers.llamacpp));
        assert.ok(body.providers.llamacpp.includes("Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"));
      })
      .finally(() => {
        globalThis.fetch = originalFetch;
        if (origLlamaCpp === undefined) delete process.env.LLAMACPP_BASE_URL; else process.env.LLAMACPP_BASE_URL = origLlamaCpp;
      });
  });

  test("handles Ollama not running (fetch throws)", () => {
    const origAnthropic = process.env.ANTHROPIC_API_KEY;
    const origDeepSeek = process.env.DEEPSEEK_API_KEY;

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.DEEPSEEK_API_KEY = "sk-ds-test";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };

    const router = makeRouter();

    return invoke(router, "GET", "/models")
      .then(({ status, body }) => {
        assert.strictEqual(status, 200);
        // Ollama failed, but anthropic and deepseek still listed
        assert.strictEqual(body.providers.ollama, undefined); // not present on error
        assert.ok(Array.isArray(body.providers.anthropic));
        assert.ok(Array.isArray(body.providers.deepseek));
      })
      .finally(() => {
        globalThis.fetch = originalFetch;
        if (origAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = origAnthropic;
        if (origDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = origDeepSeek;
      });
  });
});

// =============================================================================
// GET /metrics  /  GET /system
// =============================================================================

describe("GET /metrics", () => {
  test("returns cached system metrics", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/metrics");
    assert.strictEqual(status, 200);
    // Guaranteed fields (initial cache — the setInterval may not have fired yet)
    assert.ok(typeof body.rss === "number");
    assert.ok(typeof body.heap === "number");
    assert.strictEqual(typeof body.cpu, "number");
    assert.ok(typeof body.embedding_queue_size === "number");
    // Interval-updated fields: optional if the 2-second tick hasn't run yet
    if (body.cores !== undefined) {
      assert.ok(typeof body.cores === "number");
      assert.ok(typeof body.loadAvg1 === "number");
      assert.ok(typeof body.systemTotalMem === "number");
      assert.ok(typeof body.uptime === "number");
      assert.strictEqual(typeof body.platform, "string");
      assert.strictEqual(typeof body.nodeVersion, "string");
    }
  });
});

describe("GET /system", () => {
  test("is an alias for /metrics and returns the same structure", async () => {
    const router = makeRouter();
    const { status, body } = await invoke(router, "GET", "/system");
    assert.strictEqual(status, 200);
    assert.ok(typeof body.rss === "number");
    assert.ok(typeof body.heap === "number");
  });
});

// =============================================================================
// Late-bound deps (early-mount): the API serves before the agent/watchdog exist
// =============================================================================

describe("warming up (lazy agent/watchdog)", () => {
  test("GET /version works before the agent is ready", async () => {
    const router = Router();
    mountMetaRoutes(router, { getAgent: () => null, store: {}, getWatchdog: () => null, version: "9.9.9" });
    const { status, body } = await invoke(router, "GET", "/version");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.version, "9.9.9");
  });

  test("GET /provider becomes live once the agent is bound (no remount)", async () => {
    let agent = null;
    const router = Router();
    mountMetaRoutes(router, { getAgent: () => agent, store: {}, getWatchdog: () => null });
    // Agent finishes booting after the route was mounted.
    agent = { provider: { name: "ollama", model: "gemma4:e4b" } };
    const { status, body } = await invoke(router, "GET", "/provider");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.provider, "ollama");
    assert.strictEqual(body.model, "gemma4:e4b");
  });

  test("GET /heartbeat tolerates a not-yet-ready watchdog", async () => {
    const router = Router();
    mountMetaRoutes(router, { getAgent: () => null, store: {}, getWatchdog: () => null });
    const { status, body } = await invoke(router, "GET", "/heartbeat");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });

  test("heartbeat is forwarded to the watchdog once it is bound", async () => {
    let hits = 0;
    let watchdog = null;
    const router = Router();
    mountMetaRoutes(router, { getAgent: () => null, store: {}, getWatchdog: () => watchdog });
    watchdog = { heartbeat: () => { hits++; } };
    await invoke(router, "GET", "/heartbeat");
    assert.strictEqual(hits, 1);
  });
});

describe("POST /quit", () => {
  const originalSupervised = process.env.APERIO_SUPERVISED;
  after(() => {
    if (originalSupervised === undefined) delete process.env.APERIO_SUPERVISED;
    else process.env.APERIO_SUPERVISED = originalSupervised;
  });

  test("refuses with 409 when the process is supervised", async () => {
    process.env.APERIO_SUPERVISED = "1";
    const router = makeRouter();
    const { status, body } = await invoke(router, "POST", "/quit");
    assert.strictEqual(status, 409);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.supervised, true);
  });

  test("answers ok and quits via the watchdog when unsupervised", async () => {
    process.env.APERIO_SUPERVISED = "0";
    let quitCalled = false;
    const router = makeRouter({}, {}, { quit: () => { quitCalled = true; } });
    const { status, body } = await invoke(router, "POST", "/quit");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.supervised, false);
    // Teardown is deferred so the response can flush first.
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(quitCalled, true, "watchdog.quit should be invoked");
  });
});
