import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyRuntimeLog,
  createMetricReport,
  captureLedgerOffsets,
  sliceLedger,
  summarizeToolQuality,
  executeBenchmarkCases,
  restoreQualificationState,
  modelReady,
  importQualificationFixture,
  waitForFixture,
  beginQualificationMeasurement,
  preflightModelCandidate,
  parseArgs,
  resolveBenchmarkArtifactDir,
  selectPilotCases,
  DEFAULT_PILOT_CASE_IDS,
  verifyState,
  resolveTierConfiguration,
  resolveHostTier,
  evaluateTierAdmission,
  TIER_POLICY,
  teardownOwnedProcesses,
  runWsCase,
  writeInvalidAdmissionRun,
  validateTargetTier,
} from "../../scripts/model-tier-bench.js";

const cases = [
  {
    id: "first", title: "First case", objective: "Complete before the invalid case.",
    section: "recall", kind: "behavior", prompt: "first", expectedToolSequence: ["recall"],
    requiredAnswerTerms: [], requireAllToolsSuccessful: true, hardGate: true,
    stateAssertion: { kind: "none" }, timeoutMs: 1_000,
  },
  {
    id: "second", title: "Second case", objective: "Retain partial evidence when interrupted.",
    section: "chains", kind: "behavior", prompt: "second", expectedToolSequence: ["fetch_url", "remember"],
    requiredAnswerTerms: ["saved"], requireAllToolsSuccessful: true, hardGate: true,
    stateAssertion: { kind: "memory", type: "source", contentIncludes: ["example.com"] }, timeoutMs: 1_000,
  },
];

const RUNNER = fileURLToPath(new URL("../../scripts/model-tier-bench.js", import.meta.url));
const REPO_ROOT = dirname(dirname(RUNNER));

test("parseArgs collects repeatable case ids and the environment note", () => {
  assert.deepEqual(parseArgs([
    "--model", "qwen35-9b-q4km", "--case", "recall", "--case", "guardrail",
    "--note", "contaminated", "--allow-download",
  ]), {
    modelId: "qwen35-9b-q4km",
    caseIds: ["recall", "guardrail"],
    environmentNote: "contaminated",
    allowDownload: true,
    validate: false,
  });
});

test("parseArgs records an explicit target tier", () => {
  assert.equal(parseArgs(["--model", "qwen35-9b-q4km", "--tier", "16"]).tier, 16);
});

test("pilot selection defaults to the explicit five-case funnel and accepts growth or overrides", () => {
  const suite = DEFAULT_PILOT_CASE_IDS.map(id => ({ id }));
  assert.deepEqual(selectPilotCases(suite), suite);

  const expanded = [...suite, { id: "future-pilot-case" }];
  assert.deepEqual(selectPilotCases(expanded), suite);
  assert.deepEqual(selectPilotCases(expanded, ["future-pilot-case"]), [{ id: "future-pilot-case" }]);
});

test("pilot state assertions verify the replacement memory and wiki article", async () => {
  const calls = [];
  const apiCall = async (_baseURL, path) => {
    calls.push(path);
    if (path === "/api/memories") {
      return { raw: [{ type: "preference", title: "Maya's coffee", content: "A cortado with oat milk, no sugar." }] };
    }
    return { articles: [{ slug: "nimbus-architecture" }] };
  };

  assert.equal(await verifyState("http://runner", {
    kind: "memory", type: "preference", contentIncludes: ["cortado", "oat milk"],
  }, { apiCall }), true);
  assert.equal(await verifyState("http://runner", {
    kind: "wiki", query: "Nimbus", minimumMatches: 1,
  }, { apiCall }), true);
  assert.deepEqual(calls, [
    "/api/memories",
    "/api/wiki/search?q=Nimbus&mode=fulltext&limit=25",
  ]);
});

test("resolveBenchmarkArtifactDir uses the tier-first private layout", () => {
  assert.equal(
    resolveBenchmarkArtifactDir("/repo", 16, "qwen35-9b-q4km", "20260714T120000Z"),
    "/repo/var/benchmarks/model-tiers/16gb/qwen35-9b-q4km/20260714T120000Z",
  );
  assert.throws(() => resolveBenchmarkArtifactDir("/repo", 12, "model", "campaign"), /tier must be/);
});

