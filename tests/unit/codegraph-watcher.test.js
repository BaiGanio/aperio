import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { openChokidarWatcher } from "../../../lib/codegraph/watcher.js";
import { walk } from "../../../lib/codegraph/indexer.js";

function fakeWatcher(event, value) {
  const watcher = new EventEmitter();
  watcher.closed = false;
  watcher.close = async () => { watcher.closed = true; };
  queueMicrotask(() => watcher.emit(event, value));
  return watcher;
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
});

test("an unreadable or missing code root fails instead of looking like an empty repository", async () => {
  await assert.rejects(
    Array.fromAsync(walk("/definitely/missing/aperio-codegraph-root")),
    /Cannot read code root/,
  );
});
