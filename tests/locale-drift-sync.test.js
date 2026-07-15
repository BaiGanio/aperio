import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extracts the SUPPORTED_LOCALES set from server.js via regex.
 * Safe: does NOT import server.js (importing it starts the server).
 */
function extractServerLocales() {
  // SUPPORTED_LOCALES moved to lib/server.js during composition-root extraction
  const src = readFileSync(resolve(ROOT, "lib/server.js"), "utf8");
  const m = src.match(/\s*const SUPPORTED_LOCALES = new Set\(\[\n([\s\S]+?)\n\s*\]\)/);
  if (!m) throw new Error("Could not find SUPPORTED_LOCALES in lib/server.js");
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
});