test("validateTargetTier requires model eligibility", () => {
  const model = { id: "qwen35-9b-q4km", tiers: [16, 24, 32] };
  assert.equal(validateTargetTier(model, 16), 16);
  assert.throws(() => validateTargetTier(model, 8), /not eligible/);
  assert.throws(() => validateTargetTier(model, 12), /tier must be/);
});

test("catalog contains the smallest exact cached Gemma entry", () => {
  const models = JSON.parse(readFileSync(".github/model-tiers/models.json", "utf8"));
  const gemma = models.find(model => model.id === "gemma4-e4b-q4kxl");
  assert.deepEqual(gemma, {
    id: "gemma4-e4b-q4kxl",
    displayName: "Gemma 4 E4B Q4_K_XL",
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    quant: "Q4_K_XL",
    sizeGB: 3.93,
    tiers: [8, 16, 24, 32],
  });
});

test("candidate preflight admits only the exact repo and quant with GGUF facts and disk headroom", () => {
  const model = {
    id: "gemma4-e4b-q4kxl",
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    quant: "Q4_K_XL",
    sizeGB: 3.93,
  };
  const cachedPath = "/cache/models--unsloth--gemma-4-E4B-it-qat-GGUF/snapshots/rev/gemma-4-E4B-it-qat-Q4_K_XL.gguf";
  const result = preflightModelCandidate(model, {
    cacheRoot: "/cache",
    findCached: () => cachedPath,
    factsFromGguf: path => ({
      path,
      source: "gguf",
      sizeGB: 3.93,
      architecture: "dense",
      maxContext: 131072,
      kvLayers: 42,
      kvBytesPerToken: 172032,
    }),
    diskAvailableBytes: 7 * 1024 ** 3,
  });

  assert.equal(result.status, "admitted");
  assert.equal(result.hf, model.hf);
  assert.equal(result.cachedGguf.path, cachedPath);
  assert.equal(result.ggufFacts.architecture, "dense");
  assert.equal(result.disk.requiredGB, 5.93);
});

test("candidate preflight reports concrete admission reasons for identity, facts, and disk failures", () => {
  const model = {
    id: "gemma4-e4b-q4kxl",
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    quant: "Q4_K_XL",
    sizeGB: 3.93,
  };
  const base = {
    cacheRoot: "/cache",
    findCached: () => "/cache/models--unsloth--gemma-4-E4B-it-qat-GGUF/snapshots/rev/wrong-Q5_K_M.gguf",
    factsFromGguf: () => null,
    diskAvailableBytes: 1 * 1024 ** 3,
  };

  const result = preflightModelCandidate(model, base);
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.reasons, [
    "cached GGUF quantization does not match requested Q4_K_XL",
    "cached GGUF facts could not be read",
    "insufficient disk space: need 5.93 GB, have 1 GB",
  ]);
});

