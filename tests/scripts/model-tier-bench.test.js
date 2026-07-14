import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  resolveCampaignAggregateDir,
  buildCampaignPlan,
  writeCampaignPlan,
  selectPilotCases,
  DEFAULT_PILOT_CASE_IDS,
  verifyState,
  resolveTierConfiguration,
  resolveHostTier,
  evaluateTierAdmission,
  TIER_POLICY,
  teardownOwnedProcesses,
  stopRunnerProcesses,
  registerRunnerCleanup,
  runWsCase,
  writeInvalidAdmissionRun,
  writeCampaignSummary,
  writeFinalistManifest,
  writeTierDecisions,
  validateTargetTier,
} from "../../scripts/model-tier-bench.js";
import {
  aggregateBenchmarkRuns,
  benchmarkSummaryCsv,
  generateTierDecisions,
  selectFinalists,
  tierDecisionsMarkdown,
  validateBenchmarkModels,
  validateFullExamManifest,
  validateFinalistEvidence,
} from "../../lib/helpers/modelTierBench.js";

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
const FULL_EXAM = validateFullExamManifest(JSON.parse(readFileSync(join(REPO_ROOT, ".github/model-tiers/full-exam.json"), "utf8")));

function finalistEvidence(overrides = {}) {
  const repeatIds = new Set(Object.values(FULL_EXAM.repeatGroups).flat());
  const observations = FULL_EXAM.drills.flatMap(drill => Array.from({ length: repeatIds.has(drill.id) ? 3 : 1 }, (_, index) => ({
    drillId: drill.id,
    repetition: index + 1,
    status: "pass",
    actualToolSequence: [...drill.expectedToolSequence],
    toolResults: [],
    statePassed: true,
    guardrailMode: drill.kind === "guardrail" ? "model_refusal" : null,
  })));
  return {
    contractVersion: 1,
    modelId: "model-a",
    status: "complete",
    runStatus: "valid",
    fullExam: { manifestId: FULL_EXAM.manifestId, manifestVersion: FULL_EXAM.contractVersion, observations },
    artifacts: {
      root: "var/benchmarks/model-tiers/16gb/model-a/campaign-a",
      files: [...FULL_EXAM.artifactContract.requiredFiles],
    },
    scoredDrills: 65,
    criticalRepeatCount: 3,
    servedContext: 16384,
    swapDeltaBytes: 0,
    scoreVector: {
      recall: { passed: 4, total: 4 },
      chains: { passed: 4, total: 4 },
      guardrails: { passed: 2, total: 2 },
    },
    ...overrides,
  };
}

function aggregateRun(overrides = {}) {
  return {
    status: "complete",
    campaignId: "campaign-a",
    targetTierGB: 16,
    gitCommit: "abc123",
    platform: "darwin 1 arm64",
    hardware: "Apple M",
    profile: "balanced",
    servedContext: 16384,
    qualificationSuiteVersion: 1,
    fixtureVersion: "fixture-sha",
    fixtureContractVersion: 1,
    fixtureMemoryCount: 28,
    fixtureTag: "aperio-exam",
    tierPolicy: "RAM <= 8 => 8 GB",
    tierConfiguration: { servedContext: 16384, evidenceMode: "physical-tier" },
    model: { id: "model-a", hf: "org/model-a:Q4_K_M" },
    caseResults: [
      { id: "recall", section: "recall", hardGate: true, status: "pass" },
      { id: "chain", section: "chains", hardGate: true, status: "pass" },
    ],
    metrics: { qualification: {
      baseline: { swapBytes: 10 },
      samples: [{ usedRamBytes: 100, aperioRssBytes: 20, llamaRssBytes: 70, swapBytes: 12 }],
    } },
    ...overrides,
  };
}

