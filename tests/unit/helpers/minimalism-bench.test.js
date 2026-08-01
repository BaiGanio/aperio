// tests/unit/helpers/minimalism-bench.test.js — WS2 of epic #285.
// Groups E2 (metrics) and E7 (verdict) of trash/plans/ponytail-borrow/ponytail-borrow-ws2-tests.md.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  countSourceLoc, locDelta, sumUsage, collectCellMetrics, runFixtureTests, median, medianAbsoluteDeviation,
  computeVerdict, isMatrixComplete, renderTranscript, renderReport, REPO_ROOT, DUPLICATE_FAILURE_BUDGET, EVAL_MODE,
} from "../../../lib/helpers/minimalismBench.js";
import { buildRunPlan, buildFixtureCellPlan, buildBenchPrompt, BENCH_TOOL_ALLOWLIST, createBenchHostTools } from "../../../scripts/minimalism-bench.js";
import {
  LIVE_EVAL_PORT, LIVE_EVAL_BASE_URL, createLiveEvalPaths, waitForLlamaReadiness,
  assertLiveUsage, teardownLiveEval, startIsolatedLlamaEval,
} from "../../../lib/helpers/minimalismLiveEval.js";

const FIXTURE = (id) => resolve(REPO_ROOT, "tests/fixtures/minimalism-tasks", id);

describe("live minimalism-bench isolation", () => {
  test("uses the dedicated port and keeps runtime state outside the repository", () => {
    const paths = createLiveEvalPaths("org/model:Q4_K_M");
    try {
      assert.equal(LIVE_EVAL_PORT, "18080");
      assert.equal(LIVE_EVAL_BASE_URL, "http://127.0.0.1:18080");
      assert.ok(!paths.runtimeRoot.startsWith(REPO_ROOT));
      assert.ok(!paths.ledgerPath.startsWith(resolve(REPO_ROOT, "var", "autotune")));
      assert.match(paths.ledgerPath, /org_model_Q4_K_M/);
    } finally {
      rmSync(paths.runtimeRoot, { recursive: true, force: true });
      rmSync(paths.ledgerPath, { force: true });
    }
  });

  test("readiness requires health and the requested model", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith("/health")) return { ok: true, status: 200 };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "aperio-main" }] }) };
    };
    const result = await waitForLlamaReadiness({ model: "org/model:Q4_K_M", fetchImpl, timeoutMs: 20, pollMs: 1 });
    assert.equal(result.ready, true);
    assert.deepEqual(calls, ["http://127.0.0.1:18080/health", "http://127.0.0.1:18080/v1/models"]);
  });

  test("startup owns the child with the dedicated URL, port, model, and temporary cwd", () => {
    const paths = createLiveEvalPaths("org/model:Q4_K_M");
    let captured;
    try {
      const handle = startIsolatedLlamaEval({
        model: "org/model:Q4_K_M",
        paths,
        bootstrapPath: "/repo/scripts/minimalism-live-server.js",
        env: { KEEP_ME: "yes" },
        spawnImpl: (...args) => {
          captured = args;
          return { pid: 7, exitCode: 0, signalCode: null };
        },
      });
      assert.equal(handle.child.pid, 7);
      assert.equal(captured[0], process.execPath);
      assert.deepEqual(captured[1], ["/repo/scripts/minimalism-live-server.js"]);
      assert.equal(captured[2].cwd, paths.runtimeRoot);
      assert.equal(captured[2].env.LLAMACPP_PORT, "18080");
      assert.equal(captured[2].env.LLAMACPP_BASE_URL, LIVE_EVAL_BASE_URL);
      assert.equal(captured[2].env.LLAMACPP_MODEL, "org/model:Q4_K_M");
      assert.equal(captured[2].env.KEEP_ME, "yes");
    } finally {
      rmSync(paths.runtimeRoot, { recursive: true, force: true });
      rmSync(paths.ledgerPath, { force: true });
    }
  });

  test("readiness fails when the requested model is unavailable", async () => {
    await assert.rejects(
      waitForLlamaReadiness({
        model: "org/missing:Q4_K_M",
        fetchImpl: async (url) => url.endsWith("/health")
          ? { ok: true, status: 200 }
          : { ok: true, status: 200, json: async () => ({ data: [{ id: "aperio-main", hf_repo: "org/other:Q4_K_M" }] }) },
        timeoutMs: 5,
        pollMs: 1,
      }),
      /requested model is unavailable/,
    );
  });

  test("zero-usage cells invalidate a live run", () => {
    assert.throws(() => assertLiveUsage({ task: "slug-helper", arm: "A", repeat: 1, input_tokens: 0, output_tokens: 0 }), /zero token usage/);
    assert.doesNotThrow(() => assertLiveUsage({ task: "slug-helper", arm: "A", repeat: 1, input_tokens: 1, output_tokens: 0 }));
  });

  test("teardown signals the owned child and removes its runtime root", async () => {
    const paths = createLiveEvalPaths("org/model");
    const listeners = new Map();
    const child = { pid: 424242, exitCode: null, signalCode: null, once(event, fn) { listeners.set(event, fn); } };
    const signals = [];
    await teardownLiveEval({ child, runtimeRoot: paths.runtimeRoot }, {
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        child.exitCode = 0;
        listeners.get("exit")?.();
      },
      timeoutMs: 20,
    });
    assert.deepEqual(signals, [[424242, "SIGTERM"]]);
    assert.equal(existsSync(paths.runtimeRoot), false);
    rmSync(paths.ledgerPath, { force: true });
  });
});