test("admission failures are persisted as invalid runs with a concrete reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-tier-admission-test-"));
  try {
    const path = join(dir, "run.json");
    const run = writeInvalidAdmissionRun(path, {
      model: { id: "gemma4-e4b-q4kxl", hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL" },
      campaignId: "20260714T120000Z",
      targetTierGB: 8,
      reasons: ["cached GGUF quantization does not match requested Q4_K_XL"],
    });
    assert.equal(run.status, "invalid");
    assert.match(run.invalidReason, /cached GGUF quantization/);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI admission failure writes only a private invalid run without starting processes or a workdir", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "model-tier-cli-admission-test-"));
  const campaignId = "cli-admission-test";
  const modelId = "uncached-exact-model";
  const artifactDir = join(REPO_ROOT, "var/benchmarks/model-tiers/8gb", modelId, campaignId);
  const tempPrefix = "aperio-model-tier-uncached-exact-model-";
  const beforeTemp = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(tempPrefix)));
  try {
    writeFileSync(join(fixtureDir, "models.json"), JSON.stringify([{
      id: modelId,
      displayName: "Uncached exact model",
      hf: "example.invalid/uncached-model-GGUF:Q4_K_M",
      quant: "Q4_K_M",
      sizeGB: 1,
      tiers: [8],
    }]));
    rmSync(artifactDir, { recursive: true, force: true });

    const result = spawnSync(process.execPath, [RUNNER,
      "--models", join(fixtureDir, "models.json"),
      "--model", modelId,
      "--tier", "8",
      "--campaign", campaignId,
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, HF_HOME: fixtureDir },
      encoding: "utf8",
    });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid admission/);
    assert.match(result.stderr, /not cached with an exact GGUF candidate/);
    assert.deepEqual(readdirSync(artifactDir), ["run.json"]);
    assert.equal(statSync(artifactDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(artifactDir, "run.json")).mode & 0o777, 0o600);
    const run = JSON.parse(readFileSync(join(artifactDir, "run.json"), "utf8"));
    assert.equal(run.status, "invalid");
    assert.equal(run.admission, true);
    assert.equal(run.tierPolicy, TIER_POLICY);
    assert.equal(run.tierAdmission.policy, TIER_POLICY);
    assert.equal(run.tierAdmission.hostRamGB, run.tierConfiguration.hostRamGB);
    // The tier itself is admissible (a 32 GB host simulates the 8 GB tier);
    // the invalid run comes from the preflight GGUF-cache check, not the tier.
    assert.equal(run.tierAdmission.admission, "accepted");
    assert.match(run.invalidReason, /not cached with an exact GGUF candidate/);
    assert.deepEqual(run.caseResults, []);
    assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith(tempPrefix)), [...beforeTemp]);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("tier configuration distinguishes target tier from physical host evidence", () => {
  assert.equal(resolveHostTier(8), 8);
  assert.equal(resolveHostTier(16), 16);
  assert.equal(resolveHostTier(24), 24);
  assert.equal(resolveHostTier(32), 32);
  const facts = { sizeGB: 3.93, kvBytesPerToken: 172032, maxContext: 131072 };
  const simulated = resolveTierConfiguration(8, 32, facts);
  const hardware = resolveTierConfiguration(32, 32, facts);
  assert.equal(simulated.evidenceMode, "simulated-tier");
  assert.equal(simulated.targetTierGB, 8);
  assert.equal(simulated.memoryBudgetGB, 8);
  assert.ok(simulated.servedContext < hardware.servedContext);
  assert.equal(hardware.evidenceMode, "hardware-tier");
});

test("tier admission simulates a smaller tier on a larger host instead of rejecting it", () => {
  const decision = evaluateTierAdmission(16, 32, {
    sizeGB: 5.29,
    kvBytesPerToken: 172032,
    maxContext: 32768,
  });

  assert.equal(decision.status, "admitted");
  assert.equal(decision.admission, "accepted");
  assert.equal(decision.invalidReason, null);
  assert.equal(decision.targetTierGB, 16);
  assert.equal(decision.hostRamGB, 32);
  assert.equal(decision.hostTierGB, 32);
  assert.equal(decision.configuration.evidenceMode, "simulated-tier");
  assert.equal(decision.policy, TIER_POLICY);
});

test("tier admission still rejects a requested tier a host is too small to represent", () => {
  const decision = evaluateTierAdmission(32, 16, {
    sizeGB: 5.29,
    kvBytesPerToken: 172032,
    maxContext: 32768,
  });

  assert.equal(decision.status, "invalid");
  assert.equal(decision.admission, "rejected");
  assert.equal(decision.targetTierGB, 32);
  assert.equal(decision.hostRamGB, 16);
  assert.equal(decision.hostTierGB, 16);
  assert.match(decision.invalidReason, /cannot represent the requested 32 GB tier budget/i);
  assert.equal(decision.policy, TIER_POLICY);
});

test("tier admission rejects a model configuration that exceeds the requested memory budget", () => {
  const decision = evaluateTierAdmission(8, 8, {
    sizeGB: 7.5,
    kvBytesPerToken: 172032,
    maxContext: 16384,
  });

  assert.equal(decision.status, "invalid");
  assert.equal(decision.hostRamGB, 8);
  assert.match(decision.invalidReason, /configuration requires .* beyond the 8 GB memory budget/i);
});

