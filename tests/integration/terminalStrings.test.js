// tests/lib/terminalStrings.test.js — resolveStrings locale overlay (#178 Phase 4).
// Points APERIO_LOCALES_DIR at a temp dir so the overlay/fallback logic is
// exercised without depending on shipped translations.

import assert from "node:assert";
import { describe, test, before, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EN, resolveStrings } from "../../lib/terminal/strings.js";

let dir, prevEnv;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aperio-locales-"));
  // A partial locale: one key translated, the rest intentionally absent.
  // Terminal keys are cli_-prefixed in the shared locale files.
  writeFileSync(join(dir, "zz.json"), JSON.stringify({
    cli_help_title: "ZZ-TITLE",
    cli_welcome_privacy: "   ", // blank → must be ignored, fall back to English
  }));
  prevEnv = process.env.APERIO_LOCALES_DIR;
  process.env.APERIO_LOCALES_DIR = dir;
});

after(() => {
  if (prevEnv === undefined) delete process.env.APERIO_LOCALES_DIR;
  else process.env.APERIO_LOCALES_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveStrings", () => {
  test("English is returned as-is and is the default", () => {
    assert.strictEqual(resolveStrings("en"), EN);
    assert.strictEqual(resolveStrings(), EN);
  });

  test("present locale keys overlay English", () => {
    assert.strictEqual(resolveStrings("zz").help_title, "ZZ-TITLE");
  });

  test("missing or blank locale keys fall back to English", () => {
    const S = resolveStrings("zz");
    assert.strictEqual(S.welcome_privacy, EN.welcome_privacy, "blank → English");
    assert.strictEqual(S.help_intro, EN.help_intro, "absent → English");
  });

  test("an unknown locale file falls back entirely to English", () => {
    assert.deepStrictEqual(resolveStrings("xx"), EN);
  });
});
