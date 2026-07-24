// Tests for browser.js — auto-launch the user's browser at boot.
//
// openBrowser() uses child_process.execFile and fs.mkdirSync internally.
// The function accepts deps.execFile and deps.mkdirSync so tests can
// inject spies without touching the built-in module bindings.
// The function is synchronous (fire-and-forget); the mock execFile
// delivers its callback synchronously so all assertions are immediate.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import logger from "../../../lib/helpers/logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Mock state & helpers
// ═══════════════════════════════════════════════════════════════════════════

const execCalls  = [];
const mkdirCalls = [];
let execError   = null;      // if set, execFile callback receives this
let mkdirError  = null;      // if set, mkdirSync throws this

function resetMockState() {
  execCalls.length  = 0;
  mkdirCalls.length = 0;
  execError  = null;
  mkdirError = null;
}

/** Mocks to pass as deps.execFile / deps.mkdirSync.
 *  Calls the callback synchronously so per-test state is never at risk of
 *  cross-contamination from pending setImmediate/timers. */
const mockExecFile = (file, args, cb) => {
  execCalls.push({ file, args });
  if (typeof cb === "function") cb(execError);
};
const mockMkdirSync = (dir, opts) => {
  mkdirCalls.push({ dir, opts });
  if (mkdirError) throw mkdirError;
};