test("tier admission records an admitted effective policy when host and configuration fit", () => {
  const decision = evaluateTierAdmission(16, 16, {
    sizeGB: 5.29,
    kvBytesPerToken: 172032,
    maxContext: 16384,
  });

  assert.equal(decision.status, "admitted");
  assert.equal(decision.admission, "accepted");
  assert.equal(decision.invalidReason, null);
  assert.equal(decision.policy, TIER_POLICY);
  assert.equal(decision.memoryBudgetGB, 16);
});

test("runtime llama logs can be copied before teardown", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-tier-log-test-"));
  try {
    const source = join(dir, "server.log");
    const target = join(dir, "llamacpp.log");
    writeFileSync(source, "owned llama diagnostic\n", { mode: 0o600 });
    assert.equal(copyRuntimeLog(source, target), true);
    assert.equal(readFileSync(target, "utf8"), "owned llama diagnostic\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metric report keeps model-load and qualification windows separate", () => {
  const report = createMetricReport(
    { samples: [{ phase: "load" }], peakUsedRamBytes: 10 },
    { samples: [{ phase: "qualification" }], peakUsedRamBytes: 20 },
  );
  assert.deepEqual(report.load.samples, [{ phase: "load" }]);
  assert.deepEqual(report.qualification.samples, [{ phase: "qualification" }]);
  assert.equal(report.qualification.baseline.phase, "qualification");
});

test("ledger offsets and slices preserve the shared ledger and copy only appended rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-tier-ledger-test-"));
  try {
    const source = join(dir, "events.tsv");
    const target = join(dir, "result", "toolrepair-events.tsv");
    writeFileSync(source, "header\nold\n", { mode: 0o600 });
    const offsets = captureLedgerOffsets({ events: source, failures: join(dir, "missing.tsv") });
    appendFileSync(source, "new\n");
    const slice = sliceLedger(source, offsets.events, target);
    assert.equal(slice.startOffset, Buffer.byteLength("header\nold\n"));
    assert.equal(slice.endOffset, Buffer.byteLength("header\nold\nnew\n"));
    assert.equal(slice.rowsCopied, 1);
    assert.equal(readFileSync(target, "utf8"), "new\n");
    assert.equal(readFileSync(source, "utf8"), "header\nold\nnew\n");
    assert.equal(offsets.failures.offset, 0);
    assert.equal(offsets.failures.exists, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool quality keeps first-attempt validity separate from persistent failures", () => {
  const report = summarizeToolQuality({
    events: [
      { type: "tool_start", name: "recall" },
      { type: "tool_start", name: "remember" },
      { type: "tool_start", name: "remember" },
      { type: "tool_result", name: "recall", ok: true },
    ],
    toolRepairRows: ["2026-07-14T00:00:00.000Z\tmodel\tremember\tmissing\tcontent\ttext\t\t0"],
    toolFailureRows: [
      "2026-07-14T00:00:00.000Z\tmodel\tleak\t0\trecovered",
      "2026-07-14T00:00:01.000Z\tmodel\techo\t1\tpersisted",
    ],
    caseResults: [{ status: "pass" }, { status: "fail" }, { status: "invalid" }],
  });
  assert.equal(report.toolAttempts, 3);
  assert.equal(report.malformedFirstAttempts, 1);
  assert.equal(report.firstAttemptValidity, 2 / 3);
  assert.equal(report.persistentFailures, 1);
  assert.equal(report.completedCases, 2);
  assert.equal(report.persistentFailureRate, 1 / 2);
  assert.equal(report.toolExecutionSuccess, 1);
});

test("model readiness requires the exact active model", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ data: [{ id: "requested-model" }] }) };
  };
  await modelReady("http://127.0.0.1:1234", "requested-model", { fetchImpl });
  assert.deepEqual(calls, ["http://127.0.0.1:1234/health", "http://127.0.0.1:1234/v1/models"]);
});

