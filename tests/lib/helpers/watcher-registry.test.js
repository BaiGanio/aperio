// tests/lib/helpers/watcher-registry.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createWatcherRegistry } from "../../../lib/helpers/watcher-registry.js";

const fakeHandle = () => {
  let stopped = 0;
  return { stop: async () => { stopped++; }, stops: () => stopped };
};

describe("createWatcherRegistry", () => {
  test("stop(kind, root) stops only the matching watcher and forgets it", async () => {
    const reg = createWatcherRegistry();
    const a = fakeHandle();
    const b = fakeHandle();
    await reg.register("codegraph", "/repo/a", a);
    await reg.register("codegraph", "/repo/b", b);

    const stopped = await reg.stop("codegraph", "/repo/a");
    assert.equal(stopped, true);
    assert.equal(a.stops(), 1);
    assert.equal(b.stops(), 0, "sibling watcher must keep running");
    assert.equal(reg.has("codegraph", "/repo/a"), false, "forgotten after stop");
    assert.equal(reg.has("codegraph", "/repo/b"), true);
  });

  test("stop returns false when nothing is registered for that root", async () => {
    const reg = createWatcherRegistry();
    assert.equal(await reg.stop("codegraph", "/nope"), false);
  });

  test("same root is keyed per kind — codegraph and docgraph don't collide", async () => {
    const reg = createWatcherRegistry();
    const code = fakeHandle();
    const doc = fakeHandle();
    await reg.register("codegraph", "/repo", code);
    await reg.register("docgraph", "/repo", doc);

    await reg.stop("codegraph", "/repo");
    assert.equal(code.stops(), 1);
    assert.equal(doc.stops(), 0, "docgraph watcher on the same folder is untouched");
    assert.equal(reg.has("docgraph", "/repo"), true);
  });

  test("re-registering the same (kind, root) stops the stale watcher", async () => {
    const reg = createWatcherRegistry();
    const oldH = fakeHandle();
    const newH = fakeHandle();
    await reg.register("codegraph", "/repo", oldH);
    await reg.register("codegraph", "/repo", newH);
    assert.equal(oldH.stops(), 1, "old watcher stopped on replace");
    assert.equal(newH.stops(), 0);
    assert.equal(reg.has("codegraph", "/repo"), true);
  });

  test("stopAll stops every watcher across kinds and clears the registry", async () => {
    const reg = createWatcherRegistry();
    const a = fakeHandle();
    const b = fakeHandle();
    const c = fakeHandle();
    await reg.register("codegraph", "/a", a);
    await reg.register("codegraph", "/b", b);
    await reg.register("docgraph", "/a", c);

    await reg.stopAll();
    assert.equal(a.stops(), 1);
    assert.equal(b.stops(), 1);
    assert.equal(c.stops(), 1);
    assert.equal(reg.has("codegraph", "/a"), false);
    assert.equal(reg.has("docgraph", "/a"), false);
  });
});
