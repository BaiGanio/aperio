// Tests for signals.js — slashCompleter, stopGeneration, restartProcess,
// registerSignalHandlers
//
// Pure functions (slashCompleter) are tested directly. State-dependent
// functions (stopGeneration) get their dependencies via the shared state
// object. Process-heavy functions (restartProcess) mock child_process.spawn
// on the CJS module that ESM imports read from. registerSignalHandlers is
// tested with isTTY=false so no keypress wiring is attempted.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// ─── Module-level mocks (before dynamic import of SUT) ───────────────────────

const require = createRequire(import.meta.url);
const cp = require("node:child_process");

/** Track the last spawned child so tests can simulate events. */
let lastChild = null;
let spawnCalled = false;

mock.method(cp, "spawn", (cmd, args, opts) => {
  spawnCalled = true;
  lastChild = {
    cmd, args, opts,
    on: mock.fn((event, handler) => {
      if (event === "exit") lastChild._exitHandler = handler;
      if (event === "error") lastChild._errorHandler = handler;
    }),
    emit: mock.fn(),
  };
  return lastChild;
});

let stdoutWrites = [];
mock.method(process.stdout, "write", (chunk) => { stdoutWrites.push(chunk); });

let stdinPaused = false;
mock.method(process.stdin, "pause", () => { stdinPaused = true; });

// ─── Import SUT after mocks ──────────────────────────────────────────────────

let signals;

before(async () => {
  signals = await import("../../../lib/terminal/signals.js");
});

after(() => {
  mock.restoreAll();
});

// ═══════════════════════════════════════════════════════════════════════════════
// SLASH_COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

