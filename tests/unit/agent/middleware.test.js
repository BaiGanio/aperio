import test from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_HOOKS,
  LifecycleMiddlewareError,
  createLifecycleRunner,
} from "../../../lib/agent/middleware.js";
import { createLifecycleTrace } from "../../../lib/agent/lifecycle-trace.js";

test("exports the complete ordered lifecycle hook contract", () => {
  assert.deepEqual(LIFECYCLE_HOOKS, [
    "beforeModel",
    "selectTools",
    "beforeTool",
    "afterTool",
    "afterModel",
    "onInterrupt",
    "onError",
  ]);
  assert.equal(Object.isFrozen(LIFECYCLE_HOOKS), true);
});

test("runs async middleware in registration order and passes updates forward", async () => {
  const calls = [];
  const runner = createLifecycleRunner([
    {
      name: "first",
      async beforeModel(request, lifecycle) {
        await Promise.resolve();
        calls.push([lifecycle.middleware, request.count]);
        return { update: { count: request.count + 1, selected: ["memory"] } };
      },
    },
    {
      name: "second",
      beforeModel(request, lifecycle) {
        calls.push([lifecycle.middleware, request.count, request.selected]);
        assert.deepEqual(lifecycle.context, { runId: "run-1" });
        return { update: { count: request.count + 1 } };
      },
    },
  ]);

  const result = await runner.run("beforeModel", { count: 0 }, { runId: "run-1" });

  assert.deepEqual(calls, [
    ["first", 0],
    ["second", 1, ["memory"]],
  ]);
  assert.deepEqual(result, {
    request: { count: 2, selected: ["memory"] },
    stopped: false,
  });
  assert.deepEqual(runner.middlewareNames, ["first", "second"]);
});

test("isolates the caller and each middleware with immutable request snapshots", async () => {
  const original = { nested: { enabled: true }, tools: ["read_file"] };
  let firstSnapshot;
  const runner = createLifecycleRunner([
    {
      name: "immutable",
      beforeTool(request) {
        firstSnapshot = request;
        assert.equal(Object.isFrozen(request), true);
        assert.equal(Object.isFrozen(request.nested), true);
        assert.equal(Object.isFrozen(request.tools), true);
        assert.throws(() => { request.nested.enabled = false; }, TypeError);
        assert.throws(() => { request.tools.push("write_file"); }, TypeError);
        return { update: { nested: { enabled: false } } };
      },
    },
    {
      name: "fresh-snapshot",
      beforeTool(request) {
        assert.notEqual(request, firstSnapshot);
        assert.deepEqual(request.nested, { enabled: false });
      },
    },
  ]);

  const result = await runner.run("beforeTool", original);

  assert.deepEqual(original, { nested: { enabled: true }, tools: ["read_file"] });
  assert.deepEqual(result.request, {
    nested: { enabled: false },
    tools: ["read_file"],
  });
});

test("short-circuits remaining middleware after applying the final update", async () => {
  let reached = false;
  const runner = createLifecycleRunner([
    {
      name: "approval-gate",
      beforeTool() {
        return {
          stop: true,
          value: { interrupt: "confirm-write" },
          update: { approved: false },
        };
      },
    },
    {
      name: "executor",
      beforeTool() {
        reached = true;
      },
    },
  ]);

  const result = await runner.run("beforeTool", { approved: null });

  assert.equal(reached, false);
  assert.deepEqual(result, {
    request: { approved: false },
    stopped: true,
    value: { interrupt: "confirm-write" },
  });
});

test("wraps failures and notifies every onError observer in order", async () => {
  const observed = [];
  const cause = new Error("tool policy unavailable");
  const runner = createLifecycleRunner([
    {
      name: "observer-a",
      onError(request, lifecycle) {
        observed.push([
          lifecycle.middleware,
          request.failedHook,
          request.failedMiddleware,
          request.error,
        ]);
      },
    },
    {
      name: "policy",
      selectTools() {
        throw cause;
      },
    },
    {
      name: "observer-b",
      async onError(request, lifecycle) {
        await Promise.resolve();
        observed.push([lifecycle.middleware, request.error]);
      },
    },
  ]);

  await assert.rejects(
    runner.run("selectTools", { tools: [] }),
    error => {
      assert.equal(error instanceof LifecycleMiddlewareError, true);
      assert.equal(error.hook, "selectTools");
      assert.equal(error.middleware, "policy");
      assert.equal(error.cause, cause);
      return true;
    },
  );
  assert.deepEqual(observed, [
    ["observer-a", "selectTools", "policy", observed[0][3]],
    ["observer-b", observed[0][3]],
  ]);
  assert.equal(observed[0][3] instanceof LifecycleMiddlewareError, true);
});

