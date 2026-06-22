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
// the scheduler never holds the process open, and every run is persisted to the
// agent_runs table (read back by the agents UI) as a best-effort side effect.

import { join } from "path";
import { readFileSync, existsSync } from "fs";
import logger from "../helpers/logger.js";
import { makeSinkEmitter } from "../emitters/sinkEmitter.js";

const JOBS_PATH         = join(process.cwd(), "var/agents/jobs.json");
const INITIAL_DELAY_MS  = 30_000;  // wait 30s after boot before scheduling, like deduplicate.js
const DEFAULT_TIMEOUT_MS = 300_000; // freeform-run cap (5 min)
const MAX_OUT_CHARS     = 4000;    // cap the per-answer output stored in agent_runs
const WATCHER_DEBOUNCE_MS = 2_000; // collapse a burst of file changes into one run (Phase 3)

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
 * @param {Array}    [deps.jobs]       - job definitions to schedule. Phase 4: the
 *        server loads these from the DB (store.listAgentJobs()) and passes them in;
 *        defaults to [] (the legacy var/agents/jobs.json file is no longer read).
 * @param {Function} [deps.recordRun]  - best-effort sink for run history, e.g.
 *        store.recordAgentRun(); called after every run (Phase 4). Optional.
 * @param {Function} [deps.notify]     - best-effort sink for "job finished" UI
 *        pushes, e.g. a WebSocket broadcast. Called after every run with
 *        { jobId, verdict, mode, durationMs, trigger, model, error }. Optional.
 * @param {import('events').EventEmitter} [deps.watcherEvents] - codegraph/docgraph
 *        watcher event bus; `trigger.kind: "watcher"` jobs subscribe to its
 *        `change` events (Phase 3). Only wired when APERIO_AGENT_JOBS=on.
 * @returns {{ stop: () => void, runJob: (job: object, ctx?: object) => Promise<object|null> }}
 */
