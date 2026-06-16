// lib/workers/agent-scheduler.js
//
// Background-agents feature (see docs/background-agents.md).
//
// Standing, scheduled agents that operate on the store without a chat turn.
// Two job modes:
//   • steps    — a fixed list of { tool, input } run in order via agent.callTool().
//                Deterministic, no model. (Phase 1)
//   • freeform — a natural-language `prompt` run through agent.runAgentLoop() with
//                an optional per-job provider/persona/character. (Phase 2)
//
// Triggers: interval (gated by APERIO_AGENT_JOBS=on) and manual runJob() — the
// /api/agents/:id/run route calls runJob() directly.
//
// Lifecycle mirrors the other background workers (createSessionPruner,
// deduplicateMemories): a factory that returns { stop }, timers are unref()'d so
// the scheduler never holds the process open, and the on-disk run record is a
// best-effort side effect that no-ops under tests.

import { join } from "path";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import logger from "../helpers/logger.js";
import { makeSinkEmitter } from "../emitters/sinkEmitter.js";

const JOBS_PATH         = join(process.cwd(), "var/agents/jobs.json");
const RECORDS_DIR       = join(process.cwd(), "var/agents");
const INITIAL_DELAY_MS  = 30_000;  // wait 30s after boot before scheduling, like deduplicate.js
const DEFAULT_TIMEOUT_MS = 300_000; // freeform-run cap (5 min)
const MAX_OUT_CHARS     = 4000;    // cap per-step / per-answer output in the run record

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
export function writeAgentRunRecord({ job, entries = [], startedAt, verdict, error, trigger, tools }) {
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
      ...(tools?.length ? [`tools used: ${tools.join(", ")}`, ""] : []),
      ...(error ? [`> error: ${error}`, ""] : []),
      ...entries.flatMap(e => [`### ${e.label}`, "", "```", String(e.body).slice(0, MAX_OUT_CHARS), "```", ""]),
    ];
    appendFileSync(file, header + lines.join("\n") + "\n");
    return file;
  } catch (err) {
    logger.warn(`[agent-scheduler] could not write run record for ${job?.id}: ${err.message}`);
    return null;
  }
}

/** Reject a promise if it doesn't settle within ms. Timer is unref()'d. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Start the background-agent scheduler.
 *
 * Interval scheduling is gated by APERIO_AGENT_JOBS=on. Without it, jobs are still
 * loaded but nothing fires on a timer — runJob() can be invoked manually (the
 * /api/agents/:id/run route uses this).
 *
 * @param {object}   deps
 * @param {Function} deps.callTool     - agent.callTool (steps mode)
 * @param {Function} [deps.createAgent]- factory to build a per-job agent (freeform mode)
 * @param {string}   [deps.root]       - project root passed to createAgent
 * @param {string}   [deps.version]    - app version passed to createAgent
 * @param {Array}    [deps.jobs]       - injectable for tests; defaults to loadJobs()
 * @returns {{ stop: () => void, runJob: (job: object, ctx?: object) => Promise<object|null> }}
 */
export function createAgentScheduler({ callTool, createAgent, root, version, jobs = loadJobs() } = {}) {
  const inFlight = new Set();

  // Pushes into the caller's `entries` so partial progress survives a mid-run throw.
  async function runSteps(job, entries) {
    for (const step of job.steps) {
      const out = await callTool(step.tool, step.input ?? {});
      entries.push({ label: step.tool, body: out ?? "" });
    }
    return {};
  }

  async function runFreeform(job, entries) {
    const agent = await createAgent({
      root,
      version,
      clientName: `aperio-agent-${job.id}`,
      providerConfig: job.provider ?? null,
      persona: job.persona ?? null,
      character: job.character ?? null,
    });
    const { emitter, toolsUsed } = makeSinkEmitter();
    const messages = [{ role: "user", content: job.prompt }];
    const answer = await withTimeout(
      agent.runAgentLoop(messages, emitter, { ...(job.opts ?? {}) }),
      job.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `job ${job.id}`,
    );
    entries.push({ label: "answer", body: answer ?? "" });
    return { tools: toolsUsed, answer };
  }

  async function runJob(job, triggerCtx = {}) {
    if (!job?.id) {
      logger.warn("[agent-scheduler] job missing id — skipped");
      return null;
    }
    const mode = Array.isArray(job.steps) && job.steps.length ? "steps"
      : (typeof job.prompt === "string" && job.prompt.trim()) ? "freeform"
      : null;
    if (!mode) {
      logger.warn(`[agent-scheduler] ${job.id}: needs non-empty steps[] or prompt — skipped`);
      return null;
    }
    if (mode === "freeform" && typeof createAgent !== "function") {
      logger.warn(`[agent-scheduler] ${job.id}: freeform job needs a createAgent factory — skipped`);
      return null;
    }
    if (inFlight.has(job.id)) {
      logger.info(`[agent-scheduler] ${job.id} already running — skipped this tick`);
      return null;
    }

    inFlight.add(job.id);
    const startedAt = Date.now();
    const entries = [];
    try {
      const out = mode === "steps" ? await runSteps(job, entries) : await runFreeform(job, entries);
      const record = writeAgentRunRecord({
        job, entries, tools: out.tools, startedAt, verdict: "ok", trigger: triggerCtx.kind,
      });
      logger.info(`[agent-scheduler] ${job.id}: ${mode} ok in ${Date.now() - startedAt}ms`);
      return { verdict: "ok", mode, entries, answer: out.answer, record };
    } catch (err) {
      writeAgentRunRecord({ job, entries, startedAt, verdict: "error", error: err.message, trigger: triggerCtx.kind });
      logger.error(`[agent-scheduler] ${job.id} failed: ${err.message}`);
      return { verdict: "error", mode, error: err.message, entries };
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