// ── E2 — Metrics ──────────────────────────────────────────────────────────
describe("E2 — LOC counter ignores blanks and comments", () => {
  test("a naive `//` split would miscount a string literal containing '//'", () => {
    const text = [
      "/**",
      " * JSDoc comment",
      " * @param {string} x",
      " */",
      "function foo(x) {",
      "",
      "  // line comment",
      '  const url = "http://example.com"; // trailing comment',
      "  /* inline block */ return x;",
      "}",
    ].join("\n");
    // Counted: `function foo(x) {`, the url assignment line (the string-literal
    // `//` must not be treated as a comment start), the inline-block-comment
    // line (code survives after the closing `*/`), and the closing `}`.
    assert.equal(countSourceLoc(text), 4);
  });

  test("blank lines and pure comment lines are excluded", () => {
    assert.equal(countSourceLoc("\n\n   \n"), 0);
    assert.equal(countSourceLoc("// only a comment\n"), 0);
    assert.equal(countSourceLoc("/* a\nmultiline\nblock */\n"), 0);
  });
});

describe("E2 — workspace LOC delta", () => {
  test("untouched contributes 0, modified contributes its delta, new/deleted contribute full LOC", () => {
    const before = new Map([
      ["untouched.js", "const a = 1;\n"],
      ["modified.js", "const a = 1;\nconst b = 2;\n"],
      ["deleted.js", "const a = 1;\nconst b = 2;\nconst c = 3;\n"],
    ]);
    const after = new Map([
      ["untouched.js", "const a = 1;\n"],
      ["modified.js", "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n"],
      ["new.js", "const x = 1;\nconst y = 2;\n"],
    ]);
    // untouched: 0, modified: +3 (2 -> 5), deleted: -3 (3 -> 0), new: +2 (0 -> 2)
    assert.equal(locDelta(before, after), 2);
  });

  test("a file deleted by the model contributes a negative delta, not a crash", () => {
    const before = new Map([["gone.js", "const a = 1;\nconst b = 2;\n"]]);
    const after = new Map();
    assert.equal(locDelta(before, after), -2);
  });
});

describe("E2 — token accounting", () => {
  test("sums input/output across stream_end events; missing usage contributes 0, not NaN", () => {
    const events = [
      { type: "stream_end", usage: { input_tokens: 100, output_tokens: 20 } },
      { type: "token", text: "x" },
      { type: "stream_end", usage: { input_tokens: 50, output_tokens: 10 } },
      { type: "stream_end" }, // usage absent entirely
      { type: "stream_end", usage: { input_tokens: 30, output_tokens: 5 } },
    ];
    const usage = sumUsage(events);
    assert.equal(usage.input, 180);
    assert.equal(usage.output, 35);
    assert.equal(usage.net, 215);
    assert.ok(Number.isFinite(usage.net), "net must never be NaN");
  });

  test("a real zeroUsage() frame contributes 0 the same as a real value would, not skipped as missing", () => {
    const events = [
      { type: "stream_end", usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 } },
      { type: "stream_end", usage: { input_tokens: 40, output_tokens: 4 } },
    ];
    assert.deepEqual(sumUsage(events), { input: 40, output: 4, net: 44 });
  });
});

