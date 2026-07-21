#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { LLAMACPP_MAIN_ALIAS } from "../lib/helpers/llamacppAliases.js";
import { runBenchmark } from "../lib/helpers/localBench.js";
import { resolveModelCacheDir } from "../lib/helpers/modelCache.js";
import { validateBenchmarkCases, validateBenchmarkModels, validateFullExamManifest } from "../lib/helpers/modelTierBench.js";
import {
  QUALIFICATION_SUITE_VERSION,
  validateQualificationFixture,
  validateQualificationSuite,
} from "../lib/helpers/modelTierQualification.js";
import { DEFAULT_CASES, DEFAULT_FULL_EXAM, DEFAULT_MODELS, FIXTURE, FIXTURE_CONTRACT, ROOT, WORKSPACE_FIXTURE } from "./model-tier-bench/paths.js";
import { GIB, TIER_POLICY, DEFAULT_PILOT_CASE_IDS } from "./model-tier-bench/constants.js";
import { atomicJson, readJson } from "./model-tier-bench/io.js";
import {
  availableDiskBytes,
  preflightModelCandidate,
  resolveHostTier,
  resolveTierConfiguration,
  evaluateTierAdmission,
  selectPilotCases,
  validateTargetTier,
  writeInvalidAdmissionRun,
} from "./model-tier-bench/admission.js";
import {
  resolveBenchmarkArtifactDir,
  resolveCampaignAggregateDir,
  buildCampaignPlan,
  writeCampaignPlan,
  readCampaignPlacements,
  executeCampaign,
  requireLiveCampaignApproval,
} from "./model-tier-bench/campaign.js";
import {
  rescorePersistedRuns,
  writeCampaignSummary,
  writeFinalistManifest,
  writeTierDecisions,
} from "./model-tier-bench/report.js";
import {
  freePort,
  api,
  connectWhenReady,
  closeWebSocket,
  waitForRetryReadiness,
  modelReady,
  runWsCase,
  classifyTimeoutEvidence,
  restoreQualificationState,
  executeBenchmarkCases,
  verifyState,
  importQualificationFixture,
  waitForFixture,
  beginQualificationMeasurement,
  waitForGraphs,
} from "./model-tier-bench/runtime.js";
import {
  copyRuntimeLog,
  startMetrics,
  createMetricReport,
  captureLedgerOffsets,
  sliceLedger,
  summarizeToolQuality,
  teardownOwnedProcesses,
  stopRunnerProcesses,
  registerRunnerCleanup,
  readLlamaPid,
} from "./model-tier-bench/process.js";

export {
  TIER_POLICY,
  DEFAULT_PILOT_CASE_IDS,
  preflightModelCandidate,
  resolveHostTier,
  resolveTierConfiguration,
  evaluateTierAdmission,
  selectPilotCases,
  validateTargetTier,
  writeInvalidAdmissionRun,
  resolveBenchmarkArtifactDir,
  resolveCampaignAggregateDir,
  buildCampaignPlan,
  writeCampaignPlan,
  readCampaignPlacements,
  executeCampaign,
  requireLiveCampaignApproval,
  rescorePersistedRuns,
  writeCampaignSummary,
  writeFinalistManifest,
  writeTierDecisions,
  connectWhenReady,
  waitForRetryReadiness,
  modelReady,
  runWsCase,
  classifyTimeoutEvidence,
  restoreQualificationState,
  executeBenchmarkCases,
  verifyState,
  importQualificationFixture,
  waitForFixture,
  beginQualificationMeasurement,
  copyRuntimeLog,
  createMetricReport,
  captureLedgerOffsets,
  sliceLedger,
  summarizeToolQuality,
  teardownOwnedProcesses,
  stopRunnerProcesses,
  registerRunnerCleanup,
};

