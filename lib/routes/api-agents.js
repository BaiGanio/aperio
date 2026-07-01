// lib/routes/api-agents.js
// Background-agent endpoints — job CRUD, run history, and run-now.
// Job definitions live in the agent_jobs DB table (Phase 4); the legacy
// var/agents/jobs.json file is no longer read. Definition CRUD is always
// available so jobs can be configured before auto-run is switched on; only
// *running* a job is gated by APERIO_AGENT_JOBS=on.
import { logError } from "../helpers/logger.js";
import { configSettingKey } from "../config-resolver.js";

const jobsEnabled = () => process.env.APERIO_AGENT_JOBS === "on";

// A job is valid if it has a non-empty steps[] or a non-empty prompt.
function hasWork(job) {
  return (Array.isArray(job?.steps) && job.steps.length > 0) ||
         (typeof job?.prompt === "string" && job.prompt.trim().length > 0);
}

export function mountAgentRoutes(router, opts = {}) {
  const { store } = opts;
  const getScheduler = opts.getScheduler ?? (() => opts.scheduler ?? null);
  // Late-bound scheduler (mounted before it's built at boot). Methods bind to the
  // real instance; absent → property reads return undefined, so the existing
  // optional-chaining guards degrade to "scheduler unavailable".
  const scheduler = new Proxy({}, {
    get(_t, prop) {
      const s = getScheduler();
      if (!s) return undefined;
      const v = s[prop];
      return typeof v === "function" ? v.bind(s) : v;
    },
  });
  // After a CRUD mutation, hand the scheduler a fresh DB snapshot so interval/
  // watcher scheduling tracks the change without a restart. Best-effort: the DB
  // write already succeeded, so a reload hiccup must not fail the response.
  async function reschedule() {
    if (typeof scheduler?.reload !== "function") return;
    try {
      scheduler.reload(await store.listAgentJobs());
    } catch (err) {
      logError("agents/reschedule", err);
    }
  }

  // Flip the master switch (APERIO_AGENT_JOBS) at runtime: gate run-now, start or
  // stop interval/watcher auto-run, and persist the choice so it survives a
  // restart. Persistence goes to the DB settings store (config-resolver injects
  // it back into process.env at boot) — never to .env, which only the user edits.
  router.put("/agents/enabled", async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "body must include a boolean \"enabled\"" });
    }
    const on = req.body.enabled;
    process.env.APERIO_AGENT_JOBS = on ? "on" : "off";
    scheduler?.setEnabled?.(on);
    try {
      await store?.setSetting?.(configSettingKey("APERIO_AGENT_JOBS"), on ? "on" : "off");
    } catch (err) {
      logError("agents/enabled persist", err);  // runtime flip still applied
    }
    res.json({ enabled: on });
  });

  // List jobs, each with its most recent run.
  router.get("/agents", async (_req, res) => {
    try {
      const jobs = await store.listAgentJobs();
      const withRuns = await Promise.all(jobs.map(async (job) => {
        const runs = await store.listAgentRuns(job.id, 1).catch(() => []);
        return { ...job, lastRun: runs[0] ?? null, running: scheduler?.isRunning?.(job.id) ?? false };
      }));
      res.json({ enabled: jobsEnabled(), jobs: withRuns });
    } catch (err) {
      logError("agents/list", err);
      res.status(500).json({ error: err.message });
    }
  });

  // One job's definition.
  router.get("/agents/:id", async (req, res) => {
    try {
      const job = await store.getAgentJob(req.params.id);
      if (!job) return res.status(404).json({ error: `no job with id "${req.params.id}"` });
      res.json(job);
    } catch (err) {
      logError("agents/get", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Run history, newest first.
  router.get("/agents/:id/runs", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const runs = await store.listAgentRuns(req.params.id, limit);
      res.json({ runs });
    } catch (err) {
      logError("agents/runs", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete one run from the history.
  router.delete("/agents/:id/runs/:runId", async (req, res) => {
    try {
      const removed = await store.deleteAgentRun(Number(req.params.runId));
      if (!removed) return res.status(404).json({ error: `no run with id "${req.params.runId}"` });
      res.json({ ok: true });
    } catch (err) {
      logError("agents/run-delete", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Create a job.
  router.post("/agents", async (req, res) => {
    try {
      const job = req.body || {};
      if (!job.id) return res.status(400).json({ error: "job requires an id" });
      if (!hasWork(job)) return res.status(400).json({ error: "job requires a non-empty steps[] or prompt" });
      if (await store.getAgentJob(job.id)) {
        return res.status(409).json({ error: `job "${job.id}" already exists` });
      }
      const saved = await store.upsertAgentJob(job);
      await reschedule();
      res.status(201).json(saved);
    } catch (err) {
      logError("agents/create", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update a job (id comes from the path).
  router.put("/agents/:id", async (req, res) => {
    try {
      const job = { ...(req.body || {}), id: req.params.id };
      if (!hasWork(job)) return res.status(400).json({ error: "job requires a non-empty steps[] or prompt" });
      if (!await store.getAgentJob(req.params.id)) {
        return res.status(404).json({ error: `no job with id "${req.params.id}"` });
      }
      const saved = await store.upsertAgentJob(job);
      await reschedule();
      res.json(saved);
    } catch (err) {
      logError("agents/update", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Remove a job.
  router.delete("/agents/:id", async (req, res) => {
    try {
      const removed = await store.deleteAgentJob(req.params.id);
      if (!removed) return res.status(404).json({ error: `no job with id "${req.params.id}"` });
      await reschedule();
      res.json({ ok: true });
    } catch (err) {
      logError("agents/delete", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Run-now — trigger immediately. Gated by the master switch.
  router.post("/agents/:id/run", async (req, res) => {
    if (!jobsEnabled()) {
      return res.status(403).json({ error: "background agents disabled — set APERIO_AGENT_JOBS=on" });
    }
    if (!scheduler?.runJob) {
      return res.status(503).json({ error: "scheduler unavailable" });
    }
    try {
      const job = await store.getAgentJob(req.params.id);
      if (!job) return res.status(404).json({ error: `no job with id "${req.params.id}"` });
      // Tell "already running" apart from "invalid" so the message is actionable.
      if (scheduler.isRunning?.(job.id)) {
        return res.status(409).json({ error: "already running — wait for the current run to finish" });
      }
      const result = await scheduler.runJob(job, { kind: "manual" });
      if (!result) return res.status(409).json({ error: "job has nothing to run — needs steps or a prompt" });
      const status = result.verdict === "ok" ? 200 : 500;
      res.status(status).json(result);
    } catch (err) {
      logError("agents/run", err);
      res.status(500).json({ error: err.message });
    }
  });
}
