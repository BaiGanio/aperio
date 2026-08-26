// lib/routes/api-agents.js
// Background-agent endpoints — job CRUD, run history, and run-now.
// Job definitions live in the agent_jobs DB table (Phase 4); the legacy
// var/agents/jobs.json file is no longer read. Definition CRUD is always
// available so jobs can be configured before auto-run is switched on; only
// *running* a job is gated by APERIO_AGENT_JOBS=on.
import { logError } from "../helpers/logger.js";
import { configSettingKey } from "../config-resolver.js";
import { normalizeAgentJobDefinition } from "../agent/job-spec.js";
import { complete as defaultComplete } from "../helpers/completion.js";
import {
  buildBackgroundJobToolCatalog,
  validateBackgroundJobSteps,
} from "../workers/background-job-tools.js";

const jobsEnabled = () => process.env.APERIO_AGENT_JOBS === "on";

// A job is valid if it has a non-empty steps[] or a non-empty prompt.
function hasWork(job) {
  return (Array.isArray(job?.steps) && job.steps.length > 0) ||
         (typeof job?.prompt === "string" && job.prompt.trim().length > 0);
}

// "What should this job do?" wizard — turns a plain-English description into a
// suggested job definition for the form to prefill. Never persisted here; the
// user reviews/edits it and it goes through the same POST /agents validation
// as any hand-built job when they save.
function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeWizardTrigger(trigger) {
  if (trigger?.kind === "interval") {
    const everyMs = Number(trigger.everyMs);
    return { kind: "interval", everyMs: Number.isFinite(everyMs) && everyMs > 0 ? everyMs : 86400000 };
  }
  if (trigger?.kind === "watcher") {
    const debounceMs = Number(trigger.debounceMs);
    const source = trigger.source === "codegraph" || trigger.source === "docgraph" ? trigger.source : undefined;
    return {
      kind: "watcher",
      debounceMs: Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 5000,
      ...(source ? { source } : {}),
    };
  }
  return { kind: "manual" };
}

function wizardPrompt(description, tools) {
  const toolList = tools
    .map(t => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.inputSchema)}`)
    .join("\n") || "(no deterministic tools are currently available)";
  return `You are configuring a background job for Aperio, a personal memory assistant. The user described what they want in plain English. Turn it into a single JSON object describing the job. Respond with ONLY the JSON object — no markdown fences, no explanation.

User's request:
"""
${description}
"""

Choose a mode:
- "steps": a fixed sequence of deterministic tool calls, no model involved at run time. Only use tools from this exact list — never invent a tool name or an input field:
${toolList}
- "freeform": a plain-English task carried out by a model at run time. Use this whenever the request needs judgment, summarizing, or isn't covered by the tools above.

Choose a trigger:
- interval: runs every N minutes — use for "every night", "every hour", "daily", "weekly", etc. (convert to minutes, expressed as everyMs)
- watcher: runs when codegraph (indexed code) or docgraph (indexed documents) changes
- manual: only runs when the user clicks "Run now" — use when no schedule is implied

