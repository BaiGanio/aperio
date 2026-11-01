import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";

import { openChokidarWatcher, startWatcher, isIndexable, hasSkippedSegment } from "../../../lib/codegraph/watcher.js";
import { walk, pickExtractor } from "../../../lib/codegraph/indexer.js";
import { SUPPORTED_EXTS as GENERIC_EXTS } from "../../../lib/codegraph/extract-generic.js";

function fakeWatcher(event, value) {
  const watcher = new EventEmitter();
  watcher.closed = false;
  watcher.close = async () => { watcher.closed = true; };
  queueMicrotask(() => watcher.emit(event, value));
  return watcher;
}

function watcherDeps({ knownRoot }) {
  const enqueued = [];
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  return {
    enqueued,
    deps: {
      isReadPathAllowed: () => true,
      isCodegraphAvailable: () => true,
      listRepoRoots: async () => knownRoot ? ["/repo"] : [],
      createSymbolEmbeddingQueue: () => ({
        enqueueMany: (rows) => enqueued.push(rows),
        shutdown: () => {},
      }),
      generateEmbedding: async () => [0.1],
      indexRepo: async () => ({ indexed: 1, pending: [{ id: "bulk" }] }),
      pendingStoreNames: async () => new Set(["codegraph"]),
      listPendingEmbeddings: async () => [{ id: "existing" }],
      sweepMissing: async () => ({ removed: 0 }),
      indexFile: async () => ({}),
      removeFile: async () => {},
      openChokidarWatcher: async () => ({ watcher, mode: "native" }),
    },
  };
}

describe("codegraph watcher startup", () => {
  test("falls back to polling when native watching is denied", async () => {
    const calls = [];
    const nativeError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const watch = (_root, options) => {
      calls.push(options);
      return calls.length === 1 ? fakeWatcher("error", nativeError) : fakeWatcher("ready");
    };

    const result = await openChokidarWatcher("/Users/me/Documents/private", { persistent: true }, { watch });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].usePolling, undefined);
    assert.equal(calls[1].usePolling, true);
    assert.equal(result.mode, "polling");
  });

  test("closes and rejects a watcher that errors before readiness", async () => {
    const failure = Object.assign(new Error("watcher exploded"), { code: "EINVAL" });
    const watcher = fakeWatcher("error", failure);

    await assert.rejects(
      openChokidarWatcher("/broken", {}, { watch: () => watcher }),
      /watcher exploded/,
    );
    assert.equal(watcher.closed, true);
  });

  test("reports an actionable error when polling is denied too", async () => {
    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });

    await assert.rejects(
      openChokidarWatcher("/Users/me/Documents/private", {}, {
        watch: () => fakeWatcher("error", denied),
      }),
      /permission|privacy|access/i,
    );
  });

  test("defers a known root's pending embeddings to an active reindex", async () => {
    const { deps, enqueued } = watcherDeps({ knownRoot: true });
    const handle = await startWatcher({}, "/repo", undefined, deps);

    assert.deepEqual(enqueued, []);
    await handle.stop();
  });

  test("embeds a new root even while a reindex is active", async () => {
    const { deps, enqueued } = watcherDeps({ knownRoot: false });
    const handle = await startWatcher({}, "/repo", undefined, deps);

    assert.deepEqual(enqueued, [[{ id: "bulk" }], [{ id: "existing" }]]);
    await handle.stop();
  });
});

test("an unreadable or missing code root fails instead of looking like an empty repository", async () => {
  await assert.rejects(
    Array.fromAsync(walk("/definitely/missing/aperio-codegraph-root")),
    /Cannot read code root/,
  );
});

// ── S2.2: one shared indexability predicate ────────────────────────────────
// The watcher used to test JS_EXT alone while the indexer's pickExtractor()
// also accepted 25 generic extensions, so a .cs/.py/.go repo indexed once at
// startup and then silently went stale on every save. These assert the two
// now agree, by construction.
describe("codegraph watcher indexability predicate", () => {
  const root = "/repo";

  for (const ext of ["js", "mjs", "cjs", "jsx", "ts", "tsx"]) {
    test(`a .${ext} file is indexable`, () => {
      assert.equal(isIndexable(root, path.join(root, `src/file.${ext}`)), true);
    });
  }

  // Every extension the generic extractor supports must reach the watcher too.
  for (const bare of [...GENERIC_EXTS].sort()) {
    test(`a .${bare} file is indexable (generic extractor)`, () => {
      assert.equal(isIndexable(root, path.join(root, `src/file.${bare}`)), true);
    });
  }

  for (const ext of ["txt", "md", "json", "lock", "png", ""]) {
    test(`an unsupported .${ext || "(none)"} file stays ignored`, () => {
      assert.equal(isIndexable(root, path.join(root, `src/file${ext ? "." + ext : ""}`)), false);
    });
  }

  test("the predicate delegates to the indexer's pickExtractor", () => {
    // Not an assertion about text: every extension pickExtractor accepts must
    // be indexable, and every one it rejects must not be. If the two ever
    // diverge again this fails for the diverging extension.
    for (const bare of [...GENERIC_EXTS, "js", "ts", "txt", "md", "zzz"]) {
      const file = path.join(root, `probe.${bare}`);
      assert.equal(isIndexable(root, file), pickExtractor(file) !== null, `.${bare}`);
    }
  });

  test("a file inside a skip dir within the root is ignored", () => {
    assert.equal(isIndexable(root, path.join(root, "node_modules/pkg/index.js")), false);
    assert.equal(isIndexable(root, path.join(root, "build/out.cs")), false);
  });
});

// Second half of S2.2: SKIP_DIRS was split out of the ABSOLUTE path, so a root
// that merely lives under a directory named build/, bin/, out/, var/ or trash/
// had every one of its files rejected. docgraph scoped this to the relative
// path on 2026-08-21; codegraph did not.
describe("codegraph SKIP_DIRS scoping", () => {
  const underSkipName = "/Users/me/build/myproject";
  const macTempRoot = "/private/var/folders/ab/xyz123/T/aperio-scratch";

  test("a root under a SKIP_DIRS-named ancestor is not skipped itself", () => {
    assert.equal(hasSkippedSegment(underSkipName, underSkipName), false);
    assert.equal(hasSkippedSegment(macTempRoot, macTempRoot), false);
  });

  test("a file inside such a root is indexable", () => {
    assert.equal(isIndexable(underSkipName, path.join(underSkipName, "main.cs")), true);
    assert.equal(isIndexable(macTempRoot, path.join(macTempRoot, "main.go")), true);
  });

  test("a real skip dir *within* such a root is still skipped", () => {
    assert.equal(isIndexable(underSkipName, path.join(underSkipName, "obj", "a.cs")), false);
    assert.equal(hasSkippedSegment(macTempRoot, path.join(macTempRoot, "var", "x.py")), true);
  });
});
