// tests/lib/helpers/sessions.test.js
//
// Mock strategy (proven by tests/mcp/tools/files.test.js and
// tests/lib/tools/validateWrittenFile.test.js):
//
// 1. Use createRequire() to get CJS module reference for "fs" — the same
//    object that ESM live bindings read for built-in modules.
// 2. Call mock.method() at TOP LEVEL on that CJS object before the
//    dynamic import of the module under test.
// 3. Use mutable closure variables so each test can control the in-memory
//    filesystem behaviour per scenario.
// 4. Call mock.restoreAll() ONCE in after(), never between tests.
// 5. Reset the in-memory filesystem in beforeEach via a closure setter.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("fs");

// ─── In-memory filesystem ─────────────────────────────────────────────────
const memFS = new Map();
let mockCwd = "/test/workspace";

const callLog = {
  readFileSync: [],
  writeFileSync: [],
  mkdirSync: [],
  readdirSync: [],
  existsSync: [],
  unlinkSync: [],
  rmSync: [],
};

function join(...parts) {
  return parts.join("/").replace(/\/+/g, "/");
}

function dirname(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) || "/" : ".";
}

function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

function sessionsDir() {
  return join(mockCwd, "var/sessions");
}

function resetMemFS() {
  memFS.clear();
  const dir = sessionsDir();
  const dirSet = new Set(["existing-session.json", "pinned-session.json"]);
  memFS.set(dir, dirSet);
  memFS.set(
    join(dir, "existing-session.json"),
    JSON.stringify({
      id: "existing-session",
      startedAt: "2026-06-01T10:00:00.000Z",
      endedAt: "2026-06-01T11:00:00.000Z",
      model: "gpt-4",
      provider: "openai",
      source: "web",
      title: "Existing session",
      pinned: false,
      summaries: [],
      messages: [{ role: "user", content: "Hello" }],
    })
  );
  memFS.set(
    join(dir, "pinned-session.json"),
    JSON.stringify({
      id: "pinned-session",
      startedAt: "2026-04-01T10:00:00.000Z",
      endedAt: "2026-04-01T11:00:00.000Z",
      model: "claude-3",
      provider: "anthropic",
      source: "web",
      title: "Pinned session",
      pinned: true,
      summaries: [],
      messages: [],
    })
  );
  for (const key of Object.keys(callLog)) callLog[key] = [];
}

function seedSession(overrides = {}) {
  const session = {
    id: "test-session-id",
    startedAt: "2026-06-01T12:00:00.000Z",
    endedAt: null,
    model: "gpt-4",
    provider: "openai",
    source: "web",
    title: null,
    summaries: [],
    messages: [],
    ...overrides,
  };
  const p = join(sessionsDir(), `${session.id}.json`);
  memFS.set(p, JSON.stringify(session));
  const dirSet = memFS.get(sessionsDir());
  if (dirSet instanceof Set) dirSet.add(`${session.id}.json`);
  return session;
}

// ─── Mutable closures (per-test control) ──────────────────────────────────

// These are set by setupTest() before each test. The mock fs functions
// below use these closures so each test can control behaviour.

let mockReadFileSyncImpl = null;
let mockWriteFileSyncImpl = null;
let mockMkdirSyncImpl = null;
let mockReaddirSyncImpl = null;
let mockExistsSyncImpl = null;
let mockUnlinkSyncImpl = null;
let mockRmSyncImpl = null;

