#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { findCachedGguf, factsFromGguf } from "../lib/helpers/ggufModelFacts.js";
import { LLAMACPP_MAIN_ALIAS } from "../lib/helpers/llamacppAliases.js";
import { runBenchmark } from "../lib/helpers/localBench.js";
import { resolveModelCacheDir } from "../lib/helpers/modelCache.js";
import {
  evaluateBenchmarkCase,
  selectBenchmarkCases,
  validateBenchmarkCases,
  validateBenchmarkModels,
} from "../lib/helpers/modelTierBench.js";
import {
  QUALIFICATION_SUITE_VERSION,
  validateQualificationFixture,
  validateQualificationSuite,
} from "../lib/helpers/modelTierQualification.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODELS = join(ROOT, ".github/model-tiers/models.json");
const DEFAULT_CASES = join(ROOT, ".github/model-tiers/cases.json");
const FIXTURE = join(ROOT, ".github/capability-exam/exam.memories.json");
const FIXTURE_CONTRACT = join(ROOT, ".github/model-tiers/fixture-contract.json");
const WORKSPACE_FIXTURE = join(ROOT, ".github/model-tiers/workspace");
const GIB = 1024 ** 3;
export const TIER_POLICY = "RAM <= 8 => 8 GB; RAM <= 16 => 16 GB; RAM <= 24 => 24 GB; RAM > 24 => 32 GB";
// Keep the pilot funnel explicit and extensible as additional pilot cases are
// approved. The full qualification suite remains available through --case.
export const DEFAULT_PILOT_CASE_IDS = Object.freeze([
  "recall-semantic-nats",
  "recall-filter-type",
  "recall-filter-tag",
  "recall-update-by-id",
  "chain-recall-wiki",
]);

export function parseArgs(argv) {
  const out = { caseIds: [], validate: false, allowDownload: false };
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
    "  --campaign <id>     Override the UTC campaign id",
    "  --tier <8|16|24|32> Target RAM tier for this run (required when running)",
    "  --note <text>        Record an environment caveat on the run",
    "  --validate          Validate model/case files without starting processes",
  ].join("\n");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function resolveBenchmarkArtifactDir(root, tier, modelId, id) {
  if (![8, 16, 24, 32].includes(tier)) throw new Error("tier must be 8, 16, 24, or 32");
  if (!modelId || !id) throw new Error("model id and campaign id are required");
  return join(root, "var/benchmarks/model-tiers", `${tier}gb`, modelId, id);
}

export function selectPilotCases(cases, requestedIds = []) {
  return selectBenchmarkCases(cases, requestedIds.length ? requestedIds : DEFAULT_PILOT_CASE_IDS);
}

export function validateTargetTier(model, tier) {
  if (![8, 16, 24, 32].includes(tier)) throw new Error("tier must be 8, 16, 24, or 32");
  if (!model?.tiers?.includes(tier)) throw new Error(`model ${model?.id ?? "unknown"} is not eligible for the ${tier} GB tier`);
  return tier;
}

const PREFLIGHT_DISK_RESERVE_GB = 2;

function exactModelParts(hf) {
  const separator = String(hf).lastIndexOf(":");
  return { repo: String(hf).slice(0, separator), quant: String(hf).slice(separator + 1) };
}

