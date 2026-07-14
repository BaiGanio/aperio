#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { findCachedGguf, factsFromGguf } from "../lib/helpers/ggufModelFacts.js";
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
const DEFAULT_MODELS = join(ROOT, "benchmarks/model-tiers/models.json");
const DEFAULT_CASES = join(ROOT, "benchmarks/model-tiers/cases.json");
const FIXTURE = join(ROOT, ".github/capability-exam/exam.memories.json");
const FIXTURE_CONTRACT = join(ROOT, "benchmarks/model-tiers/fixture-contract.json");
const WORKSPACE_FIXTURE = join(ROOT, "benchmarks/model-tiers/workspace");
const GIB = 1024 ** 3;
export const TIER_POLICY = "RAM <= 8 => 8 GB; RAM <= 16 => 16 GB; RAM <= 24 => 24 GB; RAM > 24 => 32 GB";

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
    "This is a qualification runner. Its 14-case suite validates model behavior;",
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

export function validateTargetTier(model, tier) {
  if (![8, 16, 24, 32].includes(tier)) throw new Error("tier must be 8, 16, 24, or 32");
  if (!model?.tiers?.includes(tier)) throw new Error(`model ${model?.id ?? "unknown"} is not eligible for the ${tier} GB tier`);
  return tier;
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

export async function executeBenchmarkCases(cases, {
  runCase,
  verifyCaseState,
  recordEvents = () => {},
} = {}) {
  if (typeof runCase !== "function") throw new TypeError("runCase is required");
  if (typeof verifyCaseState !== "function") throw new TypeError("verifyCaseState is required");
  const caseResults = [];

  for (const caseDef of cases) {
    const started = Date.now();
    let events = [];
    let durationMs;
    let eventsRecorded = false;
    try {
      const execution = await runCase(caseDef);
      events = execution.events;
      durationMs = execution.durationMs;
      eventsRecorded = true;
      recordEvents(caseDef, events);
      const statePassed = await verifyCaseState(caseDef);
      caseResults.push({
        durationMs,
        ...evaluateBenchmarkCase(caseDef, events, { statePassed }),
      });
    } catch (error) {
      events = error.caseEvents ?? events;
      durationMs = error.durationMs ?? durationMs ?? Date.now() - started;
      if (!eventsRecorded) recordEvents(caseDef, events);
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

async function verifyState(baseURL, assertion) {
  if (!assertion || assertion.kind === "none") return true;
  if (assertion.kind === "memory") {
    const { raw = [] } = await api(baseURL, "/api/memories");
    return raw.some(memory => {
      if (assertion.type && memory.type !== assertion.type) return false;
      const haystack = `${memory.title ?? ""}\n${memory.content ?? ""}`.toLowerCase();
      return (assertion.contentIncludes ?? []).every(term => haystack.includes(String(term).toLowerCase()));
    });
  }
  return false;
}

async function waitForFixture(baseURL, expected = 28, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { raw = [] } = await api(baseURL, "/api/memories");
    const tagged = raw.filter(memory => Array.isArray(memory.tags) && memory.tags.includes("aperio-exam"));
    if (tagged.length === expected) {
      const metrics = await api(baseURL, "/api/metrics");
      if (metrics.memories_total >= expected && metrics.embedding_queue_size === 0) return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`fixture did not reach exactly ${expected} tagged memories`);
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
    aperioRssBytes: rssBytes(serverPid),
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
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { return; } }
  await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

export async function teardownOwnedProcesses(processes) {
  for (const owned of processes ?? []) {
    try { await owned?.stop?.(); } catch { /* continue teardown for every owned process */ }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const models = validateBenchmarkModels(readJson(args.modelsPath ?? DEFAULT_MODELS));
  const allCases = validateBenchmarkCases(readJson(args.casesPath ?? DEFAULT_CASES));
  validateQualificationSuite(allCases);
  const cases = selectBenchmarkCases(allCases, args.caseIds);
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

  const cacheRoot = resolveModelCacheDir(process.env);
  const discoveredGguf = findCachedGguf(model.hf, cacheRoot);
  const requestedQuant = model.hf.split(":")[1]?.toLowerCase();
  const ggufPath = discoveredGguf && (!requestedQuant || basename(discoveredGguf).toLowerCase().includes(requestedQuant))
    ? discoveredGguf
    : null;
  if (!ggufPath && !args.allowDownload) {
    throw new Error(`${model.hf} is not cached; pass --allow-download to permit a network download`);
  }
  const facts = ggufPath ? factsFromGguf(ggufPath) : null;
  const hostRamGB = Number((os.totalmem() / GIB).toFixed(2));
  const tierConfiguration = resolveTierConfiguration(args.tier, hostRamGB, facts ?? {});
  const id = args.campaignId ?? campaignId();
  const modelDir = resolveBenchmarkArtifactDir(ROOT, args.tier, model.id, id);
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
  const child = spawn(process.execPath, [join(ROOT, "server.js")], {
    cwd: tempDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(applicationLog, { end: false });
  child.stderr.pipe(applicationLog, { end: false });
  const metrics = startMetrics(child.pid, tempDir);
  let connection;
  let sessionId;
  let run;
  let transcript;
  let loadMetrics;
  const ownedLlamaPid = () => readLlamaPid(tempDir);
  let caseResults = [];
  try {
    connection = await connectWhenReady(appPort);
    const provider = connection.handshake.find(message => message.type === "provider");
    sessionId = connection.handshake.find(message => message.type === "session_created")?.id;
    if (provider?.name !== "llamacpp" || provider?.model !== model.hf) {
      throw new Error(`invalid run: requested ${model.hf}, active provider is ${provider?.name}:${provider?.model}`);
    }
    if (provider.toolEligible !== true) throw new Error("invalid run: active model has no tool surface");

    await modelReady(`http://127.0.0.1:${llamaPort}`, model.hf);

    const localBench = await runBenchmark({
      baseURL: `http://127.0.0.1:${llamaPort}`,
      model: model.hf,
      profile: "balanced",
      servedCtx: tierConfiguration.servedContext,
    });
    atomicJson(join(modelDir, "local-bench.json"), localBench);

    const imported = await api(baseURL, "/api/memories/import", { method: "POST", body: JSON.stringify(fixture) });
    if (imported.imported !== 28 || imported.errors?.length) throw new Error(`fixture import failed: ${JSON.stringify(imported)}`);
    await waitForFixture(baseURL);
    // Let the code/doc graphs finish indexing the seeded workspace before the
    // qualification window opens, so the search tools have data and index CPU
    // lands in the load phase rather than skewing per-case timing.
    await waitForGraphs(baseURL);
    loadMetrics = metrics.beginQualification();

    transcript = createWriteStream(join(modelDir, "transcript.jsonl"), { mode: 0o600 });
    caseResults = await executeBenchmarkCases(cases, {
      runCase: caseDef => runWsCase(connection.ws, caseDef),
      verifyCaseState: caseDef => verifyState(baseURL, caseDef.stateAssertion),
      recordEvents: (caseDef, events) => {
        for (const event of events) transcript.write(JSON.stringify({ caseId: caseDef.id, ...event }) + "\n");
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
    const llamaPid = ownedLlamaPid();
    await teardownOwnedProcesses([
      { stop: () => stopChild(child) },
      { stop: () => stopOwnedPid(llamaPid) },
    ]);
    const measured = createMetricReport(loadMetrics ?? measuredQualification, loadMetrics ? measuredQualification : measuredQualification);
    applicationLog.end();
    rmSync(tempDir, { recursive: true, force: true });
    if (run) {
      run.metrics = measured;
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
