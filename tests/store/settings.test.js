// tests/store/settings.test.js
// Round-trips the key/value settings layer.
//   • LanceDBStore — exercises the real settings.json file in a temp dir.
//     The settings methods only touch DB_PATH (like pins), so we can test
//     them on a bare instance without a full init()/native table.
//   • mockStore    — verifies the shared interface contract.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeMockStore } from "../mockStore.js";

// LANCEDB_PATH must be set before importing lancedb.js — DB_PATH is resolved
// at module load. Point it at a throwaway temp dir.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-settings-"));
process.env.LANCEDB_PATH = TMP;

const { LanceDBStore } = await import("../../db/lancedb.js");

describe("LanceDBStore settings (settings.json)", () => {
  let store;

  before(() => {
    store = new LanceDBStore(); // constructor doesn't connect — settings are file-only
  });

  after(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test("getSetting returns null for an unknown key", async () => {
    assert.equal(await store.getSetting("nope"), null);
  });

  test("setSetting then getSetting round-trips a string", async () => {
    await store.setSetting("theme", "aurora");
    assert.equal(await store.getSetting("theme"), "aurora");
  });

  test("preserves booleans and objects through JSON", async () => {
    await store.setSetting("sound", false);
    await store.setSetting("voice", { rate: 1.2, lang: "en" });
    assert.equal(await store.getSetting("sound"), false);
    assert.deepEqual(await store.getSetting("voice"), { rate: 1.2, lang: "en" });
  });

  test("setSetting overwrites an existing key", async () => {
    await store.setSetting("theme", "dark");
    assert.equal(await store.getSetting("theme"), "dark");
  });

  test("getSettings returns the full map", async () => {
    const all = await store.getSettings();
    assert.equal(all.theme, "dark");
    assert.equal(all.sound, false);
    assert.deepEqual(all.voice, { rate: 1.2, lang: "en" });
  });

  test("persists across instances (survives reload)", async () => {
    const fresh = new LanceDBStore();
    assert.equal(await fresh.getSetting("theme"), "dark");
  });

  test("deleteSetting removes a key and reports whether it existed", async () => {
    assert.equal(await store.deleteSetting("theme"), true);
    assert.equal(await store.deleteSetting("theme"), false);
    assert.equal(await store.getSetting("theme"), null);
  });
});

describe("settings interface contract (mockStore)", () => {
  test("round-trips through the shared interface", async () => {
    const store = makeMockStore();
    assert.equal(await store.getSetting("k"), null);
    await store.setSetting("k", "v");
    assert.equal(await store.getSetting("k"), "v");
    assert.deepEqual(await store.getSettings(), { k: "v" });
    assert.equal(await store.deleteSetting("k"), true);
    assert.equal(await store.deleteSetting("k"), false);
  });
});
