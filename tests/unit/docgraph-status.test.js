// tests/lib/docgraph/status.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  getDocgraphStatus, markEnabled, markRootStarted, markRootProgress,
  markRootDone, markRootError, markAllDone,
} from "../../lib/docgraph/status.js";

// The status module is a singleton; each test re-seeds it via markEnabled().

describe("docgraph status", () => {
  test("markRootProgress surfaces live doc/chunk counts while a root indexes", () => {
    markEnabled(["/a", "/b"]);
    markRootStarted("/a");
    markRootProgress("/a", { docs: 40, chunks: 300 });
    const r = getDocgraphStatus().roots.find(x => x.path === "/a");
    assert.equal(r.phase, "indexing");
    assert.equal(r.docs, 40);
    assert.equal(r.chunks, 300);
  });

  test("markRootProgress never overwrites a finished root", () => {
    markEnabled(["/a"]);
    markRootDone("/a", { docCount: 10, chunkCount: 50 });
    markRootProgress("/a", { docs: 999, chunks: 999 }); // late straggler
    const r = getDocgraphStatus().roots.find(x => x.path === "/a");
    assert.equal(r.docs, 10);
    assert.equal(r.chunks, 50);
  });

  test("markAllDone stays 'indexing' while any root is still pending", () => {
    markEnabled(["/a", "/b"]);
    markRootDone("/a", { docCount: 5, chunkCount: 5 }); // /b still pending
    markAllDone();
    assert.equal(getDocgraphStatus().phase, "indexing");
  });

  test("markAllDone flips to 'ready' only once every root is done", () => {
    markEnabled(["/a", "/b"]);
    markRootDone("/a", { docCount: 5, chunkCount: 5 });
    markRootDone("/b", { docCount: 7, chunkCount: 9 });
    markAllDone();
    const s = getDocgraphStatus();
    assert.equal(s.phase, "ready");
    assert.ok(s.completedAt);
  });

  test("markAllDone reports 'error' when a root failed", () => {
    markEnabled(["/a", "/b"]);
    markRootDone("/a", { docCount: 5, chunkCount: 5 });
    markRootError("/b", new Error("boom"));
    markAllDone();
    assert.equal(getDocgraphStatus().phase, "error");
  });
});
