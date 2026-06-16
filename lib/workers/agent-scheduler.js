// lib/workers/agent-scheduler.js
//
// Phase 1 of the background-agents feature (see docs/background-agents.md).
//
// Standing, scheduled agents that operate on the store without a chat turn.
// Phase 1 supports interval triggers running "steps mode" jobs: a fixed list of
// { tool, input } executed in order via the same agent.callTool() that chat uses.
// Freeform (runAgentLoop) jobs and watcher/manual triggers land in later phases.
//
// Lifecycle mirrors the other background workers (createSessionPruner,
// deduplicateMemories): a factory that returns { stop }, timers are unref()'d so
// the scheduler never holds the process open, and the on-disk run record is a
// best-effort side effect that no-ops under tests.

import { join } from "path";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import logger from "../helpers/logger.js";

const JOBS_PATH        = join(process.cwd(), "var/agents/jobs.json");
const RECORDS_DIR      = join(process.cwd(), "var/agents");
const INITIAL_DELAY_MS = 30_000; // wait 30s after boot before scheduling, like deduplicate.js
const MAX_OUT_CHARS    = 4000;   // cap per-step output written to the run record

/**
 * Load job definitions from var/agents/jobs.json. Missing/malformed file → [].
 * @param {string} [path]
 * @returns {Array<object>}
 */
export function loadJobs(path = JOBS_PATH) {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const jobs = Array.isArray(raw) ? raw : raw?.jobs;
    return Array.isArray(jobs) ? jobs : [];
  } catch (err) {
    logger.error(`[agent-scheduler] failed to parse ${path}: ${err.message}`);
    return [];
  }
}

/**
 * Append a human-readable run transcript under var/agents/. One file per job id.
 * Best-effort: never throws, no-ops under tests (mirrors writeRoundtableRecord).
 * @returns {string|null} the written path, or null.
 */
export function writeAgentRunRecord({ job, results = [], startedAt, verdict, error, trigger }) {
  if (process.env.NODE_ENV === "test") return null;
  try {
    mkdirSync(RECORDS_DIR, { recursive: true });
    const file   = join(RECORDS_DIR, `aperio-agent-${job.id}.md`);
    const header = existsSync(file) ? "" : `# Agent job: ${job.id}\n\n`;
    const status = verdict === "ok" ? "✅ ok" : "❌ error";
    const took   = Date.now() - startedAt;
    const lines  = [
      `## ${new Date(startedAt).toISOString()} · ${status} · ${took}ms${trigger ? ` · ${trigger}` : ""}`,
      "",
      ...(error ? [`> error: ${error}`, ""] : []),
      ...results.flatMap(r => [`### ${r.tool}`, "", "```", String(r.out).slice(0, MAX_OUT_CHARS), "```", ""]),
    ];
    appendFileSync(file, header + lines.join("\n") + "\n");
    return file;
  } catch (err) {
    logger.warn(`[agent-scheduler] could not write run record for ${job?.id}: ${err.message}`);
    return null;
  }
}

/**
 * Start the background-agent scheduler.
 *
 * Auto-scheduling is gated by APERIO_AGENT_JOBS=on. Without it, jobs are still
 * loaded but nothing fires on a timer — runJob() can be invoked manually (the
 * Phase 2 /api/agents/:id/run route uses this).
 *
 * @param {object}   deps
 * @param {Function} deps.callTool - agent.callTool
 * @param {Array}    [deps.jobs]   - injectable for tests; defaults to loadJobs()
 * @returns {{ stop: () => void, runJob: (job: object, ctx?: object) => Promise<object|null> }}
 */
export function createAgentScheduler({ callTool, jobs = loadJobs() } = {}) {
  const inFlight = new Set();

  async function runJob(job, triggerCtx = {}) {
    if (!job?.id) {
      logger.warn("[agent-scheduler] job missing id — skipped");
      return null;
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      logger.warn(`[agent-scheduler] ${job.id}: no steps — Phase 1 runs steps-mode jobs only; skipped`);
      return null;
    }
    if (inFlight.has(job.id)) {
      logger.info(`[agent-scheduler] ${job.id} already running — skipped this tick`);
      return null;
    }

    inFlight.add(job.id);
    const startedAt = Date.now();
    const results   = [];
    try {
      for (const step of job.steps) {
        const out = await callTool(step.tool, step.input ?? {});
        results.push({ tool: step.tool, out: out ?? "" });
      }
      const record = writeAgentRunRecord({ job, results, startedAt, verdict: "ok", trigger: triggerCtx.kind });
      logger.info(`[agent-scheduler] ${job.id}: ${results.length} step(s) ok in ${Date.now() - startedAt}ms`);
      return { verdict: "ok", results, record };
    } catch (err) {
      writeAgentRunRecord({ job, results, startedAt, verdict: "error", error: err.message, trigger: triggerCtx.kind });
      logger.error(`[agent-scheduler] ${job.id} failed: ${err.message}`);
      return { verdict: "error", error: err.message, results };
    } finally {
      inFlight.delete(job.id);
    }
  }

  if (process.env.APERIO_AGENT_JOBS !== "on") {
    if (jobs.length) {
      logger.info(`[agent-scheduler] ${jobs.length} job(s) defined; auto-run off (set APERIO_AGENT_JOBS=on)`);
    }
    return { stop() {}, runJob };
  }

  const scheduled = jobs.filter(j => j.enabled && j.trigger?.kind === "interval" && j.trigger.everyMs > 0);
  const timers    = [];
  const bootId    = setTimeout(() => {
    for (const job of scheduled) {
      runJob(job, { kind: "interval" });
      const t = setInterval(() => runJob(job, { kind: "interval" }), job.trigger.everyMs);
      t.unref?.();
      timers.push(t);
    }
  }, INITIAL_DELAY_MS);
  bootId.unref?.();

  logger.info(`[agent-scheduler] active — ${scheduled.length} interval job(s) scheduled`);

  return {
    stop() {
      clearTimeout(bootId);
      timers.forEach(clearInterval);
    },
    runJob,
  };
}
