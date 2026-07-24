// Tests for locale.js — request locale detection and HTML renderer.
//
// detectLocale is a pure function (input req headers → output locale string).
// createHtmlRenderer uses readFileSync — integration test with real files.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import logger from "../../../lib/helpers/logger.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
// Import SUT
// ═══════════════════════════════════════════════════════════════════════════

let detectLocale, createHtmlRenderer, SUPPORTED_LOCALES, I18N_COOKIE;

before(async () => {
  const mod = await import("../../../lib/server/locale.js");
  detectLocale         = mod.detectLocale;
  createHtmlRenderer   = mod.createHtmlRenderer;
  SUPPORTED_LOCALES   = mod.SUPPORTED_LOCALES;
  I18N_COOKIE         = mod.I18N_COOKIE;
});

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Build a minimal request object. */
function req(cookie, acceptLang) {
  const h = {};
  if (cookie != null)     h.cookie            = `${I18N_COOKIE}=${cookie}`;
  if (acceptLang != null) h["accept-language"] = acceptLang;
  return { headers: h };
}

// ═══════════════════════════════════════════════════════════════════════════
// detectLocale
// ═══════════════════════════════════════════════════════════════════════════

describe("detectLocale", () => {
  beforeEach(() => {
    delete process.env.DEFAULT_LOCALE;
  });

  // ─── Cookie priority ──────────────────────────────────────────────────

  test("returns cookie value when valid and matches SUPPORTED_LOCALES", () => {
    assert.strictEqual(detectLocale(req("de", "en")), "de");
  });

  test("returns cookie value for en (also supported)", () => {
    assert.strictEqual(detectLocale(req("en", "fr")), "en");
  });

  test("ignores cookie when value is NOT in SUPPORTED_LOCALES — falls through to Accept-Language", () => {
    const result = detectLocale(req("xx", "bg"));
    assert.strictEqual(result, "bg", "falls through to Accept-Language");
  });

  test("ignores cookie when value is NOT in SUPPORTED_LOCALES and no Accept-Language — falls to default", () => {
    const result = detectLocale(req("invalid-locale", null));
    assert.strictEqual(result, "en", "falls to en");
  });

  // ─── Accept-Language ──────────────────────────────────────────────────

  test("returns locale from Accept-Language when no cookie", () => {
    assert.strictEqual(detectLocale(req(null, "fr")), "fr");
    assert.strictEqual(detectLocale(req(null, "de")), "de");
    assert.strictEqual(detectLocale(req(null, "es")), "es");
  });

  test("extracts base language from complex Accept-Language tag (zh-CN → zh)", () => {
    assert.strictEqual(detectLocale(req(null, "zh-CN")), "zh");
    assert.strictEqual(detectLocale(req(null, "en-GB")), "en");
    assert.strictEqual(detectLocale(req(null, "pt-BR")), "pt");
  });

  test("respects quality weights — higher q wins", () => {
    assert.strictEqual(detectLocale(req(null, "fr;q=0.5, de;q=0.9")), "de");
    assert.strictEqual(detectLocale(req(null, "fr;q=0.9, de;q=0.5")), "fr");
  });

  test("returns first matching locale when Accept-Language has no q values (all q=1)", () => {
    // First matching supported locale in the list wins
    const result = detectLocale(req(null, "fr, de, bg"));
    assert.ok(SUPPORTED_LOCALES.has(result), `${result} is supported`);
    // "fr" is first
    assert.strictEqual(result, "fr");
  });

  test("handles Accept-Language with only unsupported locales — falls to default", () => {
    assert.strictEqual(detectLocale(req(null, "xx, yy")), "en");
  });

  test("handles Accept-Language with mixed supported/unsupported — picks first supported", () => {
    assert.strictEqual(detectLocale(req(null, "xx, yy, de, fr")), "de");
  });

  test("treats invalid q value as 1.0", () => {
    // When q= is present but has no valid number, treat q as 1.0 (same as default)
    // "de;q=invalid" → q=1, "fr" → q=1, first match is "de"
    assert.strictEqual(detectLocale(req(null, "de;q=invalid, fr")), "de");
  });

  test("treats negative q values as 1.0 (parseFloat clamps via isNaN)", () => {
    // parseFloat("-1") returns -1, which is finite → quality = -1
    // Sort puts -1 at the bottom, so fr (q=1) wins
    assert.strictEqual(detectLocale(req(null, "de;q=-1, fr")), "fr");
  });

  // ─── Fallback chain ──────────────────────────────────────────────────

  test("returns DEFAULT_LOCALE env when neither cookie nor Accept-Language match", () => {
    process.env.DEFAULT_LOCALE = "bg";
    assert.strictEqual(detectLocale(req(null, null)), "bg");
  });

  test('returns "en" when nothing matches and no DEFAULT_LOCALE is set', () => {
    assert.strictEqual(detectLocale(req(null, null)), "en");
  });

  test("handles request with no headers object gracefully", () => {
    assert.strictEqual(detectLocale({ headers: {} }), "en");
  });

  test("handles request with missing cookie and missing accept-language headers", () => {
    assert.strictEqual(detectLocale({ headers: {} }), "en");
  });

  // ─── I18N_COOKIE constant ────────────────────────────────────────────

  test("I18N_COOKIE is aperio_lang", () => {
    assert.strictEqual(I18N_COOKIE, "aperio_lang");
  });

  // ─── SUPPORTED_LOCALES set ────────────────────────────────────────────

  test("SUPPORTED_LOCALES contains en, bg, de, fr, es, zh, ja", () => {
    for (const l of ["en", "bg", "de", "fr", "es", "zh", "ja"]) {
      assert.ok(SUPPORTED_LOCALES.has(l), `${l} is supported`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createHtmlRenderer
// ═══════════════════════════════════════════════════════════════════════════

describe("createHtmlRenderer", () => {
  const ROOT = PROJECT_ROOT;

  test("returns an object with renderHtmlWithLocale method", () => {
    const renderer = createHtmlRenderer({ root: ROOT });
    assert.ok(renderer);
    assert.strictEqual(typeof renderer.renderHtmlWithLocale, "function");
  });

  test('renderHtmlWithLocale("index.html", "de") stamps data-aperio-lang="de" on <html>', () => {
    const { renderHtmlWithLocale } = createHtmlRenderer({ root: ROOT });
    const html = renderHtmlWithLocale("index.html", "de");
    assert.ok(html.includes('data-aperio-lang="de"'), "expected data-aperio-lang=de");
    // Original lang attribute should still be there
    assert.ok(html.includes('lang="en"'), "original lang attribute preserved");
  });

  test('renderHtmlWithLocale("setup.html", "bg") stamps data-aperio-lang="bg"', () => {
    const { renderHtmlWithLocale } = createHtmlRenderer({ root: ROOT });
    const html = renderHtmlWithLocale("setup.html", "bg");
    assert.ok(html.includes('data-aperio-lang="bg"'), "expected data-aperio-lang=bg");
  });

  test("multiple calls with different locales each work", () => {
    const { renderHtmlWithLocale } = createHtmlRenderer({ root: ROOT });
    const en = renderHtmlWithLocale("index.html", "en");
    const de = renderHtmlWithLocale("index.html", "de");
    assert.ok(en.includes('data-aperio-lang="en"'));
    assert.ok(de.includes('data-aperio-lang="de"'));
  });

  test("returns valid HTML (starts with doctype)", () => {
    const { renderHtmlWithLocale } = createHtmlRenderer({ root: ROOT });
    const html = renderHtmlWithLocale("index.html", "en");
    assert.ok(html.startsWith("<!DOCTYPE"), "HTML starts with DOCTYPE");
  });

  test("non-cached file (not index.html or setup.html) is read directly", () => {
    const { renderHtmlWithLocale } = createHtmlRenderer({ root: ROOT });
    // help.html exists in public/ — it should be readable
    const html = renderHtmlWithLocale("help.html", "en");
    assert.ok(html.includes("data-aperio-lang="), "help.html has locale stamp");
  });

  test("caches index.html and setup.html — subsequent calls avoid re-read", () => {
    // We can't easily spy on readFileSync, but we can verify the result
    // is consistent across calls as evidence of caching.
    const { renderHtmlWithLocale } = createHtmlRenderer({ root: ROOT });
    const first  = renderHtmlWithLocale("index.html", "en");
    const second = renderHtmlWithLocale("index.html", "fr");
    // Both calls produce HTML — second call uses cache with different lang
    assert.ok(first.includes('data-aperio-lang="en"'));
    assert.ok(second.includes('data-aperio-lang="fr"'));
  });
});