test("onError observer failures do not mask the originating failure", async () => {
  const runner = createLifecycleRunner([
    {
      name: "broken-observer",
      onError() {
        throw new Error("telemetry unavailable");
      },
    },
    {
      name: "model-policy",
      afterModel() {
        throw new Error("unsafe output");
      },
    },
  ]);

  await assert.rejects(
    runner.run("afterModel", {}),
    error => {
      assert.equal(error.middleware, "model-policy");
      assert.equal(error.cause.message, "unsafe output");
      assert.equal(error.onErrorErrors.length, 1);
      assert.equal(error.onErrorErrors[0].middleware, "broken-observer");
      return true;
    },
  );
});

test("rejects invalid registrations, hooks, requests, and hook results", async () => {
  assert.throws(() => createLifecycleRunner({}), /must be an array/);
  assert.throws(() => createLifecycleRunner([{}]), /non-empty name/);
  assert.throws(
    () => createLifecycleRunner([{ name: "same" }, { name: "same" }]),
    /Duplicate/,
  );
  assert.throws(
    () => createLifecycleRunner([{ name: "bad", beforeModel: true }]),
    /must be a function/,
  );
  assert.throws(
    () => createLifecycleRunner([{ name: "typo", beforeModle() {} }]),
    /unknown field "beforeModle"/,
  );

  const runner = createLifecycleRunner([
    { name: "invalid-result", beforeModel: () => "changed" },
  ]);
  await assert.rejects(runner.run("unknown", {}), /Unknown lifecycle hook/);
  await assert.rejects(runner.run("beforeModel", []), /must be an object/);
  await assert.rejects(
    runner.run("beforeModel", {}),
    error => error instanceof LifecycleMiddlewareError
      && error.cause.message.includes("must return an object"),
  );
});

test("records metadata-only timing, decisions, and errors in a bounded trace", async () => {
  let tick = 100;
  const now = () => tick++;
  const trace = createLifecycleTrace({ limit: 3, now });
  const runner = createLifecycleRunner([
    {
      name: "updates",
      beforeModel() {
        return { update: { secretPrompt: "must not be traced" } };
      },
    },
    {
      name: "stops",
      beforeTool() {
        return { stop: true, value: { token: "must not be traced" } };
      },
    },
    {
      name: "fails",
      afterModel() {
        throw new TypeError("secret result must not be traced");
      },
    },
    {
      name: "observes",
      onError() {},
    },
  ], { trace, now });

  await runner.run("beforeModel", { apiKey: "must not be traced" });
  await runner.run("beforeTool", { arguments: { password: "must not be traced" } });
  await assert.rejects(runner.run("afterModel", { result: "must not be traced" }));

  const entries = trace.entries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(entry => [entry.hook, entry.middleware, entry.decision]), [
    ["beforeTool", "stops", "stop"],
    ["afterModel", "fails", "error"],
    ["onError", "observes", "continue"],
  ]);
  assert.equal(entries[1].errorType, "TypeError");
  assert.deepEqual(trace.stats(), { retained: 3, dropped: 1, limit: 3 });
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /apiKey|password|secretPrompt|secret result|token/);
  assert.equal(Object.isFrozen(entries), true);
  assert.equal(Object.isFrozen(entries[0]), true);
});

test("trace normalizes arbitrary error names instead of storing attacker text", () => {
  const trace = createLifecycleTrace();
  trace.record({
    hook: "afterTool",
    middleware: "test",
    durationMs: 1,
    decision: "error",
    errorType: "sk_live_must_not_be_traced",
  });
  assert.equal(trace.entries()[0].errorType, "Error");
  assert.doesNotMatch(JSON.stringify(trace.entries()), /sk_live/);
});

test("trace recording failures never change middleware behavior", async () => {
  const runner = createLifecycleRunner([
    { name: "safe", selectTools: () => ({ update: { tools: ["recall"] } }) },
  ], {
    trace: { record() { throw new Error("trace unavailable"); } },
  });

  const result = await runner.run("selectTools", { tools: [] });
  assert.deepEqual(result.request.tools, ["recall"]);
  assert.throws(
    () => createLifecycleRunner([], { trace: {} }),
    /must provide record/,
  );
});
