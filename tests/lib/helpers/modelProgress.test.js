// tests/lib/helpers/modelProgress.test.js
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, truncateSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  cacheDirNameFor,
  downloadInProgressBytes,
  startModelProgressWatcher,
} from "../../../lib/helpers/modelProgress.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A fake emitter that records every payload it is sent.
function recordingEmitter() {
  const events = [];
  return { events, send(obj) { events.push(obj); } };
}

let tmpRoot = null;
afterEach(() => {
  if (tmpRoot) { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {} tmpRoot = null; }
});

function makeCache(modelId, blobs = {}) {
  tmpRoot = mkdtempSync(join(tmpdir(), "aperio-modelprog-"));
  const blobsDir = join(tmpRoot, cacheDirNameFor(modelId), "blobs");
  mkdirSync(blobsDir, { recursive: true });
  for (const [name, bytes] of Object.entries(blobs)) {
    const p = join(blobsDir, name);
    writeFileSync(p, "");
    truncateSync(p, bytes); // sparse — multi-GB "blobs" without touching disk
  }
  return tmpRoot;
}

describe("cacheDirNameFor", () => {
  test("maps hf repo[:quant] to the llama.cpp cache dir name", () => {
    assert.equal(
      cacheDirNameFor("unsloth/Qwen3.6-27B-GGUF:Q4_K_M"),
      "models--unsloth--Qwen3.6-27B-GGUF"
    );
  });

  test("returns null for non-repo ids (local alias, empty)", () => {
    assert.equal(cacheDirNameFor("my-local-model"), null);
    assert.equal(cacheDirNameFor(""), null);
    assert.equal(cacheDirNameFor(null), null);
  });
});

describe("downloadInProgressBytes", () => {
  const MODEL = "unsloth/Qwen3.6-27B-GGUF:Q4_K_M";

  test("sums only *.downloadInProgress blobs", () => {
    const root = makeCache(MODEL, {
      "aaa.downloadInProgress": 1000,
      "bbb.downloadInProgress": 500,
      "finished-blob": 9999, // finalised — not part of an active download
    });
    assert.equal(downloadInProgressBytes(MODEL, root), 1500);
  });

  test("returns 0 when nothing is downloading or dir is missing", () => {
    const root = makeCache(MODEL, { "finished-blob": 123 });
    assert.equal(downloadInProgressBytes(MODEL, root), 0);
    assert.equal(downloadInProgressBytes("org/never-fetched", root), 0);
    assert.equal(downloadInProgressBytes("bare-alias", root), 0);
  });
});

describe("startModelProgressWatcher", () => {
  const MODEL = "unsloth/Qwen3.6-27B-GGUF:Q4_K_M"; // not in MODEL_FACTS → no totalGB

  test("emits downloading progress, then ready on stop()", async () => {
    const root = makeCache(MODEL, { "x.downloadInProgress": 2 * 1024 ** 3 });
    const emitter = recordingEmitter();
    const stop = startModelProgressWatcher(
      { model: MODEL, emitter, cacheRoot: root, pollMs: 20, graceMs: 40 },
      async () => null
    );
    await sleep(60);
    stop();
    const statuses = emitter.events.map(e => `${e.type}:${e.status}`);
    assert.ok(statuses.includes("model_status:downloading"), `expected downloading in ${statuses}`);
    assert.equal(statuses.at(-1), "model_status:ready");
    const dl = emitter.events.find(e => e.status === "downloading");
    assert.equal(dl.gotGB, 2);
    assert.equal(dl.model, MODEL);
    assert.equal("totalGB" in dl, false); // unknown model → no phantom total
  });

  test("dedupes: unchanged progress emits once", async () => {
    const root = makeCache(MODEL, { "x.downloadInProgress": 1024 ** 3 });
    const emitter = recordingEmitter();
    const stop = startModelProgressWatcher(
      { model: MODEL, emitter, cacheRoot: root, pollMs: 15, graceMs: 500 },
      async () => null
    );
    await sleep(80); // several polls over an unchanging blob
    stop();
    assert.equal(emitter.events.filter(e => e.status === "downloading").length, 1);
  });

  test("known model carries totalGB from MODEL_FACTS", async () => {
    const KNOWN = "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL"; // curated facts: sizeGB 21.3
    const root = makeCache(KNOWN, { "x.downloadInProgress": 9 * 1024 ** 3 });
    const emitter = recordingEmitter();
    const stop = startModelProgressWatcher(
      { model: KNOWN, emitter, cacheRoot: root, pollMs: 20, graceMs: 500 },
      async () => null
    );
    await sleep(50);
    stop();
    const dl = emitter.events.find(e => e.status === "downloading");
    assert.equal(dl.totalGB, 21.3);
    assert.equal(dl.gotGB, 9);
  });

  test("no download + not loaded → loading after the grace period", async () => {
    const root = makeCache(MODEL, {});
    const emitter = recordingEmitter();
    const stop = startModelProgressWatcher(
      { model: MODEL, emitter, cacheRoot: root, pollMs: 15, graceMs: 45 },
      async () => "unloaded"
    );
    await sleep(30);
    assert.equal(emitter.events.length, 0); // still inside the grace period
    await sleep(60);
    stop();
    const statuses = emitter.events.map(e => e.status);
    assert.ok(statuses.includes("loading"), `expected loading in ${statuses}`);
    assert.equal(statuses.at(-1), "ready");
  });

  test("warm model stays silent: loaded before grace → no events at all", async () => {
    const root = makeCache(MODEL, {});
    const emitter = recordingEmitter();
    const stop = startModelProgressWatcher(
      { model: MODEL, emitter, cacheRoot: root, pollMs: 15, graceMs: 500 },
      async () => "loaded"
    );
    await sleep(60);
    stop();
    assert.equal(emitter.events.length, 0);
  });

  test("download finishing then loaded → ready exactly once", async () => {
    const root = makeCache(MODEL, { "x.downloadInProgress": 1024 ** 3 });
    const emitter = recordingEmitter();
    const stop = startModelProgressWatcher(
      { model: MODEL, emitter, cacheRoot: root, pollMs: 15, graceMs: 500 },
      async () => "loaded"
    );
    await sleep(30); // sees the download
    rmSync(join(root, cacheDirNameFor(MODEL), "blobs", "x.downloadInProgress"));
    await sleep(40); // next poll: no blob, router says loaded → ready + self-stop
    stop();          // must not re-emit ready
    const readies = emitter.events.filter(e => e.status === "ready");
    assert.equal(readies.length, 1);
  });

  test("stop() before the first poll emits nothing", async () => {
    const root = makeCache(MODEL, { "x.downloadInProgress": 1024 ** 3 });
    const emitter = recordingEmitter();
    const stop = startModelProgressWatcher(
      { model: MODEL, emitter, cacheRoot: root, pollMs: 50, graceMs: 500 },
      async () => null
    );
    stop();
    await sleep(80);
    assert.equal(emitter.events.length, 0);
  });
});
