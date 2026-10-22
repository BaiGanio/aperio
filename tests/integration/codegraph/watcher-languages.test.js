// tests/integration/codegraph/watcher-languages.test.js
//
// T2.2: the codegraph watcher must index every language the indexer supports.
//
// What this guards, and why a unit test cannot: the watcher's isIndexable()
// used to test JS_EXT alone, while the indexer's pickExtractor() accepted 25
// further extensions. The consequence was invisible — the initial indexRepo
// pass DID index a .cs/.py/.go repository, and then every live save to one of
// those files was dropped in silence. The graph went stale forever with no
// error anywhere. Only a real chokidar watcher over a real tree, with a real
// database behind it, can see that: the predicate agrees in isolation but the
// event never reaches the indexer.
//
// This drives the real watcher, the real extractors (tree-sitter WASM on a
// worker thread) and a real better-sqlite3 database. It asserts add, change
// and unlink for each of .js, .cs, .py and .go, plus that an unsupported
// extension still produces nothing.
//
// On the polling fallback: openChokidarWatcher() retries with usePolling when
// native watching is denied. A pass that only succeeds under native fs events
// is not a pass, so the watch mode is recorded and reported with every
// failure — read it before believing a green run.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { runSqliteMigrations } from "../../../db/migrate-sqlite.js";
import { startWatcher, openChokidarWatcher } from "../../../lib/codegraph/watcher.js";
import { stopExtractorPool } from "../../../lib/codegraph/indexer.js";
import { setAllowlist, getUserPaths } from "../../../lib/routes/paths.js";

// The watcher debounces 250 ms and chokidar's awaitWriteFinish adds ~100 ms.
// Generous so a loaded runner cannot flake it; the assertion is "did it ever
// happen", not "how fast".
const SETTLE_MS = 8000;

// One file per language, each with a function the extractor must find. The
// name is unique per language so a symbol lookup cannot be satisfied by
// another file's row.
const CASES = [
  { file: "sample.js", symbol: "jsAlpha",
    v1: "export function jsAlpha(a) { return a + 1; }\n",
    v2: "export function jsAlpha(a) { return a + 1; }\nexport function jsBeta(b) { return b; }\n",
    added: "jsBeta" },
  { file: "Sample.cs", symbol: "CsAlpha",
    v1: "class Holder { void CsAlpha() { } }\n",
    v2: "class Holder { void CsAlpha() { } void CsBeta() { } }\n",
    added: "CsBeta" },
  { file: "sample.py", symbol: "py_alpha",
    v1: "def py_alpha(a):\n    return a\n",
    v2: "def py_alpha(a):\n    return a\n\ndef py_beta(b):\n    return b\n",
    added: "py_beta" },
  { file: "sample.go", symbol: "GoAlpha",
    v1: "package main\n\nfunc GoAlpha(a int) int { return a }\n",
    v2: "package main\n\nfunc GoAlpha(a int) int { return a }\n\nfunc GoBeta(b int) int { return b }\n",
    added: "GoBeta" },
];

async function createDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE"); // vec0 requires DELETE mode
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  await runSqliteMigrations(db);
  return db;
}

let root, store, handle, events, priorPaths, watchMode = "unknown";

/** Count rows in cg_symbols by name, across every file in the repo. */
function symbolCount(name) {
  return store.db.prepare("SELECT COUNT(*) AS n FROM cg_symbols WHERE name = ?").get(name).n;
}

function fileRow(relPath) {
  return store.db.prepare("SELECT language FROM cg_files WHERE path = ?").get(relPath);
}

/**
 * Wait for the watcher's own `change` event for one relative path and op, so
 * the test never races the debounce. Resolves false on timeout — the caller
 * asserts, so the failure message can name the watch mode.
 */
function waitForChange(relPath, op, ms = SETTLE_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { events.off("change", onChange); resolve(false); }, ms);
    function onChange(e) {
      if (e.kind !== "codegraph" || e.relPath !== relPath || e.op !== op) return;
      clearTimeout(timer);
      events.off("change", onChange);
      resolve(true);
    }
    events.on("change", onChange);
  });
}

