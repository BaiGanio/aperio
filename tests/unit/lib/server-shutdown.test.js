import { test } from "node:test";
import assert from "node:assert/strict";

import { finishBootBeforeShutdown } from "../../../lib/server.js";

test("shutdown during late boot waits for full teardown", async () => {
  const calls = [];
  let releaseBoot;
  let fullShutdown = null;
  const bootAppPromise = new Promise((resolve) => {
    releaseBoot = () => {
      fullShutdown = async () => {
        calls.push("scheduler");
        calls.push("watchers");
        calls.push("llamacpp");
        calls.push("embeddings");
        calls.push("store");
        calls.push("http");
      };
      resolve();
    };
  });

  const shutdownPromise = finishBootBeforeShutdown({
    bootAppPromise,
    getFullShutdown: () => fullShutdown,
    earlyShutdown: async () => calls.push("early-http-only"),
  });

  await Promise.resolve();
  assert.deepEqual(calls, [], "shutdown waits while late boot still owns resources");

  releaseBoot();
  await shutdownPromise;

  assert.deepEqual(calls, [
    "scheduler",
    "watchers",
    "llamacpp",
    "embeddings",
    "store",
    "http",
  ]);
});