test("qualification fixture import posts the exact 28-memory fixture and verifies the count", async () => {
  const fixture = { memories: Array.from({ length: 28 }, (_, index) => ({ id: index + 1 })) };
  const calls = [];
  const result = await importQualificationFixture("http://127.0.0.1:1234", fixture, {
    request: async (baseURL, path, options) => {
      calls.push({ baseURL, path, options });
      return { imported: 28, errors: [] };
    },
    now: (() => { let tick = 100; return () => (tick += 25); })(),
  });

  assert.equal(result.status, "imported");
  assert.equal(result.memoryCount, 28);
  assert.equal(result.durationMs, 25);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/memories/import");
  assert.deepEqual(JSON.parse(calls[0].options.body), fixture);
});

test("fixture readiness records embedding readiness and qualification cannot start early", async () => {
  const calls = [];
  let poll = 0;
  const readiness = await waitForFixture("http://127.0.0.1:1234", 28, 1_000, {
    request: async (_baseURL, path) => {
      calls.push(path);
      if (path === "/api/memories") {
        poll++;
        return { raw: Array.from({ length: 28 }, () => ({ tags: ["aperio-exam"] })) };
      }
      return { memories_total: 28, embedding_queue_size: poll < 2 ? 1 : 0 };
    },
    sleep: async () => {},
    now: (() => { let tick = 1_000; return () => (tick += 50); })(),
  });
  assert.deepEqual(readiness, {
    status: "ready",
    expectedMemoryCount: 28,
    taggedMemoryCount: 28,
    embeddingQueueSize: 0,
    durationMs: 200,
  });

  const phases = [];
  const metrics = { beginQualification: () => { phases.push("begin"); return { phase: "load" }; } };
  assert.equal(beginQualificationMeasurement(metrics, readiness).phase, "load");
  assert.deepEqual(phases, ["begin"]);
  assert.throws(() => beginQualificationMeasurement(metrics, { status: "pending" }), /embedding readiness/);
});

test("teardown invokes every owned process cleanup even when one stop fails", async () => {
  const stopped = [];
  await teardownOwnedProcesses([
    { stop: async () => stopped.push("server") },
    { stop: async () => { stopped.push("worker"); throw new Error("worker stop failed"); } },
  ]);
  assert.deepEqual(stopped, ["server", "worker"]);
});

test("runWsCase waits for the correlated turn_complete, not stream_end", async () => {
  class FakeSocket extends EventEmitter {
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({ type: "stream_end", text: "intermediate" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "tool_start", name: "recall" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "turn_complete", turnId: "other", status: "completed" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "turn_complete", turnId: request.turnId, status: "completed" })));
      });
    }
  }
  const result = await runWsCase(new FakeSocket(), { id: "recall", prompt: "Recall it", timeoutMs: 1_000 });
  assert.deepEqual(result.events.map(event => event.type), ["stream_end", "tool_start", "turn_complete", "turn_complete"]);
  assert.equal(result.events.at(-1).turnId, "recall");
});

test("executeBenchmarkCases preserves completed and interrupted case artifacts on an invalid run", async () => {
  const partialEvents = [{ type: "tool_start", name: "fetch_url" }];
  const timeout = Object.assign(new Error("case second timed out"), {
    caseEvents: partialEvents,
    durationMs: 1234,
  });
  const seenEvents = [];

  await assert.rejects(
    () => executeBenchmarkCases(cases, {
      runCase: async caseDef => {
        if (caseDef.id === "second") throw timeout;
        return {
          durationMs: 50,
          events: [
            { type: "tool_start", name: "recall" },
            { type: "tool_result", name: "recall", ok: true },
            { type: "turn_complete", status: "completed" },
          ],
        };
      },
      verifyCaseState: async () => true,
      recordEvents: (caseDef, events) => seenEvents.push([caseDef.id, events]),
    }),
    error => {
      assert.equal(error, timeout);
      assert.equal(error.caseResults.length, 2);
      assert.equal(error.caseResults[0].status, "pass");
      assert.equal(error.caseResults[0].title, "First case");
      assert.equal(error.caseResults[1].status, "invalid");
      assert.equal(error.caseResults[1].invalidReason, "case second timed out");
      assert.equal(error.caseResults[1].durationMs, 1234);
      assert.equal(error.caseResults[1].title, "Second case");
      assert.equal(error.caseResults[1].objective, "Retain partial evidence when interrupted.");
      assert.equal(error.caseResults[1].prompt, "second");
      assert.deepEqual(error.caseResults[1].actualToolSequence, ["fetch_url"]);
      assert.deepEqual(error.caseResults[1].expectedToolSequence, ["fetch_url", "remember"]);
      assert.deepEqual(error.caseResults[1].requiredAnswerTerms, ["saved"]);
      assert.deepEqual(error.caseResults[1].stateAssertion, {
        kind: "memory", type: "source", contentIncludes: ["example.com"],
      });
      return true;
    },
  );
  assert.equal(seenEvents.length, 2);
  assert.equal(seenEvents[0][0], "first");
  assert.deepEqual(seenEvents[1], ["second", partialEvents]);
});

