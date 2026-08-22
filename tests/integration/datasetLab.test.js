import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDataset, normalizeRows, catalogList } from "../../lib/datasets/catalog.js";
import { macroF1, recallAt, reciprocalRank } from "../../lib/helpers/datasetMetrics.js";
import { runDatasetExperiment } from "../../lib/helpers/datasetLab.js";

test("catalog exposes curated metadata and rejects unsupported datasets", () => {
  assert.ok(catalogList().some(item => item.id === "BeIR/scifact"));
  assert.equal(getDataset("PolyAI/banking77").task, "classification");
  assert.throws(() => getDataset("arbitrary/dataset"), /Unsupported dataset/);
});

test("adapters normalize retrieval and fail closed on malformed rows", () => {
  const rows = normalizeRows("BeIR/scifact", [{ query_id: "q1", text: "Which database?", document: { id: "d1", title: "SQLite", text: "SQLite is simple" }, relevantDocumentIds: ["d1"] }]);
  assert.deepEqual(rows[0].relevantDocumentIds, ["d1"]);
  assert.throws(() => normalizeRows("BeIR/scifact", [{ text: "missing document" }]), /corpus row has no document id|missing required field/);
  assert.throws(() => normalizeRows("PolyAI/banking77", [{ text: "hello" }]), /no label/);
});

test("metrics match hand-calculated retrieval and classification fixtures", () => {
  const ranked = [{ id: "x" }, { id: "b" }, { id: "a" }];
  assert.equal(recallAt(ranked, ["a"], 1), 0);
  assert.equal(recallAt(ranked, ["a"], 5), 1);
  assert.equal(reciprocalRank(ranked, ["a"]), 1/3);
  assert.equal(macroF1(["a", "b", "a"], ["a", "b", "b"]), 2/3);
});

test("experiment compares modes and persists reproducibility metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "aperio-dataset-lab-"));
  const rows = [
    { query_id: "q1", text: "simple local setup", document: { id: "d1", title: "SQLite", text: "SQLite is zero configuration for local development" }, relevantDocumentIds: ["d1"] },
    { query_id: "q2", text: "production database", document: { id: "d2", title: "PostgreSQL", text: "PostgreSQL is preferred for production" }, relevantDocumentIds: ["d2"] },
  ];
  const artifact = await runDatasetExperiment({ dataset: "BeIR/scifact", split: "test", rows, modes: ["fulltext", "vector", "hybrid"], topK: [1,5,10], root, revision: "fixture-rev", embeddingFingerprint: { provider: "test", model: "fixture", dims: 2 }, embeddingFn: async text => text.includes("production") ? [0,1] : [1,0] });
  assert.equal(artifact.metadata.revision, "fixture-rev");
  assert.equal(artifact.metadata.license, "cc-by-sa-4.0");
  assert.equal(artifact.results.length, 6);
  assert.equal(artifact.summary.recallAt5, 1);
  const persisted = JSON.parse(await readFile(join(root, `${artifact.id}.json`), "utf8"));
  assert.deepEqual(persisted.embeddingFingerprint, { provider: "test", model: "fixture", dims: 2 });
});
