/**
 * tests/chat-utils.test.js
 *
 * Imports the REAL chat-utils.js so every line executed here shows up
 * in the c8 coverage report under lib/chat-utils.js.
 *
 * Run:  node --test tests/chat-utils.test.js
 * Coverage: c8 node --test tests/chat-utils.test.js
 */

import assert from "assert";
import { describe, test, beforeEach, afterEach } from "node:test";

import {
  // ANSI constants
  R, BOLD, DIM, CYAN, GRAY, GREEN, YELLOW, RED,
  SAVE_CURSOR, RESTORE_CURSOR, ERASE_EOL,
  HIDE_CURSOR, SHOW_CURSOR, RESET_SCROLL, HEADER_LINES,
  moveTo,
  // header
  initDockerState, initHeader, setHeaderStatus, getHeaderInfo,
  updateHeaderModel, updateHeaderReasoning, redrawHeader,
  // spinner
  SPINNER_FRAMES, SPINNER_STAGES,
  resolveSpinnerStage, startSpinner, stopSpinner,
  // readline helpers
  ask, printQ,
  // port helpers
  isPortOpen, pidsOnPort, killPids,
  // llama.cpp
  parseLlamaCppPort, llamacppBase, llamacppHealthy,
  // server probe
  probeServer,
  // memory display
  printMemories,
  // misc
  detectMightThink, makeStderrShim,
  parseServerPort,
} from "../../../lib/utils/chat-utils.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { get output() { return chunks.join(""); }, restore() { process.stdout.write = orig; } };
}

function captureConsole() {
  const lines = [];
  const orig = console.log.bind(console);
  console.log = (...args) => lines.push(args.join(" "));
  return { lines, restore() { console.log = orig; } };
}

function withTerminalSize(cols, rows, fn) {
  const oc = process.stdout.columns, or = process.stdout.rows;
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true, writable: true });
  Object.defineProperty(process.stdout, "rows",    { value: rows, configurable: true, writable: true });
  try     { return fn(); }
  finally {
    Object.defineProperty(process.stdout, "columns", { value: oc, configurable: true, writable: true });
    Object.defineProperty(process.stdout, "rows",    { value: or, configurable: true, writable: true });
  }
}

function withMockFetch(mockFn, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn;
  const result = fn();
  // support both sync and async
  if (result && typeof result.then === "function") {
    return result.finally(() => { globalThis.fetch = orig; });
  }
  globalThis.fetch = orig;
  return result;
}

// Reset header state before each test so module-level vars don't leak
beforeEach(() => {
  const cap = captureStdout();
  initDockerState(false);
  initHeader("", "", false);
  setHeaderStatus("");
  cap.restore();
});

// ─── ANSI constants ───────────────────────────────────────────────────────────
describe("ANSI constants", () => {
  test("R resets attributes",          () => assert.equal(R,            "\x1b[0m"));
  test("BOLD sets bold",               () => assert.equal(BOLD,         "\x1b[1m"));
  test("DIM sets dim",                 () => assert.equal(DIM,          "\x1b[2m"));
  test("CYAN colour",                  () => assert.equal(CYAN,         "\x1b[36m"));
  test("GRAY colour",                  () => assert.equal(GRAY,         "\x1b[90m"));
  test("GREEN colour",                 () => assert.equal(GREEN,        "\x1b[32m"));
  test("YELLOW colour",                () => assert.equal(YELLOW,       "\x1b[33m"));
  test("RED colour",                   () => assert.equal(RED,          "\x1b[31m"));
  test("SAVE_CURSOR",                  () => assert.equal(SAVE_CURSOR,    "\x1b[s"));
  test("RESTORE_CURSOR",               () => assert.equal(RESTORE_CURSOR, "\x1b[u"));
  test("ERASE_EOL",                    () => assert.equal(ERASE_EOL,      "\x1b[K"));
  test("HIDE_CURSOR",                  () => assert.equal(HIDE_CURSOR,    "\x1b[?25l"));
  test("SHOW_CURSOR",                  () => assert.equal(SHOW_CURSOR,    "\x1b[?25h"));
  test("RESET_SCROLL",                 () => assert.equal(RESET_SCROLL,   "\x1b[r"));
  test("HEADER_LINES is 4",            () => assert.equal(HEADER_LINES,   4));
});