Respond with exactly this JSON shape (omit "steps" for freeform mode, omit "prompt"/"timeoutMs" for steps mode):
{
  "id": "short-kebab-case-slug",
  "trigger": { "kind": "interval", "everyMs": 3600000 },
  "mode": "steps",
  "steps": [ { "tool": "tool_name", "input": {} } ],
  "prompt": "plain-English task for the model",
  "timeoutMs": 120000
}`;
}

const WIZARD_FAILURE = "Could not turn that into a job — try rephrasing, or use the form below directly.";

export function mountAgentRoutes(router, opts = {}) {
  const { store } = opts;
  const complete = opts.complete ?? defaultComplete;
  const getAgent = opts.getAgent ?? (() => opts.agent ?? null);
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

  async function attachRunInterrupts(run) {
    if (!run || !store?.listAgentInterrupts || run.id == null) return run;
    try {
      const rows = await store.listAgentInterrupts({ runId: String(run.id), status: null, includeExpired: true, limit: 50 });
      if (!rows.length) return run;
      return {
        ...run,
        interrupts: rows.map(row => ({
          id: row.id,
          tool: row.tool_name,
          status: row.status,
          decision: row.decision ?? null,
          updated_at: row.updated_at ?? null,
        })),
      };
    } catch (err) {
      logError("agents/run-interrupts", err);
      return run;
    }
  }

  function registeredTools() {
    const agent = getAgent();
    if (!agent) {
      const err = new Error("Server is warming up — background-job tools are not available yet.");
      err.status = 503;
      throw err;
    }
    return Array.isArray(agent.mcpTools) ? agent.mcpTools : [];
  }

  function validateSteps(job) {
    if (!Array.isArray(job.steps)) return;
    const errors = validateBackgroundJobSteps(job.steps, registeredTools());
    if (errors.length) {
      const err = new TypeError(`Invalid background job steps: ${errors.join("; ")}`);
      err.status = 400;
      throw err;
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
        return { ...job, lastRun: await attachRunInterrupts(runs[0] ?? null), running: scheduler?.isRunning?.(job.id) ?? false };
      }));
      res.json({ enabled: jobsEnabled(), jobs: withRuns });
    } catch (err) {
      logError("agents/list", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Visual-builder catalog. Names and input schemas come from the live MCP
  // registry; only the unattended-job eligibility/copy overlay is curated.
  // Keep this route above /agents/:id so "tools" is never parsed as a job id.
  router.get("/agents/tools", (_req, res) => {
    try {
      res.json({ tools: buildBackgroundJobToolCatalog(registeredTools()) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // "What should this job do?" wizard — one-shot completion, not persisted.
  // Keep above /agents/:id so "wizard" is never parsed as a job id.
  router.post("/agents/wizard", async (req, res) => {
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    if (!description) return res.status(400).json({ error: "body must include a non-empty \"description\"" });
    try {
      const tools = buildBackgroundJobToolCatalog(registeredTools());
      const response = await complete([{ role: "user", content: wizardPrompt(description, tools) }], { maxTokens: 800 });
      const match = typeof response === "string" ? response.match(/\{[\s\S]*\}/) : null;
      const suggestion = match ? JSON.parse(match[0]) : null;
      if (!suggestion || typeof suggestion !== "object") return res.status(502).json({ error: WIZARD_FAILURE });

      const job = { id: slugify(suggestion.id) || "new-job", enabled: false };
      job.trigger = normalizeWizardTrigger(suggestion.trigger);
      const warnings = [];

      if (Array.isArray(suggestion.steps) && suggestion.steps.length) {
        job.steps = suggestion.steps;
        warnings.push(...validateBackgroundJobSteps(job.steps, registeredTools()));
      } else if (typeof suggestion.prompt === "string" && suggestion.prompt.trim()) {
        job.prompt = suggestion.prompt.trim();
        const timeoutMs = Number(suggestion.timeoutMs);
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) job.timeoutMs = timeoutMs;
      } else {
        return res.status(502).json({ error: WIZARD_FAILURE });
      }

      res.json({ job, warnings });
    } catch (err) {
      if (err instanceof SyntaxError) return res.status(502).json({ error: WIZARD_FAILURE });
      if (err.status === 503) return res.status(503).json({ error: err.message });
      logError("agents/wizard", err);
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
      res.json({ runs: await Promise.all(runs.map(attachRunInterrupts)) });
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
      const job = normalizeAgentJobDefinition(req.body || {});
      if (!job.id) return res.status(400).json({ error: "job requires an id" });
      if (!hasWork(job)) return res.status(400).json({ error: "job requires a non-empty steps[] or prompt" });
      validateSteps(job);
      if (await store.getAgentJob(job.id)) {
        return res.status(409).json({ error: `job "${job.id}" already exists` });
      }
      const saved = await store.upsertAgentJob(job);
      await reschedule();
      res.status(201).json(saved);
    } catch (err) {
      if (err instanceof TypeError && /Invalid (?:AgentSpec|background job steps)/.test(err.message)) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      if (err.status === 503) return res.status(503).json({ error: err.message });
      logError("agents/create", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update a job (id comes from the path).
  router.put("/agents/:id", async (req, res) => {
    try {
      const job = normalizeAgentJobDefinition({ ...(req.body || {}), id: req.params.id });
      if (!hasWork(job)) return res.status(400).json({ error: "job requires a non-empty steps[] or prompt" });
      if (!await store.getAgentJob(req.params.id)) {
        return res.status(404).json({ error: `no job with id "${req.params.id}"` });
      }
      validateSteps(job);
      const saved = await store.upsertAgentJob(job);
      await reschedule();
      res.json(saved);
    } catch (err) {
      if (err instanceof TypeError && /Invalid (?:AgentSpec|background job steps)/.test(err.message)) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      if (err.status === 503) return res.status(503).json({ error: err.message });
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