function setupTest() {
  resetMemFS();

  mockReadFileSyncImpl = (p, _enc) => {
    callLog.readFileSync.push(p);
    const content = memFS.get(p);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file '${p}'`);
      err.code = "ENOENT";
      throw err;
    }
    return content;
  };

  mockWriteFileSyncImpl = (p, data, _enc) => {
    callLog.writeFileSync.push(p);
    memFS.set(p, data);
  };

  mockMkdirSyncImpl = (p, _opts) => {
    callLog.mkdirSync.push(p);
    if (!memFS.has(p)) {
      memFS.set(p, new Set());
    }
  };

  mockReaddirSyncImpl = (p) => {
    callLog.readdirSync.push(p);
    const entry = memFS.get(p);
    if (entry === undefined) {
      const err = new Error(`ENOENT: no such directory '${p}'`);
      err.code = "ENOENT";
      throw err;
    }
    if (entry instanceof Set) return [...entry];
    const err = new Error(`ENOTDIR: '${p}' is not a directory`);
    err.code = "ENOTDIR";
    throw err;
  };

  mockExistsSyncImpl = (p) => {
    callLog.existsSync.push(p);
    return memFS.has(p);
  };

  mockUnlinkSyncImpl = (p) => {
    callLog.unlinkSync.push(p);
    if (!memFS.delete(p)) {
      const err = new Error(`ENOENT: no such file '${p}'`);
      err.code = "ENOENT";
      throw err;
    }
    const parent = dirname(p);
    const dirSet = memFS.get(parent);
    if (dirSet instanceof Set) dirSet.delete(basename(p));
  };

  mockRmSyncImpl = (p, _opts) => {
    callLog.rmSync.push(p);
    for (const key of [...memFS.keys()]) {
      if (key === p || key.startsWith(p + "/")) {
        memFS.delete(key);
      }
    }
  };
}

// ─── Top-level mocks (BEFORE the dynamic import) ──────────────────────────
// These use the mutable closures so each test can control behaviour.

const REAL = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  mkdirSync: fs.mkdirSync,
  readdirSync: fs.readdirSync,
  existsSync: fs.existsSync,
  unlinkSync: fs.unlinkSync,
  rmSync: fs.rmSync,
};

function callMockOrReal(funcName, impl, ...args) {
  if (impl) return impl(...args);
  return REAL[funcName](...args);
}

mock.method(fs, "readFileSync",  (...args) => callMockOrReal("readFileSync", mockReadFileSyncImpl, ...args));
mock.method(fs, "writeFileSync", (...args) => callMockOrReal("writeFileSync", mockWriteFileSyncImpl, ...args));
mock.method(fs, "mkdirSync",     (...args) => callMockOrReal("mkdirSync", mockMkdirSyncImpl, ...args));
mock.method(fs, "readdirSync",   (...args) => callMockOrReal("readdirSync", mockReaddirSyncImpl, ...args));
mock.method(fs, "existsSync",    (...args) => callMockOrReal("existsSync", mockExistsSyncImpl, ...args));
mock.method(fs, "unlinkSync",    (...args) => callMockOrReal("unlinkSync", mockUnlinkSyncImpl, ...args));
mock.method(fs, "rmSync",        (...args) => callMockOrReal("rmSync", mockRmSyncImpl, ...args));

// Also mock process.cwd so module-level path defaults match our mock
const originalCwd = process.cwd;
mock.method(process, "cwd", () => mockCwd);

// ─── Dynamic import ───────────────────────────────────────────────────────

let sessions;

before(async () => {
  setupTest();
  sessions = await import("../../../lib/helpers/sessions.js");
  // Reset the paths to use our mockCwd (init is called by each test anyway)
  sessions.init(mockCwd);
});

after(() => {
  mock.restoreAll();
  process.cwd = originalCwd;
});

// beforeEach — reset in-memory state for a fresh test
beforeEach(() => {
  setupTest();
  sessions.init(mockCwd);
});

// =============================================================================
// init
// =============================================================================
describe("init()", () => {
  test("updates the directory paths", () => {
    sessions.init("/custom/root");
    const scratch = sessions.sessionScratchDir("abc123");
    assert.ok(scratch.includes("/custom/root/var/scratch/abc123"));
    sessions.init(mockCwd); // reset
  });
});

// =============================================================================
// sessionScratchDir
// =============================================================================
describe("sessionScratchDir()", () => {
  test("returns the scratch path for a session id", () => {
    const result = sessions.sessionScratchDir("my-session-id");
    assert.ok(result.includes("var/scratch/my-session-id"));
  });
});

// =============================================================================
// createSession
// =============================================================================
describe("createSession()", () => {
  test("creates a session file and returns the id", () => {
    const id = sessions.createSession({ model: "gpt-4", provider: "openai", source: "web" });

    assert.ok(id, "should return an id");
    assert.equal(typeof id, "string");
    assert.equal(id.length, 36); // UUID length

    const p = join(mockCwd, "var/sessions", `${id}.json`);
    assert.ok(memFS.has(p), "session file should exist");

    const saved = JSON.parse(memFS.get(p));
    assert.equal(saved.id, id);
    assert.equal(saved.model, "gpt-4");
    assert.equal(saved.provider, "openai");
    assert.equal(saved.source, "web");
    assert.equal(saved.title, null);
    assert.deepEqual(saved.summaries, []);
    assert.deepEqual(saved.messages, []);
    assert.equal(saved.endedAt, null);
    assert.ok(saved.startedAt);
  });

  test("defaults source to web", () => {
    const id = sessions.createSession({ model: "gpt-4", provider: "openai" });
    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions", `${id}.json`)));
    assert.equal(saved.source, "web");
  });

  test("creates the sessions directory if missing", () => {
    const dir = join(mockCwd, "var/sessions");
    memFS.delete(dir); // Remove the sessions dir

    sessions.createSession({ model: "gpt-4", provider: "openai" });

    assert.ok(callLog.mkdirSync.some(p => p === dir), "mkdirSync should be called for sessions dir");
    assert.ok(memFS.has(dir), "sessions dir should now exist");
  });

  test("accepts custom source", () => {
    const id = sessions.createSession({ model: "m1", provider: "p1", source: "terminal" });
    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions", `${id}.json`)));
    assert.equal(saved.source, "terminal");
  });
});

// =============================================================================
// setSessionTitle
// =============================================================================
describe("setSessionTitle()", () => {
  test("sets the title from the first user text", () => {
    seedSession({ id: "test-session" });

    sessions.setSessionTitle("test-session", "Hello, I need help with something");

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/test-session.json")));
    assert.equal(saved.title, "Hello, I need help with something");
  });

  test("does nothing if session does not exist", () => {
    sessions.setSessionTitle("nonexistent", "Hello");
  });

  test("does nothing if title is already set", () => {
    seedSession({ id: "session-with-title", title: "Existing title" });

    sessions.setSessionTitle("session-with-title", "New title");

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/session-with-title.json")));
    assert.equal(saved.title, "Existing title");
  });

  test("truncates to 80 characters and replaces newlines", () => {
    seedSession({ id: "trunc-session" });

    const longText = "a".repeat(100) + "\n" + "b".repeat(100);
    sessions.setSessionTitle("trunc-session", longText);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/trunc-session.json")));
    assert.equal(saved.title.length, 80);
    assert.ok(!saved.title.includes("\n"));
  });

  test("uses Untitled session for empty text", () => {
    seedSession({ id: "empty-session" });

    sessions.setSessionTitle("empty-session", "");

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/empty-session.json")));
    assert.equal(saved.title, "Untitled session");
  });
});

// =============================================================================
// updateSessionModel
// =============================================================================
describe("updateSessionModel()", () => {
  test("updates the model and provider", () => {
    seedSession({ id: "model-update-session", model: "old-model", provider: "old-provider" });

    sessions.updateSessionModel("model-update-session", {
      model: "new-model",
      provider: "new-provider",
    });

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/model-update-session.json")));
    assert.equal(saved.model, "new-model");
    assert.equal(saved.provider, "new-provider");
  });

  test("does nothing if session does not exist", () => {
    sessions.updateSessionModel("nonexistent", { model: "x", provider: "y" });
  });
});

// =============================================================================
// appendSummary
// =============================================================================
describe("appendSummary()", () => {
  test("appends a summary with transcript", () => {
    seedSession({ id: "summarised", summaries: [] });

    const messages = [
      { role: "system", content: "internal greeting" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How do I write tests?" },
      { role: "assistant", content: "Let me show you\u2026" },
    ];

    sessions.appendSummary("summarised", {
      content: "The user asked about testing.",
      messages,
    });

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/summarised.json")));
    assert.equal(saved.summaries.length, 1);
    assert.equal(saved.summaries[0].content, "The user asked about testing.");
    assert.equal(saved.summaries[0].messageCount, 4); // messages.length - 1
    assert.ok(saved.summaries[0].generatedAt);
    assert.equal(saved.summaries[0].transcript.length, 4);
    assert.equal(saved.summaries[0].transcript[0].role, "user");
    assert.equal(saved.summaries[0].transcript[0].content, "Hello");
  });

  test("does nothing if session does not exist", () => {
    sessions.appendSummary("nonexistent", { content: "x", messages: [] });
  });

  test("appends multiple summaries", () => {
    seedSession({ id: "multi-summary", summaries: [] });

    sessions.appendSummary("multi-summary", {
      content: "First summary",
      messages: [{ role: "user", content: "Hi" }],
    });
    sessions.appendSummary("multi-summary", {
      content: "Second summary",
      messages: [{ role: "assistant", content: "Bye" }],
    });

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/multi-summary.json")));
    assert.equal(saved.summaries.length, 2);
  });

  test("does not include the internal greeting in the transcript", () => {
    seedSession({ id: "no-greeting-transcript", summaries: [] });

    const messages = [
      { role: "system", content: "You are an AI assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    sessions.appendSummary("no-greeting-transcript", {
      content: "A greeting.",
      messages,
    });

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/no-greeting-transcript.json")));
    assert.equal(saved.summaries[0].messageCount, 2);
    assert.ok(saved.summaries[0].transcript.every(m => m.role !== "system"));
  });
});

// =============================================================================
// finaliseSession
// =============================================================================
describe("finaliseSession()", () => {
  test("finalises a meaningful session", () => {
    seedSession({ id: "final", title: null, summaries: [], messages: [] });

    // Need 7+ real messages (after index 0 is sliced off) for isMeaningful
    const messages = [
      { role: "system", content: "internal greeting" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "How can I help?" },
      { role: "user", content: "I need help with something" },
      { role: "assistant", content: "Sure, let me help" },
      { role: "user", content: "I need to build a web scraper with Node.js" },
      { role: "assistant", content: "Here\u2019s how\u2026" },
      { role: "user", content: "Can you show me an example?" },
      { role: "assistant", content: "Here\u2019s a complete example" },
    ];

    sessions.finaliseSession("final", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/final.json")));
    assert.ok(saved.endedAt, "should have endedAt set");
    assert.ok(saved.title, "should have a title");
    assert.ok(Array.isArray(saved.messages), "should have messages");
    assert.ok(saved.messages.every(m => m.role !== "system"), "system messages should be filtered out");
  });

  test("discards a trivial session (greetings only)", () => {
    seedSession({ id: "trivial" });
    const p = join(mockCwd, "var/sessions/trivial.json");
    assert.ok(memFS.has(p), "session file should exist before finalise");

    const messages = [
      { role: "system", content: "internal greeting" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You\u2019re welcome!" },
      { role: "user", content: "Bye" },
      { role: "assistant", content: "See you!" },
    ];

    sessions.finaliseSession("trivial", messages);

    assert.ok(!memFS.has(p), "trivial session file should be removed");
  });

  test("keeps a trivial session that has scratch files", () => {
    const scratchPath = join(mockCwd, "var/scratch/scratchy-session");
    memFS.set(scratchPath, new Set(["output.pptx"]));
    memFS.set(join(scratchPath, "output.pptx"), "fake pptx content");

    seedSession({ id: "scratchy-session" });

    const messages = [
      { role: "system", content: "internal greeting" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];

    sessions.finaliseSession("scratchy-session", messages);

    const p = join(mockCwd, "var/sessions/scratchy-session.json");
    assert.ok(memFS.has(p), "session with scratch files should be kept");
    const saved = JSON.parse(memFS.get(p));
    assert.ok(saved.endedAt, "should be finalised");
  });

  test("keeps a trivial session that had attachments via WeakMap", () => {
    seedSession({ id: "attached-session" });

    const attachMap = new WeakMap();
    const userMsg = { role: "user", content: "Check this" };
    attachMap.set(userMsg, [{ savedPath: "/tmp/upload/file.pdf" }]);

    const messages = [
      { role: "system", content: "internal greeting" },
      userMsg,
      { role: "assistant", content: "Nice file!" },
    ];

    sessions.finaliseSession("attached-session", messages, attachMap);

    const p = join(mockCwd, "var/sessions/attached-session.json");
    assert.ok(memFS.has(p), "session with attachments should be kept");
  });

  test("keeps a trivial session with hadAttachments flag set", () => {
    seedSession({ id: "had-att" });

    const messages = [
      { role: "system", content: "internal greeting" },
      { role: "user", content: "Hi" },
    ];

    sessions.finaliseSession("had-att", messages, null, true);

    const p = join(mockCwd, "var/sessions/had-att.json");
    assert.ok(memFS.has(p), "session with hadAttachments should be kept");
  });

  test("does nothing if session does not exist", () => {
    sessions.finaliseSession("nonexistent", []);
  });

  test("deletes session log and scratch for discarded trivial sessions", () => {
    seedSession({ id: "discard-me" });

    const logPath = join(mockCwd, "var/logs/discard-me.log");
    memFS.set(logPath, "some log data");

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "NP" },
      { role: "user", content: "Bye" },
      { role: "assistant", content: "Cya" },
    ];

    sessions.finaliseSession("discard-me", messages);

    const p = join(mockCwd, "var/sessions/discard-me.json");
    assert.ok(!memFS.has(p), "session should be discarded");
    assert.ok(!memFS.has(logPath), "log file should be deleted");
  });
});

// =============================================================================
// listSessions
// =============================================================================
describe("listSessions()", () => {
  test("returns all sessions without pagination", () => {
    const result = sessions.listSessions();
    assert.equal(Array.isArray(result), true);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "existing-session");
    assert.equal(result[1].id, "pinned-session");
  });

  test("returns paginated results", () => {
    const dir = join(mockCwd, "var/sessions");
    const dirSet = memFS.get(dir);
    for (let i = 0; i < 5; i++) {
      const s = { id: `session-${i}`, startedAt: `2026-06-0${i + 1}T00:00:00.000Z`, endedAt: null, model: "gpt-4", provider: "openai", source: "web", title: `Session ${i}`, pinned: false, summaries: [], messages: [] };
      dirSet.add(`session-${i}.json`);
      memFS.set(join(dir, `session-${i}.json`), JSON.stringify(s));
    }

    const result = sessions.listSessions({ page: 1, limit: 3 });
    assert.equal(result.sessions.length, 3);
    assert.equal(result.total, 7);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 3);
    assert.equal(result.pages, 3);
  });

  test("handles empty sessions dir", () => {
    const dir = join(mockCwd, "var/sessions");
    memFS.set(dir, new Set());

    const result = sessions.listSessions();
    assert.deepEqual(result, []);
  });

  test("skips corrupt JSON files gracefully", () => {
    const dir = join(mockCwd, "var/sessions");
    const dirSet = memFS.get(dir);
    dirSet.add("corrupt.json");
    memFS.set(join(dir, "corrupt.json"), "{not-valid-json");

    const result = sessions.listSessions();
    assert.equal(result.length, 2);
  });

  test("includes metadata in list results", () => {
    const result = sessions.listSessions();
    const pinned = result.find(s => s.id === "pinned-session");
    assert.ok(pinned);
    assert.equal(pinned.pinned, true);
    assert.equal(pinned.title, "Pinned session");
    assert.ok(pinned.startedAt);
    assert.ok(pinned.endedAt);
    assert.equal(pinned.model, "claude-3");
    assert.equal(pinned.provider, "anthropic");
    assert.equal(pinned.source, "web");
  });

  test("sorts sessions newest first", () => {
    const dir = join(mockCwd, "var/sessions");
    const dirSet = memFS.get(dir);
    for (const s of [
      { id: "old", startedAt: "2025-01-01T00:00:00.000Z" },
      { id: "new", startedAt: "2026-06-06T00:00:00.000Z" },
      { id: "mid", startedAt: "2026-01-01T00:00:00.000Z" },
    ]) {
      dirSet.add(`${s.id}.json`);
      memFS.set(join(dir, `${s.id}.json`), JSON.stringify({ ...s, endedAt: null, model: "gpt-4", provider: "openai", source: "web", title: s.id, pinned: false, summaries: [], messages: [] }));
    }

    const result = sessions.listSessions();
    const ids = result.map(s => s.id);
    // Correct order: new (2026-06-06) > existing-session (2026-06-01) > pinned-session (2026-04-01) > mid (2026-01-01) > old (2025-01-01)
    assert.deepEqual(ids.slice(0, 5), ["new", "existing-session", "pinned-session", "mid", "old"]);
  });

  test("uses defaults for missing fields", () => {
    const dir = join(mockCwd, "var/sessions");
    const dirSet = memFS.get(dir);
    dirSet.add("minimal.json");
    memFS.set(join(dir, "minimal.json"), JSON.stringify({
      id: "minimal",
      startedAt: "2026-06-01T00:00:00.000Z",
    }));

    const result = sessions.listSessions();
    const s = result.find(r => r.id === "minimal");
    assert.ok(s);
    assert.equal(s.title, "Untitled");
    assert.equal(s.pinned, false);
    assert.equal(s.summaryCount, 0);
    assert.equal(s.messageCount, 0);
    assert.equal(s.source, "web");
  });
});

// =============================================================================
// getSession
// =============================================================================
describe("getSession()", () => {
  test("returns the session object", () => {
    const result = sessions.getSession("existing-session");
    assert.ok(result);
    assert.equal(result.id, "existing-session");
    assert.equal(result.title, "Existing session");
  });

  test("returns null for non-existent session", () => {
    const result = sessions.getSession("nonexistent");
    assert.equal(result, null);
  });
});

// =============================================================================
// deleteSession
// =============================================================================
describe("deleteSession()", () => {
  test("deletes the session and its artifacts", () => {
    seedSession({
      id: "delete-me",
      messages: [
        { role: "user", content: "Hi", attachments: [{ savedPath: "/tmp/uploads/test.pdf" }] },
      ],
    });
    memFS.set("/tmp/uploads/test.pdf", "fake pdf");

    const result = sessions.deleteSession("delete-me");

    assert.equal(result, true);
    const p = join(mockCwd, "var/sessions/delete-me.json");
    assert.ok(!memFS.has(p), "session file should be deleted");
    assert.ok(!memFS.has("/tmp/uploads/test.pdf"), "attachment file should be deleted");
  });

  test("returns false if session does not exist", () => {
    const result = sessions.deleteSession("nonexistent");
    assert.equal(result, false);
  });

  test("deletes log and scratch directories", () => {
    const logDir = join(mockCwd, "var/logs");
    memFS.set(logDir, new Set(["log-session.log"]));
    memFS.set(join(logDir, "log-session.log"), "log content");
    const scratchDir = join(mockCwd, "var/scratch/log-session");
    memFS.set(scratchDir, new Set(["file.txt"]));
    memFS.set(join(scratchDir, "file.txt"), "content");

    seedSession({ id: "log-session" });

    sessions.deleteSession("log-session");

    assert.ok(!memFS.has(join(logDir, "log-session.log")), "log file should be deleted");
    assert.ok(!memFS.has(scratchDir), "scratch dir should be deleted");
  });

  test("handles missing attachment files gracefully", () => {
    seedSession({
      id: "missing-att",
      messages: [
        { role: "user", content: "Hi", attachments: [{ savedPath: "/tmp/nonexistent/file.pdf" }] },
      ],
    });

    const result = sessions.deleteSession("missing-att");
    assert.equal(result, true);
  });

  test("handles missing log file gracefully", () => {
    seedSession({ id: "no-log" });
    const result = sessions.deleteSession("no-log");
    assert.equal(result, true);
  });
});

// =============================================================================
// pinSession
// =============================================================================
describe("pinSession()", () => {
  test("pins a session", () => {
    seedSession({ id: "pin-test" });

    const result = sessions.pinSession("pin-test", true);
    assert.equal(result, true);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/pin-test.json")));
    assert.equal(saved.pinned, true);
  });

  test("unpins a session", () => {
    seedSession({ id: "pin-test", pinned: true });

    const result = sessions.pinSession("pin-test", false);
    assert.equal(result, true);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/pin-test.json")));
    assert.equal(saved.pinned, false);
  });

  test("returns false if session does not exist", () => {
    const result = sessions.pinSession("nonexistent", true);
    assert.equal(result, false);
  });
});

// =============================================================================
// pruneOldSessions
// =============================================================================
describe("pruneOldSessions()", () => {
  test("removes old non-pinned sessions", () => {
    const origEnv = process.env.SESSION_RETENTION_DAYS;
    process.env.SESSION_RETENTION_DAYS = "1";

    // Clear default sessions so they don't interfere with the count
    const dir = join(mockCwd, "var/sessions");
    memFS.set(dir, new Set());

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    seedSession({ id: "old-session", startedAt: oldDate, pinned: false });
    seedSession({ id: "fresh-session", startedAt: new Date().toISOString(), pinned: false });

    const removed = sessions.pruneOldSessions();
    assert.equal(removed, 1);

    assert.ok(!memFS.has(join(mockCwd, "var/sessions/old-session.json")), "old session should be removed");
    assert.ok(memFS.has(join(mockCwd, "var/sessions/fresh-session.json")), "fresh session should remain");

    if (origEnv !== undefined) process.env.SESSION_RETENTION_DAYS = origEnv;
    else delete process.env.SESSION_RETENTION_DAYS;
  });

  test("does not remove pinned sessions even if old", () => {
    const origEnv = process.env.SESSION_RETENTION_DAYS;
    process.env.SESSION_RETENTION_DAYS = "1";

    // Clear default sessions so they don't interfere with the count
    const dir = join(mockCwd, "var/sessions");
    memFS.set(dir, new Set());

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    seedSession({ id: "old-pinned", startedAt: oldDate, pinned: true });

    const removed = sessions.pruneOldSessions();
    assert.equal(removed, 0);
    assert.ok(memFS.has(join(mockCwd, "var/sessions/old-pinned.json")), "pinned session should remain");

    if (origEnv !== undefined) process.env.SESSION_RETENTION_DAYS = origEnv;
    else delete process.env.SESSION_RETENTION_DAYS;
  });

  test("uses 90 day default retention", () => {
    const origEnv = process.env.SESSION_RETENTION_DAYS;
    delete process.env.SESSION_RETENTION_DAYS;

    // Clear default sessions so they don't interfere
    const dir = join(mockCwd, "var/sessions");
    memFS.set(dir, new Set());

    const oldDate = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();
    seedSession({ id: "very-old", startedAt: oldDate, pinned: false });

    const removed = sessions.pruneOldSessions();
    assert.equal(removed, 1);

    if (origEnv !== undefined) process.env.SESSION_RETENTION_DAYS = origEnv;
  });

  test("handles unreadable files gracefully", () => {
    const dir = join(mockCwd, "var/sessions");
    const dirSet = memFS.get(dir);
    dirSet.add("corrupt.json");
    memFS.set(join(dir, "corrupt.json"), "{invalid json");

    const removed = sessions.pruneOldSessions();
    assert.equal(typeof removed, "number");
  });

  test("uses SESSION_RETENTION_DAYS env var", () => {
    const origEnv = process.env.SESSION_RETENTION_DAYS;
    process.env.SESSION_RETENTION_DAYS = "30";

    seedSession({ id: "recent-env", startedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(), pinned: false });
    seedSession({ id: "old-env", startedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(), pinned: false });

    const removed = sessions.pruneOldSessions();
    assert.equal(removed, 1);

    if (origEnv !== undefined) process.env.SESSION_RETENTION_DAYS = origEnv;
    else delete process.env.SESSION_RETENTION_DAYS;
  });

  test("clamps negative retention values to 1 day", () => {
    const origEnv = process.env.SESSION_RETENTION_DAYS;
    // Setting SESSION_RETENTION_DAYS = "-5" would be Number("-5") → -5,
    // and -5 || 90 → -5 (truthy), then Math.max(1, -5) → 1.
    // So with 1 day retention and a 2-day-old session, it should be pruned.
    process.env.SESSION_RETENTION_DAYS = "-5";

    // Clear default sessions so they don't interfere with the count
    const dir = join(mockCwd, "var/sessions");
    memFS.set(dir, new Set());

    seedSession({ id: "neg-ret", startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), pinned: false });

    const removed = sessions.pruneOldSessions();
    assert.equal(removed, 1);

    if (origEnv !== undefined) process.env.SESSION_RETENTION_DAYS = origEnv;
    else delete process.env.SESSION_RETENTION_DAYS;
  });
});

// =============================================================================
// buildResumeContext
// =============================================================================
describe("buildResumeContext()", () => {
  test("builds context with summaries", () => {
    const session = {
      id: "resume-test",
      startedAt: "2026-06-05T14:00:00.000Z",
      title: "Testing session",
      summaries: [{ content: "The user asked about testing methods." }],
      messages: [],
    };

    const result = sessions.buildResumeContext(session);

    assert.ok(result.includes("Testing session"));
    assert.ok(result.includes("05 Jun 2026"));
    assert.ok(result.includes("The user asked about testing methods."));
  });

  test("builds context with last exchanges when no summaries", () => {
    const session = {
      id: "resume-test-2",
      startedAt: "2026-06-05T14:00:00.000Z",
      title: "Chat about coding",
      summaries: [],
      messages: [
        { role: "user", content: "How do I write a parser?" },
        { role: "assistant", content: "Here\u2019s a recursive descent parser example\u2026" },
      ],
    };

    const result = sessions.buildResumeContext(session);

    assert.ok(result.includes("Chat about coding"));
    assert.ok(result.includes("How do I write a parser?"));
    assert.ok(result.includes("Here\u2019s a recursive descent parser example"));
  });

  test("minimal context with no summaries and no messages", () => {
    const result = sessions.buildResumeContext({
      id: "empty",
      startedAt: "2026-06-05T14:00:00.000Z",
      title: null,
      summaries: [],
      messages: [],
    });
    assert.ok(result.includes("Untitled"));
  });

  test("truncates long message content to 200 chars", () => {
    const longContent = "x".repeat(500);
    const result = sessions.buildResumeContext({
      id: "long-msg",
      startedAt: "2026-06-05T14:00:00.000Z",
      title: "Long chat",
      summaries: [],
      messages: [{ role: "user", content: longContent }],
    });
    const userLine = result.split("\n").find(l => l.startsWith("User:"));
    assert.ok(userLine, "should have a User: line");
    assert.ok(userLine.length <= 210, "content should be truncated");
  });

  test("includes latest summary content from multiple summaries", () => {
    const result = sessions.buildResumeContext({
      id: "multi-sum",
      startedAt: "2026-06-05T14:00:00.000Z",
      title: "Multi summary",
      summaries: [
        { content: "First summary." },
        { content: "Second summary." },
      ],
      messages: [],
    });
    assert.ok(result.includes("Second summary."));
  });

  test("handles null title gracefully", () => {
    const result = sessions.buildResumeContext({
      id: "null-title",
      startedAt: "2026-06-05T14:00:00.000Z",
      title: null,
      summaries: [],
      messages: [],
    });
    assert.ok(result.includes("Untitled"));
  });

  test("handles undefined summaries gracefully", () => {
    const result = sessions.buildResumeContext({
      id: "no-summaries",
      startedAt: "2026-06-05T14:00:00.000Z",
      title: "Test",
      messages: [],
    });
    assert.ok(result.includes("Test"));
  });
});

// =============================================================================
// isMeaningful (tested through finaliseSession)
// =============================================================================
describe("isMeaningful — trivial detection", () => {
  test("greeting-only sessions are trivial and get discarded", () => {
    seedSession({ id: "greeting-only" });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "welcome" },
      { role: "user", content: "bye" },
      { role: "assistant", content: "see you" },
    ];

    sessions.finaliseSession("greeting-only", messages);
    assert.ok(!memFS.has(join(mockCwd, "var/sessions/greeting-only.json")));
  });

  test("session with substantive content is meaningful", () => {
    seedSession({ id: "substantive" });

    // 7+ real messages (after index 0 is sliced) to pass isMeaningful's count check
    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "I need help" },
      { role: "assistant", content: "Sure" },
      { role: "user", content: "I need to build a React component that handles file uploads with drag and drop" },
      { role: "assistant", content: "Great question!" },
      { role: "user", content: "Here\u2019s a complete example\u2026" },
      { role: "assistant", content: "Thanks!" },
    ];

    sessions.finaliseSession("substantive", messages);
    assert.ok(memFS.has(join(mockCwd, "var/sessions/substantive.json")));
  });

  test("many trivial messages is still trivial", () => {
    seedSession({ id: "many-trivial" });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
      { role: "assistant", content: "good" },
      { role: "user", content: "cool" },
      { role: "assistant", content: "yeah" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "np" },
      { role: "user", content: "bye" },
      { role: "assistant", content: "cya" },
    ];

    sessions.finaliseSession("many-trivial", messages);
    assert.ok(!memFS.has(join(mockCwd, "var/sessions/many-trivial.json")));
  });

  test("short message matching trivial pattern is trivial", () => {
    seedSession({ id: "short-substantive" });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "I'm an AI." },
      { role: "user", content: "fine" },
      { role: "assistant", content: "Good." },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "np" },
      { role: "user", content: "bye" },
    ];

    sessions.finaliseSession("short-substantive", messages);
    assert.ok(!memFS.has(join(mockCwd, "var/sessions/short-substantive.json")));
  });

  test("message longer than 50 chars is never trivial", () => {
    seedSession({ id: "long-enough" });

    // 7+ real messages with one > 50 chars → should be kept
    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
      { role: "assistant", content: "good" },
      { role: "user", content: "ok" + "a".repeat(60) },  // > 50 chars → not trivial
      { role: "assistant", content: "Great!" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "welcome" },
    ];

    sessions.finaliseSession("long-enough", messages);
    assert.ok(memFS.has(join(mockCwd, "var/sessions/long-enough.json")));
  });

  test("hadAttachments flag overrides trivial detection", () => {
    seedSession({ id: "att-override" });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "hi" },
    ];

    sessions.finaliseSession("att-override", messages, null, true);
    assert.ok(memFS.has(join(mockCwd, "var/sessions/att-override.json")));
  });
});

// =============================================================================
// deriveTitle (tested through finaliseSession)
// =============================================================================
describe("deriveTitle — title derivation", () => {
  test("uses summary bullet point for title", () => {
    seedSession({ id: "title-summary", summaries: [], title: null });

    sessions.appendSummary("title-summary", {
      content: "- Building a REST API with Express\n- Setting up middleware",
      messages: [
        { role: "system" },
        { role: "user", content: "I need to build a REST API" },
      ],
    });

    // 7+ real messages for isMeaningful
    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "I need help" },
      { role: "assistant", content: "Sure" },
      { role: "user", content: "I need to build a REST API" },
      { role: "assistant", content: "Sure, here\u2019s how\u2026" },
      { role: "user", content: "Can you show me?" },
      { role: "assistant", content: "Yes, here" },
    ];
    sessions.finaliseSession("title-summary", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/title-summary.json")));
    assert.ok(saved.title, "should have a title");
    assert.ok(saved.title.includes("Building") || saved.title.includes("REST"));
  });

  test("falls back to first substantive user message", () => {
    seedSession({ id: "title-msg", summaries: [], title: null });

    // 7+ real messages for isMeaningful
    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "I need help" },
      { role: "assistant", content: "Sure" },
      { role: "user", content: "Can you help me deploy a Docker container to AWS ECS?" },
      { role: "assistant", content: "I\u2019d be happy to help!" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You\u2019re welcome" },
    ];

    sessions.finaliseSession("title-msg", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/title-msg.json")));
    assert.ok(saved.title, "should have a title");
    assert.ok(
      saved.title.toLowerCase().includes("docker") || saved.title.toLowerCase().includes("aws"),
      "title should mention the substantive topic"
    );
  });

  test("cleans leading filler words from title", () => {
    seedSession({ id: "filler-test", summaries: [], title: null });

    // 7+ real messages for isMeaningful
    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "I need help" },
      { role: "assistant", content: "Sure" },
      { role: "user", content: "so basically I need to build a machine learning pipeline" },
      { role: "assistant", content: "Great question!" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You\u2019re welcome" },
    ];

    sessions.finaliseSession("filler-test", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/filler-test.json")));
    assert.ok(saved.title, "should have a title");
    // cleanTitle only removes the first match. "so " is removed but "basically"
    // remains because the regex is applied once (only one replacement pass).
    assert.ok(!saved.title.startsWith("So "), "should not start with 'So '");
    assert.ok(saved.title.startsWith("Basically"), "'Basically' remains after 'so ' is stripped");
    assert.ok(saved.title.toLowerCase().includes("machine learning"), "should include the topic");
  });

  test("removes leading articles from title", () => {
    seedSession({ id: "article-title", summaries: [], title: null });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "I need help" },
      { role: "assistant", content: "Sure" },
      { role: "user", content: "The best way to write unit tests in JavaScript" },
      { role: "assistant", content: "Here\u2019s how!" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You\u2019re welcome" },
    ];

    sessions.finaliseSession("article-title", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/article-title.json")));
    assert.ok(!saved.title.startsWith("The "), "should not start with 'The'");
    assert.ok(saved.title.startsWith("Best"), "should start with 'Best'");
  });

  test("titles are truncated to 60 chars", () => {
    seedSession({ id: "long-title-test", summaries: [], title: null });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "I need help" },
      { role: "assistant", content: "Sure" },
      { role: "user", content: "Can you explain the complete architecture of a distributed event-sourcing system using Kafka, Cassandra, and Kubernetes with detailed deployment instructions?" },
      { role: "assistant", content: "Sure!" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You\u2019re welcome" },
    ];

    sessions.finaliseSession("long-title-test", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/long-title-test.json")));
    assert.ok(saved.title, "should have a title");
    assert.ok(saved.title.length <= 60, `title length ${saved.title.length} should be \u2264 60`);
  });

  test("uses summary first line fallback when no bullet point found", () => {
    seedSession({ id: "summary-fallback", summaries: [], title: null });

    sessions.appendSummary("summary-fallback", {
      content: "The user asked about configuring Webpack for a React project.",
      messages: [
        { role: "system" },
        { role: "user", content: "Webpack config help" },
      ],
    });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "I need help" },
      { role: "assistant", content: "Sure" },
      { role: "user", content: "Webpack config help" },
      { role: "assistant", content: "Here\u2019s how\u2026" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You\u2019re welcome" },
    ];
    sessions.finaliseSession("summary-fallback", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/summary-fallback.json")));
    assert.ok(saved.title, "should have a title");
    assert.ok(saved.title.toLowerCase().includes("webpack") || saved.title.toLowerCase().includes("react"));
  });

  test("meta-command messages get lower score for title", () => {
    seedSession({ id: "meta-vs-substantive", summaries: [], title: null });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "summarize the key points from our discussion" },
      { role: "assistant", content: "Here's the summary\u2026" },
      { role: "user", content: "Can you explain how promises work in JavaScript?" },
      { role: "assistant", content: "Promises are\u2026" },
      { role: "user", content: "save this for later" },
      { role: "assistant", content: "Saved!" },
    ];

    sessions.finaliseSession("meta-vs-substantive", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/meta-vs-substantive.json")));
    assert.ok(saved.title, "should have a title");
    assert.ok(
      saved.title.toLowerCase().includes("promise") || saved.title.toLowerCase().includes("javascript"),
      "title should prefer substantive topic over meta-command"
    );
  });

  test("strips 'okay' and 'right now' from title", () => {
    seedSession({ id: "clean-test", summaries: [], title: null });

    const messages = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "I need help" },
      { role: "assistant", content: "Sure" },
      { role: "user", content: "Okay, how do I deploy Node.js to production?" },
      { role: "assistant", content: "Here\u2019s a guide\u2026" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You\u2019re welcome" },
    ];

    sessions.finaliseSession("clean-test", messages);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/clean-test.json")));
    assert.ok(saved.title, "should have a title");
    assert.ok(!saved.title.startsWith("Okay,"), "should not start with 'Okay,'");
    assert.ok(saved.title.toLowerCase().includes("deploy") || saved.title.toLowerCase().includes("node.js"));
  });
});

// =============================================================================
// toReadableMessages (tested through finaliseSession)
// =============================================================================
describe("toReadableMessages — message formatting", () => {
  test("filters out system messages", () => {
    seedSession({ id: "readable-test", summaries: [], title: null });

    // Need 7+ real messages. Use hadAttachments flag to bypass trivial check.
    const messages = [
      { role: "system", content: "internal greeting prompt" },
      { role: "user", content: "How do I sort an array?" },
      { role: "assistant", content: "Use .sort()!" },
    ];

    sessions.finaliseSession("readable-test", messages, null, true);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/readable-test.json")));
    assert.equal(saved.messages.length, 2);
    assert.ok(saved.messages.every(m => m.role !== "system"));
  });

  test("extracts text from array content blocks", () => {
    seedSession({ id: "array-content", summaries: [], title: null });

    const messages = [
      { role: "system" },
      {
        role: "user",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      },
      { role: "assistant", content: "Hi there!" },
    ];

    sessions.finaliseSession("array-content", messages, null, true);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/array-content.json")));
    assert.equal(saved.messages[0].content, "Hello world");
  });

  test("includes attachments metadata from WeakMap", () => {
    seedSession({ id: "attach-meta", summaries: [], title: null });

    const attachMap = new WeakMap();
    const userMsg = { role: "user", content: "See this file" };
    attachMap.set(userMsg, [{ name: "report.pdf", size: 12345 }]);

    const messages = [
      { role: "system" },
      userMsg,
      { role: "assistant", content: "Looks good" },
    ];

    sessions.finaliseSession("attach-meta", messages, attachMap);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/attach-meta.json")));
    assert.ok(saved.messages[0].attachments, "should have attachments");
    assert.equal(saved.messages[0].attachments[0].name, "report.pdf");
  });

  test("filters out messages with no content and no attachments", () => {
    seedSession({ id: "no-content-filter", summaries: [], title: null });

    const messages = [
      { role: "system" },
      { role: "user", content: "" },
      { role: "assistant", content: "   " },
      { role: "user", content: "Actual content here" },
    ];

    sessions.finaliseSession("no-content-filter", messages, null, true);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/no-content-filter.json")));
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.messages[0].content, "Actual content here");
  });

  test("copies _model and _provider fields", () => {
    seedSession({ id: "model-meta", summaries: [], title: null });

    const messages = [
      { role: "system" },
      { role: "user", content: "Hello", _model: "gpt-4", _provider: "openai" },
      { role: "assistant", content: "Hi" },
    ];

    sessions.finaliseSession("model-meta", messages, null, true);

    const saved = JSON.parse(memFS.get(join(mockCwd, "var/sessions/model-meta.json")));
    assert.equal(saved.messages[0].model, "gpt-4");
    assert.equal(saved.messages[0].provider, "openai");
  });
});