export function parseArgs(argv) {
  const out = { caseIds: [], validate: false, plan: false, executeCampaign: false, dryRun: false, approveLive: false, aggregate: false, rescore: false, allowDownload: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") out.modelId = argv[++i];
    else if (arg === "--case") out.caseIds.push(argv[++i]);
    else if (arg === "--models") out.modelsPath = resolve(argv[++i]);
    else if (arg === "--cases") out.casesPath = resolve(argv[++i]);
    else if (arg === "--campaign") out.campaignId = argv[++i];
    else if (arg === "--tier") out.tier = Number(argv[++i]);
    else if (arg === "--note") out.environmentNote = argv[++i];
    else if (arg === "--allow-download") out.allowDownload = true;
    else if (arg === "--plan") out.plan = true;
    else if (arg === "--execute-campaign") out.executeCampaign = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--approve-live") out.approveLive = true;
    else if (arg === "--aggregate") out.aggregate = true;
    else if (arg === "--rescore") out.rescore = true;
    else if (arg === "--finalists") out.finalists = true;
    else if (arg === "--decide") out.decide = true;
    else if (arg === "--evidence") out.evidencePath = resolve(argv[++i]);
    else if (arg === "--validate") out.validate = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage: npm run model-tier:pilot -- --model <model-id> [options]",
    "",
    "This is a qualification runner. Its five-case pilot validates model behavior;",
    "results are not sufficient to select installer defaults without a campaign.",
    "",
    "Options:",
    "  --case <id>         Run one case (repeatable)",
    "  --allow-download    Permit llama.cpp to download an uncached GGUF",
    "  --plan              Write a private, non-live plan for every catalog placement",
    "  --execute-campaign  Execute every placement in a private campaign plan",
    "  --dry-run           Show campaign execution without starting model processes",
    "  --approve-live      Explicitly authorize non-dry-run campaign execution",
    "  --aggregate         Build private campaign summaries from existing run artifacts",
    "  --rescore           Audit complete persisted run.json artifacts without writing them",
    "  --finalists         Select finalists from an existing private summary.json",
    "  --decide            Generate private tier decisions from finalist evidence",
    "  --campaign <id>     Override the UTC campaign id",
    "  --evidence <path>   JSON finalist evidence for --decide",
    "  --tier <8|16|24|32> Target RAM tier for this run (required when running)",
    "  --note <text>        Record an environment caveat on the run",
    "  --validate          Validate model/case files without starting processes",
  ].join("\n");
}

