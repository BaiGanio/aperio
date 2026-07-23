import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Extracts the SUPPORTED_LOCALES set from lib/server/locale.js via regex.
 * Safe: does NOT import server.js (importing it starts the server).
 */
function extractServerLocales() {
  // SUPPORTED_LOCALES lives in lib/server/locale.js since the #307 Phase 4 split
  const src = readFileSync(resolve(ROOT, "lib/server/locale.js"), "utf8");
  const m = src.match(/\s*const SUPPORTED_LOCALES = new Set\(\[\n([\s\S]+?)\n\s*\]\);?/);
  if (!m) throw new Error("Could not find SUPPORTED_LOCALES in lib/server/locale.js");
  const set = new Set();
  for (const line of m[1].split("\n")) {
    for (const q of line.matchAll(/"([^"]+)"/g)) {
      set.add(q[1]);
    }
  }
  return set;
}

/**
 * Extracts the LOCALE_META keys from public/scripts/i18n.js via regex.
 * Keys in LOCALE_META are bare identifiers (unquoted) before `:`.
 */
function extractClientLocales() {
  const src = readFileSync(resolve(ROOT, "public", "scripts", "i18n.js"), "utf8");
  const m = src.match(/const LOCALE_META = \{\n([\s\S]+?)\n\};/);
  if (!m) throw new Error("Could not find LOCALE_META in i18n.js");
  const set = new Set();
  for (const line of m[1].split("\n")) {
    const q = line.match(/^\s{2}(\w+):/);
    if (q) set.add(q[1]);
  }
  return set;
}

function listLocaleFiles(dir) {
  const full = resolve(ROOT, dir);
  try {
    return readdirSync(full)
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

describe("locale-drift-sync", () => {
  it("server SUPPORTED_LOCALES matches client LOCALE_META", () => {
    const server = extractServerLocales();
    const client = extractClientLocales();
    const missingInServer = [...client].filter(l => !server.has(l));
    const extraInServer = [...server].filter(l => !client.has(l));
    assert.equal(missingInServer.length, 0,
      `Locales in LOCALE_META but missing from SUPPORTED_LOCALES: ${missingInServer.join(", ")}`);
    assert.equal(extraInServer.length, 0,
      `Locales in SUPPORTED_LOCALES but missing from LOCALE_META: ${extraInServer.join(", ")}`);
  });

  it("public/locales/ contains exactly one JSON per locale", () => {
    const client = extractClientLocales();
    const files = listLocaleFiles("public/locales");
    const missing = [...client].filter(l => !files.includes(l));
    const extra = files.filter(f => !client.has(f));
    assert.equal(missing.length, 0,
      `Missing public/locales/*.json for: ${missing.join(", ")}`);
    assert.equal(extra.length, 0,
      `Extra public/locales/*.json not in LOCALE_META: ${extra.join(", ")}`);
  });

  it("docs/locales/ contains exactly one JSON per locale", () => {
    const client = extractClientLocales();
    const files = listLocaleFiles("docs/locales");
    const missing = [...client].filter(l => !files.includes(l));
    const extra = files.filter(f => !client.has(f));
    assert.equal(missing.length, 0,
      `Missing docs/locales/*.json for: ${missing.join(", ")}`);
    assert.equal(extra.length, 0,
      `Extra docs/locales/*.json not in LOCALE_META: ${extra.join(", ")}`);
  });

  // English is never fetched from /locales/en.json — i18n.js bundles it inline
  // as the immediate fallback and pre-seeds _localeLoaded with "en". A key in
  // en.json but not in the bundle therefore renders as a raw key for English
  // users (the gear-tooltip "stov_nav_title" bug, 2026-07-17).
  it("i18n.js bundled English dict has exactly the same keys as en.json", () => {
    const src = readFileSync(resolve(ROOT, "public", "scripts", "i18n.js"), "utf8");
    const m = src.match(/const TRANSLATIONS = \{\s*en: \{([\s\S]*?)\n  \},\n\};/);
    assert.ok(m, "Could not find the bundled TRANSLATIONS.en block in i18n.js");
    const bundled = new Set([...m[1].matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map(x => x[1]));
    const en = JSON.parse(readFileSync(resolve(ROOT, "public", "locales", "en.json"), "utf8"));
    const missing = Object.keys(en).filter(k => !bundled.has(k));
    const extra = [...bundled].filter(k => !(k in en));
    assert.equal(missing.length, 0,
      `i18n.js bundle is missing ${missing.length} key(s) from en.json: ${missing.slice(0, 10).join(", ")}`);
    assert.equal(extra.length, 0,
      `i18n.js bundle has ${extra.length} key(s) not in en.json: ${extra.slice(0, 10).join(", ")}`);
  });

  // The #177 lesson, made a gate (#252 test group G2): a key added to en.json
  // without every sibling locale renders as a raw key in that language.
  it("every public/locales/*.json has exactly the same keys as en.json", () => {
    const dir = resolve(ROOT, "public", "locales");
    const en = JSON.parse(readFileSync(resolve(dir, "en.json"), "utf8"));
    const enKeys = new Set(Object.keys(en));
    for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "en.json")) {
      const keys = new Set(Object.keys(JSON.parse(readFileSync(resolve(dir, f), "utf8"))));
      const missing = [...enKeys].filter(k => !keys.has(k));
      const extra = [...keys].filter(k => !enKeys.has(k));
      assert.equal(missing.length, 0,
        `${f} is missing ${missing.length} key(s) from en.json: ${missing.slice(0, 10).join(", ")}`);
      assert.equal(extra.length, 0,
        `${f} has ${extra.length} key(s) not in en.json: ${extra.slice(0, 10).join(", ")}`);
    }
  });
});
