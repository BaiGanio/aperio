#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODELS = join(ROOT, "benchmarks/model-tiers/models.json");
const DEFAULT_CASES = join(ROOT, "benchmarks/model-tiers/cases.json");
const FIXTURE = join(ROOT, ".github/capability-exam/exam.memories.json");
const GIB = 1024 ** 3;

export function parseArgs(argv) {
  const out = { caseIds: [], validate: false, allowDownload: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") out.modelId = argv[++i];
    else if (arg === "--case") out.caseIds.push(argv[++i]);
    else if (arg === "--models") out.modelsPath = resolve(argv[++i]);
    else if (arg === "--cases") out.casesPath = resolve(argv[++i]);
    else if (arg === "--campaign") out.campaignId = argv[++i];
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
    "This is a pilot qualification runner. Its three cases validate the harness;",
    "results are not sufficient to select installer defaults.",
    "",
    "Options:",
    "  --case <id>         Run one case (repeatable)",
    "  --allow-download    Permit llama.cpp to download an uncached GGUF",
    "  --campaign <id>     Override the UTC campaign id",
    "  --note <text>        Record an environment caveat on the run",
    "  --validate          Validate model/case files without starting processes",
  ].join("\n");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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
    if (tagged.length === expected) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`fixture did not reach exactly ${expected} tagged memories`);
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
  const baseline = { usedRamBytes: os.totalmem() - os.freemem(), swapBytes: readSwapBytes() };
  const samples = [];
  const sample = () => samples.push({
    at: new Date().toISOString(),
    usedRamBytes: os.totalmem() - os.freemem(),
    aperioRssBytes: rssBytes(serverPid),
    llamaRssBytes: processTreeRssBytes(readLlamaPid(tempDir)),
    swapBytes: readSwapBytes(),
  });
  sample();
  const timer = setInterval(sample, 1_000);
  return {
    stop() {
      clearInterval(timer);
      sample();
      const max = key => Math.max(0, ...samples.map(item => item[key] ?? 0));
      return {
        baseline,
        peakUsedRamBytes: max("usedRamBytes"),
        peakAperioRssBytes: max("aperioRssBytes"),
        peakLlamaRssBytes: max("llamaRssBytes"),
        peakSwapBytes: samples.some(item => item.swapBytes != null) ? max("swapBytes") : null,
        swapDeltaBytes: baseline.swapBytes == null ? null : Math.max(0, max("swapBytes") - baseline.swapBytes),
        samples,
      };
    },
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const models = validateBenchmarkModels(readJson(args.modelsPath ?? DEFAULT_MODELS));
  const cases = selectBenchmarkCases(validateBenchmarkCases(readJson(args.casesPath ?? DEFAULT_CASES)), args.caseIds);
  if (args.validate) {
    console.log(`Validated ${models.length} model(s) and ${cases.length} case(s).`);
    return;
  }
  if (!args.modelId) throw new Error("--model is required\n\n" + usage());
  const model = models.find(item => item.id === args.modelId);
  if (!model) throw new Error(`unknown model id: ${args.modelId}`);

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
  const id = args.campaignId ?? campaignId();
  const campaignDir = join(ROOT, "var/benchmarks/model-tiers", id);
  const modelDir = join(campaignDir, model.id);
  mkdirSync(modelDir, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(join(os.tmpdir(), `aperio-model-tier-${model.id}-`));
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
    LLAMACPP_SERVE_CTX: "16384",
    LLAMACPP_CTX: "16384",
    LLAMACPP_PORT: String(llamaPort),
    LLAMACPP_BASE_URL: `http://127.0.0.1:${llamaPort}`,
    PORT: String(appPort),
    HOST: "127.0.0.1",
    DB_BACKEND: "sqlite",
    SQLITE_PATH: join(tempDir, "aperio.db"),
    APERIO_CONFIG_PRECEDENCE: "env",
    APERIO_CODEGRAPH: "off",
    APERIO_DOCGRAPH: "off",
    APERIO_ENABLE_SHELL: "off",
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
  let caseResults = [];
  try {
    connection = await connectWhenReady(appPort);
    const provider = connection.handshake.find(message => message.type === "provider");
    sessionId = connection.handshake.find(message => message.type === "session_created")?.id;
    if (provider?.name !== "llamacpp" || provider?.model !== model.hf) {
      throw new Error(`invalid run: requested ${model.hf}, active provider is ${provider?.name}:${provider?.model}`);
    }
    if (provider.toolEligible !== true) throw new Error("invalid run: active model has no tool surface");

    const localBench = await runBenchmark({
      baseURL: `http://127.0.0.1:${llamaPort}`,
      model: model.hf,
      profile: "balanced",
      servedCtx: 16384,
    });
    atomicJson(join(modelDir, "local-bench.json"), localBench);

    const fixture = readJson(FIXTURE);
    const imported = await api(baseURL, "/api/memories/import", { method: "POST", body: JSON.stringify(fixture) });
    if (imported.imported !== 28 || imported.errors?.length) throw new Error(`fixture import failed: ${JSON.stringify(imported)}`);
    await waitForFixture(baseURL);

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
      qualificationSuiteVersion: "pilot-1",
      environmentNote: args.environmentNote ?? null,
      campaignId: id,
      model,
      factsSource: facts ? "gguf" : "catalog",
      ggufFacts: facts,
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      hardware: os.cpus()[0]?.model ?? "unknown",
      ramGB: Number((os.totalmem() / GIB).toFixed(2)),
      profile: "balanced",
      servedContext: 16384,
      fixtureVersion,
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
      qualificationSuiteVersion: "pilot-1",
      environmentNote: args.environmentNote ?? null,
      campaignId: id,
      model,
      factsSource: facts ? "gguf" : "catalog",
      ggufFacts: facts,
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      hardware: os.cpus()[0]?.model ?? "unknown",
      ramGB: Number((os.totalmem() / GIB).toFixed(2)),
      profile: "balanced",
      servedContext: 16384,
      fixtureVersion,
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
    await stopChild(child);
    const measured = metrics.stop();
    applicationLog.end();
    try {
      const llamaLog = join(tempDir, "var/llamacpp/server.log");
      if (existsSync(llamaLog)) writeFileSync(join(modelDir, "llamacpp.log"), readFileSync(llamaLog), { mode: 0o600 });
    } catch { /* optional diagnostic */ }
    rmSync(tempDir, { recursive: true, force: true });
    if (run) {
      run.metrics = measured;
      atomicJson(join(modelDir, "run.json"), run);
      writeFileSync(join(modelDir, "cases.jsonl"), run.caseResults.map(item => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
      const metricHeader = "at,usedRamBytes,aperioRssBytes,llamaRssBytes,swapBytes\n";
      const metricRows = measured.samples.map(sample => [
        sample.at, sample.usedRamBytes, sample.aperioRssBytes, sample.llamaRssBytes, sample.swapBytes ?? "",
      ].join(",")).join("\n");
      writeFileSync(join(modelDir, "metrics.csv"), metricHeader + metricRows + "\n", { mode: 0o600 });
      atomicJson(join(campaignDir, "campaign.json"), {
        campaignId: id,
        pilot: true,
        warning: "Pilot harness evidence is not sufficient to select installer defaults.",
        modelIds: [model.id],
        qualificationSuiteVersion: "pilot-1",
        fixtureVersion,
        profile: "balanced",
        servedContext: 16384,
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