describe("collectCellMetrics — per-request/recovery counts (issue #336)", () => {
  test("counts requests, tool calls/errors, duplicate calls, context trims, and the max single-request input", () => {
    const events = [
      { type: "stream_end", usage: { input_tokens: 100, output_tokens: 20 } },
      { type: "tool_call", name: "read_file", args: { path: "a.js" }, result: "❌ a.js not found" },
      { type: "tool_call", name: "read_file", args: { path: "a.js" }, result: "❌ a.js not found" },
      { type: "context_trimmed", dropped: 2, pct: 0.3 },
      { type: "stream_end", usage: { input_tokens: 4000, output_tokens: 30 } },
      { type: "tool_call", name: "write_file", args: { path: "a.js", content: "x" }, result: "wrote a.js" },
    ];
    assert.deepEqual(collectCellMetrics(events), {
      requestCount: 2,
      toolCallCount: 3,
      toolErrorCount: 2,
      duplicateCallCount: 1,
      contextTrimCount: 1,
      maxInputTokens: 4000,
    });
  });

  test("empty/missing events produce all-zero metrics, never NaN or a throw", () => {
    assert.deepEqual(collectCellMetrics([]), {
      requestCount: 0, toolCallCount: 0, toolErrorCount: 0,
      duplicateCallCount: 0, contextTrimCount: 0, maxInputTokens: 0,
    });
    assert.deepEqual(collectCellMetrics(undefined), {
      requestCount: 0, toolCallCount: 0, toolErrorCount: 0,
      duplicateCallCount: 0, contextTrimCount: 0, maxInputTokens: 0,
    });
  });

  test("a third identical call counts as a second duplicate, not capped at one", () => {
    const events = [
      { type: "tool_call", name: "read_file", args: { path: "a.js" }, result: "❌ not found" },
      { type: "tool_call", name: "read_file", args: { path: "a.js" }, result: "❌ not found" },
      { type: "tool_call", name: "read_file", args: { path: "a.js" }, result: "❌ not found" },
    ];
    assert.equal(collectCellMetrics(events).duplicateCallCount, 2);
  });

  test("stream_end frames without usage do not count as a request", () => {
    const events = [{ type: "stream_end", text: "done" }];
    assert.equal(collectCellMetrics(events).requestCount, 0);
  });
});

