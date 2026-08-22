import express from "express";
import { randomUUID } from "node:crypto";
import { catalogList } from "../datasets/catalog.js";
import { createDatasetRunRegistry, DATASET_TERMINAL_STATUSES } from "../helpers/datasetRuns.js";
import { datasetArtifactRoot, readDatasetArtifact, runDatasetExperiment } from "../helpers/datasetLab.js";

export function mountDatasetRoutes(router, { generateEmbedding, artifactRoot, runs: runRegistry } = {}) {
  // Terminal runs are trimmed and evicted here; their full results live in the
  // persisted artifact, which the read paths below fall back to.
  const runs = runRegistry ?? createDatasetRunRegistry();
  const root = artifactRoot ?? datasetArtifactRoot();
  router.get("/datasets/catalog", (_req, res) => res.json({ datasets: catalogList().map(({ normalize, ...item }) => item) }));

  router.post("/datasets/runs", express.json({ limit: "256kb" }), async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body.dataset || !body.split) return res.status(400).json({ error: "dataset and split are required" });
      const id = randomUUID();
      const state = runs.create(id, body);
      void execute(state, { generateEmbedding });
      res.status(202).json({ id, status: state.status });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.get("/datasets/runs/:id", async (req, res) => {
    const state = runs.get(req.params.id);
    if (state) return res.json(state);
    try { return res.json(await readDatasetArtifact(req.params.id, root)); } catch { return res.status(404).json({ error: "run not found" }); }
  });
  router.get("/datasets/runs/:id/results", async (req, res) => {
    try { const artifact = await readDatasetArtifact(req.params.id, root); res.json({ id: artifact.id, summary: artifact.summary, results: artifact.results }); } catch { res.status(404).json({ error: "run not found" }); }
  });
  router.post("/datasets/runs/:id/cancel", (req, res) => {
    const state = runs.get(req.params.id);
    if (!state || DATASET_TERMINAL_STATUSES.has(state.status)) return res.status(404).json({ error: "active run not found" });
    state.cancel = true; state.status = "cancelling"; res.json({ id: state.id, status: state.status });
  });

  async function execute(state, deps) {
    state.status = "running"; state.startedAt = new Date().toISOString();
    try {
      const artifact = await runDatasetExperiment({ dataset: state.config.dataset, split: state.config.split, rows: state.config.rows, limit: Math.min(Number(state.config.limit) || 100, 10000), modes: state.config.modes ?? state.config.retrievalModes ?? ["fulltext", "vector", "hybrid"], topK: state.config.topK ?? [1,5,10], embeddingFn: deps.generateEmbedding, revision: state.config.revision ?? "main", embeddingFingerprint: state.config.embeddingFingerprint, root });
      // `finish` keeps the summary the poller reads and discards artifact.results.
      if (state.cancel) runs.finish(state, { status: "cancelled" });
      else runs.finish(state, { ...artifact, status: "complete" });
    } catch (err) { runs.finish(state, { status: state.cancel ? "cancelled" : "failed", error: err.message }); }
  }

  return { runs };
}