test("executeBenchmarkCases retries a failed case with restored state and a fresh session", async () => {
  const retryCase = {
    id: "retry-me", title: "Retry me", objective: "Recover once state and session are reset.",
    section: "chains", kind: "behavior", prompt: "retry", expectedToolSequence: ["remember"],
    requiredAnswerTerms: ["saved"], requireAllToolsSuccessful: true, hardGate: true,
    stateAssertion: { kind: "none" }, stateContract: {
      reset: "fresh-session", restore: "fixture-and-workspace", mutations: ["adds one source memory"],
    }, timeoutMs: 1_000,
  };
  const restored = [];
  const contexts = [];
  const recorded = [];
  const disposed = [];
  const snapshots = [];
  let attempts = 0;

  const results = await executeBenchmarkCases([retryCase], {
    context: { sessionId: "initial-session" },
    captureState: async caseDef => {
      snapshots.push(caseDef.id);
      return { database: "fixture-db-before-retry", workspace: "workspace-before-retry" };
    },
    runCase: async (caseDef, context) => {
      contexts.push(context);
      attempts++;
      return {
        durationMs: attempts * 10,
        events: attempts === 1
          ? [{ type: "turn_complete", status: "completed" }]
          : [
            { type: "tool_start", name: "remember" },
            { type: "tool_result", name: "remember", ok: true },
            { type: "stream_end", text: "saved" },
            { type: "turn_complete", status: "completed" },
          ],
      };
    },
    verifyCaseState: async () => true,
    restoreState: async (caseDef, snapshot) => restored.push([caseDef.id, snapshot]),
    createFreshContext: async (_caseDef, { attempt }) => ({ sessionId: `retry-session-${attempt}` }),
    disposeContext: async context => disposed.push(context.sessionId),
    recordEvents: (caseDef, events, meta) => recorded.push({ id: caseDef.id, events, meta }),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "pass");
  assert.equal(results[0].retried, true);
  assert.equal(results[0].firstAttempt.status, "fail");
  assert.equal(results[0].retry.status, "pass");
  assert.deepEqual(snapshots, ["retry-me"]);
  assert.deepEqual(restored, [["retry-me", { database: "fixture-db-before-retry", workspace: "workspace-before-retry" }]]);
  assert.deepEqual(contexts.map(context => context.sessionId), ["initial-session", "retry-session-2"]);
  assert.deepEqual(recorded.map(item => item.meta.attempt), [1, 2]);
  assert.deepEqual(disposed, ["retry-session-2"]);
  assert.deepEqual(results[0].firstAttempt.actualToolSequence, []);
  assert.equal(results[0].firstAttempt.firstAttemptPass, false);
  assert.equal(results[0].firstAttempt.status, "fail");
});

test("restoreQualificationState enforces the fixture and workspace contract", async () => {
  const calls = [];
  await restoreQualificationState({
    caseDef: {
      id: "stateful-case",
      stateContract: { reset: "fresh-session", restore: "fixture-and-workspace", mutations: ["writes a file"] },
    },
    fixtureContract: {
      reset: { beforeRetry: "fresh-session", restore: "fixture-and-workspace" },
    },
    snapshot: { database: { memories: ["fixture"] }, workspace: { files: ["baseline"] } },
    restoreDatabase: async snapshot => calls.push(["database", snapshot]),
    restoreWorkspace: async snapshot => calls.push(["workspace", snapshot]),
  });
  assert.deepEqual(calls, [
    ["workspace", { files: ["baseline"] }],
    ["database", { memories: ["fixture"] }],
  ]);
});
