// tests/lib/codegraph/status.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  getCodegraphStatus, markEnabled, markRootStarted, markRootProgress,
  markRootDone, markRootError, markAllDone,
} from "../../../lib/codegraph/status.js";

// The status module is a singleton; each test re-seeds it via markEnabled().

describe("codegraph status", () => {
  test("markRootProgress surfaces live counts while a root is still indexing", () => {
    markEnabled(["/a", "/b"]);
    markRootStarted("/a");
    markRootProgress("/a", { files: 40, symbols: 300, edges: 120 });
    const r = getCodegraphStatus().roots.find(x => x.path === "/a");
    assert.equal(r.phase, "indexing");
    assert.equal(r.files, 40);
    assert.equal(r.symbols, 300);
    assert.equal(r.edges, 120);
  });

  test("markRootProgress never overwrites a finished root", () => {
    markEnabled(["/a"]);
    markRootDone("/a", { files: 10, symbols: 50, edges: 5 });
    markRootProgress("/a", { files: 999, symbols: 999, edges: 999 }); // late straggler
    const r = getCodegraphStatus().roots.find(x => x.path === "/a");
    assert.equal(r.files, 10);
    assert.equal(r.symbols, 50);
  });

  test("markAllDone stays 'indexing' while any root is still pending", () => {
    markEnabled(["/a", "/b"]);
    markRootDone("/a", { files: 5, symbols: 5, edges: 0 }); // /b still pending
    markAllDone();
    assert.equal(getCodegraphStatus().phase, "indexing");
  });

  test("markAllDone flips to 'ready' only once every root is done", () => {
    markEnabled(["/a", "/b"]);
    markRootDone("/a", { files: 5, symbols: 5, edges: 0 });
    markRootDone("/b", { files: 7, symbols: 9, edges: 1 });
    markAllDone();
    const s = getCodegraphStatus();
    assert.equal(s.phase, "ready");
    assert.ok(s.completedAt);
  });

  test("markAllDone reports 'error' when a root failed", () => {
    markEnabled(["/a", "/b"]);
    markRootDone("/a", { files: 5, symbols: 5, edges: 0 });
    markRootError("/b", new Error("boom"));
    markAllDone();
    assert.equal(getCodegraphStatus().phase, "error");
  });
});
