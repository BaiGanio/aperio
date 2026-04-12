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
  moveTo, setScrollRegion,
  // header
  initDockerState, initHeader, setHeaderStatus,
  updateHeaderModel, updateHeaderReasoning, redrawHeader,
  // spinner
  SPINNER_FRAMES, SPINNER_STAGES,
  resolveSpinnerStage, startSpinner, stopSpinner,
  // readline helpers
  ask, printQ,
  // port helpers
  isPortOpen, pidsOnPort, killPids,
  // ollama
  ollamaBase, ollamaHealthy, listOllamaModels,
  // model picker
  resolveModelChoice,
  // server probe
  probeServer,
  // memory display
  printMemories,
  // misc
  detectMightThink, makeStderrShim,
  parseServerPort, parseOllamaPort,
} from "../../../lib/assets/chat-utils.js";

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

describe("setScrollRegion", () => {
  test("produces DECSTBM sequence", () => assert.equal(setScrollRegion(5, 40), "\x1b[5;40r"));
  test("uses HEADER_LINES+1",       () => assert.equal(setScrollRegion(HEADER_LINES + 1, 30), "\x1b[5;30r"));
});

// ─── parseServerPort / parseOllamaPort ───────────────────────────────────────
describe("parseServerPort", () => {
  test("defaults to 31337",          () => assert.equal(parseServerPort({}),                    31337));
  test("reads custom value",         () => assert.equal(parseServerPort({ SERVER_PORT: "8080" }), 8080));
  test("undefined falls to default", () => assert.equal(parseServerPort({ SERVER_PORT: undefined }), 31337));
});

describe("parseOllamaPort", () => {
  test("defaults to 11434",          () => assert.equal(parseOllamaPort({}),                    11434));
  test("reads custom value",         () => assert.equal(parseOllamaPort({ OLLAMA_PORT: "12000" }), 12000));
});

// ─── initDockerState ──────────────────────────────────────────────────────────
describe("initDockerState", () => {
  test("docker on → 'on' and 'postgres' appear in header", () => {
    const cap = captureStdout();
    initDockerState(true);
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("on"));
    assert.ok(cap.output.includes("postgres"));
  });

  test("docker off → 'off' and 'lancedb' appear in header", () => {
    const cap = captureStdout();
    initDockerState(false);
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("off"));
    assert.ok(cap.output.includes("lancedb"));
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

  test("mode appears in output", () => {
    const cap = captureStdout();
    initHeader("standalone", "model", false);
    cap.restore();
    assert.ok(cap.output.includes("standalone"));
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
    // after second init the status line has no DIM (status is empty)
    const afterSecondInit = cap.output.split("\x1b[2J").pop();
    assert.ok(!afterSecondInit.includes(DIM));
  });

  test("sets scroll region below HEADER_LINES", () => {
    const cap = captureStdout();
    withTerminalSize(80, 30, () => initHeader("x", "y", false));
    cap.restore();
    assert.ok(cap.output.includes(setScrollRegion(HEADER_LINES + 1, 30)));
  });
});

// ─── redrawHeader ─────────────────────────────────────────────────────────────
describe("redrawHeader", () => {
  test("wraps in HIDE/SHOW cursor", () => {
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes(HIDE_CURSOR));
    assert.ok(cap.output.includes(SHOW_CURSOR));
    assert.ok(cap.output.indexOf(HIDE_CURSOR) < cap.output.indexOf(SHOW_CURSOR));
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
    assert.ok(cap.output.includes("reasoning:"));
  });

  test("reasoning indicator absent when false", () => {
    const cap = captureStdout();
    initHeader("chat", "model", false);
    cap.restore();
    assert.ok(!cap.output.includes("reasoning:"));
  });

  test("commands line always present", () => {
    const cap = captureStdout();
    redrawHeader();
    cap.restore();
    assert.ok(cap.output.includes("exit"));
    assert.ok(cap.output.includes("clear"));
    assert.ok(cap.output.includes("memories"));
    assert.ok(cap.output.includes("reasoning"));
  });
});

// ─── setHeaderStatus ──────────────────────────────────────────────────────────
describe("setHeaderStatus", () => {
  test("status text renders with DIM", () => {
    const cap = captureStdout();
    setHeaderStatus("thinking");
    cap.restore();
    assert.ok(cap.output.includes("thinking"));
    assert.ok(cap.output.includes(DIM));
  });

  test("clearing status removes DIM", () => {
    let cap = captureStdout();
    setHeaderStatus("working");
    cap.restore();
    cap = captureStdout();
    setHeaderStatus("");
    cap.restore();
    assert.ok(!cap.output.includes(DIM));
  });
});

// ─── updateHeaderModel ────────────────────────────────────────────────────────
describe("updateHeaderModel", () => {
  test("trims whitespace", () => {
    const cap = captureStdout();
    updateHeaderModel("  phi3:mini  ");
    cap.restore();
    assert.ok(cap.output.includes("phi3:mini"));
    assert.ok(!cap.output.includes("  phi3:mini  "));
  });

  test("new model replaces old in output", () => {
    let cap = captureStdout();
    initHeader("chat", "llama3", false);
    cap.restore();
    cap = captureStdout();
    updateHeaderModel("mistral:7b");
    cap.restore();
    assert.ok(cap.output.includes("mistral:7b"));
    assert.ok(!cap.output.includes("llama3"));
  });
});