test("aggregate run summaries distinguish valid model failures from invalid runs", () => {
  const validFailure = aggregateRun({
    model: { id: "model-fail", hf: "org/model-fail:Q4_K_M" },
    caseResults: [{ id: "recall", section: "recall", hardGate: true, status: "fail" }],
  });
  const invalid = aggregateRun({
    model: { id: "model-invalid", hf: "org/model-invalid:Q4_K_M" },
    status: "invalid", invalidReason: "fetch failed",
  });
  const summary = aggregateBenchmarkRuns([
    { run: aggregateRun(), artifactPath: "/private/a/run.json" },
    { run: validFailure, artifactPath: "/private/b/run.json" },
    { run: invalid, artifactPath: "/private/c/run.json" },
  ], { campaignId: "campaign-a", targetTierGB: 16 });

  assert.deepEqual(summary.counts, {
    discovered: 3, valid: 2, comparable: 2, invalid: 1, modelFailures: 1, controlMismatches: 0,
  });
  assert.equal(summary.rows[1].qualificationStatus, "fail");
  assert.equal(summary.rows[2].runStatus, "invalid");
  assert.equal(summary.rows[2].qualificationStatus, "invalid");
  assert.equal(summary.rows[2].comparisonStatus, "excluded-invalid");
});

test("aggregate excludes valid runs with incomparable campaign controls", () => {
  const summary = aggregateBenchmarkRuns([
    aggregateRun(),
    aggregateRun({ model: { id: "model-b", hf: "org/model-b:Q4_K_M" }, servedContext: 8192 }),
  ], { campaignId: "campaign-a", targetTierGB: 16 });
  assert.equal(summary.counts.comparable, 1);
  assert.equal(summary.counts.controlMismatches, 1);
  assert.equal(summary.rows[1].comparisonStatus, "incomparable");
  assert.equal(summary.rows[1].comparisonReason, "campaign controls differ from the first valid run");
});

test("summary CSV has a stable private-safe comparison contract", () => {
  const summary = aggregateBenchmarkRuns([{ run: aggregateRun(), artifactPath: "/private/run.json" }], {
    campaignId: "campaign-a", targetTierGB: 16,
  });
  const csv = benchmarkSummaryCsv(summary);
  assert.match(csv, /^modelId,model,artifactPath,runStatus/);
  assert.match(csv, /model-a,org\/model-a:Q4_K_M,/);
  assert.match(csv, /100,70,12,2,comparable/);
  assert.equal(csv.split("\n").length, 3);
});

