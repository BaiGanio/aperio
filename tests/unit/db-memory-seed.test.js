// tests/db/memory-seed.test.js
// Shape checks for the three first-boot seed sets, plus the APERIO_LITE gate:
// a fresh store seeded with APERIO_LITE=on gets the non-coder starter set
// (MEMORY_SEED_LITE) instead of the developer-oriented MEMORY_SEED, and the
// self-seed identity entries win the wake-up preload (importance DESC).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import { MEMORY_SEED } from "../../db/memory-seed.js";
import { MEMORY_SEED_LITE } from "../../db/memory-seed-lite.js";
import { SELF_MEMORY_SEED } from "../../db/self-memory-seed.js";

const VALID_TYPES = [
  "fact", "preference", "project", "decision",
  "solution", "source", "person", "inference",
];

let oldPath, oldDims, oldLite;

before(() => {
  oldPath = process.env.SQLITE_PATH;
  oldDims = process.env.EMBEDDING_DIMS;
  oldLite = process.env.APERIO_LITE;
  process.env.SQLITE_PATH = ":memory:";
  process.env.EMBEDDING_DIMS = "4";
});

after(() => {
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
  if (oldLite) process.env.APERIO_LITE = oldLite; else delete process.env.APERIO_LITE;
});

describe("seed shapes", () => {
  for (const [name, seed] of [["MEMORY_SEED", MEMORY_SEED], ["MEMORY_SEED_LITE", MEMORY_SEED_LITE]]) {
    test(`${name} entries have valid type / importance / tags / text`, () => {
      assert.ok(seed.length > 0);
      for (const m of seed) {
        assert.ok(VALID_TYPES.includes(m.type), `${name}: bad type '${m.type}' on '${m.title}'`);
        assert.ok(m.title?.trim() && m.content?.trim(), `${name}: empty title/content`);
        assert.ok(Number.isInteger(m.importance) && m.importance >= 1 && m.importance <= 5,
          `${name}: importance out of range on '${m.title}'`);
        assert.ok(Array.isArray(m.tags) && m.tags.length > 0, `${name}: tags missing on '${m.title}'`);
      }
    });
  }

  test("SELF_MEMORY_SEED entries are lean (no type/pinned) and well-formed", () => {
    for (const s of SELF_MEMORY_SEED) {
      assert.ok(s.title?.trim() && s.content?.trim());
      assert.ok(Number.isInteger(s.importance) && s.importance >= 1 && s.importance <= 5);
      assert.ok(Array.isArray(s.tags) && s.tags.length > 0);
      assert.equal(s.type, undefined);
      assert.equal(s.pinned, undefined);
    }
  });

  test("lite set reuses the capability-exam entry from MEMORY_SEED", () => {
    const exam = MEMORY_SEED.find(m => m.tags?.includes("exam"));
    assert.ok(exam, "MEMORY_SEED lost its exam-tagged entry — memory-seed-lite.js reuses it by that tag");
    assert.ok(MEMORY_SEED_LITE.includes(exam));
  });

  test("self-seed carries at least three identity entries at importance 5", () => {
    const identity = SELF_MEMORY_SEED.filter(s => s.tags.includes("identity"));
    assert.ok(identity.length >= 3);
    for (const s of identity) assert.equal(s.importance, 5);
  });
});

describe("APERIO_LITE seed gate", () => {
  test("APERIO_LITE=on seeds the lite set; unset seeds the developer set", async () => {
    const { SqliteStore } = await import("../../db/sqlite.js");

    process.env.APERIO_LITE = "on";
    const liteStore = await SqliteStore.init();
    const liteMems = await liteStore.recall({ limit: 50 });
    const liteTitles = new Set(liteMems.map(m => m.title));
    for (const m of MEMORY_SEED_LITE) assert.ok(liteTitles.has(m.title), `lite store missing '${m.title}'`);
    assert.equal(liteMems.length, MEMORY_SEED_LITE.length);
    liteStore.close?.();

    delete process.env.APERIO_LITE;
    const devStore = await SqliteStore.init();
    const devMems = await devStore.recall({ limit: 50 });
    const devTitles = new Set(devMems.map(m => m.title));
    for (const m of MEMORY_SEED) assert.ok(devTitles.has(m.title), `dev store missing '${m.title}'`);
    assert.equal(devMems.length, MEMORY_SEED.length);
    devStore.close?.();
  });

  test("identity entries lead the wake-up preload (recallSelf, no query)", async () => {
    const { SqliteStore } = await import("../../db/sqlite.js");
    const store = await SqliteStore.init();
    const top = await store.recallSelf({ limit: 6 });
    const topTitles = new Set(top.map(s => s.title));
    for (const s of SELF_MEMORY_SEED.filter(x => x.tags.includes("identity"))) {
      assert.ok(topTitles.has(s.title), `identity entry '${s.title}' not in the top-6 preload`);
    }
    store.close?.();
  });
});