// ─── updateHeaderReasoning ────────────────────────────────────────────────────
describe("updateHeaderReasoning", () => {
  test("true enables reasoning line", () => {
    const cap = captureStdout();
    updateHeaderReasoning(true);
    cap.restore();
    assert.ok(cap.output.includes("reasoning:"));
  });

  test("false disables reasoning line", () => {
    let cap = captureStdout();
    initHeader("chat", "model", true);
    cap.restore();
    cap = captureStdout();
    updateHeaderReasoning(false);
    cap.restore();
    assert.ok(!cap.output.includes("reasoning:"));
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

  test("stopSpinner clears header status", () => {
    const cap = captureStdout();
    startSpinner("busy");
    stopSpinner();
    cap.restore();
    // After stopSpinner, status should be empty — no DIM in final redraw
    const lastRedraw = cap.output.split(HIDE_CURSOR).pop();
    assert.ok(!lastRedraw.includes(DIM));
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

// ─── ollamaBase ───────────────────────────────────────────────────────────────
describe("ollamaBase", () => {
  test("returns localhost URL with given port", () => {
    const orig = process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_BASE_URL;
    assert.equal(ollamaBase(11434), "http://localhost:11434");
    if (orig !== undefined) process.env.OLLAMA_BASE_URL = orig;
  });

  test("returns OLLAMA_BASE_URL env var when set", () => {
    const orig = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = "http://custom:9999";
    assert.equal(ollamaBase(11434), "http://custom:9999");
    if (orig !== undefined) process.env.OLLAMA_BASE_URL = orig;
    else delete process.env.OLLAMA_BASE_URL;
  });
});

// ─── ollamaHealthy ────────────────────────────────────────────────────────────
describe("ollamaHealthy", () => {
  test("returns true when fetch responds ok:true", async () => {
    await withMockFetch(
      async () => ({ ok: true }),
      async () => {
        const result = await ollamaHealthy(11434);
        assert.equal(result, true);
      }
    );
  });

  test("returns false when fetch responds ok:false", async () => {
    await withMockFetch(
      async () => ({ ok: false }),
      async () => {
        const result = await ollamaHealthy(11434);
        assert.equal(result, false);
      }
    );
  });

  test("returns false when fetch throws", async () => {
    await withMockFetch(
      async () => { throw new Error("connection refused"); },
      async () => {
        const result = await ollamaHealthy(11434);
        assert.equal(result, false);
      }
    );
  });
});

// ─── listOllamaModels ─────────────────────────────────────────────────────────
describe("listOllamaModels", () => {
  test("returns model names from API response", async () => {
    await withMockFetch(
      async () => ({
        ok: true,
        json: async () => ({ models: [{ name: "llama3:8b" }, { name: "mistral:7b" }] }),
      }),
      async () => {
        const result = await listOllamaModels(11434);
        assert.deepEqual(result, ["llama3:8b", "mistral:7b"]);
      }
    );
  });

  test("returns [] when models key is missing", async () => {
    await withMockFetch(
      async () => ({ ok: true, json: async () => ({}) }),
      async () => {
        const result = await listOllamaModels(11434);
        assert.deepEqual(result, []);
      }
    );
  });

  test("returns [] when fetch throws", async () => {
    await withMockFetch(
      async () => { throw new Error("network error"); },
      async () => {
        const result = await listOllamaModels(11434);
        assert.deepEqual(result, []);
      }
    );
  });
});

// ─── resolveModelChoice ───────────────────────────────────────────────────────
describe("resolveModelChoice", () => {
  const current = "llama3.1";
  const others  = ["mistral:7b", "phi3:mini", "gemma2"];

  test("empty answer → keep",          () => assert.deepEqual(resolveModelChoice("",    current, others), { action: "keep",   model: current }));
  test("'0' → keep",                   () => assert.deepEqual(resolveModelChoice("0",   current, others), { action: "keep",   model: current }));
  test("non-numeric → keep",           () => assert.deepEqual(resolveModelChoice("abc", current, others), { action: "keep",   model: current }));
  test("'1' → switch to first",        () => assert.deepEqual(resolveModelChoice("1",   current, others), { action: "switch", model: "mistral:7b" }));
  test("'2' → switch to second",       () => assert.deepEqual(resolveModelChoice("2",   current, others), { action: "switch", model: "phi3:mini"  }));
  test("'3' → switch to third",        () => assert.deepEqual(resolveModelChoice("3",   current, others), { action: "switch", model: "gemma2"     }));
  test("pullIdx → pull",               () => assert.deepEqual(resolveModelChoice("4",   current, others), { action: "pull",   model: null         }));
  test("out of range → keep",          () => assert.deepEqual(resolveModelChoice("99",  current, others), { action: "keep",   model: current      }));
  test("whitespace trimmed",           () => assert.deepEqual(resolveModelChoice("  1 ", current, others), { action: "switch", model: "mistral:7b" }));
  test("no others: '1' → pull",        () => assert.deepEqual(resolveModelChoice("1",   current, []),      { action: "pull",   model: null         }));
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
    assert.ok(!cap.lines.some(l => /\[.+\]/.test(l)));
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