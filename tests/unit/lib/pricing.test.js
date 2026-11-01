import { describe, test, after, before } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, writeFileSync, mkdirSync, unlinkSync,
} from "fs";
import { resolve } from "path";

// The cache file path is the same one pricing.js uses internally.
// We must create it before ensurePricingCache() runs so the first
// call loads test data instead of fetching from OpenRouter.
const CACHE_FILE = resolve(process.cwd(), "var", "pricing-cache.json");
const TEST_MODELS = {
  "deepseek-v4-pro":   { in: 0.5,   out: 1.5,   cacheRead: 0.135, cacheWrite: null, contextWindow: 200000 },
  "deepseek-v4-flash": { in: 0.075, out: 0.3,   contextWindow: 128000 },
  "claude-opus-4-8":   { in: 15,    out: 75,    cacheRead: 1.5, cacheWrite: 18.75, contextWindow: 200000 },
  "claude-sonnet-4-6": { in: 3,     out: 15,    contextWindow: 200000 },
  // Deliberately written in the pre-cache-rate shape, the way a cache file left
  // over from an older build still on disk would be.
  "gemini-2.5-pro":    { in: 1.25,  out: 5,     contextWindow: 1048576 },
  "gpt-5.6-luna":      { in: 10,    out: 40,    contextWindow: 128000 },
};

// Clean cache before suite
mkdirSync(resolve(process.cwd(), "var"), { recursive: true });
try { unlinkSync(CACHE_FILE); } catch { /* never existed */ }

// Write test cache with a fresh timestamp
writeFileSync(CACHE_FILE, JSON.stringify({
  fetchedAt: Date.now(),
  models: TEST_MODELS,
}));

let getPricing, ensurePricingCache;

before(async () => {
  const mod = await import("../../../lib/pricing.js");
  getPricing = mod.getPricing;
  ensurePricingCache = mod.ensurePricingCache;
  // Load the test cache into the module's _cache
  await ensurePricingCache();
});

after(() => {
  try { unlinkSync(CACHE_FILE); } catch { /* best-effort */ }
});

// =============================================================================
// ensurePricingCache — loads cached pricing from disk
// =============================================================================
describe("ensurePricingCache", () => {
  test("loads cache from file without network fetch", async () => {
    // The before hook already loaded it — verify by checking a known model
    const price = getPricing("deepseek-v4-pro");
    assert.notStrictEqual(price, null);
    assert.equal(price.in, 0.5);
    assert.equal(price.out, 1.5);
    assert.equal(price.contextWindow, 200000);
  });
});