/** Snapshot + clear relevant env vars. */
const _envSnapshot = {};
function clearTestEnv() {
  for (const k of [
    "APERIO_BENCHMARK_RUN",
    "APERIO_BROWSER",
    "APERIO_BROWSER_ISOLATED",
  ]) {
    _envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreTestEnv() {
  for (const [k, v] of Object.entries(_envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

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
  restoreTestEnv();
});

// ═══════════════════════════════════════════════════════════════════════════
// Import SUT
// ═══════════════════════════════════════════════════════════════════════════

let openBrowser;

before(async () => {
  const mod = await import("../../../lib/server/browser.js");
  openBrowser = mod.openBrowser;
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("openBrowser (macOS darwin)", () => {
  const URL  = "http://localhost:31337";
  const ROOT = "/tmp/aperio-test";
  const DEPS = { execFile: mockExecFile, mkdirSync: mockMkdirSync };

  beforeEach(() => {
    resetMockState();
    clearTestEnv();
  });

  // ─── Benchmark guard ──────────────────────────────────────────────────

  test("returns immediately when APERIO_BENCHMARK_RUN=1 (no execFile calls)", () => {
    process.env.APERIO_BENCHMARK_RUN = "1";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(execCalls.length, 0, "no execFile calls");
    assert.strictEqual(mkdirCalls.length, 0, "no mkdirSync calls");
  });

  // ─── Unknown browser → default open fallback ──────────────────────────

  test('falls back to "open <url>" for unknown APERIO_BROWSER value', () => {
    process.env.APERIO_BROWSER = "nonexistent-browser";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    // Default open on darwin: execFile("open", [url], cb)
    assert.strictEqual(execCalls.length, 1);
    assert.strictEqual(execCalls[0].file, "open");
    assert.deepStrictEqual(execCalls[0].args, [URL]);
  });

  test("does not call mkdirSync for unknown browser fallback", () => {
    process.env.APERIO_BROWSER = "does-not-exist";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(mkdirCalls.length, 0);
  });

  test("logs error when default open fails", () => {
    process.env.APERIO_BROWSER = "unknown-browser";
    execError = new Error("ENOENT");
    logger.error.mock.resetCalls();

    openBrowser(URL, { root: ROOT, deps: DEPS });

    const errLog = logger.error.mock.calls.find((c) =>
      c.arguments[0].includes("Could not open browser")
    );
    assert.ok(errLog, "expected error log about failed browser open");
    assert.ok(errLog.arguments[1].includes("ENOENT"));
  });

  // ─── Known browser ───────────────────────────────────────────────────

  test("launches firefox with private window flag", () => {
    process.env.APERIO_BROWSER = "firefox";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    // On darwin: open -na <mac-binary> --args <firefox-args>
    assert.strictEqual(execCalls.length, 1);
    const call = execCalls[0];
    assert.strictEqual(call.file, "open");
    assert.strictEqual(call.args[0], "-na");
    assert.ok(
      call.args[1].toLowerCase().includes("firefox"),
      `expected firefox binary, got ${call.args[1]}`
    );
    assert.strictEqual(call.args[2], "--args");
    assert.ok(call.args.includes("-private-window"), "expected -private-window");
    assert.ok(call.args.includes(URL), "expected URL in args");
  });

  test("launches chrome with --incognito flag", () => {
    process.env.APERIO_BROWSER = "chrome";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(execCalls.length, 1);
    const call = execCalls[0];
    assert.strictEqual(call.args[0], "-na");
    assert.ok(
      call.args[1].toLowerCase().includes("google chrome"),
      `expected Google Chrome, got ${call.args[1]}`
    );
    assert.ok(call.args.includes("--incognito"));
    assert.ok(call.args.includes(URL));
  });

  test("launches chromium with --incognito flag", () => {
    process.env.APERIO_BROWSER = "chromium";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(execCalls.length, 1);
    assert.ok(execCalls[0].args.includes("--incognito"));
    assert.ok(execCalls[0].args.includes(URL));
  });

  test("launches brave with --incognito flag", () => {
    process.env.APERIO_BROWSER = "brave";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(execCalls.length, 1);
    assert.ok(execCalls[0].args.includes("--incognito"));
  });

  test("launches edge with --inprivate flag", () => {
    process.env.APERIO_BROWSER = "edge";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(execCalls.length, 1);
    assert.ok(execCalls[0].args.includes("--inprivate"), "expected --inprivate for edge");
  });

  test("launches firefox-dev as firefox-family browser", () => {
    process.env.APERIO_BROWSER = "firefox-dev";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(execCalls.length, 1);
    assert.ok(execCalls[0].args.includes("-private-window"));
    assert.ok(execCalls[0].args.includes(URL));
  });

  // ─── Browser exec failure → fallback to default open ─────────────────

  test("falls back to default open when browser execFile fails", () => {
    process.env.APERIO_BROWSER = "firefox";
    execError = new Error("binary not found");

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(execCalls.length, 2, "expected browser attempt + default fallback");
    // Call 0: browser launch (open -na firefox …)
    // Call 1: default open fallback
    assert.strictEqual(execCalls[1].file, "open", "fallback should be 'open' command");
    assert.strictEqual(execCalls[1].args[0], URL, "fallback should pass URL");
  });

  test("does NOT fall back to default open when browser succeeds", () => {
    process.env.APERIO_BROWSER = "firefox";
    execError = null; // success

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(execCalls.length, 1, "only the browser attempt, no fallback");
  });

  // ─── Isolated profile ───────────────────────────────────────────────

  test("creates isolated profile dir for firefox when APERIO_BROWSER_ISOLATED=1", () => {
    process.env.APERIO_BROWSER = "firefox";
    process.env.APERIO_BROWSER_ISOLATED = "1";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(mkdirCalls.length, 1, "mkdirSync should be called once");
    const mkdir = mkdirCalls[0];
    assert.ok(
      mkdir.dir.includes("var/browser-profiles/firefox"),
      `expected profile dir, got ${mkdir.dir}`
    );
    assert.ok(mkdir.opts.recursive, "mkdirSync should be recursive");
    assert.strictEqual(mkdir.opts.mode, 0o700, "mkdirSync should use 0o700");

    const args = execCalls[0].args;
    assert.ok(args.includes("--profile"), "expected --profile in browser args");
    assert.ok(
      args.some((a) => a.includes("var/browser-profiles/firefox")),
      "expected profile path in args"
    );
  });

  test("creates isolated profile dir for chrome when APERIO_BROWSER_ISOLATED=1", () => {
    process.env.APERIO_BROWSER = "chrome";
    process.env.APERIO_BROWSER_ISOLATED = "on";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(mkdirCalls.length, 1, "mkdirSync should be called once");
    const args = execCalls[0].args;
    assert.ok(
      args.some(
        (a) =>
          a.startsWith("--user-data-dir=") &&
          a.includes("var/browser-profiles/chrome")
      ),
      `expected --user-data-dir=... in args, got [${args}]`
    );
  });

  test("accepts truthy values for APERIO_BROWSER_ISOLATED (1, true, on, yes)", () => {
    for (const val of ["1", "true", "on", "yes"]) {
      resetMockState();
      process.env.APERIO_BROWSER = "firefox";
      process.env.APERIO_BROWSER_ISOLATED = val;

      openBrowser(URL, { root: ROOT, deps: DEPS });

      assert.strictEqual(
        mkdirCalls.length, 1,
        `mkdirSync should be called for APERIO_BROWSER_ISOLATED=${val}`
      );
    }
  });

  test("rejects falsy values for APERIO_BROWSER_ISOLATED (no profile)", () => {
    for (const val of ["0", "false", "off", "no", ""]) {
      resetMockState();
      process.env.APERIO_BROWSER = "firefox";
      process.env.APERIO_BROWSER_ISOLATED = val;

      openBrowser(URL, { root: ROOT, deps: DEPS });

      assert.strictEqual(
        mkdirCalls.length, 0,
        `no mkdirSync for APERIO_BROWSER_ISOLATED=${JSON.stringify(val)}`
      );
    }
  });

  test("warns and skips isolated profile for app-family browsers (tor)", () => {
    logger.warn.mock.resetCalls();
    process.env.APERIO_BROWSER = "tor";
    process.env.APERIO_BROWSER_ISOLATED = "1";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    // No profile dir created
    assert.strictEqual(mkdirCalls.length, 0, "no mkdirSync for app-family browser");
    // Warn logged
    const warnMsg = logger.warn.mock.calls.find((c) =>
      c.arguments[0].includes("APERIO_BROWSER_ISOLATED ignored")
    );
    assert.ok(warnMsg, "expected warn about ignored isolated flag");
    assert.ok(warnMsg.arguments[0].includes("tor"));
  });

  test("logs error and continues when mkdirSync fails for isolated profile", () => {
    logger.error.mock.resetCalls();
    process.env.APERIO_BROWSER = "firefox";
    process.env.APERIO_BROWSER_ISOLATED = "1";
    mkdirError = new Error("EPERM: permission denied");

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(mkdirCalls.length, 1, "mkdirSync was attempted");
    const errMsg = logger.error.mock.calls.find((c) =>
      c.arguments[0].includes("Could not create browser profile dir")
    );
    assert.ok(errMsg, "expected error log about failed mkdir");

    // Browser is still launched (without profile argument — profileDir was null)
    assert.strictEqual(execCalls.length, 1, "browser launch still attempted");
    const args = execCalls[0].args;
    assert.ok(
      !args.some((a) => a.includes("var/browser-profiles")),
      `no profile dir in args when mkdir fails: [${args}]`
    );
  });

  // ─── No side effects for disabled isolated ───────────────────────────

  test("does not create profile when APERIO_BROWSER_ISOLATED is not set", () => {
    process.env.APERIO_BROWSER = "firefox";

    openBrowser(URL, { root: ROOT, deps: DEPS });

    assert.strictEqual(mkdirCalls.length, 0, "no mkdirSync without isolated flag");
    const args = execCalls[0].args;
    assert.ok(
      !args.some((a) => a.includes("--profile")),
      "no --profile flag when not isolated"
    );
  });
});
