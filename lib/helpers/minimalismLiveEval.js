// Isolation and lifecycle primitives for live minimalism-bench runs.
//
// The benchmark owns a short-lived llama-server child. Its cwd is a temporary
// directory, so startLlamaCpp's deliberately relative runtime paths cannot
// touch Aperio's normal var/ tree.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LIVE_EVAL_PORT = "18080";
export const LIVE_EVAL_BASE_URL = `http://127.0.0.1:${LIVE_EVAL_PORT}`;
export const LIVE_EVAL_LEDGER_ROOT = join(tmpdir(), "aperio-minimalism-ledgers");

function safeModelName(model) {
  return String(model).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "model";
}

export function createLiveEvalPaths(model, { tempRoot = tmpdir(), ledgerRoot = LIVE_EVAL_LEDGER_ROOT } = {}) {
  const runtimeRoot = mkdtempSync(join(tempRoot, "aperio-minimalism-live-"));
  mkdirSync(ledgerRoot, { recursive: true, mode: 0o700 });
  const ledgerPath = join(ledgerRoot, `${safeModelName(model)}-${Date.now()}-${process.pid}.tsv`);
  return { runtimeRoot, ledgerPath };
}

function modelIsPresent(data, requestedModel) {
  const entries = Array.isArray(data?.data) ? data.data : [];
  return entries.some(entry => entry?.id === requestedModel ||
    (entry?.id === "aperio-main" && (!entry?.hf_repo || entry.hf_repo === requestedModel)));
}

/** Wait for both the HTTP health endpoint and the exact requested preset model. */
export async function waitForLlamaReadiness({
  baseURL = LIVE_EVAL_BASE_URL,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  pollMs = 250,
} = {}) {
  if (!model) throw new Error("live eval requires a requested model");
  const deadline = Date.now() + timeoutMs;
  let lastReason = "not checked";
  while (Date.now() < deadline) {
    try {
      const health = await fetchImpl(`${baseURL}/health`, { signal: AbortSignal.timeout(1000) });
      if (!health.ok) {
        lastReason = `/health returned ${health.status}`;
      } else {
        const models = await fetchImpl(`${baseURL}/v1/models`, { signal: AbortSignal.timeout(1000) });
        if (!models.ok) lastReason = `/v1/models returned ${models.status}`;
        else if (modelIsPresent(await models.json(), model)) return { baseURL, model, ready: true };
        else lastReason = `requested model is unavailable: ${model}`;
      }
    } catch (error) {
      lastReason = error?.message || String(error);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`llama-server readiness failed for ${model}: ${lastReason}`);
}

export function assertLiveUsage(row) {
  if (Number(row?.input_tokens) === 0 && Number(row?.output_tokens) === 0) {
    throw new Error(`live eval invalid: zero token usage in ${row.task}/${row.arm}/repeat-${row.repeat}`);
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

/** Stop only the evaluator-owned child and remove its temporary runtime root. */
export async function teardownLiveEval(handle, { kill = process.kill, timeoutMs = 7_000 } = {}) {
  if (!handle) return;
  try {
    if (handle.child && handle.child.exitCode === null && !handle.child.signalCode) {
      kill(handle.child.pid, "SIGTERM");
      await waitForExit(handle.child, timeoutMs);
      if (handle.child.exitCode === null && !handle.child.signalCode) kill(handle.child.pid, "SIGKILL");
    }
  } finally {
    if (handle.runtimeRoot && existsSync(handle.runtimeRoot)) rmSync(handle.runtimeRoot, { recursive: true, force: true });
  }
}

export function startIsolatedLlamaEval({ model, paths, env = process.env, bootstrapPath, spawnImpl = spawn }) {
  if (!model || !paths?.runtimeRoot || !bootstrapPath) throw new Error("invalid live eval startup configuration");
  const child = spawnImpl(process.execPath, [bootstrapPath], {
    cwd: paths.runtimeRoot,
    env: {
      ...env,
      AI_PROVIDER: "llamacpp",
      LLAMACPP_MODEL: model,
      LLAMACPP_PORT: LIVE_EVAL_PORT,
      LLAMACPP_BASE_URL: LIVE_EVAL_BASE_URL,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { child, runtimeRoot: paths.runtimeRoot, ledgerPath: paths.ledgerPath };
}
