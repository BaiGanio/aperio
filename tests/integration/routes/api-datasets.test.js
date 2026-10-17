// tests/integration/routes/api-datasets.test.js
// Dataset-lab routes: an active run stays queryable and cancellable, and a
// finished run is served from its persisted artifact rather than from a
// process-lifetime copy of every result row.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";

import { mountDatasetRoutes } from "../../../lib/routes/api-datasets.js";
import { createDatasetRunRegistry } from "../../../lib/helpers/datasetRuns.js";

function invoke(router, method, url, { body = {}, query = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, body, query, params,
      path: url,
      headers: {}, baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
    };
    const res = {
      _status: 200, headersSent: false, _headers: {},
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k)    { return this._headers[String(k).toLowerCase()]; },
      set()           { return this; },
      on()            { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "aperio-datasets-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function writeArtifact(id, artifact) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${id}.json`), JSON.stringify(artifact), "utf8");
}

describe("dataset run routes", () => {
  test("rejects a run without a dataset and split", async () => {
    const router = Router();
    mountDatasetRoutes(router, { artifactRoot: root });
    const { status, body } = await invoke(router, "POST", "/datasets/runs", { body: { dataset: "x" } });
    assert.equal(status, 400);
    assert.match(body.error, /dataset and split/);
  });

  test("an in-flight run is queryable and cancellable", async () => {
    const router = Router();
    const runs = createDatasetRunRegistry();
    mountDatasetRoutes(router, { artifactRoot: root, runs });

    const state = runs.create("live", { dataset: "d", split: "s" });
    state.status = "running";

    const fetched = await invoke(router, "GET", "/datasets/runs/live", { params: { id: "live" } });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.status, "running");

    const cancelled = await invoke(router, "POST", "/datasets/runs/live/cancel", { params: { id: "live" } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelling");
    assert.equal(state.cancel, true);
  });

  test("a finished run cannot be cancelled", async () => {
    const router = Router();
    const runs = createDatasetRunRegistry();
    mountDatasetRoutes(router, { artifactRoot: root, runs });
    runs.finish(runs.create("done", {}), { status: "complete" });

    const { status } = await invoke(router, "POST", "/datasets/runs/done/cancel", { params: { id: "done" } });
    assert.equal(status, 404);
  });

  test("an evicted run is served from its persisted artifact", async () => {
    const router = Router();
    const runs = createDatasetRunRegistry();
    mountDatasetRoutes(router, { artifactRoot: root, runs });
    await writeArtifact("gone", { id: "gone", summary: { recallAt1: 1 }, results: [{ q: "a" }] });

    const { status, body } = await invoke(router, "GET", "/datasets/runs/gone", { params: { id: "gone" } });
    assert.equal(status, 200);
    assert.deepEqual(body.summary, { recallAt1: 1 });
  });

  test("results come from the artifact, not from retained run state", async () => {
    const router = Router();
    const runs = createDatasetRunRegistry();
    mountDatasetRoutes(router, { artifactRoot: root, runs });
    const results = [{ q: "a" }, { q: "b" }];
    await writeArtifact("done", { id: "done", summary: { recallAt1: 0.5 }, results });
    runs.finish(runs.create("done", {}), { status: "complete", summary: { recallAt1: 0.5 }, results });

    const { status, body } = await invoke(router, "GET", "/datasets/runs/done/results", { params: { id: "done" } });
    assert.equal(status, 200);
    assert.deepEqual(body.results, results);
    // …and the in-memory record no longer carries them.
    assert.equal(runs.get("done").results, undefined);
  });

  test("an unknown run id is a 404 on both read paths", async () => {
    const router = Router();
    mountDatasetRoutes(router, { artifactRoot: root });
    for (const url of ["/datasets/runs/nope", "/datasets/runs/nope/results"]) {
      const { status } = await invoke(router, "GET", url, { params: { id: "nope" } });
      assert.equal(status, 404);
    }
  });
});
