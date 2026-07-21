import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { GIB } from "./constants.js";

export function copyRuntimeLog(source, target) {
  try {
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    return true;
  } catch {
    return false;
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

export function readLlamaPid(tempDir) {
  try { return JSON.parse(readFileSync(join(tempDir, "var/llamacpp/state.json"), "utf8")).pid ?? null; }
  catch { return null; }
}

export function startMetrics(serverPid, tempDir) {
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

  // The app can finish a graceful shutdown/restart race by publishing a new
  // router after the initial port sweep (observed during retry recovery). Do
  // one final sweep after the Node process is stopped so a newly published
  // llama listener cannot survive the runner's finally block.
  const latePids = pidsOnPortFn(llamaPort).filter(pid => !pids.has(pid));
  if (latePids.length) {
    await teardownOwnedProcesses(latePids.map(pid => ({ stop: () => stopLlamaFn(pid) })));
  }
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