describe("moveTo", () => {
  test("row and col",       () => assert.equal(moveTo(5, 3),  "\x1b[5;3H"));
  test("col defaults to 1", () => assert.equal(moveTo(3),     "\x1b[3;1H"));
  test("row 1 col 1",       () => assert.equal(moveTo(1, 1),  "\x1b[1;1H"));
});


// ─── parseServerPort ──────────────────────────────────────────────────────────
describe("parseServerPort", () => {
  test("defaults to 31337",             () => assert.equal(parseServerPort({}),                            31337));
  test("reads SERVER_PORT",             () => assert.equal(parseServerPort({ SERVER_PORT: "8080" }),         8080));
  test("falls back to PORT",            () => assert.equal(parseServerPort({ PORT: "1701" }),               1701));
  test("SERVER_PORT wins over PORT",    () => assert.equal(parseServerPort({ SERVER_PORT: "9000", PORT: "1701" }), 9000));
  test("undefined falls to default",    () => assert.equal(parseServerPort({ SERVER_PORT: undefined }),     31337));
});

// ─── initDockerState ──────────────────────────────────────────────────────────
describe("initDockerState", () => {
  // Docker/DB show in the dim navbar (line 4) and are also reported by getHeaderInfo().
  test("docker on → 'postgres' in navbar and getHeaderInfo", () => {
    const cap = captureStdout();
    initDockerState(true);
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("postgres"));
    assert.ok(cap.output.includes("Docker on"));
    assert.strictEqual(getHeaderInfo().dockerOn, true);
    assert.strictEqual(getHeaderInfo().db, "postgres");
  });

  test("docker off → 'sqlite' in navbar and getHeaderInfo", () => {
    const cap = captureStdout();
    initDockerState(false);
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("sqlite"));
    assert.ok(cap.output.includes("Docker off"));
    assert.strictEqual(getHeaderInfo().dockerOn, false);
    assert.strictEqual(getHeaderInfo().db, "sqlite");
  });
});

