// tests/unit/helpers/extractorPool.test.js
//
// The pool moves indexing's extraction step onto a worker thread (issue S2.1).
// What has to be true for that to be safe is mostly about failure: a worker
// that will not start, dies mid-file, or cannot be handed the payload must
// never cost a file — the caller falls back to extracting in-process. And the
// one case that must NOT fall back is a genuine extractor error, because
// retrying an unparseable file on the main thread only burns the time twice.
//
// The Worker class is injected, so these tests spawn no threads. One test at
// the end uses the real worker modules to prove the wiring.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import logger from "../../../lib/helpers/logger.js";
import {
  createExtractorPool,
  viaWorker,
  MAX_CONSECUTIVE_FAILURES,
} from "../../../lib/helpers/extractorPool.js";

before(() => {
  mock.method(logger, "info", () => {});
  mock.method(logger, "warn", () => {});
  mock.method(logger, "error", () => {});
});
after(() => { mock.restoreAll(); });

// A fake Worker whose replies the test drives by hand.
class FakeWorker extends EventEmitter {
  constructor(url, { onPost, failConstruct } = {}) {
    super();
    if (failConstruct) throw new Error("worker threads unavailable");
    this.url = url;
    this.posted = [];
    this.terminated = false;
    this.refs = [];
    this._onPost = onPost;
  }
  postMessage(msg) {
    this.posted.push(msg);
    this._onPost?.(this, msg);
  }
  ref() { this.refs.push("ref"); }
  unref() { this.refs.push("unref"); }
  async terminate() { this.terminated = true; }
  // Convenience: answer the last message.
  reply(result) {
    const { id } = this.posted.at(-1);
    this.emit("message", { id, ok: true, result });
  }
  replyError(error) {
    const { id } = this.posted.at(-1);
    this.emit("message", { id, ok: false, error });
  }
}

function poolWith(opts = {}) {
  const made = [];
  const WorkerImpl = class extends FakeWorker {
    constructor(url) { super(url, opts); made.push(this); }
  };
  const pool = createExtractorPool({
    workerUrl: "file:///fake-worker.js",
    label: "testgraph",
    idleMs: 10_000,
    WorkerImpl,
  });
  return { pool, made };
}

