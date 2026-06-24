// tests/lib/cliPrefs.test.js — readCliPrefs/writeCliPrefs (#178 examples toggle).
// Uses a real temp file via APERIO_CLI_PREFS so the round-trip exercises the
// actual serialize → fs → parse path rather than mocks.

import assert from "node:assert";
import { describe, test, before, after, beforeEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCliPrefs, writeCliPrefs } from "../../lib/helpers/cliPrefs.js";
import { resolveLang } from "../../lib/terminal.js";

let dir, prefsFile, prevEnv;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aperio-cliprefs-"));
  prefsFile = join(dir, "cli-prefs.json");
  prevEnv = process.env.APERIO_CLI_PREFS;
  process.env.APERIO_CLI_PREFS = prefsFile;
});

after(() => {
  if (prevEnv === undefined) delete process.env.APERIO_CLI_PREFS;
  else process.env.APERIO_CLI_PREFS = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(prefsFile)) rmSync(prefsFile);
});

describe("cliPrefs", () => {
  test("readCliPrefs returns defaults when the file is missing", () => {
    assert.deepStrictEqual(readCliPrefs(), { examples: true });
  });

  test("readCliPrefs falls back to defaults on malformed JSON", () => {
    writeFileSync(prefsFile, "{ not json");
    assert.deepStrictEqual(readCliPrefs(), { examples: true });
  });

  test("writeCliPrefs persists a choice that reads back (round-trip)", () => {
    writeCliPrefs({ examples: false });
    assert.deepStrictEqual(readCliPrefs(), { examples: false });
    writeCliPrefs({ examples: true });
    assert.deepStrictEqual(readCliPrefs(), { examples: true });
  });

  test("unknown stored keys are merged over defaults", () => {
    writeFileSync(prefsFile, JSON.stringify({ examples: false, extra: 1 }));
    assert.strictEqual(readCliPrefs().examples, false);
  });
});

describe("resolveLang precedence (saved pref → env → en)", () => {
  let prevUiLang;
  before(() => { prevUiLang = process.env.APERIO_UI_LANG; });
  after(() => {
    if (prevUiLang === undefined) delete process.env.APERIO_UI_LANG;
    else process.env.APERIO_UI_LANG = prevUiLang;
  });

  test("defaults to English when nothing is set", () => {
    delete process.env.APERIO_UI_LANG;
    assert.strictEqual(resolveLang(), "en");
  });

  test("uses APERIO_UI_LANG when no saved pref", () => {
    process.env.APERIO_UI_LANG = "fr";
    assert.strictEqual(resolveLang(), "fr");
  });

  test("ignores an unknown language code, falling through", () => {
    process.env.APERIO_UI_LANG = "zz";
    assert.strictEqual(resolveLang(), "en");
  });

  test("saved pref wins over APERIO_UI_LANG", () => {
    process.env.APERIO_UI_LANG = "fr";
    writeCliPrefs({ lang: "de" });
    assert.strictEqual(resolveLang(), "de");
  });
});