// ─── initHeader ───────────────────────────────────────────────────────────────
describe("initHeader", () => {
  test("clears screen", () => {
    const cap = captureStdout();
    initHeader("chat", "llama3", false);
    cap.restore();
    assert.ok(cap.output.includes("\x1b[2J"));
  });

  test("moves to row 1", () => {
    const cap = captureStdout();
    initHeader("chat", "llama3", false);
    cap.restore();
    assert.ok(cap.output.includes(moveTo(1)));
  });

  test("brand + ready state appear in output", () => {
    const cap = captureStdout();
    initHeader("standalone", "model", false);
    cap.restore();
    assert.ok(cap.output.includes("Aperio"));
    assert.ok(cap.output.includes("ready"));
  });

  test("mode shown in navbar and tracked by getHeaderInfo", () => {
    const cap = captureStdout();
    initHeader("standalone", "model", false);
    cap.restore();
    assert.ok(cap.output.includes("standalone"));
    assert.strictEqual(getHeaderInfo().mode, "standalone");
  });

  test("model appears in output", () => {
    const cap = captureStdout();
    initHeader("chat", "mistral:7b", false);
    cap.restore();
    assert.ok(cap.output.includes("mistral:7b"));
  });

  test("resets status to empty", () => {
    const cap = captureStdout();
    initHeader("chat", "model", false);
    setHeaderStatus("busy");
    initHeader("chat", "model", false); // re-init
    cap.restore();
    // after second init the live state returns to "ready" (no "busy" label)
    const afterSecondInit = cap.output.split("\x1b[2J").pop();
    assert.ok(afterSecondInit.includes("ready"));
    assert.ok(!afterSecondInit.includes("busy"));
  });

  test("does NOT pin a scroll region (preserves native scrollback)", () => {
    const cap = captureStdout();
    withTerminalSize(80, 30, () => initHeader("x", "y", false));
    cap.restore();
    // A DECSTBM region (\x1b[<top>;<bottom>r) would trap content above the header
    // and break scrollback — the banner must stay inline. \x1b[r (a bare region
    // reset) is allowed; a region *set* with numbers is not.
    assert.ok(!/\x1b\[\d+;\d+r/.test(cap.output));
  });
});

// ─── redrawHeader ─────────────────────────────────────────────────────────────
describe("redrawHeader", () => {
  test("prints inline — no cursor save/restore or absolute repositioning", () => {
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    // The inline banner must not hop the cursor around (that machinery only
    // made sense for the old pinned bar) — otherwise it can't flow into scrollback.
    assert.ok(!cap.output.includes(SAVE_CURSOR));
    assert.ok(!cap.output.includes(RESTORE_CURSOR));
    assert.ok(!cap.output.includes(moveTo(1)));
  });

  test("separator is (cols-2) long", () => {
    const cap = captureStdout();
    withTerminalSize(60, 30, () => redrawHeader());
    cap.restore();
    assert.ok(cap.output.includes("─".repeat(58)));
    assert.ok(!cap.output.includes("─".repeat(59)));
  });

  test("separator defaults to 78 when columns undefined", () => {
    const origCols = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true, writable: true });
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    Object.defineProperty(process.stdout, "columns", { value: origCols, configurable: true, writable: true });
    assert.ok(cap.output.includes("─".repeat(78)));
  });

  test("reasoning indicator shown when true", () => {
    const cap = captureStdout();
    initHeader("chat", "model", true);
    cap.restore();
    assert.ok(cap.output.includes("reasoning"));
  });

  test("reasoning indicator absent when false", () => {
    const cap = captureStdout();
    initHeader("chat", "model", false);
    cap.restore();
    assert.ok(!cap.output.includes("reasoning"));
  });

  test("help hint line always present", () => {
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("help"));
    assert.ok(cap.output.includes("exit"));
  });
});

// ─── setHeaderStatus ──────────────────────────────────────────────────────────
describe("setHeaderStatus", () => {
  test("tracked status renders as the live working state (YELLOW) on next redraw", () => {
    setHeaderStatus("thinking");
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("thinking"));
    assert.ok(cap.output.includes(YELLOW));
  });

  test("clearing status returns the banner to 'ready'", () => {
    setHeaderStatus("working");
    setHeaderStatus("");
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("ready"));
    assert.ok(!cap.output.includes("working"));
  });
});

// ─── updateHeaderModel ────────────────────────────────────────────────────────
describe("updateHeaderModel", () => {
  test("trims whitespace", () => {
    updateHeaderModel("  phi3:mini  ");
    assert.strictEqual(getHeaderInfo().model, "phi3:mini");
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("phi3:mini"));
    assert.ok(!cap.output.includes("  phi3:mini  "));
  });

  test("new model replaces old on next redraw", () => {
    initHeader("chat", "llama3", false);
    updateHeaderModel("mistral:7b");
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("mistral:7b"));
    assert.ok(!cap.output.includes("llama3"));
  });
});

// ─── updateHeaderReasoning ────────────────────────────────────────────────────
describe("updateHeaderReasoning", () => {
  test("true enables reasoning line on next redraw", () => {
    updateHeaderReasoning(true);
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("reasoning"));
  });

  test("false disables reasoning line on next redraw", () => {
    initHeader("chat", "model", true);
    updateHeaderReasoning(false);
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(!cap.output.includes("reasoning"));
  });
});