export function createAgentScheduler({ callTool, createAgent, root, version, jobs = [], watcherEvents, recordRun, notify } = {}) {
  const inFlight = new Set();
  // Mutable so reload() can swap in a fresh DB snapshot without a restart.
  let currentJobs = jobs;

  // Pushes into the caller's `entries` so partial progress survives a mid-run throw.
  async function runSteps(job, entries) {
    for (const step of job.steps) {
      const out = await callTool(step.tool, step.input ?? {});
      entries.push({ label: step.tool, body: out ?? "" });
    }
    return {};
  }

  async function runFreeform(job, entries, triggerCtx = {}) {
    const agent = await createAgent({
      root,
      version,
      clientName: `aperio-agent-${job.id}`,
      providerConfig: job.provider ?? null,
      persona: job.persona ?? null,
      character: job.character ?? null,
    });
    // Capture which model actually answered so the run history can show "who
    // triaged this" — a job may override the provider/model per definition.
    const model = agent.provider?.model ?? null;
    const { emitter, toolsUsed } = makeSinkEmitter();
    // Watcher-triggered runs hand the model the list of files that changed so a
    // prompt like "note what changed" has something concrete to act on.
    const changed = triggerCtx.changedFiles?.length
      ? `\n\nFiles changed since the last run:\n${triggerCtx.changedFiles.map(f => `- ${f}`).join("\n")}`
      : "";
    const messages = [{ role: "user", content: job.prompt + changed }];
    const answer = await withTimeout(
      agent.runAgentLoop(messages, emitter, { ...(job.opts ?? {}) }),
      job.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `job ${job.id}`,
    );
    entries.push({ label: "answer", body: answer ?? "" });
    return { tools: toolsUsed, answer, model };
  }

  // Persist a one-line run summary to the DB (Phase 4). Best-effort: a recording
  // failure must not fail the job itself.
  async function safeRecordRun({ job, mode, startedAt, verdict, trigger, tools, error, answer, model }) {
    if (typeof recordRun !== "function") return;
    try {
      const finishedAt = Date.now();
      await recordRun({
        jobId: job.id,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        verdict, mode,
        trigger: trigger ?? null,
        model: model ?? null,
        tools: tools?.length ? tools : null,
        error: error ?? null,
        answer: answer != null ? String(answer).slice(0, MAX_OUT_CHARS) : null,
      });
    } catch (err) {
      logger.warn(`[agent-scheduler] could not record run for ${job.id}: ${err.message}`);
    }
  }

  // Push a "job finished" notification to the UI (Phase 5). Best-effort; fires
  // for every trigger (including manual run-now) so long jobs surface a banner
  // even when the user has navigated away from the agents panel.
  function safeNotify(payload) {
    if (typeof notify !== "function") return;
    try {
      notify(payload);
    } catch (err) {
      logger.warn(`[agent-scheduler] could not notify for ${payload.jobId}: ${err.message}`);
    }
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
    const n = triggerCtx.changedFiles?.length;
    const triggerLabel = triggerCtx.kind === "watcher" && n
      ? `watcher (${n} file${n === 1 ? "" : "s"})`
      : triggerCtx.kind;
    try {
      const out = mode === "steps" ? await runSteps(job, entries) : await runFreeform(job, entries, triggerCtx);
      await safeRecordRun({ job, mode, startedAt, verdict: "ok", trigger: triggerLabel, tools: out.tools, answer: out.answer, model: out.model });
      logger.info(`[agent-scheduler] ${job.id}: ${mode} ok in ${Date.now() - startedAt}ms`);
      safeNotify({ jobId: job.id, verdict: "ok", mode, durationMs: Date.now() - startedAt, trigger: triggerLabel, model: out.model });
      return { verdict: "ok", mode, entries, answer: out.answer };
    } catch (err) {
      await safeRecordRun({ job, mode, startedAt, verdict: "error", trigger: triggerLabel, error: err.message });
      logger.error(`[agent-scheduler] ${job.id} failed: ${err.message}`);
      safeNotify({ jobId: job.id, verdict: "error", mode, durationMs: Date.now() - startedAt, trigger: triggerLabel, error: err.message });
      return { verdict: "error", mode, error: err.message, entries };
    } finally {
      inFlight.delete(job.id);
    }
  }

  // Subscribe watcher-kind jobs to the codegraph/docgraph change bus. A burst of
  // file events is debounced per job, then fires one run carrying the deduped
  // changedFiles. A job may set trigger.source ('codegraph'|'docgraph') to listen
  // to one graph only, and trigger.debounceMs to override the default window.
  // Returns an unsubscribe fn.
  function wireWatcherJobs(events) {
    const watcherJobs = currentJobs.filter(j => j.enabled && j.trigger?.kind === "watcher");
    if (!watcherJobs.length) return () => {};

    const buffers = new Map(); // job.id → { files: Set<string>, timer }
    const onChange = ({ kind, relPath }) => {
      for (const job of watcherJobs) {
        if (job.trigger.source && job.trigger.source !== kind) continue;
        let buf = buffers.get(job.id);
        if (!buf) { buf = { files: new Set(), timer: null }; buffers.set(job.id, buf); }
        buf.files.add(relPath);
        clearTimeout(buf.timer);
        buf.timer = setTimeout(() => {
          buffers.delete(job.id);
          runJob(job, { kind: "watcher", changedFiles: [...buf.files] });
        }, job.trigger.debounceMs ?? WATCHER_DEBOUNCE_MS);
        buf.timer.unref?.();
      }
    };

    events.on("change", onChange);
    return () => {
      events.off("change", onChange);
      for (const buf of buffers.values()) clearTimeout(buf.timer);
      buffers.clear();
    };
  }

  // Wire interval + watcher triggers. Returns a teardown that cancels everything.
  // Split out of construction so the master switch can be flipped at runtime
  // (setEnabled) without a restart — run-now works regardless, this is just the
  // auto-run side.
  function startScheduling() {
    const scheduled = currentJobs.filter(j => j.enabled && j.trigger?.kind === "interval" && j.trigger.everyMs > 0);
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

    const unwireWatcher = watcherEvents ? wireWatcherJobs(watcherEvents) : () => {};
    const watcherCount  = currentJobs.filter(j => j.enabled && j.trigger?.kind === "watcher").length;

    logger.info(`[agent-scheduler] active — ${scheduled.length} interval job(s) scheduled` +
      (watcherEvents && watcherCount ? `, ${watcherCount} watcher job(s) wired` : ""));

    return () => {
      clearTimeout(bootId);
      timers.forEach(clearInterval);
      unwireWatcher();
    };
  }

  let teardown = null;
  // Idempotent. on=true wires triggers if not already active; on=false tears down.
  function setEnabled(on) {
    if (on && !teardown) {
      teardown = startScheduling();
    } else if (!on && teardown) {
      teardown();
      teardown = null;
      logger.info("[agent-scheduler] auto-run disabled");
    }
    return !!teardown;
  }

  // Swap in a fresh job snapshot (e.g. after a CRUD mutation) and re-wire if
  // auto-run is currently active, so interval/watcher scheduling tracks the DB
  // without a restart. A no-op on the timers when disabled — the new list is just
  // remembered for the next setEnabled(true).
  function reload(newJobs) {
    currentJobs = Array.isArray(newJobs) ? newJobs : [];
    if (teardown) {
      teardown();
      teardown = startScheduling();
      logger.info(`[agent-scheduler] rescheduled — ${currentJobs.length} job(s) loaded`);
    }
    return currentJobs.length;
  }

  if (process.env.APERIO_AGENT_JOBS === "on") {
    setEnabled(true);
  } else if (currentJobs.length) {
    logger.info(`[agent-scheduler] ${currentJobs.length} job(s) defined; auto-run off (set APERIO_AGENT_JOBS=on)`);
  }

  return {
    stop() { setEnabled(false); },
    runJob,
    setEnabled,
    isEnabled: () => !!teardown,
    reload,
    // In-flight introspection so the API/UI can show a "running…" badge and the
    // run-now route can tell "already running" apart from "invalid job".
    isRunning: (id) => inFlight.has(id),
    runningIds: () => [...inFlight],
  };
}