function campaignId(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  if (args.rescore) {
    console.log(JSON.stringify({ mode: "offline-rescore", writes: [], artifacts: rescorePersistedRuns(ROOT) }, null, 2));
    return;
  }
  const models = validateBenchmarkModels(readJson(args.modelsPath ?? DEFAULT_MODELS));
  const allCases = validateBenchmarkCases(readJson(args.casesPath ?? DEFAULT_CASES));
  const fullExam = validateFullExamManifest(readJson(DEFAULT_FULL_EXAM));
  validateQualificationSuite(allCases);
  const cases = selectPilotCases(allCases, args.caseIds);
  const fixture = readJson(FIXTURE);
  const fixtureContract = readJson(FIXTURE_CONTRACT);
  const fixtureSummary = validateQualificationFixture(fixture, fixtureContract);
  const fixtureVersion = createHash("sha256").update(readFileSync(FIXTURE)).digest("hex");
  if (args.validate) {
    console.log(`Validated ${models.length} model(s), ${cases.length} case(s), and ${fullExam.scoredDrills}-drill full exam (${fullExam.execution.totalObservations} observations).`);
    return;
  }
  if (args.plan) {
    const id = args.campaignId ?? campaignId();
    const plan = buildCampaignPlan({
      models,
      campaignId: id,
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      hardware: os.cpus()[0]?.model ?? "unknown",
      ramGB: Number((os.totalmem() / GIB).toFixed(2)),
      fixtureVersion,
      fixtureContractVersion: fixtureContract.version,
      fixtureMemoryCount: fixtureSummary.memoryCount,
      fixtureTag: fixtureSummary.tag,
    });
    const result = writeCampaignPlan(ROOT, plan);
    console.log(`Planned ${plan.counts.placements} placement(s) across ${result.outputDirs.length} tier(s) into ${id}`);
    return;
  }
  if (args.executeCampaign) {
    if (!args.campaignId) throw new Error("--campaign is required with --execute-campaign");
    requireLiveCampaignApproval(args);
    const result = await executeCampaign(ROOT, args.campaignId, { dryRun: args.dryRun, runnerPath: fileURLToPath(import.meta.url) });
    const failed = result.results.filter(item => !args.dryRun && (item.error || item.signal || item.exitCode !== 0));
    console.log(`${args.dryRun ? "Validated" : "Executed"} ${result.placements.length} campaign placement(s) for ${args.campaignId}`);
    if (failed.length) {
      console.error(`${failed.length} placement process(es) failed or could not start`);
      process.exitCode = 2;
    }
    return;
  }
  if (args.aggregate) {
    if (!args.campaignId) throw new Error("--campaign is required with --aggregate");
    validateTargetTier({ id: "aggregate", tiers: [8, 16, 24, 32] }, args.tier);
    const result = writeCampaignSummary(ROOT, args.tier, args.campaignId);
    console.log(`Aggregated ${result.summary.counts.discovered} run(s) into ${result.outputDir}`);
    return;
  }
  if (args.finalists || args.decide) {
    if (!args.campaignId) throw new Error("--campaign is required with --finalists/--decide");
    validateTargetTier({ id: "aggregate", tiers: [8, 16, 24, 32] }, args.tier);
    if (args.finalists) {
      const result = writeFinalistManifest(ROOT, args.tier, args.campaignId);
      console.log(`Selected ${result.manifest.finalists.length} finalist(s) into ${result.outputDir}`);
    }
    if (args.decide) {
      const result = writeTierDecisions(ROOT, args.tier, args.campaignId, args.evidencePath);
      console.log(`Generated tier decisions in ${result.outputDir}`);
    }
    return;
  }
  if (!args.modelId) throw new Error("--model is required\n\n" + usage());
  validateTargetTier({ id: args.modelId, tiers: [8, 16, 24, 32] }, args.tier);
  const model = models.find(item => item.id === args.modelId);
  if (!model) throw new Error(`unknown model id: ${args.modelId}`);
  validateTargetTier(model, args.tier);

  const id = args.campaignId ?? campaignId();
  const modelDir = resolveBenchmarkArtifactDir(ROOT, args.tier, model.id, id);
  const cacheRoot = resolveModelCacheDir(process.env);
  const hostRamGB = Number((os.totalmem() / GIB).toFixed(2));
  const preflight = preflightModelCandidate(model, {
    cacheRoot,
    diskAvailableBytes: availableDiskBytes(cacheRoot) ?? availableDiskBytes(ROOT),
  });
  const facts = preflight.ggufFacts;
  const tierAdmission = evaluateTierAdmission(args.tier, hostRamGB, facts ?? { sizeGB: model.sizeGB });
  const admissionReasons = [...preflight.reasons, ...tierAdmission.reasons];
  if (admissionReasons.length) {
    const run = writeInvalidAdmissionRun(join(modelDir, "run.json"), {
      model,
      campaignId: id,
      targetTierGB: args.tier,
      reasons: admissionReasons,
      preflight,
      tierConfiguration: tierAdmission.configuration,
      tierAdmission,
    });
    console.error(`${model.id}: invalid admission — ${run.invalidReason}`);
    process.exitCode = 2;
    return;
  }
  const tierConfiguration = tierAdmission.configuration;
  mkdirSync(modelDir, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(join(os.tmpdir(), `aperio-model-tier-${model.id}-`));
  // Isolated workspace the code/doc/shell cases operate on. Seeded with a tiny
  // tracked fixture tree so codegraph/docgraph have a real symbol and document
  // to index, and so run_shell/run_node_script have an allowed cwd. It is the
  // ONLY path in the allow-list, which keeps the out-of-scope-read guardrails
  // honest (/etc stays unreachable).
  const workspaceDir = join(tempDir, "workspace");
  cpSync(WORKSPACE_FIXTURE, workspaceDir, { recursive: true });
  const appPort = await freePort();
  const llamaPort = await freePort();
  const baseURL = `http://127.0.0.1:${appPort}`;
  const applicationLog = createWriteStream(join(modelDir, "application.log"), { mode: 0o600 });
  const env = {
    ...process.env,
    AI_PROVIDER: "llamacpp",
    LLAMACPP_MODEL: model.hf,
    APERIO_CAPABLE_MODELS: model.hf,
    APERIO_RECALL_SCAFFOLD_MODELS: "",
    APERIO_LOCAL_PERF_PROFILE: "balanced",
    LLAMACPP_SERVE_CTX: String(tierConfiguration.servedContext),
    LLAMACPP_CTX: String(tierConfiguration.servedContext),
    LLAMACPP_PORT: String(llamaPort),
    LLAMACPP_BASE_URL: `http://127.0.0.1:${llamaPort}`,
    PORT: String(appPort),
    HOST: "127.0.0.1",
    DB_BACKEND: "sqlite",
    SQLITE_PATH: join(tempDir, "aperio.db"),
    APERIO_CONFIG_PRECEDENCE: "env",
    // Code/doc/shell qualification cases need these subsystems live. The graph
    // watchers index every allowed read path, so scoping the allow-list to the
    // seeded workspace keeps indexing tiny and the guardrail cases meaningful.
    // APERIO_ENABLE_SHELL is read as the exact string "1" (mcp/tools/shell.js).
    APERIO_CODEGRAPH: "on",
    APERIO_DOCGRAPH: "on",
    APERIO_ENABLE_SHELL: "1",
    APERIO_ALLOWED_PATHS_TO_READ: workspaceDir,
    APERIO_ALLOWED_PATHS_TO_WRITE: workspaceDir,
    APERIO_AGENT_SCHEDULER: "off",
    EMBEDDING_PROVIDER: "transformers",
    APERIO_DB_ENCRYPT: "off",
    IDLE_SHUTDOWN: "off",
    ROUNDTABLE_AGENTS: "",
    APERIO_BENCHMARK_RUN: "1",
    APERIO_AUTH_TOKEN: "",
    LLAMA_CACHE: cacheRoot,
    PATH: `${join(ROOT, "vendor/llamacpp")}:${process.env.PATH ?? ""}`,
  };
  const startedAt = new Date().toISOString();
  const startRunnerServer = () => {
    const server = spawn(process.execPath, [join(ROOT, "server.js")], {
      cwd: tempDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.pipe(applicationLog, { end: false });
    server.stderr.pipe(applicationLog, { end: false });
    return server;
  };
  let child = startRunnerServer();
  const metrics = startMetrics(() => child?.pid, tempDir);
  let connection;
  let sessionId;
  let run;
  let transcript;
  let loadMetrics;
  let fixtureImport;
  let embeddingReadiness;
  let ledgerOffsets;
  let ledgerSlices;
  const benchmarkEvents = [];
  const ownedLlamaPid = () => readLlamaPid(tempDir);
  // Every llama-server router PID this run has spawned. state.json only names the
  // latest, so an in-run restart would otherwise orphan the previous group; we
  // remember them all and reap the union (plus the port holder) at teardown.
  const llamaPids = new Set();
  const recordLlamaPid = () => { const pid = ownedLlamaPid(); if (pid) llamaPids.add(pid); };
  let processesStopped = false;
  const stopAllProcesses = async () => {
    if (processesStopped) return; // idempotent: finally + a signal must not double-run
    processesStopped = true;
    recordLlamaPid();
    await stopRunnerProcesses({ child, llamaPids, llamaPort });
  };
  let tempRemoved = false;
  const removeTempWorkdir = () => {
    if (tempRemoved) return;
    tempRemoved = true;
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  // A signal (Ctrl+C / SIGTERM) skips the finally block entirely — the exact case
  // where a user abandons a run and its engines pile up. Reap them here too.
  registerRunnerCleanup({ cleanup: async () => { await stopAllProcesses(); removeTempWorkdir(); } });
  let caseResults = [];
  const retrySnapshotDir = join(tempDir, "retry-snapshot");
  const captureRetryState = async () => {
    const database = await api(baseURL, "/api/data/export", {
      method: "POST",
      body: JSON.stringify({ include_wiki: true, include_agent_jobs: false, include_self_memories: false }),
    });
    const workspace = join(retrySnapshotDir, "workspace");
    rmSync(retrySnapshotDir, { recursive: true, force: true });
    cpSync(workspaceDir, workspace, { recursive: true });
    return { database, workspace };
  };
  const restoreRetryDatabase = async database => {
    await closeWebSocket(connection?.ws);
    if (sessionId) {
      try { await api(baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" }); } catch { /* isolated DB is restarted below */ }
    }
    const oldLlamaPid = ownedLlamaPid();
    if (oldLlamaPid) llamaPids.add(oldLlamaPid);
    await stopRunnerProcesses({ child, llamaPids: [oldLlamaPid], llamaPort });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${env.SQLITE_PATH}${suffix}`, { force: true });
    child = startRunnerServer();
    connection = undefined;
    sessionId = undefined;
    await waitForRetryReadiness({ baseURL, appPort });
    // Probe the tier-sized preset alias, not the raw HF id: requesting the raw
    // repo:quant resolves to llama.cpp's auto-discovered cache preset (full
    // model ctx), which the router loads as a SECOND resident instance and
    // doubles the tier RAM measurement. The app's chat path uses this alias too.
    await modelReady(`http://127.0.0.1:${llamaPort}`, LLAMACPP_MAIN_ALIAS);
    recordLlamaPid();
    const imported = await api(baseURL, "/api/data/import", { method: "POST", body: JSON.stringify(database) });
    if (imported.imported?.memories !== database.memories?.length) {
      throw new Error(`retry fixture restore imported ${imported.imported?.memories ?? 0} memories`);
    }
    await waitForFixture(baseURL, fixtureSummary.memoryCount);
    await waitForGraphs(baseURL);
  };
  try {
    connection = await connectWhenReady(appPort);
    const provider = connection.handshake.find(message => message.type === "provider");
    sessionId = connection.handshake.find(message => message.type === "session_created")?.id;
    if (provider?.name !== "llamacpp" || provider?.model !== model.hf) {
      throw new Error(`invalid run: requested ${model.hf}, active provider is ${provider?.name}:${provider?.model}`);
    }
    if (provider.toolEligible !== true) throw new Error("invalid run: active model has no tool surface");
    console.error(`⏳ app ready — provider ${provider.name}:${model.id}, loading model…`);

    await modelReady(`http://127.0.0.1:${llamaPort}`, LLAMACPP_MAIN_ALIAS);
    recordLlamaPid();
    console.error(`⏳ model loaded (${LLAMACPP_MAIN_ALIAS})`);

    // Drive the throughput probe through the tier-sized preset alias. Passing
    // the raw HF id here made the router load a second, full-context copy of the
    // model (see modelReady note above), contaminating the RAM curve. Record the
    // real model id in the artifact so local-bench.json stays keyed on model.hf.
    const localBench = await runBenchmark({
      baseURL: `http://127.0.0.1:${llamaPort}`,
      model: LLAMACPP_MAIN_ALIAS,
      profile: "balanced",
      servedCtx: tierConfiguration.servedContext,
    });
    atomicJson(join(modelDir, "local-bench.json"), { ...localBench, model: model.hf });
    console.error("⏳ throughput probe done — importing fixture…");

    fixtureImport = await importQualificationFixture(baseURL, fixture);
    embeddingReadiness = await waitForFixture(baseURL, fixtureSummary.memoryCount);
    // Let the code/doc graphs finish indexing the seeded workspace before the
    // qualification window opens, so the search tools have data and index CPU
    // lands in the load phase rather than skewing per-case timing.
    await waitForGraphs(baseURL);
    console.error(`⏳ fixture imported (${fixtureSummary.memoryCount}) + graphs ready — measuring ${cases.length} cases`);
    loadMetrics = beginQualificationMeasurement(metrics, embeddingReadiness);
    ledgerOffsets = captureLedgerOffsets({
      events: join(tempDir, "var/toolrepair/events.tsv"),
      failures: join(tempDir, "var/toolrepair/failures.tsv"),
    });

    transcript = createWriteStream(join(modelDir, "transcript.jsonl"), { mode: 0o600 });
    caseResults = await executeBenchmarkCases(cases, {
      context: { ws: connection.ws, sessionId },
      runCase: async (caseDef, context) => {
        if (!context?.ws || context.ws.readyState === WebSocket.CLOSED) {
          const fresh = await connectWhenReady(appPort);
          context.ws = fresh.ws;
          context.sessionId = fresh.handshake.find(message => message.type === "session_created")?.id;
          connection = fresh;
          sessionId = context.sessionId;
        }
        const position = cases.indexOf(caseDef) + 1;
        const label = `[${position}/${cases.length}] ${caseDef.id}`;
        console.error(`${label} (working on it …)`);
        try {
          const execution = await runWsCase(context.ws, caseDef);
          console.error(`${label} (turn done in ${(execution.durationMs / 1000).toFixed(1)}s)`);
          return execution;
        } catch (error) {
          const seconds = ((error.durationMs ?? 0) / 1000).toFixed(1);
          console.error(`${label} (stopped after ${seconds}s — ${error.message})`);
          throw error;
        }
      },
      verifyCaseState: (caseDef) => verifyState(baseURL, caseDef.stateAssertion),
      captureState: captureRetryState,
      restoreState: (caseDef, snapshot) => restoreQualificationState({
        caseDef,
        fixtureContract,
        snapshot,
        restoreDatabase: restoreRetryDatabase,
        restoreWorkspace: workspace => {
          rmSync(workspaceDir, { recursive: true, force: true });
          cpSync(workspace, workspaceDir, { recursive: true });
        },
      }),
      createFreshContext: async () => {
        const fresh = await connectWhenReady(appPort);
        connection = fresh;
        sessionId = fresh.handshake.find(message => message.type === "session_created")?.id;
        return { ws: fresh.ws, sessionId };
      },
      disposeContext: async context => {
        await closeWebSocket(context?.ws);
        if (context?.sessionId) {
          try { await api(baseURL, `/api/sessions/${context.sessionId}`, { method: "DELETE" }); } catch { /* isolated DB is removed below */ }
        }
      },
      recordEvents: (caseDef, events, { attempt = 1 } = {}) => {
        for (const event of events) {
          benchmarkEvents.push(event);
          transcript.write(JSON.stringify({ caseId: caseDef.id, attempt, ...event }) + "\n");
        }
      },
    });
    run = {
      pilot: true,
      status: "complete",
      qualificationSuiteVersion: QUALIFICATION_SUITE_VERSION,
      environmentNote: args.environmentNote ?? null,
      campaignId: id,
      targetTierGB: args.tier,
      tierConfiguration,
      tierPolicy: TIER_POLICY,
      tierAdmission,
      model,
      factsSource: facts ? "gguf" : "catalog",
      ggufFacts: facts,
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      hardware: os.cpus()[0]?.model ?? "unknown",
      ramGB: Number((os.totalmem() / GIB).toFixed(2)),
      profile: "balanced",
      servedContext: tierConfiguration.servedContext,
      fixtureVersion,
      fixtureContractVersion: fixtureContract.version,
      fixtureMemoryCount: fixtureSummary.memoryCount,
      fixtureTag: fixtureSummary.tag,
      fixtureImport,
      embeddingReadiness,
      startedAt,
      finishedAt: new Date().toISOString(),
      caseResults,
    };
  } catch (error) {
    caseResults = error.caseResults ?? caseResults;
    run = {
      pilot: true,
      status: "invalid",
      invalidReason: error.message,
      qualificationSuiteVersion: QUALIFICATION_SUITE_VERSION,
      environmentNote: args.environmentNote ?? null,
      campaignId: id,
      targetTierGB: args.tier,
      tierConfiguration,
      tierPolicy: TIER_POLICY,
      tierAdmission,
      model,
      factsSource: facts ? "gguf" : "catalog",
      ggufFacts: facts,
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      hardware: os.cpus()[0]?.model ?? "unknown",
      ramGB: Number((os.totalmem() / GIB).toFixed(2)),
      profile: "balanced",
      servedContext: tierConfiguration.servedContext,
      fixtureVersion,
      fixtureContractVersion: fixtureContract.version,
      fixtureMemoryCount: fixtureSummary.memoryCount,
      fixtureTag: fixtureSummary.tag,
      fixtureImport,
      embeddingReadiness,
      startedAt,
      finishedAt: new Date().toISOString(),
      caseResults,
    };
    throw error;
  } finally {
    transcript?.end();
    try { await closeWebSocket(connection?.ws); } catch { /* best effort */ }
    if (sessionId) {
      try { await api(baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" }); } catch { /* isolated DB is removed below */ }
    }
    try {
      const llamaLog = join(tempDir, "var/llamacpp/server.log");
      if (existsSync(llamaLog)) copyRuntimeLog(llamaLog, join(modelDir, "llamacpp.log"));
    } catch { /* optional diagnostic */ }
    const measuredQualification = metrics.stop();
    await stopAllProcesses();
    const measured = createMetricReport(loadMetrics ?? measuredQualification, measuredQualification);
    ledgerOffsets ??= captureLedgerOffsets({
      events: join(tempDir, "var/toolrepair/events.tsv"),
      failures: join(tempDir, "var/toolrepair/failures.tsv"),
    });
    ledgerSlices = {
      events: sliceLedger(ledgerOffsets.events.path, ledgerOffsets.events.offset, join(modelDir, "toolrepair-events.tsv")),
      failures: sliceLedger(ledgerOffsets.failures.path, ledgerOffsets.failures.offset, join(modelDir, "toolcall-failures.tsv")),
    };
    const toolQuality = summarizeToolQuality({
      events: benchmarkEvents,
      toolRepairRows: ledgerSlices.events.rows,
      toolFailureRows: ledgerSlices.failures.rows,
      caseResults: run?.caseResults ?? caseResults,
    });
    applicationLog.end();
    removeTempWorkdir();
    if (run) {
      run.metrics = measured;
      run.ledger = {
        offsets: ledgerOffsets,
        slices: ledgerSlices,
      };
      run.toolQuality = toolQuality;
      atomicJson(join(modelDir, "run.json"), run);
      writeFileSync(join(modelDir, "cases.jsonl"), run.caseResults.map(item => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
      const metricHeader = "phase,at,usedRamBytes,aperioRssBytes,llamaRssBytes,swapBytes\n";
      const metricRows = [...(measured.load?.samples ?? []), ...(measured.qualification?.samples ?? [])].map(sample => [
        sample.phase, sample.at, sample.usedRamBytes, sample.aperioRssBytes, sample.llamaRssBytes, sample.swapBytes ?? "",
      ].join(",")).join("\n");
      writeFileSync(join(modelDir, "metrics.csv"), metricHeader + metricRows + "\n", { mode: 0o600 });
      atomicJson(join(modelDir, "campaign.json"), {
        campaignId: id,
        targetTierGB: args.tier,
        hostRamGB: tierConfiguration.hostRamGB,
        hostTierGB: tierConfiguration.hostTierGB,
        tierConfiguration,
        pilot: true,
        warning: "Pilot harness evidence is not sufficient to select installer defaults.",
        modelIds: [model.id],
        qualificationSuiteVersion: QUALIFICATION_SUITE_VERSION,
        fixtureVersion,
        fixtureContractVersion: fixtureContract.version,
        fixtureMemoryCount: fixtureSummary.memoryCount,
        fixtureTag: fixtureSummary.tag,
        profile: "balanced",
        servedContext: tierConfiguration.servedContext,
      });
    }
  }
  console.log(`${model.id}: ${run.caseResults.filter(item => item.status === "pass").length}/${run.caseResults.length} pilot cases passed`);
  console.log(join(modelDir, "run.json"));
  if (run.caseResults.some(item => item.status !== "pass")) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`model-tier benchmark failed: ${error.message}`);
    process.exitCode = 1;
  });
}