// ─── resolveSpinnerStage ──────────────────────────────────────────────────────
describe("resolveSpinnerStage", () => {
  test("0ms → thinking",               () => assert.equal(resolveSpinnerStage(0),     "thinking"));
  test("2999ms → still thinking",      () => assert.equal(resolveSpinnerStage(2999),  "thinking"));
  test("3000ms → preparing answer",    () => assert.equal(resolveSpinnerStage(3000),  "preparing answer"));
  test("6999ms → preparing answer",    () => assert.equal(resolveSpinnerStage(6999),  "preparing answer"));
  test("7000ms → this may take",       () => assert.equal(resolveSpinnerStage(7000),  "this may take a moment"));
  test("12000ms → still working",      () => assert.equal(resolveSpinnerStage(12000), "still working…"));
  test("huge elapsed → still working", () => assert.equal(resolveSpinnerStage(99999), "still working…"));
});

describe("SPINNER_FRAMES / SPINNER_STAGES", () => {
  test("10 braille frames",                    () => assert.equal(SPINNER_FRAMES.length, 10));
  test("4 stages",                             () => assert.equal(SPINNER_STAGES.length, 4));
  test("stages in ascending after-ms order",   () => {
    for (let i = 1; i < SPINNER_STAGES.length; i++)
      assert.ok(SPINNER_STAGES[i].after > SPINNER_STAGES[i - 1].after);
  });
  test("first stage fires immediately (after:0)", () => assert.equal(SPINNER_STAGES[0].after, 0));
});

// ─── startSpinner / stopSpinner ───────────────────────────────────────────────
describe("startSpinner / stopSpinner", () => {
  afterEach(() => {
    const cap = captureStdout();
    stopSpinner();
    cap.restore();
  });

  test("startSpinner writes a braille frame to stdout", () => {
    const cap = captureStdout();
    startSpinner();
    cap.restore();
    const hasFrame = SPINNER_FRAMES.some(f => cap.output.includes(f));
    assert.ok(hasFrame, "expected a braille spinner frame in stdout");
  });

  test("startSpinner with fixed label uses that label", () => {
    const cap = captureStdout();
    startSpinner("waking up");
    cap.restore();
    assert.ok(cap.output.includes("waking up"));
  });

  test("startSpinner without label starts with 'thinking'", () => {
    const cap = captureStdout();
    startSpinner();
    cap.restore();
    assert.ok(cap.output.includes("thinking"));
  });

  test("stopSpinner clears the spinner line", () => {
    let cap = captureStdout();
    startSpinner();
    cap.restore();
    cap = captureStdout();
    stopSpinner();
    cap.restore();
    // stopSpinner writes spaces to clear the line
    assert.ok(cap.output.includes(" ".repeat(50)));
  });

  test("stopSpinner resets tracked status so the next redraw shows 'ready'", () => {
    startSpinner("busy");
    stopSpinner();
    // Spinner setters no longer repaint the banner; stopSpinner clears the
    // tracked status to "" so the next redraw renders the idle "ready" state.
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("ready"));
    assert.ok(!cap.output.includes("busy"));
  });
});

// ─── printQ ───────────────────────────────────────────────────────────────────
describe("printQ", () => {
  test("writes 'You:' prompt in yellow bold", () => {
    const cap = captureStdout();
    printQ();
    cap.restore();
    assert.ok(cap.output.includes("You:"));
    assert.ok(cap.output.includes(YELLOW));
    assert.ok(cap.output.includes(BOLD));
  });
});

// ─── killPids ─────────────────────────────────────────────────────────────────
describe("killPids", () => {
  test("does not throw for empty array", () => {
    assert.doesNotThrow(() => killPids([]));
  });

  test("does not throw for invalid pid (swallows error)", () => {
    // PID 999999999 almost certainly does not exist
    assert.doesNotThrow(() => killPids([999999999]));
  });
});

