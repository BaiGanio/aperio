// Tests for session-prune.js — createSessionPruner
//
// installMemfs patches the CJS `fs` module object which ESM `import from "fs"`
// reads from. ALL static imports of modules that transitively import "fs" are
// AVOIDED — they would snapshot the ESM bindings before memfs can patch.
// Logger and sessions are imported dynamically after installMemfs runs.
//
// No real filesystem is touched. Session files live in an in-memory Map.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installMemfs } from "../../helpers/memfs.js";

// ─── In-memory filesystem — install BEFORE any ESM import that uses "fs" ──────

const mem = installMemfs({ root: "/mem/prune" });
const { fs: memfs, root } = mem;

// ─── Test suites ──────────────────────────────────────────────────────────────

describe("createSessionPruner", () => {
  let sessInit;
  let createSessionPruner;
  let logger;

  before(async () => {
    // Dynamic imports — these resolve AFTER installMemfs has patched fs,
    // so their ESM bindings read from the patched CJS module.
    const loggerMod = await import("../../../lib/helpers/logger.js");
    logger = loggerMod.default;

    mock.method(logger, "info",  mock.fn());
    mock.method(logger, "error", mock.fn());

    const sess = await import("../../../lib/helpers/sessions.js");
    sessInit = sess.init;

    const mod = await import("../../../lib/workers/session-prune.js");
    createSessionPruner = mod.createSessionPruner;
  });

  after(() => {
    mem.restore();
    mock.restoreAll();
  });

  /** Each test starts with a clean memfs and fresh SESSION_DIR pointing to root. */
  beforeEach(() => {
    mem.reset();
    sessInit(root);
  });

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const SESSION_DIR = () => `${root}/var/sessions`;

  function createSession(id, overrides = {}) {
    mem.mkdirp(SESSION_DIR());
    const data = JSON.stringify({
      id,
      startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      pinned: false,
      messages: [],
      ...overrides,
    });
    mem.writeFile(`${SESSION_DIR()}/${id}.json`, data);
  }

  // ─── Empty sessions dir ─────────────────────────────────────────────────────

  test("returns { stop } object", () => {
    const pruner = createSessionPruner();
    assert.ok(pruner);
    assert.strictEqual(typeof pruner.stop, "function");
    pruner.stop();
  });

  test("no log when no session files exist", () => {
    const beforeInfo = logger.info.mock.callCount();

    const pruner = createSessionPruner();
    pruner.stop();

    assert.strictEqual(logger.info.mock.callCount() - beforeInfo, 0);
  });

  // ─── Retention logic ────────────────────────────────────────────────────────

  test("prunes old unpinned sessions", () => {
    createSession("old-session", {
      startedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
    });
    createSession("recent-session", { startedAt: new Date().toISOString() });

    const beforeInfo = logger.info.mock.callCount();

    const pruner = createSessionPruner();
    pruner.stop();

    assert.strictEqual(logger.info.mock.callCount() - beforeInfo, 1);
    const calls = logger.info.mock.calls;
    const lastMsg = calls[calls.length - 1].arguments[0];
    assert.match(lastMsg, /removed 1 expired/);

    // The old session file should be gone from memfs
    assert.strictEqual(memfs.existsSync(`${SESSION_DIR()}/old-session.json`), false);
    // The recent session should remain
    assert.strictEqual(memfs.existsSync(`${SESSION_DIR()}/recent-session.json`), true);
  });

  test("does not prune pinned sessions", () => {
    createSession("pinned-old", {
      startedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      pinned: true,
    });
    createSession("unpinned-old", {
      startedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      pinned: false,
    });

    const beforeInfo = logger.info.mock.callCount();

    const pruner = createSessionPruner();
    pruner.stop();

    assert.strictEqual(logger.info.mock.callCount() - beforeInfo, 1);
    assert.strictEqual(memfs.existsSync(`${SESSION_DIR()}/pinned-old.json`), true);
    assert.strictEqual(memfs.existsSync(`${SESSION_DIR()}/unpinned-old.json`), false);
  });

  test("does not prune sessions within retention period", () => {
    createSession("recent-a", {
      startedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    });
    createSession("recent-b", {
      startedAt: new Date(Date.now() - 85 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const beforeInfo = logger.info.mock.callCount();

    const pruner = createSessionPruner();
    pruner.stop();

    assert.strictEqual(logger.info.mock.callCount() - beforeInfo, 0);
    assert.strictEqual(memfs.existsSync(`${SESSION_DIR()}/recent-a.json`), true);
    assert.strictEqual(memfs.existsSync(`${SESSION_DIR()}/recent-b.json`), true);
  });

  // ─── Custom retention env var ───────────────────────────────────────────────

  test("respects SESSION_RETENTION_DAYS env var", () => {
    process.env.SESSION_RETENTION_DAYS = "10";

    createSession("env-old", {
      startedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    });
    createSession("env-ok", {
      startedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const beforeInfo = logger.info.mock.callCount();

    const pruner = createSessionPruner();
    pruner.stop();

    assert.strictEqual(logger.info.mock.callCount() - beforeInfo, 1);
    assert.strictEqual(memfs.existsSync(`${SESSION_DIR()}/env-old.json`), false);
    assert.strictEqual(memfs.existsSync(`${SESSION_DIR()}/env-ok.json`), true);

    delete process.env.SESSION_RETENTION_DAYS;
  });

  // ─── Error handling ─────────────────────────────────────────────────────────

  test("no crash when sessions dir is created on demand", () => {
    const beforeInfo = logger.info.mock.callCount();
    const beforeErr  = logger.error.mock.callCount();

    const pruner = createSessionPruner();
    pruner.stop();

    assert.strictEqual(logger.info.mock.callCount() - beforeInfo, 0);
    assert.strictEqual(logger.error.mock.callCount() - beforeErr,  0);
    // The directory was auto-created
    assert.strictEqual(memfs.existsSync(SESSION_DIR()), true);
  });

  test("skips corrupt session files without crashing", () => {
    createSession("good-session", { startedAt: new Date().toISOString() });
    mem.mkdirp(SESSION_DIR());
    mem.writeFile(`${SESSION_DIR()}/corrupt.json`, "{not valid json");

    const beforeInfo = logger.info.mock.callCount();
    const beforeErr  = logger.error.mock.callCount();

    const pruner = createSessionPruner();
    pruner.stop();

    assert.strictEqual(logger.info.mock.callCount() - beforeInfo, 0);
    assert.strictEqual(logger.error.mock.callCount() - beforeErr,  0);
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  test("stop() can be called multiple times safely", () => {
    const pruner = createSessionPruner();
    assert.doesNotThrow(() => pruner.stop());
    assert.doesNotThrow(() => pruner.stop());
  });
});