describe("E2 — correctness runner reports honest failure", () => {
  const testsDir = join(FIXTURE("slug-helper"), "tests");

  test("a passing solution scores true", () => {
    assert.equal(runFixtureTests({ testsDir, solutionDir: join(FIXTURE("slug-helper"), "reference") }), true);
  });

  test("a failing solution scores false, never throws", () => {
    const badDir = mkdtempSync(join(tmpdir(), "minimalism-bad-"));
    try {
      writeFileSync(join(badDir, "slugify.js"), "export function slugify(title) { return title; }\n");
      assert.equal(runFixtureTests({ testsDir, solutionDir: badDir }), false);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  test("a missing solution file scores false, never throws", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "minimalism-empty-"));
    try {
      assert.equal(runFixtureTests({ testsDir, solutionDir: emptyDir }), false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("a hanging reference test is killed by timeout and scores false", () => {
    const hangDir = mkdtempSync(join(tmpdir(), "minimalism-hang-"));
    const hangTests = mkdtempSync(join(tmpdir(), "minimalism-hang-tests-"));
    try {
      mkdirSync(join(hangTests), { recursive: true });
      writeFileSync(join(hangTests, "hang.test.js"), [
        'import { test } from "node:test";',
        'test("hangs forever", async () => { await new Promise(() => {}); });',
      ].join("\n"));
      const start = Date.now();
      const result = runFixtureTests({ testsDir: hangTests, solutionDir: hangDir, timeoutMs: 500 });
      assert.equal(result, false);
      assert.ok(Date.now() - start < 5000, "timeout should cut the hang short");
    } finally {
      rmSync(hangDir, { recursive: true, force: true });
      rmSync(hangTests, { recursive: true, force: true });
    }
  });
});

// ── E7 — Verdict function ────────────────────────────────────────────────

function row(task, arm, repeat, { loc, net_tokens, correct = true }) {
  return { task, arm, repeat, loc, net_tokens, correct };
}

describe("E7 — pre-registered thresholds produce the pre-registered verdicts", () => {
  test("a clear win (LOC down >=15%, net tokens down, correctness held) -> KEEP", () => {
    const rows = [
      row("t1", "B", 1, { loc: 100, net_tokens: 500 }), row("t1", "B", 2, { loc: 102, net_tokens: 510 }), row("t1", "B", 3, { loc: 101, net_tokens: 505 }),
      row("t1", "A", 1, { loc: 70, net_tokens: 300 }), row("t1", "A", 2, { loc: 72, net_tokens: 310 }), row("t1", "A", 3, { loc: 71, net_tokens: 305 }),
    ];
    assert.equal(computeVerdict(rows), "KEEP");
  });

  test("an LOC win with positive net tokens -> TRIM", () => {
    const rows = [
      row("t1", "B", 1, { loc: 100, net_tokens: 400 }), row("t1", "B", 2, { loc: 101, net_tokens: 401 }), row("t1", "B", 3, { loc: 99, net_tokens: 399 }),
      row("t1", "A", 1, { loc: 80, net_tokens: 600 }), row("t1", "A", 2, { loc: 81, net_tokens: 601 }), row("t1", "A", 3, { loc: 79, net_tokens: 599 }),
    ];
    assert.equal(computeVerdict(rows), "TRIM");
  });

  test("no effect at equal correctness -> DROP", () => {
    const rows = [
      row("t1", "B", 1, { loc: 100, net_tokens: 500 }), row("t1", "B", 2, { loc: 100, net_tokens: 500 }), row("t1", "B", 3, { loc: 100, net_tokens: 500 }),
      row("t1", "A", 1, { loc: 100, net_tokens: 500 }), row("t1", "A", 2, { loc: 100, net_tokens: 500 }), row("t1", "A", 3, { loc: 100, net_tokens: 500 }),
    ];
    assert.equal(computeVerdict(rows), "DROP");
  });

  test("a correctness regression disqualifies even a huge LOC win -> DROP", () => {
    const rows = [
      row("t1", "B", 1, { loc: 200, net_tokens: 500, correct: true }), row("t1", "B", 2, { loc: 201, net_tokens: 500, correct: true }), row("t1", "B", 3, { loc: 199, net_tokens: 500, correct: true }),
      row("t1", "A", 1, { loc: 10, net_tokens: 100, correct: false }), row("t1", "A", 2, { loc: 11, net_tokens: 100, correct: false }), row("t1", "A", 3, { loc: 9, net_tokens: 100, correct: false }),
    ];
    assert.equal(computeVerdict(rows), "DROP");
  });

  test("a PARTIAL correctness regression disqualifies too, even when the baseline itself wasn't flawless", () => {
    // B passes 2/3 repeats (bRows.every(...) is already false); A passes 0/3.
    // A's pass rate (0) is still strictly worse than B's (2/3) — this must
    // register as a regression, not fall through to a token/LOC-driven KEEP.
    const rows = [
      row("t1", "B", 1, { loc: 100, net_tokens: 500, correct: true }),
      row("t1", "B", 2, { loc: 100, net_tokens: 500, correct: true }),
      row("t1", "B", 3, { loc: 100, net_tokens: 500, correct: false }),
      row("t1", "A", 1, { loc: 60, net_tokens: 200, correct: false }),
      row("t1", "A", 2, { loc: 60, net_tokens: 200, correct: false }),
      row("t1", "A", 3, { loc: 60, net_tokens: 200, correct: false }),
    ];
    assert.equal(computeVerdict(rows), "DROP");
  });

  test("an effect smaller than the inter-repeat spread returns INCONCLUSIVE, never a rounded-up KEEP", () => {
    const rows = [
      row("t1", "B", 1, { loc: 100, net_tokens: 500 }), row("t1", "B", 2, { loc: 100, net_tokens: 500 }), row("t1", "B", 3, { loc: 100, net_tokens: 500 }),
      row("t1", "A", 1, { loc: 101, net_tokens: 500 }), row("t1", "A", 2, { loc: 99, net_tokens: 500 }), row("t1", "A", 3, { loc: 80, net_tokens: 500 }),
    ];
    assert.equal(computeVerdict(rows), "INCONCLUSIVE");
  });
});

describe("E7 — medians, not means", () => {
  test("median() of an even-length array is the mean of the middle two", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([4, 1, 3, 2]), 2.5); // unsorted input
  });

  test("median() of an odd-length array is the middle value", () => {
    assert.equal(median([5, 1, 3]), 3);
  });

  test("the verdict is unchanged by one extreme outlier repeat", () => {
    const base = [
      row("t1", "B", 1, { loc: 100, net_tokens: 500 }), row("t1", "B", 2, { loc: 100, net_tokens: 500 }),
      row("t1", "B", 3, { loc: 100, net_tokens: 500 }), row("t1", "B", 4, { loc: 100, net_tokens: 500 }),
      row("t1", "A", 1, { loc: 70, net_tokens: 300 }), row("t1", "A", 2, { loc: 70, net_tokens: 300 }),
      row("t1", "A", 3, { loc: 70, net_tokens: 300 }), row("t1", "A", 4, { loc: 70, net_tokens: 300 }),
    ];
    const withOutlier = base.map(r => (r.task === "t1" && r.arm === "A" && r.repeat === 4) ? { ...r, loc: 1000 } : r);
    assert.equal(computeVerdict(base), computeVerdict(withOutlier));
    assert.equal(computeVerdict(withOutlier), "KEEP");
  });
});

// ── Runner fixes (code review, WS2) ────────────────────────────────────────
describe("scripts/minimalism-bench.js — warm-up discard", () => {
  test("a dry run has no warm-up cell", () => {
    const plan = buildFixtureCellPlan({ dryRun: true, repeats: 2 });
    assert.equal(plan.some(c => c.discard), false);
    assert.deepEqual(plan.map(c => c.arm), buildRunPlan(2).map(c => c.arm));
  });

  test("a live run's first two cells are discarded warm-ups, one per arm, ahead of the recorded matrix", () => {
    const plan = buildFixtureCellPlan({ dryRun: false, repeats: 3 });
    assert.equal(plan[0].discard, true);
    assert.equal(plan[0].arm, "A");
    assert.equal(plan[1].discard, true);
    assert.equal(plan[1].arm, "B");
    assert.deepEqual(plan.slice(2), buildRunPlan(3).map(c => ({ ...c, discard: false })));
  });
});

describe("scripts/minimalism-bench.js — cross-platform workspace containment", () => {
  test("file tools expose explicit path/content schemas", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-schema-"));
    const tools = createBenchHostTools(workspaceDir);
    try {
      const writeFile = tools.find(t => t.name === "write_file");
      const readFile = tools.find(t => t.name === "read_file");
      const listFiles = tools.find(t => t.name === "list_files");
      assert.deepEqual(writeFile.inputSchema.required, ["path", "content"]);
      assert.deepEqual(readFile.inputSchema.required, ["path"]);
      assert.equal(writeFile.inputSchema.properties.path.type, "string");
      assert.equal(writeFile.inputSchema.properties.content.type, "string");
      assert.equal(listFiles.inputSchema.properties.path.type, "string");
      assert.equal(writeFile.inputSchema.additionalProperties, false);
    } finally {
      // The directory is intentionally cleaned by the test; the tool factory
      // itself does not own the caller's workspace.
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("task prompts explain relative file paths and the required write", () => {
    const prompt = buildBenchPrompt({ prompt: "Save the implementation to debounce.js." });
    assert.match(prompt, /temporary workspace/);
    assert.match(prompt, /relative file paths/);
    assert.match(prompt, /never the workspace directory/);
    assert.match(prompt, /write_file/);
  });

  test("the benchmark allowlist keeps unrelated Aperio tools out of the agent", () => {
    assert.deepEqual(BENCH_TOOL_ALLOWLIST, ["recall", "read_file", "write_file", "list_files"]);
  });

  test("file tools return a repairable message for directory targets", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-directory-target-"));
    try {
      const tools = createBenchHostTools(workspaceDir);
      const readResult = await tools.find(t => t.name === "read_file").handler({ path: "." });
      const writeResult = await tools.find(t => t.name === "write_file").handler({ path: workspaceDir, content: "x" });
      assert.match(readResult, /must name a file, not a directory/);
      assert.match(readResult, /Use a filename such as debounce\.js/);
      assert.match(writeResult, /must name a file, not a directory/);
      assert.equal(existsSync(join(workspaceDir, "x")), false);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("a nested subdirectory path is allowed", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-safe-"));
    try {
      const writeFile = createBenchHostTools(workspaceDir).find(t => t.name === "write_file");
      const result = await writeFile.handler({ path: "lib/nested/foo.js", content: "x" });
      assert.match(result, /^wrote /);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("a traversal path is rejected regardless of the host platform's separator", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-safe-"));
    try {
      const readFile = createBenchHostTools(workspaceDir).find(t => t.name === "read_file");
      await assert.rejects(readFile.handler({ path: "../../etc/passwd" }), /escapes workspace/);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("a tool call is recorded into the given emitter's event stream, in call order", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-safe-"));
    const events = [];
    const emitter = { send: (obj) => events.push(obj) };
    try {
      const tools = createBenchHostTools(workspaceDir, emitter);
      await tools.find(t => t.name === "write_file").handler({ path: "a.js", content: "x" });
      await tools.find(t => t.name === "read_file").handler({ path: "a.js" });
      assert.deepEqual(events.map(e => e.type), ["tool_call", "tool_call"]);
      assert.equal(events[0].name, "write_file");
      assert.deepEqual(events[0].args, { path: "a.js", content: "x" });
      assert.match(events[0].result, /^wrote /);
      assert.equal(events[1].name, "read_file");
      assert.equal(events[1].result, "x");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("no emitter given (existing single-arg call shape) — handlers still work, nothing to record into", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-safe-"));
    try {
      const writeFile = createBenchHostTools(workspaceDir).find(t => t.name === "write_file");
      const result = await writeFile.handler({ path: "a.js", content: "x" });
      assert.match(result, /^wrote /);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("createBenchHostTools — bounded duplicate-failure policy (issue #336)", () => {
  test("the same failing call repeated DUPLICATE_FAILURE_BUDGET times trips the callback exactly once, with the offending name/args/count", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-safe-"));
    try {
      const trips = [];
      const tools = createBenchHostTools(workspaceDir, null, {
        onDuplicateFailureBudgetExceeded: (info) => trips.push(info),
      });
      const readFile = tools.find(t => t.name === "read_file");
      for (let i = 0; i < DUPLICATE_FAILURE_BUDGET + 2; i++) {
        await readFile.handler({ path: "missing.js" });
      }
      assert.equal(trips.length, 1, "callback must fire exactly once, not once per call past the budget");
      assert.equal(trips[0].name, "read_file");
      assert.deepEqual(trips[0].args, { path: "missing.js" });
      assert.equal(trips[0].count, DUPLICATE_FAILURE_BUDGET);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("failures with DIFFERENT args never trip the budget, even past the count — only an identical signature counts", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-safe-"));
    try {
      const trips = [];
      const tools = createBenchHostTools(workspaceDir, null, {
        onDuplicateFailureBudgetExceeded: (info) => trips.push(info),
      });
      const readFile = tools.find(t => t.name === "read_file");
      for (let i = 0; i < DUPLICATE_FAILURE_BUDGET + 2; i++) {
        await readFile.handler({ path: `missing-${i}.js` });
      }
      assert.equal(trips.length, 0);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("a successful call never counts toward the failure budget", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-safe-"));
    try {
      const trips = [];
      const writeFile = createBenchHostTools(workspaceDir, null, {
        onDuplicateFailureBudgetExceeded: (info) => trips.push(info),
      }).find(t => t.name === "write_file");
      for (let i = 0; i < DUPLICATE_FAILURE_BUDGET + 2; i++) {
        await writeFile.handler({ path: "a.js", content: "x" });
      }
      assert.equal(trips.length, 0);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("no callback given — repeated failures still work, nothing throws", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "minimalism-safe-"));
    try {
      const readFile = createBenchHostTools(workspaceDir).find(t => t.name === "read_file");
      for (let i = 0; i < DUPLICATE_FAILURE_BUDGET + 2; i++) {
        await readFile.handler({ path: "missing.js" });
      }
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("renderTranscript — human-readable per-cell conversation", () => {
  const meta = {
    task: "slug-helper", arm: "A", repeat: 1, discard: false, model: "test-model",
    correct: true, loc: 3, inputTokens: 100, outputTokens: 20, netTokens: 120,
    wallMs: 1500, prompt: "Write a slug() helper.",
  };

  test("includes the prompt, tool calls with args/result, and assistant turns, in event order", () => {
    const events = [
      { type: "stream_start" },
      { type: "tool_call", name: "write_file", args: { path: "slug.js", content: "export function slug(s) {}" }, result: "wrote slug.js" },
      { type: "stream_end", text: "Added slug.js." },
    ];
    const md = renderTranscript(meta, events);
    assert.match(md, /## Prompt/);
    assert.match(md, /Write a slug\(\) helper\./);
    assert.match(md, /## Conversation/);
    assert.match(md, /\*\*Tool call:\*\* `write_file\(.*"path":"slug\.js".*\)`/);
    assert.match(md, /wrote slug\.js/);
    assert.match(md, /\*\*Assistant:\*\*/);
    assert.match(md, /Added slug\.js\./);
    // conversation order: tool call text appears before the assistant text that follows it
    assert.ok(md.indexOf("wrote slug.js") < md.indexOf("Added slug.js."));
  });

  test("a cell with no events (e.g. an errored-out turn) still renders prompt + metadata, not a crash", () => {
    const md = renderTranscript(meta, []);
    assert.match(md, /## Prompt/);
    assert.match(md, /correct: yes/);
  });

  test("a discarded warm-up is labeled as such", () => {
    const md = renderTranscript({ ...meta, discard: true, repeat: 0 }, []);
    assert.match(md, /\(discarded warm-up\)/);
  });
});

describe("evaluation mode is reported, not left implicit (issue #336, finding 5)", () => {
  test("EVAL_MODE is the current single execution path, real-agent — no skill-isolation path exists yet", () => {
    assert.equal(EVAL_MODE, "real-agent");
  });

  test("renderTranscript states the mode a row-less caller would otherwise have to assume", () => {
    const md = renderTranscript({ task: "t", arm: "A", repeat: 1, model: "m", mode: "real-agent", correct: true, loc: 0, prompt: "p" }, []);
    assert.match(md, /mode: real-agent/);
  });

  test("renderTranscript falls back to EVAL_MODE when no mode is given (existing call shape)", () => {
    const md = renderTranscript({ task: "t", arm: "A", repeat: 1, model: "m", correct: true, loc: 0, prompt: "p" }, []);
    assert.match(md, new RegExp(`mode: ${EVAL_MODE}`));
  });

  test("renderReport's header states the mode of the rows it summarizes", () => {
    const rows = [
      { task: "t1", arm: "A", repeat: 1, loc: 0, input_tokens: 1, output_tokens: 1, net_tokens: 2, correct: true, wall_ms: 1, model: "m", mode: "real-agent" },
    ];
    const md = renderReport(rows);
    assert.match(md, /mode `real-agent`/);
  });
});

describe("renderReport — human-readable run summary", () => {
  const row = (task, arm, repeat, overrides = {}) => ({
    task, arm, repeat, loc: 0, input_tokens: 1000, output_tokens: 200, net_tokens: 1200,
    correct: true, wall_ms: 5000, model: "test-model", skill_sha: "abc", ...overrides,
  });

  test("one row per task/arm, with a correctness fraction and medians, plus the verdict", () => {
    const rows = [
      row("slug-helper", "A", 1), row("slug-helper", "A", 2, { correct: false }),
      row("slug-helper", "B", 1), row("slug-helper", "B", 2),
    ];
    const md = renderReport(rows);
    assert.match(md, /\| slug-helper \| A \| 1\/2 \|/);
    assert.match(md, /\| slug-helper \| B \| 2\/2 \|/);
    assert.match(md, new RegExp(`\\*\\*Verdict: ${computeVerdict(rows)}\\*\\*`));
  });

  test("no rows — reports N/A rather than crashing on an empty matrix", () => {
    const md = renderReport([]);
    assert.match(md, /\*\*Verdict: N\/A/);
  });

  test("no {fixtures, repeats} given — verdict computed from whatever rows exist (existing call shape)", () => {
    const rows = [row("slug-helper", "A", 1), row("slug-helper", "B", 1)];
    const md = renderReport(rows);
    assert.match(md, new RegExp(`\\*\\*Verdict: ${computeVerdict(rows)}\\*\\*`));
  });

  test("an interrupted run (fewer rows than planned) reports incomplete and withholds the verdict", () => {
    const rows = [row("slug-helper", "A", 1), row("slug-helper", "B", 1)]; // repeats=3 planned, only repeat 1 landed
    const fixtures = [{ id: "slug-helper" }];
    const md = renderReport(rows, { fixtures, repeats: 3 });
    assert.match(md, /INCOMPLETE MATRIX/);
    assert.match(md, /2\/6 expected cells/);
    assert.doesNotMatch(md, /\*\*Verdict:/);
  });

  test("a complete matrix ({fixtures, repeats} given, every task/arm has enough repeats) shows the verdict", () => {
    const rows = [
      row("slug-helper", "A", 1), row("slug-helper", "A", 2),
      row("slug-helper", "B", 1), row("slug-helper", "B", 2),
    ];
    const fixtures = [{ id: "slug-helper" }];
    const md = renderReport(rows, { fixtures, repeats: 2 });
    assert.match(md, new RegExp(`\\*\\*Verdict: ${computeVerdict(rows)}\\*\\*`));
    assert.doesNotMatch(md, /INCOMPLETE/);
  });
});

describe("isMatrixComplete — plan-aware completeness (issue #336)", () => {
  const r = (task, arm, repeat) => ({ task, arm, repeat, loc: 0, correct: true });

  test("every fixture with both arms at the planned repeat count is complete", () => {
    const fixtures = [{ id: "t1" }, { id: "t2" }];
    const rows = ["t1", "t2"].flatMap(task => ["A", "B"].flatMap(arm => [r(task, arm, 1), r(task, arm, 2)]));
    assert.equal(isMatrixComplete(rows, fixtures, 2), true);
  });

  test("one fixture missing a repeat on one arm is incomplete", () => {
    const fixtures = [{ id: "t1" }, { id: "t2" }];
    const rows = [
      r("t1", "A", 1), r("t1", "A", 2), r("t1", "B", 1), r("t1", "B", 2),
      r("t2", "A", 1), r("t2", "A", 2), r("t2", "B", 1), // t2/B missing repeat 2
    ];
    assert.equal(isMatrixComplete(rows, fixtures, 2), false);
  });

  test("no rows at all against a non-empty plan is incomplete", () => {
    assert.equal(isMatrixComplete([], [{ id: "t1" }], 2), false);
  });
});

describe("E7 — medianAbsoluteDeviation", () => {
  test("fewer than two values, or all-identical values, has no spread", () => {
    assert.equal(medianAbsoluteDeviation([]), 0);
    assert.equal(medianAbsoluteDeviation([5]), 0);
    assert.equal(medianAbsoluteDeviation([7, 7, 7]), 0);
  });

  test("a single extreme outlier does not blow up the spread the way stdev would", () => {
    // 3 of 4 values agree; MAD tracks the majority instead of chasing the outlier.
    assert.equal(medianAbsoluteDeviation([-30, -30, -30, 900]), 0);
  });
});