// ─── pidsOnPort ───────────────────────────────────────────────────────────────
describe("pidsOnPort", () => {
  test("returns [] when execSync throws", () => {
    const badExecSync = () => { throw new Error("not found"); };
    const result = pidsOnPort(9999, badExecSync, badExecSync);
    assert.deepEqual(result, []);
  });

  test("parses pid= entries from lsof output", () => {
    const fakeExecSync = () => "pid=1234\npid=5678\n";
    const result = pidsOnPort(9999, fakeExecSync, () => { throw new Error(); });
    assert.deepEqual(result, [1234, 5678]);
  });

  test("returns [] when lsof output has no pid= entries", () => {
    const fakeExecSync = () => "some random output\n";
    const result = pidsOnPort(9999, fakeExecSync, () => { throw new Error(); });
    assert.deepEqual(result, []);
  });
});

// ─── isPortOpen ───────────────────────────────────────────────────────────────
describe("isPortOpen", () => {
  test("returns false for a port that is not listening", async () => {
    // Port 1 is almost always closed / permission-denied
    const result = await isPortOpen(1);
    assert.equal(result, false);
  });
});

// ─── parseLlamaCppPort ────────────────────────────────────────────────────────
describe("parseLlamaCppPort", () => {
  test("defaults to 8080 when unset", () => {
    assert.equal(parseLlamaCppPort({}), 8080);
  });

  test("reads LLAMACPP_PORT from env", () => {
    assert.equal(parseLlamaCppPort({ LLAMACPP_PORT: "9090" }), 9090);
  });
});

// ─── llamacppBase ─────────────────────────────────────────────────────────────
describe("llamacppBase", () => {
  test("returns 127.0.0.1 URL with given port", () => {
    const orig = process.env.LLAMACPP_BASE_URL;
    delete process.env.LLAMACPP_BASE_URL;
    assert.equal(llamacppBase(8080), "http://127.0.0.1:8080");
    if (orig !== undefined) process.env.LLAMACPP_BASE_URL = orig;
  });

  test("returns LLAMACPP_BASE_URL env var when set", () => {
    const orig = process.env.LLAMACPP_BASE_URL;
    process.env.LLAMACPP_BASE_URL = "https://custom:9999";
    assert.equal(llamacppBase(8080), "https://custom:9999");
    if (orig !== undefined) process.env.LLAMACPP_BASE_URL = orig;
    else delete process.env.LLAMACPP_BASE_URL;
  });
});

// ─── llamacppHealthy ──────────────────────────────────────────────────────────
describe("llamacppHealthy", () => {
  test("returns true when fetch responds ok:true", async () => {
    await withMockFetch(
      async () => ({ ok: true }),
      async () => {
        const result = await llamacppHealthy(8080);
        assert.equal(result, true);
      }
    );
  });

  test("returns false when fetch responds ok:false", async () => {
    await withMockFetch(
      async () => ({ ok: false }),
      async () => {
        const result = await llamacppHealthy(8080);
        assert.equal(result, false);
      }
    );
  });

  test("returns false when fetch throws", async () => {
    await withMockFetch(
      async () => { throw new Error("connection refused"); },
      async () => {
        const result = await llamacppHealthy(8080);
        assert.equal(result, false);
      }
    );
  });
});

// ─── probeServer ─────────────────────────────────────────────────────────────
describe("probeServer", () => {
  test("returns false when WebSocket errors immediately", async () => {
    function MockWS(url) {
      this._handlers = {};
      this.on = (event, fn) => { this._handlers[event] = fn; return this; };
      this.terminate = () => {};
      this.close = () => {};
      // Simulate immediate error
      setTimeout(() => this._handlers["error"]?.(), 0);
    }
    const result = await probeServer(31337, MockWS);
    assert.equal(result, false);
  });

  test("returns true when WebSocket opens", async () => {
    function MockWS(url) {
      this._handlers = {};
      this.on = (event, fn) => { this._handlers[event] = fn; return this; };
      this.terminate = () => {};
      this.close = () => {};
      setTimeout(() => this._handlers["open"]?.(), 0);
    }
    const result = await probeServer(31337, MockWS);
    assert.equal(result, true);
  });
});