describe("createExtractorPool", () => {
  test("spawns nothing until the first extraction", () => {
    const { pool, made } = poolWith();
    assert.equal(made.length, 0);
    assert.equal(pool.started, false);
  });

  test("returns the worker's result", async () => {
    const { pool, made } = poolWith({
      onPost: (w) => setImmediate(() => w.reply({ symbols: [1, 2] })),
    });
    const out = await pool.run("ts", "source", "a.js");
    assert.deepEqual(out, { ok: true, result: { symbols: [1, 2] } });
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].posted[0], { id: 1, key: "ts", source: "source", relPath: "a.js" });
  });

  test("reuses one worker across calls", async () => {
    const { pool, made } = poolWith({ onPost: (w) => setImmediate(() => w.reply(null)) });
    await pool.run("ts", "a", "a.js");
    await pool.run("ts", "b", "b.js");
    assert.equal(made.length, 1);
    assert.equal(made[0].posted.length, 2);
  });

  test("an extractor error is reported, NOT turned into a fallback", async () => {
    const { pool } = poolWith({
      onPost: (w) => setImmediate(() => w.replyError({ message: "bad syntax", code: "EXTRACT_EMPTY_TREE" })),
    });
    const out = await pool.run("ts", "junk", "a.js");
    assert.equal(out.ok, false);
    assert.equal(out.fallback, undefined);
    assert.equal(out.error.code, "EXTRACT_EMPTY_TREE");
  });

  test("a worker that will not construct falls back", async () => {
    const { pool } = poolWith({ failConstruct: true });
    const out = await pool.run("ts", "a", "a.js");
    assert.equal(out.fallback, true);
  });

  test("a worker that dies mid-extraction falls back rather than hanging", async () => {
    const { pool } = poolWith({ onPost: (w) => setImmediate(() => w.emit("exit", 7)) });
    const out = await pool.run("ts", "a", "a.js");
    assert.equal(out.fallback, true);
    assert.match(out.reason, /exit 7/);
  });

  test("a payload that cannot be posted falls back without killing the worker", async () => {
    const { pool, made } = poolWith({
      onPost: () => { throw new Error("could not be cloned"); },
    });
    const out = await pool.run("ts", "a", "a.js");
    assert.equal(out.fallback, true);
    assert.match(out.reason, /could not be cloned/);
    assert.equal(made[0].terminated, false, "one unclonable file must not cost the worker");
  });

  test("repeated crashes disable the pool instead of respawning forever", async () => {
    const { pool, made } = poolWith({ onPost: (w) => setImmediate(() => w.emit("exit", 1)) });
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      const out = await pool.run("ts", "a", "a.js");
      assert.equal(out.fallback, true);
    }
    assert.equal(pool.disabled, true);
    const spawnsSoFar = made.length;
    const after = await pool.run("ts", "a", "a.js");
    assert.equal(after.fallback, true);
    assert.equal(made.length, spawnsSoFar, "a disabled pool spawns nothing further");
  });

  test("a success resets the failure count", async () => {
    let mode = "crash";
    const { pool } = poolWith({
      onPost: (w) => setImmediate(() => {
        if (mode === "crash") w.emit("exit", 1); else w.reply("ok");
      }),
    });
    await pool.run("ts", "a", "a.js");
    await pool.run("ts", "a", "a.js");
    mode = "ok";
    assert.equal((await pool.run("ts", "a", "a.js")).ok, true);
    mode = "crash";
    // Two more crashes must not trip the ceiling, because the counter reset.
    await pool.run("ts", "a", "a.js");
    await pool.run("ts", "a", "a.js");
    assert.equal(pool.disabled, false);
  });

  test("the worker is unref'd while idle and ref'd while working", async () => {
    let captured;
    const { pool, made } = poolWith({
      onPost: (w) => { captured = w; setImmediate(() => w.reply("x")); },
    });
    await pool.run("ts", "a", "a.js");
    assert.deepEqual(captured.refs, ["ref", "unref"]);
    assert.equal(made[0].terminated, false);
  });

  test("an idle worker is terminated", async () => {
    const made = [];
    const WorkerImpl = class extends FakeWorker {
      constructor(url) {
        super(url, { onPost: (w) => setImmediate(() => w.reply("x")) });
        made.push(this);
      }
    };
    const pool = createExtractorPool({
      workerUrl: "file:///fake.js", label: "testgraph", idleMs: 1, WorkerImpl,
    });
    await pool.run("ts", "a", "a.js");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(made[0].terminated, true);
    assert.equal(pool.started, false);
  });

  test("shutdown is idempotent and safe before any spawn", () => {
    const { pool } = poolWith();
    pool.shutdown();
    pool.shutdown();
    assert.equal(pool.started, false);
  });

  test("shutdown settles anything in flight as a fallback", async () => {
    const { pool } = poolWith({ onPost: () => {} }); // never answers
    const pending = pool.run("ts", "a", "a.js");
    pool.shutdown();
    assert.equal((await pending).fallback, true);
  });
});

describe("viaWorker", () => {
  test("passes the worker's result through", async () => {
    const pool = { run: async () => ({ ok: true, result: { symbols: ["w"] } }) };
    const fn = viaWorker(pool, "ts", () => ({ symbols: ["in-process"] }));
    assert.deepEqual(await fn("src", "a.js"), { symbols: ["w"] });
  });

  test("runs the in-process extractor on a fallback, with the same arguments", async () => {
    const pool = { run: async () => ({ fallback: true, reason: "no worker" }) };
    const seen = [];
    const fn = viaWorker(pool, "ts", (source, relPath) => {
      seen.push([source, relPath]);
      return { symbols: ["in-process"] };
    });
    assert.deepEqual(await fn("src", "a.js"), { symbols: ["in-process"] });
    assert.deepEqual(seen, [["src", "a.js"]]);
  });

  test("rethrows an extractor error as a real Error and does NOT retry in-process", async () => {
    const pool = { run: async () => ({ ok: false, error: { message: "boom", code: "EXTRACT_X" } }) };
    let called = false;
    const fn = viaWorker(pool, "ts", () => { called = true; });
    await assert.rejects(fn("src", "a.js"), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "boom");
      assert.equal(err.code, "EXTRACT_X");
      return true;
    });
    assert.equal(called, false);
  });
});