function formatGB(bytes) {
  const gb = bytes / GIB;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function availableDiskBytes(path) {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * Admission-only checks. This must complete before an Aperio or llama.cpp
 * process is started, so a mismatch cannot become model-behaviour evidence.
 */
export function preflightModelCandidate(model, {
  cacheRoot,
  findCached = findCachedGguf,
  factsFromGguf: readFacts = factsFromGguf,
  diskAvailableBytes,
  diskReserveGB = PREFLIGHT_DISK_RESERVE_GB,
} = {}) {
  const reasons = [];
  const { repo, quant } = exactModelParts(model?.hf);
  if (!repo.includes("/") || !quant) reasons.push(`model must use an exact Hugging Face repo:quant identifier: ${model?.hf ?? "missing"}`);
  if (model?.quant && model.quant.toLowerCase() !== quant.toLowerCase()) {
    reasons.push(`catalog quant ${model.quant} does not match requested ${quant}`);
  }

  let cachedPath = null;
  if (!reasons.length) cachedPath = findCached(model.hf, cacheRoot);
  if (!cachedPath) {
    reasons.push(`${model.hf} is not cached with an exact GGUF candidate`);
  }

  let ggufFacts = null;
  if (cachedPath) {
    const expectedCacheDir = join(cacheRoot, `models--${repo.replaceAll("/", "--")}`);
    const relative = requireRelative(expectedCacheDir, cachedPath);
    if (relative === null) reasons.push(`cached GGUF is outside the exact Hugging Face repository cache: ${repo}`);
    if (!basename(cachedPath).toLowerCase().includes(quant.toLowerCase())) {
      reasons.push(`cached GGUF quantization does not match requested ${quant}`);
    }
    try { ggufFacts = readFacts(cachedPath); } catch { ggufFacts = null; }
    if (!ggufFacts) reasons.push("cached GGUF facts could not be read");
    else if (ggufFacts.source !== "gguf") reasons.push("cached model facts are not sourced from the GGUF header");
  }

  const sizeGB = Number(ggufFacts?.sizeGB ?? model?.sizeGB);
  const requiredGB = sizeGB + Number(diskReserveGB);
  const available = Number(diskAvailableBytes);
  if (Number.isFinite(available) && Number.isFinite(requiredGB) && available < requiredGB * GIB) {
    reasons.push(`insufficient disk space: need ${formatGB(requiredGB * GIB)} GB, have ${formatGB(available)} GB`);
  }

  return {
    status: reasons.length ? "invalid" : "admitted",
    hf: model.hf,
    repo,
    quant,
    cachedGguf: cachedPath ? { path: cachedPath, repo, quant } : null,
    ggufFacts,
    disk: {
      availableGB: Number.isFinite(available) ? Number(formatGB(available)) : null,
      requiredGB: Number.isFinite(requiredGB) ? Number(requiredGB.toFixed(2)) : null,
      reserveGB: Number(diskReserveGB),
    },
    reasons,
  };
}

function requireRelative(root, target) {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  return targetResolved === rootResolved || targetResolved.startsWith(`${rootResolved}/`)
    ? targetResolved.slice(rootResolved.length + 1)
    : null;
}

export function writeInvalidAdmissionRun(path, {
  model, campaignId, targetTierGB, reasons, preflight = null, tierConfiguration = null, tierAdmission = null,
} = {}) {
  const run = {
    pilot: true,
    status: "invalid",
    invalidReason: reasons.join("; "),
    admission: true,
    campaignId,
    targetTierGB,
    tierConfiguration,
    tierPolicy: TIER_POLICY,
    tierAdmission,
    model,
    preflight,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    caseResults: [],
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicJson(path, run);
  return run;
}

export function resolveHostTier(ramGB) {
  const gb = Number(ramGB);
  if (!Number.isFinite(gb) || gb <= 0) throw new Error("host RAM must be a positive number");
  if (gb <= 8) return 8;
  if (gb <= 16) return 16;
  if (gb <= 24) return 24;
  return 32;
}

export function resolveTierConfiguration(targetTier, hostRamGB, facts = {}) {
  const hostTierGB = resolveHostTier(hostRamGB);
  if (![8, 16, 24, 32].includes(targetTier)) throw new Error("tier must be 8, 16, 24, or 32");
  const memoryBudgetGB = targetTier;
  const reserveGB = Math.max(1, targetTier * 0.15);
  const overheadGB = 1;
  const availableGB = memoryBudgetGB - reserveGB - overheadGB - Number(facts.sizeGB || 0);
  const kvBytesPerToken = Number(facts.kvBytesPerToken) > 0 ? Number(facts.kvBytesPerToken) : 172032;
  const fitTokens = availableGB > 0 ? availableGB * GIB / kvBytesPerToken : 2048;
  const maxContext = Number(facts.maxContext) > 0 ? Number(facts.maxContext) : 16384;
  const servedContext = Math.max(2048, Math.floor(Math.min(maxContext, 16384, fitTokens) / 1024) * 1024);
  return {
    targetTierGB: targetTier,
    hostTierGB,
    hostRamGB: Number(hostRamGB),
    memoryBudgetGB,
    reserveGB,
    overheadGB,
    servedContext,
    evidenceMode: targetTier === hostTierGB ? "hardware-tier" : "simulated-tier",
    policy: TIER_POLICY,
  };
}

export function evaluateTierAdmission(targetTier, hostRamGB, facts = {}) {
  const configuration = resolveTierConfiguration(targetTier, hostRamGB, facts);
  const reasons = [];
  const contextGB = configuration.servedContext
    * (Number(facts.kvBytesPerToken) > 0 ? Number(facts.kvBytesPerToken) : 172032) / GIB;
  const configurationRequiredGB = Number(facts.sizeGB || 0)
    + configuration.reserveGB
    + configuration.overheadGB
    + contextGB;

  // A host larger than the requested tier can faithfully simulate the smaller
  // budget (see evidenceMode "simulated-tier"): we cap served context and hold
  // the model to the tier's memory budget below. Only a host too SMALL to
  // physically represent the tier is a hard rejection.
  if (configuration.hostTierGB < targetTier) {
    reasons.push(`host capacity ${configuration.hostRamGB} GB cannot represent the requested ${targetTier} GB tier budget`);
  }
  if (configurationRequiredGB > configuration.memoryBudgetGB) {
    reasons.push(`configuration requires ${formatGB(configurationRequiredGB * GIB)} GB beyond the ${targetTier} GB memory budget`);
  }

  return {
    status: reasons.length ? "invalid" : "admitted",
    admission: reasons.length ? "rejected" : "accepted",
    invalidReason: reasons.length ? reasons.join("; ") : null,
    reasons,
    policy: TIER_POLICY,
    targetTierGB: targetTier,
    hostRamGB: configuration.hostRamGB,
    hostTierGB: configuration.hostTierGB,
    memoryBudgetGB: configuration.memoryBudgetGB,
    configurationRequiredGB: Number(configurationRequiredGB.toFixed(2)),
    configuration,
  };
}

function campaignId(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function freePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

function atomicJson(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

export function copyRuntimeLog(source, target) {
  try {
    copyFileSync(source, target);
    return true;
  } catch {
    return false;
  }
}

async function api(baseURL, path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-aperio-client": "model-tier-bench",
      ...(options.headers ?? {}),
    },
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function connectWhenReady(port, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const handshake = [];
      ws.on("message", raw => handshake.push(JSON.parse(raw.toString())));
      await Promise.race([
        once(ws, "open"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket open timeout")), 3_000)),
      ]);
      while (!handshake.some(message => message.type === "session_created")) {
        await Promise.race([
          once(ws, "message"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("handshake timeout")), 5_000)),
        ]);
      }
      return { ws, handshake };
    } catch (error) {
      try { ws?.terminate(); } catch { /* retry with a fresh socket */ }
      lastError = error;
      await new Promise(resolveWait => setTimeout(resolveWait, 750));
    }
  }
  throw new Error(`Aperio did not become WebSocket-ready: ${lastError?.message ?? "timeout"}`);
}

async function waitForHttpReady(baseURL, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      // The Aperio app serves no /health route (readiness on first boot is the
      // WebSocket session_created handshake); only llama-server exposes /health.
      // Probe /api/metrics — a real app endpoint that returns 200 once routes are
      // mounted — otherwise this polled a 404 for the full window and the retry
      // restart could NEVER complete.
      const response = await fetch(`${baseURL}/api/metrics`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
      lastError = new Error(`/api/metrics returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 750));
  }
  throw new Error(`Aperio did not become HTTP-ready: ${lastError?.message ?? "timeout"}`);
}

export async function modelReady(baseURL, expectedModel, { fetchImpl = fetch } = {}) {
  const health = await fetchImpl(`${baseURL}/health`, { signal: AbortSignal.timeout(3_000) });
  if (!health.ok) throw new Error(`llama.cpp health returned ${health.status}`);
  const response = await fetchImpl(`${baseURL}/v1/models`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`llama.cpp model list returned ${response.status}`);
  const body = await response.json();
  const models = (body?.data ?? []).map(item => item.id);
  if (!models.includes(expectedModel)) throw new Error(`llama.cpp is ready with ${models.join(", ") || "no model"}, not ${expectedModel}`);
  return true;
}

export function runWsCase(ws, caseDef) {
  return new Promise((resolveCase, reject) => {
    const events = [];
    const started = Date.now();
    const timer = setTimeout(() => finish(new Error(`case ${caseDef.id} timed out`)), caseDef.timeoutMs);
    const onMessage = raw => {
      const event = JSON.parse(raw.toString());
      events.push(event);
      if (event.type === "turn_complete" && event.turnId === caseDef.id) finish();
    };
    const onClose = () => finish(new Error(`WebSocket closed during ${caseDef.id}`));
    const onError = error => finish(error);
    function finish(error) {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      if (error) {
        error.caseEvents = events;
        error.durationMs = Date.now() - started;
        reject(error);
      }
      else resolveCase({ events, durationMs: Date.now() - started });
    }
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
    ws.send(JSON.stringify({ type: "chat", text: caseDef.prompt, turnId: caseDef.id }));
  });
}

export async function restoreQualificationState({
  caseDef,
  fixtureContract,
  snapshot,
  restoreDatabase,
  restoreWorkspace,
} = {}) {
  const contract = caseDef?.stateContract;
  if (fixtureContract?.reset?.beforeRetry !== "fresh-session"
    || fixtureContract?.reset?.restore !== "fixture-and-workspace"
    || contract?.reset !== "fresh-session"
    || contract?.restore !== "fixture-and-workspace") {
    throw new Error(`case ${caseDef?.id ?? "unknown"} does not satisfy the retry state contract`);
  }
  if (!snapshot?.database || !snapshot?.workspace) throw new Error("retry state snapshot is incomplete");
  if (typeof restoreDatabase !== "function" || typeof restoreWorkspace !== "function") {
    throw new TypeError("retry state restore callbacks are required");
  }
  await restoreWorkspace(snapshot.workspace);
  await restoreDatabase(snapshot.database);
}

export async function executeBenchmarkCases(cases, {
  runCase,
  verifyCaseState,
  recordEvents = () => {},
  context,
  captureState,
  restoreState,
  createFreshContext,
  disposeContext,
} = {}) {
  if (typeof runCase !== "function") throw new TypeError("runCase is required");
  if (typeof verifyCaseState !== "function") throw new TypeError("verifyCaseState is required");
  const caseResults = [];
  let currentContext = context;

  for (const caseDef of cases) {
    const started = Date.now();
    let events = [];
    let durationMs;
    let eventsRecorded = false;
    let stateSnapshot;
    try {
      stateSnapshot = typeof captureState === "function" ? await captureState(caseDef, currentContext) : undefined;
      const execution = await runCase(caseDef, currentContext);
      events = execution.events;
      durationMs = execution.durationMs;
      eventsRecorded = true;
      recordEvents(caseDef, events, { attempt: 1 });
      const statePassed = await verifyCaseState(caseDef, currentContext);
      const firstResult = {
        durationMs,
        ...evaluateBenchmarkCase(caseDef, events, { statePassed }),
      };
      firstResult.firstAttemptPass = firstResult.status === "pass";
      if (firstResult.status === "fail" && typeof restoreState === "function" && typeof createFreshContext === "function") {
        await restoreState(caseDef, stateSnapshot);
        const retryContext = await createFreshContext(caseDef, { attempt: 2, firstResult });
        currentContext = retryContext;
        try {
          const retryExecution = await runCase(caseDef, retryContext);
          const retryEvents = retryExecution.events;
          recordEvents(caseDef, retryEvents, { attempt: 2 });
          const retryStatePassed = await verifyCaseState(caseDef, retryContext);
          const retryResult = {
            durationMs: retryExecution.durationMs,
            ...evaluateBenchmarkCase(caseDef, retryEvents, { statePassed: retryStatePassed }),
          };
          caseResults.push({
            ...retryResult,
            firstAttemptPass: false,
            retried: true,
            firstAttempt: firstResult,
            retry: retryResult,
          });
        } catch (retryError) {
          const retryEvents = retryError.caseEvents ?? [];
          const retryDurationMs = retryError.durationMs ?? Date.now() - started;
          recordEvents(caseDef, retryEvents, { attempt: 2 });
          caseResults.push({
            ...evaluateBenchmarkCase(caseDef, retryEvents, { statePassed: false }),
            durationMs: retryDurationMs,
            status: "invalid",
            firstAttemptPass: false,
            invalidReason: retryError.message,
            retried: true,
            firstAttempt: firstResult,
            retry: { durationMs: retryDurationMs, status: "invalid", invalidReason: retryError.message },
          });
        } finally {
          try { await disposeContext?.(retryContext); } catch { /* best effort */ }
        }
      } else {
        caseResults.push(firstResult);
      }
    } catch (error) {
      events = error.caseEvents ?? events;
      durationMs = error.durationMs ?? durationMs ?? Date.now() - started;
      if (!eventsRecorded) recordEvents(caseDef, events, { attempt: 1 });
      caseResults.push({
        durationMs,
        ...evaluateBenchmarkCase(caseDef, events, { statePassed: false }),
        status: "invalid",
        invalidReason: error.message,
      });
      error.caseResults = caseResults;
      throw error;
    }
  }
  return caseResults;
}

export async function verifyState(baseURL, assertion, { apiCall = api } = {}) {
  if (!assertion || assertion.kind === "none") return true;
  if (assertion.kind === "memory") {
    const { raw = [] } = await apiCall(baseURL, "/api/memories");
    return raw.some(memory => {
      if (assertion.type && memory.type !== assertion.type) return false;
      const haystack = `${memory.title ?? ""}\n${memory.content ?? ""}`.toLowerCase();
      return (assertion.contentIncludes ?? []).every(term => haystack.includes(String(term).toLowerCase()));
    });
  }
  if (assertion.kind === "wiki") {
    const query = encodeURIComponent(assertion.query);
    const { articles = [] } = await apiCall(baseURL, `/api/wiki/search?q=${query}&mode=fulltext&limit=25`);
    return articles.length >= (assertion.minimumMatches ?? 1);
  }
  return false;
}

export async function importQualificationFixture(baseURL, fixture, {
  request = api,
  now = Date.now,
} = {}) {
  const expectedMemoryCount = 28;
  if (fixture?.memories?.length !== expectedMemoryCount) {
    throw new Error(`qualification fixture must contain exactly ${expectedMemoryCount} memories`);
  }
  const startedAt = now();
  const imported = await request(baseURL, "/api/memories/import", {
    method: "POST",
    body: JSON.stringify(fixture),
  });
  if (imported.imported !== expectedMemoryCount || imported.errors?.length) {
    throw new Error(`fixture import failed: ${JSON.stringify(imported)}`);
  }
  return {
    status: "imported",
    memoryCount: imported.imported,
    durationMs: Math.max(0, now() - startedAt),
  };
}

export async function waitForFixture(baseURL, expected = 28, timeoutMs = 180_000, {
  request = api,
  sleep = resolveWait => new Promise(resolveWaitPromise => setTimeout(resolveWaitPromise, resolveWait)),
  now = Date.now,
} = {}) {
  const startedAt = now();
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const { raw = [] } = await request(baseURL, "/api/memories");
    const tagged = raw.filter(memory => Array.isArray(memory.tags) && memory.tags.includes("aperio-exam"));
    if (tagged.length === expected) {
      const metrics = await request(baseURL, "/api/metrics");
      if (metrics.memories_total >= expected && metrics.embedding_queue_size === 0) {
        return {
          status: "ready",
          expectedMemoryCount: expected,
          taggedMemoryCount: tagged.length,
          embeddingQueueSize: metrics.embedding_queue_size,
          durationMs: Math.max(0, now() - startedAt),
        };
      }
    }
    await sleep(1_000);
  }
  throw new Error(`fixture did not reach exactly ${expected} tagged memories`);
}

export function beginQualificationMeasurement(metrics, readiness) {
  if (readiness?.status !== "ready" || readiness.embeddingQueueSize !== 0) {
    throw new Error("cannot begin qualification measurement before embedding readiness");
  }
  return metrics.beginQualification();
}

// Poll the codegraph/docgraph status endpoints until both finish their initial
// index. The watchers index in the background after boot, so the search tools
// have no data until the pass reaches `ready`. `error` is terminal too: we stop
// waiting and let the dependent cases fail as visible evidence. `idle` is not
// accepted — with both subsystems enabled on a seeded SQLite workspace each
// graph must reach `ready`; a stuck `idle` means a real misconfiguration and
// should surface as a timeout rather than a silent no-data pass.
async function waitForGraphs(baseURL, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(["ready", "error"]);
  for (const kind of ["codegraph", "docgraph"]) {
    let phase = "indexing";
    while (Date.now() < deadline) {
      phase = (await api(baseURL, `/api/${kind}/status`))?.phase ?? "idle";
      if (terminal.has(phase)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
    }
    if (!terminal.has(phase)) throw new Error(`${kind} did not finish indexing within ${timeoutMs}ms (phase: ${phase})`);
  }
}

function readSwapBytes() {
  try {
    if (process.platform === "darwin") {
      const text = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" });
      const match = text.match(/used\s*=\s*([\d.]+)([MG])?/i);
      if (!match) return null;
      return Number(match[1]) * (match[2]?.toUpperCase() === "G" ? GIB : 1024 ** 2);
    }
    if (process.platform === "linux") {
      const text = readFileSync("/proc/meminfo", "utf8");
      const total = Number(text.match(/^SwapTotal:\s+(\d+)/m)?.[1]);
      const free = Number(text.match(/^SwapFree:\s+(\d+)/m)?.[1]);
      return Number.isFinite(total) && Number.isFinite(free) ? (total - free) * 1024 : null;
    }
  } catch { /* unavailable metric */ }
  return null;
}

function rssBytes(pid) {
  if (!pid) return 0;
  try {
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024 || 0;
  } catch { return 0; }
}

function processTreeRssBytes(rootPid) {
  if (!rootPid) return 0;
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim().split("\n").map(line => line.trim().split(/\s+/).map(Number))
      .filter(([pid, ppid, rss]) => Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rss));
    const owned = new Set([Number(rootPid)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of rows) {
        if (owned.has(ppid) && !owned.has(pid)) { owned.add(pid); changed = true; }
      }
    }
    return rows.filter(([pid]) => owned.has(pid)).reduce((sum, row) => sum + row[2] * 1024, 0);
  } catch { return 0; }
}

function readLlamaPid(tempDir) {
  try { return JSON.parse(readFileSync(join(tempDir, "var/llamacpp/state.json"), "utf8")).pid ?? null; }
  catch { return null; }
}

function startMetrics(serverPid, tempDir) {
  let phase = "load";
  let baseline = { usedRamBytes: os.totalmem() - os.freemem(), swapBytes: readSwapBytes(), phase };
  const samples = [];
  const sample = () => samples.push({
    at: new Date().toISOString(),
    phase,
    usedRamBytes: os.totalmem() - os.freemem(),
    aperioRssBytes: rssBytes(typeof serverPid === "function" ? serverPid() : serverPid),
    llamaRssBytes: processTreeRssBytes(readLlamaPid(tempDir)),
    swapBytes: readSwapBytes(),
  });
  sample();
  const timer = setInterval(sample, 1_000);
  const finish = () => {
    const max = key => Math.max(0, ...samples.map(item => item[key] ?? 0));
    return {
      baseline,
      peakUsedRamBytes: max("usedRamBytes"),
      peakAperioRssBytes: max("aperioRssBytes"),
      peakLlamaRssBytes: max("llamaRssBytes"),
      peakSwapBytes: samples.some(item => item.swapBytes != null) ? max("swapBytes") : null,
      swapDeltaBytes: baseline.swapBytes == null ? null : Math.max(0, max("swapBytes") - baseline.swapBytes),
      samples: [...samples],
    };
  };
  return {
    beginQualification() {
      const load = finish();
      phase = "qualification";
      samples.length = 0;
      baseline = { usedRamBytes: os.totalmem() - os.freemem(), swapBytes: readSwapBytes(), phase };
      sample();
      return load;
    },
    stop() {
      clearInterval(timer);
      sample();
      return finish();
    },
  };
}

export function createMetricReport(load, qualification) {
  const normalizedQualification = qualification?.baseline
    ? qualification
    : { ...qualification, baseline: qualification?.samples?.[0] ?? null };
  return { load, qualification: normalizedQualification };
}

function ledgerOffset(path) {
  try { return { path, offset: statSync(path).size, exists: true }; }
  catch { return { path, offset: 0, exists: false }; }
}

export function captureLedgerOffsets(paths = {}) {
  return {
    events: ledgerOffset(paths.events),
    failures: ledgerOffset(paths.failures),
  };
}

export function sliceLedger(path, start, destination) {
  const startOffset = Number(start?.offset ?? start ?? 0);
  let endOffset = startOffset;
  let appended = Buffer.alloc(0);
  try {
    const source = readFileSync(path);
    endOffset = source.length;
    if (endOffset > startOffset) appended = source.subarray(startOffset);
  } catch { /* a ledger may never be created during a run */ }
  if (appended.length > 0) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, appended, { mode: 0o600 });
  }
  return {
    path,
    destination,
    startOffset,
    endOffset,
    bytesCopied: appended.length,
    rowsCopied: appended.toString("utf8").split("\n").filter(Boolean).length,
    exists: endOffset > 0,
    rows: appended.toString("utf8").split("\n").filter(Boolean),
  };
}

function ledgerRows(value) {
  const lines = Array.isArray(value) ? value : String(value ?? "").split("\n");
  return lines
    .flatMap(line => String(line).split("\n"))
    .map(line => line.trimEnd())
    .filter(line => line && !line.startsWith("ts\t"));
}

export function summarizeToolQuality({ events = [], toolRepairRows = [], toolFailureRows = [], caseResults = [] } = {}) {
  const toolStarts = events.filter(event => event?.type === "tool_start");
  const toolResults = events.filter(event => event?.type === "tool_result");
  const repairRows = ledgerRows(toolRepairRows);
  const failureRows = ledgerRows(toolFailureRows);
  const persistentFailures = failureRows.filter(row => row.split("\t")[3] === "1").length;
  const completedCases = caseResults.filter(result => result?.status === "pass" || result?.status === "fail").length;
  return {
    toolAttempts: toolStarts.length,
    malformedFirstAttempts: repairRows.length,
    firstAttemptValidity: toolStarts.length === 0
      ? null
      : (toolStarts.length - repairRows.length) / toolStarts.length,
    persistentFailures,
    completedCases,
    persistentFailureRate: completedCases === 0 ? null : persistentFailures / completedCases,
    successfulToolResults: toolResults.filter(event => event.ok === true).length,
    toolResults: toolResults.length,
    toolExecutionSuccess: toolResults.length === 0
      ? null
      : toolResults.filter(event => event.ok === true).length / toolResults.length,
  };
}

async function closeWebSocket(ws, timeoutMs = 5_000) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close").catch(() => {});
  ws.close();
  await Promise.race([closed, new Promise(resolveWait => setTimeout(resolveWait, timeoutMs))]);
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
}

async function stopChild(child, timeoutMs = 15_000) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise(resolveWait => setTimeout(resolveWait, timeoutMs)),
  ]);
  if (child.exitCode == null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
  }
}

async function stopOwnedPid(pid) {
  if (!pid || pid <= 0) return;
  const descendants = new Set([pid]);
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
      .trim().split("\n")
      .map(line => line.trim().split(/\s+/).map(Number))
      .filter(([childPid, parentPid]) => Number.isFinite(childPid) && Number.isFinite(parentPid));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [childPid, parentPid] of rows) {
        if (descendants.has(parentPid) && !descendants.has(childPid)) {
          descendants.add(childPid);
          changed = true;
        }
      }
    }
  } catch { /* fall back to the process-group sweep below */ }

  try { process.kill(-pid, "SIGTERM"); } catch { /* group may not be available */ }
  for (const childPid of [...descendants].reverse()) {
    try { process.kill(childPid, "SIGTERM"); } catch { /* already gone */ }
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  try { process.kill(-pid, "SIGKILL"); } catch { /* group may not be available */ }
  for (const childPid of [...descendants].reverse()) {
    try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
  }
}

export async function teardownOwnedProcesses(processes) {
  for (const owned of processes ?? []) {
    try { await owned?.stop?.(); } catch { /* continue teardown for every owned process */ }
  }
}

// Every PID currently listening on `port`, group-killable via stopOwnedPid.
// Mirrors findLlamaCppPidOnPort in startLlamaCpp.js. The ephemeral llama port is
// unique to this run, so whatever holds it is ours to reap — this catches a
// leaked router whose PID we never recorded (e.g. an in-app restart that
// overwrote state.json). Best-effort: returns [] when lsof/netstat is missing.
export function pidsOnPort(port) {
  if (!port) return [];
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const needle = `:${port}`;
      const pids = new Set();
      for (const line of out.split("\n")) {
        if (!line.includes(needle) || !/LISTENING/i.test(line)) continue;
        const pid = Number(line.trim().split(/\s+/).at(-1));
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    const out = execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(out.trim().split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  } catch { return []; }
}

export async function stopRunnerProcesses({ child, llamaPid, llamaPids, llamaPort, stopChildFn = stopChild, stopLlamaFn = stopOwnedPid, pidsOnPortFn = pidsOnPort } = {}) {
  // Reap the llama process group(s) before stopping Node: Aperio's graceful
  // shutdown clears state.json as soon as it tears the engine down, and stopping
  // the detached llama workers first keeps them from surviving the app process.
  //
  // Sweep the union of EVERY llama PID we ever observed plus whatever still holds
  // the ephemeral llama port — in-run restarts (Compute-error recovery, retries)
  // leave earlier router groups that state.json no longer names, and those are
  // exactly the copies that stack up across runs until the machine swaps.
  const pids = new Set();
  for (const pid of llamaPids ?? []) if (pid) pids.add(pid);
  if (llamaPid) pids.add(llamaPid);
  for (const pid of pidsOnPortFn(llamaPort)) pids.add(pid);
  await teardownOwnedProcesses([
    ...[...pids].map(pid => ({ stop: () => stopLlamaFn(pid) })),
    { stop: () => stopChildFn(child) },
  ]);
}

// The bench's `finally` block does NOT run when the process is killed by a
// signal (Ctrl+C / SIGTERM), which is exactly when a user abandons a run
// mid-flight — the point where leaked engines pile up. Register a handler that
// runs the same teardown, then exits with the conventional 128+signal code so
// the abort still looks like an abort to the caller. Cleanup failures must never
// wedge the exit.
export function registerRunnerCleanup({
  signals = ["SIGINT", "SIGTERM", "SIGHUP"],
  cleanup,
  exit = code => process.exit(code),
  on = (signal, handler) => process.on(signal, handler),
} = {}) {
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const signal of signals) {
    on(signal, async () => {
      try { await cleanup(signal); } catch { /* still exit below */ }
      exit(codes[signal] ?? 143);
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const models = validateBenchmarkModels(readJson(args.modelsPath ?? DEFAULT_MODELS));
  const allCases = validateBenchmarkCases(readJson(args.casesPath ?? DEFAULT_CASES));
  validateQualificationSuite(allCases);
  const cases = selectPilotCases(allCases, args.caseIds);
  const fixture = readJson(FIXTURE);
  const fixtureContract = readJson(FIXTURE_CONTRACT);
  const fixtureSummary = validateQualificationFixture(fixture, fixtureContract);
  if (args.validate) {
    console.log(`Validated ${models.length} model(s) and ${cases.length} case(s).`);
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
  const ggufPath = preflight.cachedGguf.path;
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
  const fixtureVersion = createHash("sha256").update(readFileSync(FIXTURE)).digest("hex");
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
    await waitForHttpReady(baseURL);
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
