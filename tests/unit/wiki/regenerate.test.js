// Tests for lib/handlers/wiki/regenerate.js — stale-article self-heal.
//
// Pure functions (parseRefreshProvider, buildUserPrompt, extractCitedMemoryIds,
// refreshRequestModel) need no mocking.  regenerateArticle and
// checkLlamaCppModelServed mock globalThis.fetch to avoid real HTTP calls.

import { describe, test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import logger from "../../../lib/helpers/logger.js";

let parseRefreshProvider, buildUserPrompt, extractCitedMemoryIds;
let refreshRequestModel, checkLlamaCppModelServed, regenerateArticle;
let originalFetch;

before(async () => {
  const mod = await import("../../../lib/handlers/wiki/regenerate.js");
  parseRefreshProvider    = mod.parseRefreshProvider;
  buildUserPrompt         = mod.buildUserPrompt;
  extractCitedMemoryIds   = mod.extractCitedMemoryIds;
  refreshRequestModel     = mod.refreshRequestModel;
  checkLlamaCppModelServed= mod.checkLlamaCppModelServed;
  regenerateArticle       = mod.regenerateArticle;
});

before(() => {
  mock.method(logger, "info",  () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "error", () => {});
  mock.method(logger, "debug", () => {});
});

after(() => {
  mock.restoreAll();
});

// ═══════════════════════════════════════════════════════════════════════════
// Env & fetch helpers
// ═══════════════════════════════════════════════════════════════════════════

const _envSnapshot = {};

function snapshotEnv() {
  for (const k of [
    "WIKI_REFRESH_PROVIDER", "WIKI_REFRESH_AUTOSTART_LLAMACPP",
    "DEEPSEEK_API_KEY", "LLAMACPP_BASE_URL",
  ]) {
    _envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(_envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  snapshotEnv();
  logger.warn.mock.resetCalls();
  logger.error.mock.resetCalls();
  logger.info.mock.resetCalls();
});

afterEach(() => {
  restoreEnv();
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

/**
 * Convenience: set mock fetch for test scope.  Pass a URL-matching function
 * that returns the response body.  Default yields an empty ok response.
 */
function mockFetch(matchFn) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const body = await matchFn(urlStr, opts).catch((e) => { throw e; });
    if (body !== null && body !== undefined) return body;
    return { ok: true, json: async () => ({}) };
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// parseRefreshProvider
// ═══════════════════════════════════════════════════════════════════════════

describe("parseRefreshProvider", () => {
  test("returns null for null / undefined / empty string", () => {
    assert.strictEqual(parseRefreshProvider(null), null);
    assert.strictEqual(parseRefreshProvider(undefined), null);
    assert.strictEqual(parseRefreshProvider(""), null);
    assert.strictEqual(parseRefreshProvider("   "), null);
  });

  test("returns parsed object for valid 'provider:model'", () => {
    const r = parseRefreshProvider("llamacpp:Qwen/Qwen2.5-3B-Instruct-GGUF");
    assert.deepStrictEqual(r, { name: "llamacpp", model: "Qwen/Qwen2.5-3B-Instruct-GGUF" });
  });

  test("lowercases the provider name", () => {
    const r = parseRefreshProvider("DeepSeek:deepseek-chat");
    assert.strictEqual(r.name, "deepseek");
    assert.strictEqual(r.model, "deepseek-chat");
  });

  test("parses deepseek provider", () => {
    const r = parseRefreshProvider("deepseek:deepseek-chat");
    assert.deepStrictEqual(r, { name: "deepseek", model: "deepseek-chat" });
  });

  test("parses anthropic provider", () => {
    const r = parseRefreshProvider("anthropic:claude-sonnet-4");
    assert.deepStrictEqual(r, { name: "anthropic", model: "claude-sonnet-4" });
  });

  test("parses gemini provider", () => {
    const r = parseRefreshProvider("gemini:gemini-2.0-flash");
    assert.deepStrictEqual(r, { name: "gemini", model: "gemini-2.0-flash" });
  });

  test("returns null for unsupported provider and logs warning", () => {
    const r = parseRefreshProvider("openai:gpt-4");
    assert.strictEqual(r, null);
    const warn = logger.warn.mock.calls.find(c => c.arguments[0].includes("unsupported refresh provider"));
    assert.ok(warn, "expected warn about unsupported provider");
  });

  test("returns null for malformed string (no colon) and logs warning", () => {
    const r = parseRefreshProvider("just-a-name");
    assert.strictEqual(r, null);
    const warn = logger.warn.mock.calls.find(c => c.arguments[0].includes('expected "provider:model"'));
    assert.ok(warn, "expected warn about expected format");
  });

  test("returns null when model part is empty after colon", () => {
    const r = parseRefreshProvider("llamacpp:");
    assert.strictEqual(r, null);
  });

  test("handles model with colons (HF org/model:quant)", () => {
    const r = parseRefreshProvider("llamacpp:huggingface/Qwen2.5-3B:Q4_K_M");
    assert.deepStrictEqual(r, { name: "llamacpp", model: "huggingface/Qwen2.5-3B:Q4_K_M" });
  });

  test("trims whitespace", () => {
    const r = parseRefreshProvider("  llamacpp:my-model  ");
    assert.deepStrictEqual(r, { name: "llamacpp", model: "my-model" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildUserPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("buildUserPrompt", () => {
  const article = { slug: "test-art", title: "Test Article", summary: "A test article", body_md: "Old body" };
  const memories = [
    { id: "mem-1", title: "Memory 1", content: "Content 1" },
    { id: "mem-2", title: "Memory 2", content: "Content 2" },
  ];

  test("includes slug, title, summary, body, and memories", () => {
    const prompt = buildUserPrompt(article, memories);
    assert.ok(prompt.includes("test-art"), "includes slug");
    assert.ok(prompt.includes("Test Article"), "includes title");
    assert.ok(prompt.includes("A test article"), "includes summary");
    assert.ok(prompt.includes("Old body"), "includes prior body");
    assert.ok(prompt.includes("mem-1"), "includes memory id");
    assert.ok(prompt.includes("mem-2"), "includes memory id");
    assert.ok(prompt.includes("Memory 1"), "includes memory title");
    assert.ok(prompt.includes("Content 1"), "includes memory content");
  });

  test("handles article without summary (null)", () => {
    const a = { ...article, summary: null };
    const prompt = buildUserPrompt(a, memories);
    assert.ok(!prompt.includes("null"), "no literal null in output");
    assert.ok(prompt.includes("test-art"));
  });

  test("includes fallback text when memories array is empty", () => {
    const prompt = buildUserPrompt(article, []);
    assert.ok(prompt.includes("no memories matched"), "includes fallback note");
  });

  test("still includes article fields when memories are empty", () => {
    const prompt = buildUserPrompt(article, []);
    assert.ok(prompt.includes("Test Article"));
    assert.ok(prompt.includes("Old body"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// extractCitedMemoryIds
// ═══════════════════════════════════════════════════════════════════════════

describe("extractCitedMemoryIds", () => {
  const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  test("returns [] when body has no citations", () => {
    assert.deepStrictEqual(extractCitedMemoryIds("plain text without markers"), []);
  });

  test("extracts a single [[mem:uuid]] citation", () => {
    const body = `Some text [[mem:${UUID}]] more text`;
    assert.deepStrictEqual(extractCitedMemoryIds(body), [UUID]);
  });

  test("extracts multiple citations", () => {
    const u1 = "11111111-1111-1111-1111-111111111111";
    const u2 = "22222222-2222-2222-2222-222222222222";
    const body = `Start [[mem:${u1}]] middle [[mem:${u2}]] end`;
    const result = extractCitedMemoryIds(body);
    assert.strictEqual(result.length, 2);
    assert.ok(result.includes(u1));
    assert.ok(result.includes(u2));
  });

  test("deduplicates repeated citations of the same UUID", () => {
    const body = `[[mem:${UUID}]] and again [[mem:${UUID}]]`;
    assert.deepStrictEqual(extractCitedMemoryIds(body), [UUID]);
  });

  test("normalizes to lowercase", () => {
    const upper = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const body  = `[[mem:${upper}]]`;
    const result = extractCitedMemoryIds(body);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], upper.toLowerCase());
  });

  test("does not match malformed UUIDs", () => {
    const body = "[[mem:not-a-uuid]] and [[mem:123]]";
    assert.deepStrictEqual(extractCitedMemoryIds(body), []);
  });

  test("handles body with mixed citations and other [[brackets]]", () => {
    const body = `See [[other-article]] and [[mem:${UUID}]]`;
    const result = extractCitedMemoryIds(body);
    assert.deepStrictEqual(result, [UUID], "only mem: citations extracted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// refreshRequestModel
// ═══════════════════════════════════════════════════════════════════════════

describe("refreshRequestModel", () => {
  test("routes a DB-configured main model through the resident alias", () => {
    assert.strictEqual(
      refreshRequestModel("db-configured-main", {
        name: "llamacpp", model: "db-configured-main", requestModel: "aperio-main",
      }),
      "aperio-main",
    );
  });

  test("keeps a distinct refresh model as its configured model", () => {
    assert.strictEqual(
      refreshRequestModel("separate-refresh-model", {
        name: "llamacpp", model: "db-configured-main", requestModel: "aperio-main",
      }),
      "separate-refresh-model",
    );
  });

  test("returns model when there is no mainProvider", () => {
    assert.strictEqual(refreshRequestModel("some-model"), "some-model");
  });

  test("returns LLAMACPP_MAIN_ALIAS when mainProvider matches but has no requestModel", () => {
    // The default is LLAMACPP_MAIN_ALIAS
    assert.strictEqual(
      refreshRequestModel("same-model", { name: "llamacpp", model: "same-model" }),
      "aperio-main",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// checkLlamaCppModelServed
// ═══════════════════════════════════════════════════════════════════════════

describe("checkLlamaCppModelServed", () => {
  test("returns null when model is served (matches id)", async () => {
    mockFetch(async (url) => {
      if (url.includes("/models")) return { ok: true, json: async () => ({ data: [{ id: "my-model", aliases: [] }] }) };
      return null;
    });
    assert.strictEqual(await checkLlamaCppModelServed("my-model"), null);
  });

  test("returns null when model is served via an alias", async () => {
    mockFetch(async (url) => {
      if (url.includes("/models")) return { ok: true, json: async () => ({ data: [{ id: "real-id", aliases: ["aperio-main"] }] }) };
      return null;
    });
    assert.strictEqual(await checkLlamaCppModelServed("aperio-main"), null);
  });

  test("reports error when model is not served", async () => {
    mockFetch(async (url) => {
      if (url.includes("/models")) return { ok: true, json: async () => ({ data: [{ id: "served/model", aliases: ["aperio-main"] }] }) };
      return null;
    });
    const err = await checkLlamaCppModelServed("missing/model");
    assert.ok(err.includes("model not served: missing/model"), `unexpected: ${err}`);
    assert.ok(err.includes("served/model"), `should list loaded: ${err}`);
  });

  test("returns null when the /models endpoint is unreachable", async () => {
    mockFetch(async () => { throw new Error("unreachable"); });
    assert.strictEqual(await checkLlamaCppModelServed("any-model"), null);
  });

  test("matches requestModel instead of model when provided", async () => {
    mockFetch(async (url) => {
      if (url.includes("/models")) return { ok: true, json: async () => ({ data: [{ id: "request-aliased", aliases: [] }] }) };
      return null;
    });
    assert.strictEqual(await checkLlamaCppModelServed("actual-model", "request-aliased"), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// regenerateArticle
// ═══════════════════════════════════════════════════════════════════════════

describe("regenerateArticle", () => {
  /** Default context with a working mock store. */
  function defaultCtx(overrides = {}) {
    const memId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const defaultArticle = {
      slug: "test-art", title: "Test Article", body_md: "Old body",
      summary: "A test", tags: ["example"],
      source_memory_ids: [],
    };
    return {
      store: {
        wiki: {
          get: async () => ("article" in overrides ? overrides.article : defaultArticle),
        },
        recall: async () => ("memories" in overrides ? overrides.memories : [
          { id: memId, title: "Memory 1", content: "Some relevant content", updated_at: "2025-01-01" },
        ]),
        refreshCache: async () => {},
        cache: "cache" in overrides ? overrides.cache : [
          { id: memId, updated_at: new Date().toISOString(), valid_until: null },
        ],
      },
      generateEmbedding: async () => null,
      ...overrides,
    };
  }

  // ─── Provider not configured ──────────────────────────────────────────

  test("returns { ok: false } when WIKI_REFRESH_PROVIDER is not set", async () => {
    const result = await regenerateArticle(defaultCtx(), "test-art");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("refresh provider not configured"), result.reason);
  });

  // ─── Article not found ────────────────────────────────────────────────

  test("returns { ok: false } when article is not found", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "deepseek:deepseek-chat";
    const ctx = defaultCtx({ article: null });
    const result = await regenerateArticle(ctx, "nonexistent");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('article "nonexistent" not found'), result.reason);
  });

  // ─── getArticle throws ────────────────────────────────────────────────

  test("returns { ok: false } when loading article fails", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "deepseek:deepseek-chat";
    const ctx = defaultCtx();
    ctx.store.wiki.get = async () => { throw new Error("db error"); };
    const result = await regenerateArticle(ctx, "test-art");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("load failed"), result.reason);
  });

  // ─── recall returns empty ─────────────────────────────────────────────

  test("returns { ok: false } when recall returns no memories", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "deepseek:deepseek-chat";
    const ctx = defaultCtx({ memories: [] });
    const result = await regenerateArticle(ctx, "test-art");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("no source memories matched"), result.reason);
  });

  // ─── recall throws ────────────────────────────────────────────────────

  test("returns { ok: false } when recall fails", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "deepseek:deepseek-chat";
    const ctx = defaultCtx();
    ctx.store.recall = async () => { throw new Error("recall failure"); };
    const result = await regenerateArticle(ctx, "test-art");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("recall failed"), result.reason);
  });

  // ─── LLM completion fails ─────────────────────────────────────────────

  test("returns { ok: false } when deepseek API fetch fails", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "deepseek:deepseek-chat";
    process.env.DEEPSEEK_API_KEY = "test-key";
    mockFetch(async (url) => {
      if (url.includes("deepseek.com")) throw new Error("connection refused");
      return null;
    });
    const result = await regenerateArticle(defaultCtx(), "test-art");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("LLM completion failed"), result.reason);
  });

  // ─── No valid citations in generated body ─────────────────────────────

  test("returns { ok: false } when regenerated body has no valid citations", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "deepseek:deepseek-chat";
    process.env.DEEPSEEK_API_KEY = "test-key";
    mockFetch(async (url) => {
      if (url.includes("deepseek.com")) return { ok: true, json: async () => ({ choices: [{ message: { content: "Fresh content without citations" } }] }) };
      return null;
    });
    const result = await regenerateArticle(defaultCtx(), "test-art");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("no valid [[mem:uuid]]"), result.reason);
  });

  // ─── Full success path (deepseek) ─────────────────────────────────────

  test("returns { ok: true } on successful regen with deepseek", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "deepseek:deepseek-chat";
    process.env.DEEPSEEK_API_KEY = "test-key";
    const memId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mockFetch(async (url) => {
      if (url.includes("deepseek.com")) return { ok: true, json: async () => ({ choices: [{ message: { content: `Refreshed content [[mem:${memId}]]` } }] }) };
      return null;
    });
    const result = await regenerateArticle(defaultCtx({ cache: [{ id: memId, updated_at: new Date().toISOString(), valid_until: null }] }), "test-art");
    assert.strictEqual(result.ok, true, `expected success, got: ${JSON.stringify(result)}`);
    assert.ok(typeof result.citations === "number", "has citation count");
    assert.ok(typeof result.ms === "number", "has duration ms");
  });

  // ─── llamacpp model not served ────────────────────────────────────────

  test("returns { ok: false } when llamacpp model is not served", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "llamacpp:missing/model";
    mockFetch(async (url) => {
      if (url.includes("/models")) return { ok: true, json: async () => ({ data: [{ id: "served/model", aliases: [] }] }) };
      return null;
    });
    const result = await regenerateArticle(defaultCtx(), "test-art");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.startsWith("model not served: missing/model"), result.reason);
  });

  test("does not call recall when llamacpp model is not served", async () => {
    process.env.WIKI_REFRESH_PROVIDER = "llamacpp:missing/model";
    let recallCalled = false;
    mockFetch(async (url) => {
      if (url.includes("/models")) return { ok: true, json: async () => ({ data: [{ id: "served/model", aliases: [] }] }) };
      return null;
    });
    const ctx = defaultCtx();
    ctx.store.recall = async () => { recallCalled = true; return []; };
    await regenerateArticle(ctx, "test-art");
    assert.strictEqual(recallCalled, false);
  });
});
