import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EventEmitter } from "events";
import { createAgentScheduler, loadJobs } from "../../../lib/workers/agent-scheduler.js";

const INITIAL_DELAY = 30_000;
const drain = () => new Promise(resolve => setImmediate(resolve));

const stepsJob = (id = "job-a", everyMs = 60_000) => ({
  id,
  enabled: true,
  trigger: { kind: "interval", everyMs },
  steps: [
    { tool: "backfill_embeddings", input: {} },
    { tool: "deduplicate_memories", input: { dry_run: true } },
  ],
});

describe("agent-scheduler", () => {
  let prevEnv;
  beforeEach(() => { prevEnv = process.env.APERIO_AGENT_JOBS; });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.APERIO_AGENT_JOBS;
    else process.env.APERIO_AGENT_JOBS = prevEnv;
  });

  describe("loadJobs", () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aperio-jobs-")); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("returns [] when the file is missing", () => {
      assert.deepStrictEqual(loadJobs(join(dir, "nope.json")), []);
    });

    test("parses a { jobs: [...] } document", () => {
      const p = join(dir, "jobs.json");
      writeFileSync(p, JSON.stringify({ jobs: [stepsJob()] }));
      assert.strictEqual(loadJobs(p).length, 1);
      assert.strictEqual(loadJobs(p)[0].id, "job-a");
    });

    test("parses a bare [...] array", () => {
      const p = join(dir, "jobs.json");
      writeFileSync(p, JSON.stringify([stepsJob("x"), stepsJob("y")]));
      assert.strictEqual(loadJobs(p).length, 2);
    });

    test("returns [] on malformed JSON", () => {
      const p = join(dir, "jobs.json");
      writeFileSync(p, "{ not json");
      assert.deepStrictEqual(loadJobs(p), []);
    });
  });

  describe("runJob (steps mode)", () => {
    test("runs each step in order via callTool", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const calls = [];
      const sched = createAgentScheduler({
        callTool: async (name, input) => { calls.push({ name, input }); return "ok"; },
        jobs: [],
      });

      const res = await sched.runJob(stepsJob());
      sched.stop();

      assert.strictEqual(res.verdict, "ok");
      assert.deepStrictEqual(calls.map(c => c.name), ["backfill_embeddings", "deduplicate_memories"]);
      assert.deepStrictEqual(calls[1].input, { dry_run: true });
    });

    test("captures an error and keeps partial results", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const sched = createAgentScheduler({
        callTool: async (name) => {
          if (name === "deduplicate_memories") throw new Error("boom");
          return "ok";
        },
        jobs: [],
      });

      const res = await sched.runJob(stepsJob());
      sched.stop();

      assert.strictEqual(res.verdict, "error");
      assert.strictEqual(res.error, "boom");
      assert.strictEqual(res.entries.length, 1); // first step landed before the throw
    });

    test("skips a job with no steps", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      let called = false;
      const sched = createAgentScheduler({ callTool: async () => { called = true; }, jobs: [] });

      const res = await sched.runJob({ id: "empty", steps: [] });
      sched.stop();

      assert.strictEqual(res, null);
      assert.strictEqual(called, false);
    });

    test("single-flight: a second concurrent run of the same job is skipped", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      let release;
      const gate = new Promise(r => (release = r));
      let starts = 0;
      const sched = createAgentScheduler({
        callTool: async () => { starts++; await gate; return "ok"; },
        jobs: [],
      });

      const job = stepsJob();
      const first  = sched.runJob(job);     // enters, blocks on gate
      await drain();
      const second = await sched.runJob(job); // should be skipped while first is in flight

      assert.strictEqual(second, null);
      release();
      const firstRes = await first;
      sched.stop();

      assert.strictEqual(firstRes.verdict, "ok");
      assert.strictEqual(starts, 2); // 2 steps of the first run only; second never started
    });
  });

  describe("run recording (Phase 4)", () => {
    test("records an ok run with mode, trigger, tools and duration", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const recorded = [];
      const sched = createAgentScheduler({
        callTool: async () => "ok",
        recordRun: async (run) => { recorded.push(run); },
        jobs: [],
      });

      await sched.runJob(stepsJob("rec-ok"), { kind: "manual" });
      sched.stop();

      assert.strictEqual(recorded.length, 1);
      const run = recorded[0];
      assert.strictEqual(run.jobId, "rec-ok");
      assert.strictEqual(run.verdict, "ok");
      assert.strictEqual(run.mode, "steps");
      assert.strictEqual(run.trigger, "manual");
      assert.ok(typeof run.startedAt === "string" && run.startedAt.endsWith("Z"));
      assert.ok(Number.isFinite(run.durationMs));
    });

    test("records an error run carrying the message", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const recorded = [];
      const sched = createAgentScheduler({
        callTool: async () => { throw new Error("boom"); },
        recordRun: async (run) => { recorded.push(run); },
        jobs: [],
      });

      await sched.runJob(stepsJob("rec-err"));
      sched.stop();

      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0].verdict, "error");
      assert.strictEqual(recorded[0].error, "boom");
    });

    test("a throwing recordRun never fails the job", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const sched = createAgentScheduler({
        callTool: async () => "ok",
        recordRun: async () => { throw new Error("db down"); },
        jobs: [],
      });

      const res = await sched.runJob(stepsJob("rec-throws"));
      sched.stop();

      assert.strictEqual(res.verdict, "ok");
    });
  });

  describe("job-done notify (Phase 5)", () => {
    test("notifies on a background (interval) run with verdict + duration", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const notes = [];
      const sched = createAgentScheduler({
        callTool: async () => "ok",
        notify: (p) => { notes.push(p); },
        jobs: [],
      });

      await sched.runJob(stepsJob("notify-ok"), { kind: "interval" });
      sched.stop();

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].jobId, "notify-ok");
      assert.strictEqual(notes[0].verdict, "ok");
      assert.strictEqual(notes[0].trigger, "interval");
      assert.ok(Number.isFinite(notes[0].durationMs));
    });

    test("notifies on an error run with the message", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const notes = [];
      const sched = createAgentScheduler({
        callTool: async () => { throw new Error("boom"); },
        notify: (p) => { notes.push(p); },
        jobs: [],
      });

      await sched.runJob(stepsJob("notify-err"), { kind: "interval" });
      sched.stop();

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].verdict, "error");
      assert.strictEqual(notes[0].error, "boom");
    });

    test("notifies for manual run-now too (long jobs surface a banner)", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const notes = [];
      const sched = createAgentScheduler({
        callTool: async () => "ok",
        notify: (p) => { notes.push(p); },
        jobs: [],
      });

      await sched.runJob(stepsJob("notify-manual"), { kind: "manual" });
      sched.stop();

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].trigger, "manual");
    });

    test("a throwing notify never fails the job", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const sched = createAgentScheduler({
        callTool: async () => "ok",
        notify: () => { throw new Error("ws gone"); },
        jobs: [],
      });

      const res = await sched.runJob(stepsJob("notify-throws"), { kind: "interval" });
      sched.stop();

      assert.strictEqual(res.verdict, "ok");
    });

    test("a freeform run reports the answering model in record + notify", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const recorded = [];
      const notes = [];
      const createAgent = async () => ({
        provider: { name: "ollama", model: "qwen3:8b" },
        runAgentLoop: async () => "triaged",
      });
      const sched = createAgentScheduler({
        callTool: async () => "",
        createAgent,
        recordRun: async (r) => { recorded.push(r); },
        notify: (p) => { notes.push(p); },
        jobs: [],
      });

      await sched.runJob({ id: "triage", prompt: "triage issues" }, { kind: "interval" });
      sched.stop();

      assert.strictEqual(recorded[0].model, "qwen3:8b");
      assert.strictEqual(notes[0].model, "qwen3:8b");
    });
  });

  describe("runJob (freeform mode)", () => {
    const freeformJob = (overrides = {}) => ({
      id: "curator",
      enabled: true,
      trigger: { kind: "interval", everyMs: 60_000 },
      prompt: "summarise recent memories",
      provider: { name: "ollama", model: "qwen3:8b" },
      ...overrides,
    });

    test("drives createAgent + runAgentLoop and returns the answer", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      let builtWith = null;
      const createAgent = async (cfg) => {
        builtWith = cfg;
        return {
          runAgentLoop: async (messages, emitter) => {
            emitter.send({ type: "tool", name: "recall" });
            emitter.send({ type: "stream_end" });
            return `digest of: ${messages[0].content}`;
          },
        };
      };
      const sched = createAgentScheduler({ callTool: async () => "", createAgent, jobs: [] });

      const res = await sched.runJob(freeformJob());
      sched.stop();

      assert.strictEqual(res.verdict, "ok");
      assert.strictEqual(res.mode, "freeform");
      assert.strictEqual(res.answer, "digest of: summarise recent memories");
      assert.deepStrictEqual(builtWith.providerConfig, { name: "ollama", model: "qwen3:8b" });
    });

    test("skips a freeform job when no createAgent factory is provided", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const sched = createAgentScheduler({ callTool: async () => "", jobs: [] });

      const res = await sched.runJob(freeformJob());
      sched.stop();
      assert.strictEqual(res, null);
    });

    test("times out a stuck freeform run", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const createAgent = async () => ({ runAgentLoop: () => new Promise(() => {}) }); // never resolves
      const sched = createAgentScheduler({ callTool: async () => "", createAgent, jobs: [] });

      const res = await sched.runJob(freeformJob({ timeoutMs: 20 }));
      sched.stop();

      assert.strictEqual(res.verdict, "error");
      assert.match(res.error, /timed out/);
    });
  });

  describe("gating", () => {
    test("does not schedule timers when APERIO_AGENT_JOBS != on", (t) => {
      delete process.env.APERIO_AGENT_JOBS;
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

      const calls = [];
      const sched = createAgentScheduler({
        callTool: async (name) => { calls.push(name); return "ok"; },
        jobs: [stepsJob()],
      });

      t.mock.timers.tick(INITIAL_DELAY * 2);
      sched.stop();
      assert.strictEqual(calls.length, 0);
    });

    test("schedules enabled interval jobs after the initial delay when gated on", async (t) => {
      process.env.APERIO_AGENT_JOBS = "on";
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

      const calls = [];
      const sched = createAgentScheduler({
        callTool: async (name) => { calls.push(name); return "ok"; },
        jobs: [stepsJob("job-a", 60_000)],
      });

      assert.strictEqual(calls.length, 0); // nothing before the delay
      t.mock.timers.tick(INITIAL_DELAY);
      await drain(); await drain();

      sched.stop();
      assert.deepStrictEqual(calls, ["backfill_embeddings", "deduplicate_memories"]);
    });

    test("ignores disabled jobs when scheduling", async (t) => {
      process.env.APERIO_AGENT_JOBS = "on";
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

      const calls = [];
      const disabled = { ...stepsJob(), enabled: false };
      const sched = createAgentScheduler({
        callTool: async (name) => { calls.push(name); return "ok"; },
        jobs: [disabled],
      });

      t.mock.timers.tick(INITIAL_DELAY);
      await drain(); await drain();
      sched.stop();
      assert.strictEqual(calls.length, 0);
    });

    test("setEnabled flips auto-run at runtime", async (t) => {
      delete process.env.APERIO_AGENT_JOBS;            // boot off
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

      const calls = [];
      const sched = createAgentScheduler({
        callTool: async (name) => { calls.push(name); return "ok"; },
        jobs: [stepsJob("job-a", 60_000)],
      });
      assert.strictEqual(sched.isEnabled(), false);

      sched.setEnabled(true);                          // turn on without restart
      assert.strictEqual(sched.isEnabled(), true);
      t.mock.timers.tick(INITIAL_DELAY);
      await drain(); await drain();
      assert.deepStrictEqual(calls, ["backfill_embeddings", "deduplicate_memories"]);

      sched.setEnabled(false);                         // turn off → no more ticks
      assert.strictEqual(sched.isEnabled(), false);
      calls.length = 0;
      t.mock.timers.tick(60_000 * 3);
      await drain();
      assert.strictEqual(calls.length, 0);
      sched.stop();
    });

    test("reload re-wires interval scheduling when active", async (t) => {
      process.env.APERIO_AGENT_JOBS = "on";
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

      const calls = [];
      const sched = createAgentScheduler({
        callTool: async (name) => { calls.push(name); return "ok"; },
        jobs: [],                                       // nothing scheduled at boot
      });

      t.mock.timers.tick(INITIAL_DELAY);
      await drain();
      assert.strictEqual(calls.length, 0);

      sched.reload([stepsJob("job-a", 60_000)]);        // add a job at runtime
      t.mock.timers.tick(INITIAL_DELAY);
      await drain(); await drain();
      assert.deepStrictEqual(calls, ["backfill_embeddings", "deduplicate_memories"]);

      sched.reload([]);                                 // remove it → no more fires
      calls.length = 0;
      t.mock.timers.tick(60_000 * 3);
      await drain();
      assert.strictEqual(calls.length, 0);
      sched.stop();
    });

    test("reload while disabled only remembers the list", async (t) => {
      delete process.env.APERIO_AGENT_JOBS;
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

      const calls = [];
      const sched = createAgentScheduler({
        callTool: async (name) => { calls.push(name); return "ok"; },
        jobs: [],
      });
      sched.reload([stepsJob("job-a", 60_000)]);        // no timers while off
      t.mock.timers.tick(INITIAL_DELAY * 2);
      await drain();
      assert.strictEqual(calls.length, 0);

      sched.setEnabled(true);                           // now uses the reloaded list
      t.mock.timers.tick(INITIAL_DELAY);
      await drain(); await drain();
      assert.deepStrictEqual(calls, ["backfill_embeddings", "deduplicate_memories"]);
      sched.stop();
    });
  });

  describe("watcher trigger (Phase 3)", () => {
    const watcherJob = (overrides = {}) => ({
      id: "on-change",
      enabled: true,
      trigger: { kind: "watcher", debounceMs: 20 },
      steps: [{ tool: "noop", input: {} }],
      ...overrides,
    });

    test("fires once with deduped changedFiles after a burst (freeform)", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const events = new EventEmitter();
      const runs = [];
      const sched = createAgentScheduler({
        callTool: async () => "",
        createAgent: async () => ({
          runAgentLoop: async (messages) => { runs.push(messages[0].content); return "done"; },
        }),
        jobs: [watcherJob({ id: "ff", steps: undefined, prompt: "what changed" })],
        watcherEvents: events,
      });

      events.emit("change", { kind: "codegraph", relPath: "a.js", op: "index" });
      events.emit("change", { kind: "docgraph", relPath: "b.md", op: "index" });
      events.emit("change", { kind: "codegraph", relPath: "a.js", op: "index" }); // dup

      await new Promise(r => setTimeout(r, 60));
      sched.stop();

      assert.strictEqual(runs.length, 1);                    // burst collapsed into one run
      assert.match(runs[0], /what changed/);                 // original prompt preserved
      assert.match(runs[0], /- a\.js/);
      assert.match(runs[0], /- b\.md/);
      assert.strictEqual((runs[0].match(/- a\.js/g) || []).length, 1); // a.js listed once
    });

    test("trigger.source filters which graph a job listens to", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const events = new EventEmitter();
      let runs = 0;
      const sched = createAgentScheduler({
        callTool: async () => { runs++; return "ok"; },
        jobs: [watcherJob({ trigger: { kind: "watcher", source: "docgraph", debounceMs: 20 } })],
        watcherEvents: events,
      });

      events.emit("change", { kind: "codegraph", relPath: "a.js", op: "index" }); // ignored
      await new Promise(r => setTimeout(r, 40));
      assert.strictEqual(runs, 0);

      events.emit("change", { kind: "docgraph", relPath: "b.md", op: "index" }); // matches
      await new Promise(r => setTimeout(r, 40));
      sched.stop();
      assert.strictEqual(runs, 1);
    });

    test("does not wire watcher jobs when gated off", async () => {
      delete process.env.APERIO_AGENT_JOBS;
      const events = new EventEmitter();
      let runs = 0;
      const sched = createAgentScheduler({
        callTool: async () => { runs++; return "ok"; },
        jobs: [watcherJob({ trigger: { kind: "watcher", debounceMs: 20 } })],
        watcherEvents: events,
      });

      events.emit("change", { kind: "codegraph", relPath: "a.js", op: "index" });
      await new Promise(r => setTimeout(r, 40));
      sched.stop();
      assert.strictEqual(runs, 0);
    });

    test("stop() unsubscribes — no runs after teardown", async () => {
      process.env.APERIO_AGENT_JOBS = "on";
      const events = new EventEmitter();
      let runs = 0;
      const sched = createAgentScheduler({
        callTool: async () => { runs++; return "ok"; },
        jobs: [watcherJob({ trigger: { kind: "watcher", debounceMs: 20 } })],
        watcherEvents: events,
      });
      sched.stop();
      events.emit("change", { kind: "codegraph", relPath: "a.js", op: "index" });
      await new Promise(r => setTimeout(r, 40));
      assert.strictEqual(runs, 0);
    });
  });
});