// ─── printMemories ────────────────────────────────────────────────────────────
describe("printMemories", () => {
  test("null → no memories yet", () => {
    const cap = captureConsole();
    printMemories(null);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("no memories yet")));
  });

  test("empty array → no memories yet", () => {
    const cap = captureConsole();
    printMemories([]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("no memories yet")));
  });

  test("shows count in header", () => {
    const cap = captureConsole();
    printMemories([{ title: "A", content: "a", importance: 3 }, { title: "B", content: "b", importance: 3 }]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("memories (2)")));
  });

  test("shows title and content", () => {
    const cap = captureConsole();
    printMemories([{ title: "My Title", content: "My Content", importance: 3 }]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("My Title")));
    assert.ok(cap.lines.some(l => l.includes("My Content")));
  });

  test("importance 5 → 5 filled stars", () => {
    const cap = captureConsole();
    printMemories([{ title: "T", content: "C", importance: 5 }]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("★★★★★")));
  });

  test("importance 1 → 1 filled star", () => {
    const cap = captureConsole();
    printMemories([{ title: "T", content: "C", importance: 1 }]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("★☆☆☆☆")));
  });

  test("missing importance defaults to 3", () => {
    const cap = captureConsole();
    printMemories([{ title: "T", content: "C" }]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("★★★☆☆")));
  });

  test("importance > 5 clamped to 5", () => {
    const cap = captureConsole();
    printMemories([{ title: "T", content: "C", importance: 99 }]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("★★★★★")));
  });

  test("tags displayed when present", () => {
    const cap = captureConsole();
    printMemories([{ title: "T", content: "C", importance: 3, tags: ["work", "urgent"] }]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("work") && l.includes("urgent")));
  });

  test("no tag brackets when tags empty", () => {
    const cap = captureConsole();
    printMemories([{ title: "T", content: "C", importance: 3, tags: [] }]);
    cap.restore();
    assert.ok(!cap.lines.some(l => /\[[^\]]*\]/.test(l)));
  });

  test("multiple memories all printed", () => {
    const cap = captureConsole();
    printMemories([
      { title: "Alpha", content: "first",  importance: 2 },
      { title: "Beta",  content: "second", importance: 4 },
    ]);
    cap.restore();
    assert.ok(cap.lines.some(l => l.includes("Alpha")));
    assert.ok(cap.lines.some(l => l.includes("Beta")));
  });
});

// ─── detectMightThink ────────────────────────────────────────────────────────
describe("detectMightThink", () => {
  test("deepseek-r1 detected",          () => assert.ok(detectMightThink("deepseek-r1:7b")));
  test("qwen3 detected",                () => assert.ok(detectMightThink("qwen3:8b")));
  test("qwq detected",                  () => assert.ok(detectMightThink("qwq:32b")));
  test("case insensitive",              () => assert.ok(detectMightThink("DeepSeek-R1")));
  test("substring match",               () => assert.ok(detectMightThink("some-qwq-variant")));
  test("llama3 not detected",           () => assert.ok(!detectMightThink("llama3.1")));
  test("mistral not detected",          () => assert.ok(!detectMightThink("mistral:7b")));
  test("empty string → false",          () => assert.ok(!detectMightThink("")));
});

// ─── makeStderrShim ───────────────────────────────────────────────────────────
describe("makeStderrShim", () => {
  test("returns true (stream.write contract)", () => {
    assert.equal(makeStderrShim()("chunk"), true);
  });

  test("calls encoding when it is a function", () => {
    let called = false;
    makeStderrShim()("chunk", () => { called = true; });
    assert.ok(called);
  });

  test("calls callback when encoding is a string", () => {
    let called = false;
    makeStderrShim()("chunk", "utf8", () => { called = true; });
    assert.ok(called);
  });

  test("does not throw with no callbacks", () => {
    assert.doesNotThrow(() => makeStderrShim()("chunk", "utf8"));
  });
});