test("campaign summary writer keeps aggregate artifacts outside model result folders", () => {
  const root = mkdtempSync(join(tmpdir(), "model-tier-summary-test-"));
  try {
    const result = writeCampaignSummary(root, 16, "campaign-a", [{
      run: aggregateRun(), artifactPath: "/private/model-a/run.json",
    }]);
    assert.equal(result.outputDir, resolveCampaignAggregateDir(root, 16, "campaign-a"));
    assert.equal(readFileSync(join(result.outputDir, "summary.json"), "utf8").includes('"contractVersion": 1'), true);
    assert.match(readFileSync(join(result.outputDir, "summary.csv"), "utf8"), /comparisonStatus/);
    assert.equal(readdirSync(result.outputDir).sort().join(","), "summary.csv,summary.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign planner covers every validated catalog placement deterministically", () => {
  const models = [
    { id: "qwen", hf: "org/qwen:Q4_K_M", tiers: [16, 8], role: "challenger" },
    { id: "gemma", hf: "org/gemma:Q4_K_XL", tiers: [8, 16, 24], role: "default" },
  ];
  const plan = buildCampaignPlan({
    models,
    campaignId: "campaign-a",
    gitCommit: "abc123",
    platform: "darwin 1 arm64",
    hardware: "Apple M",
    ramGB: 16,
    fixtureVersion: "fixture-sha",
    fixtureContractVersion: 1,
    fixtureMemoryCount: 28,
    fixtureTag: "aperio-exam",
  });
  assert.equal(plan.counts.models, 2);
  assert.equal(plan.counts.placements, 5);
  assert.equal(plan.counts.tiers, 3);
  assert.deepEqual(plan.placements.map(item => `${item.tier}:${item.modelId}`), [
    "8:gemma", "8:qwen", "16:gemma", "16:qwen", "24:gemma",
  ]);
  assert.equal(plan.status, "planned");
  assert.equal(plan.execution, "not-started");
  assert.equal(plan.controls.tierPolicy, TIER_POLICY);
});

test("campaign planner writes only private per-tier manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "model-tier-plan-test-"));
  try {
    const plan = buildCampaignPlan({
      models: [{ id: "model-a", hf: "org/model-a:Q4_K_M", tiers: [8, 16] }],
      campaignId: "campaign-a",
      fixtureVersion: "fixture-sha",
    });
    const result = writeCampaignPlan(root, plan);
    assert.equal(result.outputDirs.length, 2);
    for (const tier of [8, 16]) {
      const path = join(resolveCampaignAggregateDir(root, tier, "campaign-a"), "campaign.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(manifest.private, true);
      assert.equal(manifest.targetTierGB, tier);
      assert.deepEqual(manifest.modelIds, ["model-a"]);
      assert.deepEqual(manifest.placements.map(item => item.tier), [tier]);
      assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    assert.equal(readdirSync(root).join(","), "var");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalist selection keeps only comparable passing evidence and caps each tier", () => {
  const summary = aggregateBenchmarkRuns([
    aggregateRun({ model: { id: "model-b", hf: "org/model-b:Q4_K_M" }, targetTierGB: 8 }),
    aggregateRun({ model: { id: "model-a", hf: "org/model-a:Q4_K_M" }, targetTierGB: 8, passed: 99 }),
    aggregateRun({ model: { id: "model-fail", hf: "org/model-fail:Q4_K_M" }, targetTierGB: 8,
      caseResults: [{ id: "recall", section: "recall", hardGate: true, status: "fail" }] }),
  ], { campaignId: "campaign-a" });
  const manifest = selectFinalists(summary, { maxPerTier: 1 });
  assert.equal(manifest.finalists.length, 1);
  assert.equal(manifest.finalists[0].tier, 8);
  assert.equal(manifest.finalists[0].modelId, "model-a");
  assert.deepEqual(manifest.fullExam.repeatGroups.recall, [
    "recall-semantic-nats", "recall-filter-type", "recall-filter-tag", "recall-update-by-id",
  ]);
});

test("full exam manifest covers 65 drills and expands the eight critical repeats", () => {
  assert.equal(FULL_EXAM.drills.length, 65);
  assert.equal(FULL_EXAM.execution.totalObservations, 81);
  assert.equal(new Set(FULL_EXAM.drills.map(item => item.id)).size, 65);
  assert.deepEqual(FULL_EXAM.repeatGroups.recall, [
    "recall-semantic-nats", "recall-filter-type", "recall-filter-tag", "recall-update-by-id",
  ]);
  assert.deepEqual(FULL_EXAM.repeatGroups.chains, [
    "chain-recall-document-existence", "chain-code-syntax-run", "chain-web-source-memory", "chain-recall-wiki-provenance",
  ]);
});

test("finalist evidence validation rejects incomplete observations and duplicate repetitions", () => {
  const complete = finalistEvidence();
  assert.equal(complete.fullExam.observations.length, 81);
  assert.throws(() => validateFullExamManifest({ ...FULL_EXAM, drills: FULL_EXAM.drills.slice(0, 64) }), /drill count/);
  assert.throws(() => validateFinalistEvidence({ ...complete, fullExam: {
    ...complete.fullExam,
    observations: complete.fullExam.observations.slice(0, 80),
  } }, FULL_EXAM), /81 observations/);
  assert.throws(() => validateFinalistEvidence({ ...complete, fullExam: {
    ...complete.fullExam,
    observations: [...complete.fullExam.observations.slice(0, 80), complete.fullExam.observations[0]],
  } }, FULL_EXAM), /duplicate/);
});

test("tier decisions apply full-exam gates and produce default/fallback roles", () => {
  const finalists = [
    { tier: 16, modelId: "model-a", model: "org/model-a:Q4_K_M" },
    { tier: 16, modelId: "model-b", model: "org/model-b:Q4_K_M" },
  ];
  const evidence = [
    finalistEvidence(),
    finalistEvidence({ modelId: "model-b", servedContext: 8192, scoreVector: {
      recall: { passed: 4, total: 4 }, chains: { passed: 3, total: 4 }, guardrails: { passed: 2, total: 2 },
    } }),
  ];
  const decisions = generateTierDecisions({ finalists, evidence, manifest: FULL_EXAM });
  assert.equal(decisions.tiers[16].status, "eligible");
  assert.equal(decisions.tiers[16].default, "model-a");
  assert.equal(decisions.tiers[16].fallback, "model-b");
  assert.equal(decisions.tiers[8].status, "unverified");
  assert.match(tierDecisionsMarkdown(decisions), /\| 16 GB \| eligible \| model-a \| model-b \|/);
});

test("tier decisions exclude finalist evidence marked invalid", () => {
  const decisions = generateTierDecisions({
    finalists: [{ tier: 8, modelId: "model-a" }],
    evidence: [finalistEvidence({ runStatus: "invalid" })],
    manifest: FULL_EXAM,
  });
  assert.equal(decisions.tiers[8].status, "unsupported");
  assert.equal(decisions.tiers[8].default, null);
});

test("finalist and decision writers keep evidence outputs private", () => {
  const root = mkdtempSync(join(tmpdir(), "model-tier-finalist-test-"));
  const evidencePath = join(root, "evidence.json");
  try {
    const summaryDir = resolveCampaignAggregateDir(root, 16, "campaign-a");
    mkdirSync(summaryDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(summaryDir, "summary.json"), JSON.stringify(aggregateBenchmarkRuns([
      aggregateRun(),
    ], { campaignId: "campaign-a", targetTierGB: 16 })));
    const manifest = writeFinalistManifest(root, 16, "campaign-a");
    assert.equal(manifest.manifest.finalists.length, 1);
    writeFileSync(evidencePath, JSON.stringify([finalistEvidence()]));
    writeTierDecisions(root, 16, "campaign-a", evidencePath);
    assert.deepEqual(readdirSync(summaryDir).sort(), ["decisions.json", "decisions.md", "finalists.json", "summary.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    plan: false,
    aggregate: false,
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

  assert.equal(await verifyState("http://runner", {
    kind: "memory", type: "preference", contentIncludes: ["espresso"],
  }, { apiCall }), false);
  assert.equal(await verifyState("http://runner", {
    kind: "wiki", query: "Nimbus", minimumMatches: 2,
  }, { apiCall }), false);
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

test("catalog contains the complete verified candidate matrix", () => {
  const models = JSON.parse(readFileSync(".github/model-tiers/models.json", "utf8"));
  const validated = validateBenchmarkModels(models);
  assert.equal(validated.length, 15);
  assert.deepEqual(validated.filter(model => model.tiers.includes(8)).map(model => model.id), [
    "gemma4-e4b-ud-q4kxl", "qwen35-4b-ud-q4kxl", "ministral3-3b-q4km", "granite40-h-tiny-ud-q4kxl",
  ]);
  assert.deepEqual(validated.filter(model => model.tiers.includes(16)).map(model => model.id), [
    "gemma4-e4b-ud-q4kxl", "qwen35-4b-ud-q4kxl", "ministral3-3b-q4km", "granite40-h-tiny-ud-q4kxl",
    "qwen35-9b-q4km", "ministral3-14b-q4km", "granite41-8b-q4km", "gpt-oss-20b-mxfp4",
  ]);
  const gemma = validated.find(model => model.id === "gemma4-e4b-ud-q4kxl");
  assert.equal(gemma.hf, "unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL");
  assert.equal(gemma.quant, "UD-Q4_K_XL");
  assert.equal(gemma.verification.repository, "https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF");
  assert.equal(validated.find(model => model.id === "gpt-oss-20b-mxfp4").quant, "mxfp4");
});

test("catalog validation rejects repository/quant drift and incomplete verification metadata", () => {
  const base = {
    id: "catalog-model", displayName: "Catalog model", hf: "org/model-GGUF:Q4_K_M", quant: "Q4_K_M",
    sizeGB: 4, tiers: [8], role: "challenger",
    verification: { source: "huggingface", repository: "https://huggingface.co/org/model-GGUF", verifiedAt: "2026-07-14" },
  };
  assert.deepEqual(validateBenchmarkModels([base]), [base]);
  assert.throws(() => validateBenchmarkModels([{ ...base, quant: "Q5_K_M" }]), /quant does not match/);
  assert.deepEqual(validateBenchmarkModels([{ ...base, hf: "org/model-GGUF" }])[0].quant, "Q4_K_M");
  assert.throws(() => validateBenchmarkModels([{ ...base, quant: "" }]), /quant/);
  assert.throws(() => validateBenchmarkModels([{ ...base, role: "default" }]), /role is unsupported/);
  assert.throws(() => validateBenchmarkModels([{ ...base, tiers: [8, 8] }]), /duplicates/);
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
      role: "challenger",
      verification: { source: "huggingface", repository: "https://huggingface.co/example.invalid/uncached-model-GGUF", verifiedAt: "2026-07-14" },
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

test("runner teardown captures llama cleanup before stopping the Node app", async () => {
  const stopped = [];
  await stopRunnerProcesses({
    child: { pid: 123 },
    llamaPid: 456,
    stopLlamaFn: async pid => stopped.push(["llama", pid]),
    stopChildFn: async child => stopped.push(["node", child.pid]),
  });
  assert.deepEqual(stopped, [["llama", 456], ["node", 123]]);
});

test("runner teardown sweeps every tracked llama pid and the port holder, deduped, before the node app", async () => {
  // In-run restarts (Compute-error recovery, retry) leave earlier router groups
  // that state.json no longer names. Teardown must reap every PID we ever saw
  // PLUS whatever still holds the ephemeral llama port, so nothing survives to
  // pile up on the next run.
  const stopped = [];
  await stopRunnerProcesses({
    child: { pid: 123 },
    llamaPids: [456, 789],
    llamaPort: 57419,
    pidsOnPortFn: () => [789, 999], // 789 duplicates a tracked pid; 999 is a pid we never recorded
    stopLlamaFn: async pid => stopped.push(["llama", pid]),
    stopChildFn: async child => stopped.push(["node", child.pid]),
  });
  const llamaPids = stopped.filter(([kind]) => kind === "llama").map(([, pid]) => pid);
  assert.deepEqual(new Set(llamaPids), new Set([456, 789, 999]), "every tracked pid and the port holder, deduped");
  assert.equal(llamaPids.length, 3, "no pid is stopped twice");
  assert.deepEqual(stopped.at(-1), ["node", 123], "the node app is stopped last, after every llama group");
});

test("runner teardown re-sweeps a newly published port holder after stopping the app", async () => {
  const stopped = [];
  let sweep = 0;
  await stopRunnerProcesses({
    child: { pid: 123 },
    llamaPids: [456],
    llamaPort: 57419,
    pidsOnPortFn: () => (sweep++ === 0 ? [456] : [999]),
    stopLlamaFn: async pid => stopped.push(["llama", pid]),
    stopChildFn: async child => stopped.push(["node", child.pid]),
  });
  assert.deepEqual(stopped, [["llama", 456], ["node", 123], ["llama", 999]]);
});

test("registerRunnerCleanup runs teardown once per signal then exits with the signal code", async () => {
  const handlers = {};
  const cleanups = [];
  const exits = [];
  registerRunnerCleanup({
    signals: ["SIGINT", "SIGTERM"],
    cleanup: signal => { cleanups.push(signal); },
    exit: code => exits.push(code),
    on: (signal, handler) => { handlers[signal] = handler; },
  });

  assert.deepEqual(Object.keys(handlers).sort(), ["SIGINT", "SIGTERM"], "registers a handler per signal");

  await handlers.SIGINT();
  await handlers.SIGTERM();

  assert.deepEqual(cleanups, ["SIGINT", "SIGTERM"], "each signal triggers the cleanup with its name");
  assert.deepEqual(exits, [130, 143], "SIGINT exits 130 (128+2), SIGTERM exits 143 (128+15)");
});

test("registerRunnerCleanup still exits even when cleanup throws (never wedges on Ctrl+C)", async () => {
  const exits = [];
  let handler;
  registerRunnerCleanup({
    signals: ["SIGINT"],
    cleanup: () => { throw new Error("teardown blew up"); },
    exit: code => exits.push(code),
    on: (_signal, fn) => { handler = fn; },
  });
  await handler();
  assert.deepEqual(exits, [130], "a failed teardown must not prevent the process from exiting");
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
