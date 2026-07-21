// tests/lib/helpers/modelPreload.test.js
//
// Boot-time model preload: triggers the router's lazy download+load at server
// boot (not on the user's first message) and publishes model_status on an
// app-wide bus that wsHandler forwards to every connected browser.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { preloadMainModel, onModelStatus, currentModelStatus } from "../../lib/helpers/modelPreload.js";

const BASE = { model: "org/Main-GGUF:Q4_K_M", routerModelId: "aperio-main", baseURL: "http://127.0.0.1:0", cacheRoot: "/nonexistent", retryDelayMs: 1 };

// Deps double: `loadedAnswers` is consumed one per isModelLoaded probe (last
// value repeats); the fake watcher hands the emitter back to the test so it
// can play llama-server's download/load stages itself.
function fakeDeps({ loadedAnswers, bytes = 0 }) {
  const calls = { warmCount: 0, watcherStarted: 0, watcherStopped: 0 };
  let i = 0;
  const deps = {
    isModelLoaded: async () => {
      const v = loadedAnswers[Math.min(i, loadedAnswers.length - 1)];
      i++;
      return v;
    },
    startModelProgressWatcher: (opts) => {
      calls.watcherStarted++;
      calls.emitter = opts.emitter;
      return () => { calls.watcherStopped++; };
    },
    downloadInProgressBytes: () => bytes,
  };
  return { deps, calls };
}

describe("preloadMainModel", () => {
  test("does nothing when the model is already resident — no watcher, no warm request", async () => {
    const { deps, calls } = fakeDeps({ loadedAnswers: [true] });
    const result = await preloadMainModel({ ...BASE, warm: async () => { calls.warmCount++; } }, deps);
    assert.equal(result, "already-loaded");
    assert.equal(calls.warmCount, 0);
    assert.equal(calls.watcherStarted, 0);
  });

  test("cold model: warms, publishes watcher events on the app-wide bus, resolves loaded, and clears state", async () => {
    const { deps, calls } = fakeDeps({ loadedAnswers: [false, true] });
    const seen = [];
    const off = onModelStatus(p => seen.push(p));
    try {
      const result = await preloadMainModel({
        ...BASE,
        warm: async () => {
          calls.warmCount++;
          // Mid-warm the watcher reports a download; the bus must carry it and
          // currentModelStatus must expose it to late-connecting sockets.
          calls.emitter.send({ type: "model_status", model: BASE.model, status: "downloading", gotGB: 1.4, totalGB: 3.9 });
          assert.equal(currentModelStatus()?.status, "downloading");
        },
      }, deps);
      assert.equal(result, "loaded");
      assert.equal(calls.warmCount, 1);
      assert.equal(calls.watcherStopped, 1);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].gotGB, 1.4);
      assert.equal(currentModelStatus(), null, "state must clear once the preload settles");
    } finally { off(); }
  });

  test("keeps waiting while bytes are still arriving, then succeeds when the model turns resident", async () => {
    // loaded: probe(false) → warm#1 → false, bytes>0 → warm#2 → true
    const { deps, calls } = fakeDeps({ loadedAnswers: [false, false, true], bytes: 1024 });
    const result = await preloadMainModel({ ...BASE, warm: async () => { calls.warmCount++; } }, deps);
    assert.equal(result, "loaded");
    assert.equal(calls.warmCount, 2, "a warm-up timed out mid-download must be retried");
  });

  test("gives up when the model neither loads nor downloads — a broken engine must not be hammered forever", async () => {
    const { deps, calls } = fakeDeps({ loadedAnswers: [false], bytes: 0 });
    const result = await preloadMainModel({ ...BASE, warm: async () => { calls.warmCount++; } }, deps);
    assert.equal(result, "failed");
    assert.equal(calls.warmCount, 1);
    assert.equal(calls.watcherStopped, 1, "the watcher must be stopped on the failure path too");
    assert.equal(currentModelStatus(), null);
  });

  test("a ready event clears currentModelStatus so new connections stop replaying a stale banner", async () => {
    const { deps, calls } = fakeDeps({ loadedAnswers: [false, true] });
    await preloadMainModel({
      ...BASE,
      warm: async () => {
        calls.emitter.send({ type: "model_status", model: BASE.model, status: "downloading", gotGB: 3.9, totalGB: 3.9 });
        calls.emitter.send({ type: "model_status", model: BASE.model, status: "ready" });
        assert.equal(currentModelStatus(), null, "ready must clear the replayed status immediately");
      },
    }, deps);
  });
});
