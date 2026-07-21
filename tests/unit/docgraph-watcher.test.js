import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { openChokidarWatcher } from "../../../lib/docgraph/watcher.js";
import { walk } from "../../../lib/docgraph/indexer.js";

function fakeWatcher(event, value) {
  const watcher = new EventEmitter();
  watcher.closed = false;
  watcher.close = async () => { watcher.closed = true; };
  queueMicrotask(() => watcher.emit(event, value));
  return watcher;
}

describe("docgraph watcher startup", () => {
  test("falls back to polling when native macOS watching is denied", async () => {
    const calls = [];
    const nativeError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const watch = (_root, options) => {
      calls.push(options);
      return calls.length === 1
        ? fakeWatcher("error", nativeError)
        : fakeWatcher("ready");
    };

    const result = await openChokidarWatcher("/Users/me/Documents/private", { persistent: true }, { watch });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].usePolling, undefined);
    assert.equal(calls[1].usePolling, true);
    assert.equal(result.mode, "polling");
  });

  test("rejects a non-permission startup error and never claims readiness", async () => {
    const failure = Object.assign(new Error("watcher exploded"), { code: "EINVAL" });
    const watchers = [];
    const watch = () => {
      const watcher = fakeWatcher("error", failure);
      watchers.push(watcher);
      return watcher;
    };

    await assert.rejects(
      openChokidarWatcher("/broken", {}, { watch }),
      /watcher exploded/,
    );
    assert.equal(watchers.length, 1);
    assert.equal(watchers[0].closed, true);
  });

  test("reports an actionable error when polling is denied too", async () => {
    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const watch = () => fakeWatcher("error", denied);

    await assert.rejects(
      openChokidarWatcher("/Users/me/Documents/private", {}, { watch }),
      /permission|privacy|access/i,
    );
  });
});

test("an unreadable or missing document root fails instead of looking like an empty corpus", async () => {
  await assert.rejects(
    Array.fromAsync(walk("/definitely/missing/aperio-docgraph-root")),
    /Cannot read document root/,
  );
});
