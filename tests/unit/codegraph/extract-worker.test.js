// tests/unit/codegraph/extract-worker.test.js
//
// Equivalence, against the real worker thread. Extraction moved off the main
// thread (issue S2.1), so the worker must return exactly what in-process
// extraction returns — see tests/unit/docgraph/extract-worker.test.js for the
// payload bug that made this a test and not an assumption.
//
// Codegraph's extractors take a string rather than a Buffer, which clones
// cleanly; the risk here is the reply, which carries every symbol and edge.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

import { extract as extractTs } from "../../../lib/codegraph/extract-ts.js";
import { extract as extractGeneric } from "../../../lib/codegraph/extract-generic.js";

const WORKER_URL = new URL("../../../lib/codegraph/extract-worker.js", import.meta.url);

let worker;
let seq = 0;
const pending = new Map();

before(async () => {
  worker = new Worker(WORKER_URL);
  worker.on("message", (msg) => {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  await new Promise((resolve, reject) => {
    worker.once("online", resolve);
    worker.once("error", reject);
  });
});

after(async () => { await worker?.terminate(); });

function onWorker(key, source, relPath) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, key, source, relPath });
  });
}

const JS = `
import { helper } from './helper.js';

/** Doc comment for Alpha. */
export class Alpha extends Base {
  method(x) { return helper(x); }
}

export function beta(a, b) {
  return Alpha.name + beta(a) + helper(b);
}

const gamma = async (n) => beta(n, n);
`;

const PY = `
import os

class Thing:
    def method(self, x):
        return helper(x)

def top(a):
    return Thing().method(a) + top(a)
`;

describe("codegraph extract-worker", () => {
  test("js: the worker yields exactly the in-process result", async () => {
    const expected = await extractTs(JS, "sample.js");
    const got = await onWorker("ts", JS, "sample.js");
    assert.equal(got.ok, true, `worker failed: ${JSON.stringify(got.error)}`);
    assert.deepEqual(got.result, expected);
    // Guard against "identical because both are empty".
    assert.ok(got.result.symbols.length >= 4, "the fixture must produce symbols");
    assert.ok(got.result.edges.length >= 4, "the fixture must produce edges");
  });

  test("generic: the worker yields exactly the in-process result", async () => {
    const expected = await extractGeneric(PY, "sample.py");
    const got = await onWorker("generic", PY, "sample.py");
    assert.equal(got.ok, true, `worker failed: ${JSON.stringify(got.error)}`);
    assert.deepEqual(got.result, expected);
    assert.ok(got.result.symbols.length >= 2, "the fixture must produce symbols");
  });

  test("a large file survives the round trip intact", async () => {
    // The reply carries every symbol and edge. 1500 functions is ~4500 edges —
    // enough that a clone problem would show rather than hide.
    const parts = [];
    for (let i = 0; i < 1500; i++) {
      parts.push(`function fn${i}(a){ return h${i % 20}(a) + fn${(i + 1) % 1500}(a); }`);
    }
    const source = parts.join("\n");
    const expected = await extractTs(source, "big.js");
    const got = await onWorker("ts", source, "big.js");
    assert.equal(got.ok, true);
    assert.equal(got.result.symbols.length, expected.symbols.length);
    assert.equal(got.result.edges.length, expected.edges.length);
    assert.deepEqual(got.result, expected);
  });

  test("an unknown key is an error, and the worker stays usable", async () => {
    const got = await onWorker("nope", "x", "x.js");
    assert.equal(got.ok, false);
    assert.equal(got.error.code, "EXTRACT_NO_KEY");
    const after = await onWorker("ts", "function f(){}", "f.js");
    assert.equal(after.ok, true);
  });

  test("an extractor failure comes back as a message, not a dead worker", async () => {
    // No tree-sitter grammar for this extension — extract-ts throws.
    const got = await onWorker("ts", "whatever", "sample.unknownext");
    assert.equal(got.ok, false);
    assert.equal(typeof got.error.message, "string");
    const after = await onWorker("ts", "function f(){}", "f.js");
    assert.equal(after.ok, true);
  });
});