before(async () => {
  // realpath, so the root matches what chokidar reports (/var -> /private/var
  // on macOS). The resulting path still contains a "var" segment, which is
  // deliberate: it is exactly the shape the old absolute-path SKIP_DIRS split
  // rejected outright.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "aperio-s22-")));

  // indexRepo gates on the app-wide allowed-folders list, not on the injected
  // isReadPathAllowed. No store is attached, so this stays in memory only.
  priorPaths = getUserPaths();
  await setAllowlist([root]);

  store = { db: await createDb() };
  events = new EventEmitter();
  events.setMaxListeners(0);

  // Start with the tree empty, so every language arrives as a live `add`
  // event rather than through the initial bulk pass.
  handle = await startWatcher(store, root, events, {
    isReadPathAllowed: () => true,
    generateEmbedding: async () => [0.1],
    createSymbolEmbeddingQueue: () => ({ enqueueMany() {}, shutdown() {} }),
    // Real indexRepo / indexFile / removeFile / sweepMissing on purpose.
    // The watcher has a polling fallback (used when native fs events are
    // denied), and a pass that only works under native events is not a pass.
    // Set APERIO_TEST_WATCH_POLLING=1 to run this whole file in polling mode;
    // both modes were verified green for S2.2.
    openChokidarWatcher: async (rootPath, options) => {
      const forcePolling = process.env.APERIO_TEST_WATCH_POLLING === "1";
      const r = await openChokidarWatcher(rootPath, forcePolling ? { ...options, usePolling: true } : options);
      watchMode = forcePolling ? "polling" : r.mode;
      return r;
    },
  });
});

after(async () => {
  await handle?.stop().catch(() => {});
  stopExtractorPool();
  store?.db?.close();
  if (priorPaths) await setAllowlist(priorPaths);
  if (root) await rm(root, { recursive: true, force: true });
});

describe("codegraph watcher indexes every supported language (T2.2)", () => {
  for (const c of CASES) {
    test(`${c.file}: add, change and unlink all reach the graph`, async () => {
      const where = `watch mode: ${watchMode}`;

      // ── add ──
      await writeFile(path.join(root, c.file), c.v1);
      assert.ok(await waitForChange(c.file, "index"),
        `no live index event for ${c.file} after ${SETTLE_MS} ms (${where})`);
      assert.equal(symbolCount(c.symbol), 1, `${c.symbol} missing after add (${where})`);
      assert.ok(fileRow(c.file), `no cg_files row for ${c.file} (${where})`);

      // ── change ──
      await writeFile(path.join(root, c.file), c.v2);
      assert.ok(await waitForChange(c.file, "index"),
        `no live index event for the edit of ${c.file} (${where})`);
      assert.equal(symbolCount(c.added), 1,
        `${c.added} missing after change — the save was dropped (${where})`);

      // ── unlink ──
      await rm(path.join(root, c.file));
      assert.ok(await waitForChange(c.file, "remove"),
        `no live remove event for ${c.file} (${where})`);
      assert.equal(fileRow(c.file), undefined, `cg_files row survived unlink (${where})`);
      assert.equal(symbolCount(c.symbol), 0, `${c.symbol} survived unlink (${where})`);
    });
  }

  test("an unsupported extension produces no event and no rows", async () => {
    await writeFile(path.join(root, "notes.txt"), "function notIndexed() {}\n");
    // A .js file written straight after acts as the fence: once ITS event has
    // arrived, any event the .txt was ever going to produce has had its turn.
    await writeFile(path.join(root, "fence.js"), "export function fenceFn() {}\n");
    assert.ok(await waitForChange("fence.js", "index"),
      `fence file never indexed (watch mode: ${watchMode})`);

    assert.equal(fileRow("notes.txt"), undefined, "a .txt file was indexed");
    assert.equal(symbolCount("notIndexed"), 0, "a .txt file's symbols reached the graph");
  });

  test("the watch mode is reported, so a native-only pass cannot hide", () => {
    assert.ok(["native", "polling"].includes(watchMode), `unexpected watch mode: ${watchMode}`);
    console.log(`[T2.2] chokidar ran in ${watchMode} mode`);
  });
});
