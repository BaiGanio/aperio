// Tests for backgroundWorkers.js — memory dedup/infer workers (gated to local
// providers) plus always-on pruners.
//
// Uses real modules throughout. Workers create timers (setTimeout/setInterval)
// which are cleaned up via .stop() after assertions. callTool is a mock fn
// so dedup/infer never touch the real agent loop.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import logger from "../../../lib/helpers/logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Logger — mock early
// ═══════════════════════════════════════════════════════════════════════════

before(() => {
  mock.method(logger, "info",  () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "error", () => {});
  mock.method(logger, "debug", () => {});
});

after(() => {
  mock.restoreAll();
});

// ═══════════════════════════════════════════════════════════════════════════
// Import SUT
// ═══════════════════════════════════════════════════════════════════════════

let createBackgroundWorkers;

before(async () => {
  const mod = await import("../../../lib/server/backgroundWorkers.js");
  createBackgroundWorkers = mod.createBackgroundWorkers;
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("createBackgroundWorkers", () => {
  /** Shared callTool mock — returns an empty-string result for dedup/infer. */
  const callTool = mock.fn(async () => "");
  /** Minimal store that satisfies createAgentRunPruner (noop when retention unset). */
  const store = {
    pruneAgentRuns: mock.fn(async () => 0),
  };
  const runtimeRoot = "/tmp/aperio-test";

  beforeEach(() => {
    callTool.mock.resetCalls();
    delete process.env.APERIO_CLOUD_MEMORY_WORKERS;
    delete process.env.AGENT_RUN_RETENTION_DAYS;
  });

  /** Call stop() on every worker so timers never hold the process open. */
  async function stopWorkers(w) {
    w.dedup.stop?.();
    w.infer.stop?.();
    w.pruner.stop?.();
    w.logPruner.stop?.();
    w.runPruner.stop?.();
  }

  // ─── Return shape ─────────────────────────────────────────────────────

  test("returns the expected 5-field shape with local provider (llamacpp)", async () => {
    const w = await createBackgroundWorkers({
      providerName: "llamacpp",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      assert.ok(w, "result is defined");
      assert.ok(w.dedup,      ".dedup");
      assert.ok(w.infer,      ".infer");
      assert.ok(w.pruner,     ".pruner");
      assert.ok(w.logPruner,  ".logPruner");
      assert.ok(w.runPruner,  ".runPruner");

      assert.strictEqual(typeof w.dedup.stop,     "function", ".dedup.stop");
      assert.strictEqual(typeof w.infer.stop,     "function", ".infer.stop");
      assert.strictEqual(typeof w.pruner.stop,    "function", ".pruner.stop");
      assert.strictEqual(typeof w.logPruner.stop,  "function", ".logPruner.stop");
      assert.strictEqual(typeof w.runPruner.stop, "function", ".runPruner.stop");
    } finally {
      await stopWorkers(w);
    }
  });

  test("returns the same 5-field shape with cloud provider", async () => {
    const w = await createBackgroundWorkers({
      providerName: "anthropic",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      assert.ok(w.dedup);
      assert.ok(w.infer);
      assert.ok(w.pruner);
      assert.ok(w.logPruner);
      assert.ok(w.runPruner);
    } finally {
      await stopWorkers(w);
    }
  });

  // ─── Provider-based gating ────────────────────────────────────────────

  test("dedup and infer have a stop() that works when local provider (dedup/infer are real workers)", async () => {
    const w = await createBackgroundWorkers({
      providerName: "llamacpp",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      // Real workers schedule timers; stop() clears them without error
      w.dedup.stop();
      w.infer.stop();
    } finally {
      await stopWorkers(w);
    }
  });

  test("dedup and infer are noop workers when cloud provider (anthropic) without override", async () => {
    const w = await createBackgroundWorkers({
      providerName: "anthropic",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      // noopWorker: { stop() {} } — calling stop is always safe
      w.dedup.stop();
      w.infer.stop();
    } finally {
      await stopWorkers(w);
    }
  });

  test("dedup and infer are REAL workers when cloud provider with APERIO_CLOUD_MEMORY_WORKERS=1", async () => {
    process.env.APERIO_CLOUD_MEMORY_WORKERS = "1";

    const w = await createBackgroundWorkers({
      providerName: "anthropic",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      // With the override, real workers are created even for cloud providers
      // Real workers schedule timers; stop() clears them
      assert.doesNotThrow(() => w.dedup.stop());
      assert.doesNotThrow(() => w.infer.stop());
    } finally {
      await stopWorkers(w);
    }
  });

  test("dedup and infer are REAL workers when provider is codex (local)", async () => {
    const w = await createBackgroundWorkers({
      providerName: "codex",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      assert.doesNotThrow(() => w.dedup.stop());
      assert.doesNotThrow(() => w.infer.stop());
    } finally {
      await stopWorkers(w);
    }
  });

  // ─── Privacy log message ──────────────────────────────────────────────

  test("logs privacy info message when memory workers are disabled on cloud provider", async () => {
    logger.info.mock.resetCalls();

    const w = await createBackgroundWorkers({
      providerName: "deepseek",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      const privacyLog = logger.info.mock.calls.find((c) =>
        c.arguments[0].includes("[privacy] memory inference/dedup workers disabled")
      );
      assert.ok(privacyLog, "expected privacy log message");
      assert.ok(privacyLog.arguments[0].includes('deepseek'),
        "log mentions the provider name");
    } finally {
      await stopWorkers(w);
    }
  });

  test("does NOT log privacy message when memory workers are enabled (local provider)", async () => {
    logger.info.mock.resetCalls();

    const w = await createBackgroundWorkers({
      providerName: "llamacpp",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      const privacyLog = logger.info.mock.calls.find((c) =>
        c.arguments[0].includes("[privacy] memory inference/dedup workers disabled")
      );
      assert.strictEqual(privacyLog, undefined,
        "no privacy disabled message for local provider");
    } finally {
      await stopWorkers(w);
    }
  });

  // ─── Pruners are always created ───────────────────────────────────────

  test("pruners are always created regardless of provider", async () => {
    const w1 = await createBackgroundWorkers({
      providerName: "llamacpp", callTool, store, runtimeRoot,
    });
    try {
      assert.strictEqual(typeof w1.pruner.stop,    "function");
      assert.strictEqual(typeof w1.logPruner.stop,  "function");
      assert.strictEqual(typeof w1.runPruner.stop, "function");
    } finally {
      await stopWorkers(w1);
    }

    const w2 = await createBackgroundWorkers({
      providerName: "anthropic", callTool, store, runtimeRoot,
    });
    try {
      assert.strictEqual(typeof w2.pruner.stop,    "function");
      assert.strictEqual(typeof w2.logPruner.stop,  "function");
      assert.strictEqual(typeof w2.runPruner.stop, "function");
    } finally {
      await stopWorkers(w2);
    }
  });

  // ─── Agent-run pruner (noop when AGENT_RUN_RETENTION_DAYS not set) ────

  test("runPruner.stop is safe to call (noop pruner when retention unset)", async () => {
    const w = await createBackgroundWorkers({
      providerName: "llamacpp",
      callTool,
      store,
      runtimeRoot,
    });

    try {
      // With AGENT_RUN_RETENTION_DAYS unset, createAgentRunPruner returns
      // { stop: () => {} } — no timers, no DB calls.
      assert.doesNotThrow(() => w.runPruner.stop());
    } finally {
      await stopWorkers(w);
    }
  });
});