describe("SLASH_COMMANDS", () => {
  test("is a non-empty array", () => {
    assert.ok(Array.isArray(signals.SLASH_COMMANDS));
    assert.ok(signals.SLASH_COMMANDS.length > 0);
  });

  test("contains common commands", () => {
    assert.ok(signals.SLASH_COMMANDS.includes("/help"));
    assert.ok(signals.SLASH_COMMANDS.includes("/exit"));
    assert.ok(signals.SLASH_COMMANDS.includes("/clear"));
    assert.ok(signals.SLASH_COMMANDS.includes("/restart"));
  });

  test("every command starts with /", () => {
    for (const cmd of signals.SLASH_COMMANDS) {
      assert.ok(cmd.startsWith("/"), `${cmd} should start with /`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// slashCompleter
// ═══════════════════════════════════════════════════════════════════════════════

describe("slashCompleter", () => {
  test("returns [[], line] when line does not start with /", () => {
    assert.deepStrictEqual(signals.slashCompleter("hello"), [[], "hello"]);
    assert.deepStrictEqual(signals.slashCompleter(""), [[], ""]);
    assert.deepStrictEqual(signals.slashCompleter("  "), [[], "  "]);
  });

  test("returns matching commands for a / prefix", () => {
    const [matches] = signals.slashCompleter("/h");
    assert.ok(matches.includes("/help"));
    assert.ok(matches.includes("/handoff"));
    assert.ok(!matches.includes("/exit"));
  });

  test("returns all commands when the / line matches nothing", () => {
    const [matches] = signals.slashCompleter("/zzz");
    assert.strictEqual(matches, signals.SLASH_COMMANDS);
  });

  test("is case-insensitive", () => {
    const [matches] = signals.slashCompleter("/HELP");
    assert.ok(matches.includes("/help"));
  });

  test("returns full list for bare /", () => {
    const [matches] = signals.slashCompleter("/");
    // .filter returns a new array, so deepStrictEqual, not strictEqual
    assert.deepStrictEqual(matches, signals.SLASH_COMMANDS);
  });

  test("second return value is the original line", () => {
    const [, line] = signals.slashCompleter("/help");
    assert.strictEqual(line, "/help");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// stopGeneration
// ═══════════════════════════════════════════════════════════════════════════════

describe("stopGeneration", () => {
  let state;

  before(async () => {
    const stateMod = await import("../../../lib/terminal/state.js");
    state = stateMod.state;
  });

  beforeEach(() => {
    state.standaloneAbort = null;
    state.proxyWaiting = false;
    state.proxySafeSend = null;
  });

  test("returns false when nothing is in progress", () => {
    assert.strictEqual(signals.stopGeneration(), false);
  });

  test("returns true and aborts standalone generation", () => {
    let aborted = false;
    state.standaloneAbort = { abort: () => { aborted = true; } };

    const result = signals.stopGeneration();

    assert.strictEqual(result, true);
    assert.strictEqual(aborted, true);
    assert.strictEqual(state.standaloneAbort, null);
  });

  test("returns true and sends stop to proxy", () => {
    let sent = null;
    state.proxyWaiting = true;
    state.proxySafeSend = (msg) => { sent = msg; };

    const result = signals.stopGeneration();

    assert.strictEqual(result, true);
    assert.strictEqual(state.proxyWaiting, false);
    assert.deepStrictEqual(sent, { type: "stop" });
  });

  test("prefers standaloneAbort over proxy (standalone checked first)", () => {
    let standaloneStopped = false;
    state.standaloneAbort = { abort: () => { standaloneStopped = true; } };
    state.proxyWaiting = true;
    state.proxySafeSend = mock.fn();

    signals.stopGeneration();

    assert.strictEqual(standaloneStopped, true);
    assert.strictEqual(state.proxySafeSend.mock.callCount(), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// restartProcess
// ═══════════════════════════════════════════════════════════════════════════════

describe("restartProcess", () => {
  beforeEach(() => {
    spawnCalled = false;
    lastChild = null;
    stdoutWrites = [];
    stdinPaused = false;
  });

  test("spawns a child process with the same argv", () => {
    signals.restartProcess();

    assert.ok(spawnCalled);
    assert.strictEqual(lastChild.cmd, process.argv[0]);
    assert.deepStrictEqual(lastChild.args, process.argv.slice(1));
    assert.deepStrictEqual(lastChild.opts, { stdio: "inherit" });
  });

  test("calls beforeSpawn if provided", () => {
    let beforeCalled = false;
    signals.restartProcess({
      beforeSpawn: () => { beforeCalled = true; },
    });
    assert.strictEqual(beforeCalled, true);
  });

  test("closes readline if provided", () => {
    let rlClosed = false;
    signals.restartProcess({
      rl: { close: () => { rlClosed = true; } },
    });
    assert.strictEqual(rlClosed, true);
  });

  test("pauses stdin", () => {
    signals.restartProcess();
    assert.strictEqual(stdinPaused, true);
  });

  test("writes restart message to stdout", () => {
    signals.restartProcess();
    assert.ok(stdoutWrites.some(w => String(w).includes("restarting")));
  });

  test("handles child exit by calling process.exit with child code", () => {
    let exitCode = null;
    const origExit = process.exit;
    mock.method(process, "exit", (code) => { exitCode = code; });

    signals.restartProcess();
    lastChild._exitHandler(42);

    assert.strictEqual(exitCode, 42);
  });

  test("handles child error by calling process.exit(1)", () => {
    let exitCode = null;
    mock.method(process, "exit", (code) => { exitCode = code; });

    signals.restartProcess();
    lastChild._errorHandler(new Error("fail"));

    assert.strictEqual(exitCode, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// registerSignalHandlers (basic smoke test)
// ═══════════════════════════════════════════════════════════════════════════════

describe("registerSignalHandlers", () => {
  test("does not crash when called", () => {
    // With isTTY not set or false, the keypress registration is skipped;
    // only the SIGINT handler is registered (side effect on process).
    assert.doesNotThrow(() => signals.registerSignalHandlers());
  });

  test("registers a SIGINT handler on process", () => {
    // We can verify the handler was registered by getting the listener count.
    // This works because process.on was NOT mocked during the call.
    const count = process.listenerCount("SIGINT");
    // registerSignalHandlers was called in the previous test, so there should
    // be at least one SIGINT listener now.
    assert.ok(count >= 1, "expected at least 1 SIGINT listener");
  });

  test("registers an exit handler on process", () => {
    const count = process.listenerCount("exit");
    assert.ok(count >= 1, "expected at least 1 exit listener");
  });
});