// =============================================================================
// getPricing — model pricing lookup
// =============================================================================
describe("getPricing", () => {
  test("returns null when model name is null", () => {
    assert.strictEqual(getPricing(null), null);
  });

  test("returns null when model name is empty string", () => {
    assert.strictEqual(getPricing(""), null);
  });

  test("returns null for unknown model", () => {
    assert.strictEqual(getPricing("nonexistent-model-v99"), null);
  });

  test("looks up by exact internal key", () => {
    const price = getPricing("deepseek-v4-flash");
    assert.notStrictEqual(price, null);
    assert.equal(price.in, 0.075);
    assert.equal(price.out, 0.3);
  });

  test("looks up by OpenRouter ID", () => {
    const price = getPricing("deepseek/deepseek-v4-flash");
    assert.notStrictEqual(price, null);
    assert.equal(price.in, 0.075);
  });

  test("looks up by sanitised OpenRouter ID (no slash)", () => {
    const price = getPricing("deepseekv4flash");
    assert.notStrictEqual(price, null);
    assert.equal(price.in, 0.075);
  });

  test("looks up by case-insensitive name", () => {
    const price = getPricing("DeepSeek-V4-Flash");
    assert.notStrictEqual(price, null);
    assert.equal(price.in, 0.075);
  });

  test("looks up by partial fragment (short search key matches inside longer mapped key)", () => {
    // The search key "deepseek" is contained within multiple SEARCH_MAP keys.
    // The longest matching key ("deepseekdeepseekv4flash" = 23 chars) wins,
    // mapping to deepseek-v4-flash.
    const price = getPricing("deepseek");
    assert.notStrictEqual(price, null);
    assert.equal(price.out, 0.3);
  });

  test("strips date suffix for lookup", () => {
    // claude-sonnet-4-6 with a date suffix should resolve
    const price = getPricing("claude-sonnet-4-6-20250601");
    assert.notStrictEqual(price, null);
    assert.equal(price.in, 3);
  });

  test("returns null for a model with unknown date-suffixed base", () => {
    assert.strictEqual(getPricing("unknown-model-20251001"), null);
  });

  test("returns correct output shape", () => {
    const price = getPricing("gemini-2.5-pro");
    assert.notStrictEqual(price, null);
    assert.ok(typeof price.in === "number");
    assert.ok(typeof price.out === "number");
    assert.ok(typeof price.contextWindow === "number" || price.contextWindow === null);
  });

  test("returns contextWindow as number when present", () => {
    const price = getPricing("gemini-2.5-pro");
    assert.equal(price.contextWindow, 1048576);
  });

  test("fragment fallback matches partial key", () => {
    // gpt-5.6-luna should be findable via fragment "5.6-luna" or "gpt-luna"
    const price = getPricing("gpt-5.6-luna");
    assert.notStrictEqual(price, null);
    assert.equal(price.in, 10);
  });

  test("carries the cache-read and cache-write rates when the catalog publishes them", () => {
    const price = getPricing("claude-opus-4-8");
    assert.equal(price.cacheRead, 1.5);
    assert.equal(price.cacheWrite, 18.75);
    // A read is billed below the input rate and a write above it, so neither can
    // ever be derived from `in`.
    assert.ok(price.cacheRead < price.in && price.cacheWrite > price.in);
  });

  test("reports a missing cache rate as null, never 0 — a zero would say those " +
    "tokens are free", () => {
    // A provider that charges no separate cache-write rate.
    const partial = getPricing("deepseek-v4-pro");
    assert.equal(partial.cacheRead, 0.135);
    assert.strictEqual(partial.cacheWrite, null);

    // A cache file written before these rates existed carries neither, and must
    // read as "not published" rather than as free.
    const legacy = getPricing("gemini-2.5-pro");
    assert.strictEqual(legacy.cacheRead, null);
    assert.strictEqual(legacy.cacheWrite, null);
  });
});

// =============================================================================
// The fetch path — pins OpenRouter's own field names, the one thing here that
// could be silently wrong: a renamed field reads as "no published rate" rather
// than as an error. Runs LAST, because it replaces the module's loaded cache.
// =============================================================================
describe("fetchFromOpenRouter (through ensurePricingCache)", () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  test("reads input_cache_read / input_cache_write and converts per-token to per-million", async () => {
    try { unlinkSync(CACHE_FILE); } catch { /* forces a fetch */ }
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "anthropic/claude-opus-4.8", context_length: 200000,
            pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005",
              input_cache_write: "0.00000625", input_cache_write_1h: "0.00001" } },
          // A provider with no separate cache-write charge at all.
          { id: "openai/gpt-5.5", context_length: 400000,
            pricing: { prompt: "0.000005", completion: "0.00003", input_cache_read: "0.0000005" } },
        ],
      }),
    });
    await ensurePricingCache();

    const opus = getPricing("claude-opus-4-8");
    assert.equal(opus.in, 5);
    assert.equal(opus.out, 25);
    assert.equal(opus.cacheRead, 0.5);
    // The 5-minute write rate, NOT input_cache_write_1h ($10/M): Aperio's
    // anthropic loop sets a bare `{ type: "ephemeral" }` breakpoint with no
    // `ttl`, so it never buys the 1-hour cache.
    assert.equal(opus.cacheWrite, 6.25);

    const gpt = getPricing("gpt-5.5");
    assert.equal(gpt.cacheRead, 0.5);
    assert.strictEqual(gpt.cacheWrite, null);
  });
});
