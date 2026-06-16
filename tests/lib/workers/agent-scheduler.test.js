import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
  });
});
