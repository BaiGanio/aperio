// src/providers/llama-launcher.js - start, watch and stop the one llama-server
// the app owns (spec S2.5, launcher 1-6 + the thread rule).
//
// Kept from v1 (lib/helpers/startLlamaCpp.js at archive/v1-final) as behaviour:
// fail closed when the port is taken; unlink the log before creating it (v1
// NUL-hole bug); `--jinja --parallel 1`.
// Dropped: router mode, models.ini presets, VLM, perf profiles, PID / state.json
// adoption, detached processes, RAM-fit context sizing (measured 10x off, L-M09).
// Changed: context = min(LLAMACPP_SERVE_CTX, header); the budget gets the n_ctx
// the server REPORTS (L-M08). Threads leave room for the embedder (S2.4).
// All async (AP4). Config comes in as an argument (AP1). No module state.

import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { access, constants, mkdir, open, unlink } from 'node:fs/promises';
import { availableParallelism as osParallelism, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findCachedGguf, resolveCacheRoot } from './gguf-cache.js';
import { readGgufHeader, capabilitiesFromHeader } from './gguf-header.js';

const BINARY = 'llama-server';
const HOST = '127.0.0.1';
const DEFAULT_LOG = 'var/logs/llama-server.log';
const POLL_MS = 250;
const STOP_GRACE_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;

export class LlamaStartError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'LlamaStartError';
    this.code = code;
  }
}

/** @param {{ cap: number, headerContext: number | null }} o */
export function pickContext({ cap, headerContext }) {
  return headerContext && headerContext > 0 ? Math.min(cap, headerContext) : cap;
}

/** @param {{ configured: number, perfCores: number, embeddingThreads: number }} o */
export function pickThreads({ configured, perfCores, embeddingThreads }) {
  if (Number.isInteger(configured) && configured > 0) return configured;
  return Math.max(1, perfCores - embeddingThreads);
}

const execFileAsync = promisify(execFile);
/** @param {string} cmd @param {string[]} args */
const runCommand = async (cmd, args) => (await execFileAsync(cmd, args, { timeout: PROBE_TIMEOUT_MS })).stdout;

/**
 * Performance cores: on macOS from sysctl (efficiency cores keep the event
 * loop), elsewhere every core Node may use.
 * @param {{ platform?: string, run?: (cmd: string, args: string[]) => Promise<string>, availableParallelism?: () => number }} [o]
 */
export async function detectPerfCores({ platform = process.platform, run = runCommand, availableParallelism = osParallelism } = {}) {
  if (platform === 'darwin') {
    try {
      const n = Number.parseInt(String(await run('sysctl', ['-n', 'hw.perflevel0.physicalcpu'])).trim(), 10);
      if (Number.isInteger(n) && n > 0) return n;
    } catch {
      return availableParallelism(); // no perflevels on this Mac (Intel): every core
    }
  }
  return availableParallelism();
}

/** @param {{ ggufPath: string, ctx: number, threads: number, port: number }} o */
export function buildServerArgs({ ggufPath, ctx, threads, port }) {
  return [
    '-m', ggufPath, '--jinja', '--parallel', '1', '-c', String(ctx),
    '-t', String(threads), '-tb', String(threads), '--host', HOST, '--port', String(port),
  ];
}

/** LLAMACPP_VENDOR_DIR first (decision 5), else the bare name so spawn uses PATH. */
export async function resolveBinary({ vendorDir }) {
  if (vendorDir) {
    const p = join(resolve(vendorDir), BINARY);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      return BINARY; // not in the vendor dir: PATH is the documented fallback
    }
  }
  return BINARY;
}

/** @param {number} ms @param {(wake: () => void) => void} [hook] */
const sleep = (ms, hook) => new Promise((r) => {
  const t = setTimeout(r, ms);
  hook?.(() => { clearTimeout(t); r(undefined); });
});

/**
 * @param {{ config: Record<string, any>, deps?: Record<string, any> }} input
 *   deps (all optional, for tests): spawn, fetch, findGguf, readHeader, perfCores,
 *   logPath, pollMs, stopGraceMs, log.
 * @returns {Promise<{ baseURL: string, ctx: number, servedCtx: number, threads: number,
 *   capabilities: { tools: boolean, thinking: boolean }, ggufPath: string, logPath: string, stop: () => Promise<void> }>}
 */
export async function startLlama({ config, deps = {} }) {
  const c = config;
  const spawn = deps.spawn ?? nodeSpawn;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? console;
  const pollMs = deps.pollMs ?? POLL_MS;
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  const logPath = resolve(deps.logPath ?? DEFAULT_LOG);
  const findGguf = deps.findGguf ?? ((model) => findCachedGguf(model, resolveCacheRoot(c.LLAMA_CACHE, homedir())));
  const readHeader = deps.readHeader ?? readGgufHeader;
  const perfCores = deps.perfCores ?? (() => detectPerfCores());
  const port = c.LLAMACPP_PORT;
  const baseURL = `http://${HOST}:${port}`;

  const probe = async (path) => fetchImpl(`${baseURL}${path}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

  // 1. Fail closed when something already answers on the port. No adoption.
  // A refused connection means nothing listens: the port is ours to use.
  const busy = await probe('/health').then(() => true, () => false);
  if (busy) throw new LlamaStartError('port_busy', `port ${port} is already in use (something answers ${baseURL}/health). Stop it or set LLAMACPP_PORT.`);

  // 2. The model, from the cache only (decision 6).
  const ggufPath = await findGguf(c.LLAMACPP_MODEL);
  if (!ggufPath) {
    const root = resolveCacheRoot(c.LLAMA_CACHE, homedir());
    throw new LlamaStartError('model_missing', `model ${c.LLAMACPP_MODEL} is not in ${root}. Run: npm run model:fetch`);
  }
  const header = await readHeader(ggufPath);
  const ctx = pickContext({ cap: c.LLAMACPP_SERVE_CTX, headerContext: header.contextLength });
  const capabilities = capabilitiesFromHeader(header);
  const threads = pickThreads({ configured: c.LLAMACPP_THREADS, perfCores: await perfCores(), embeddingThreads: c.EMBEDDING_THREADS });
  const bin = await resolveBinary({ vendorDir: c.LLAMACPP_VENDOR_DIR });
  const args = buildServerArgs({ ggufPath, ctx, threads, port });

  // 3. A fresh log file: unlink, then create (truncating in place left NUL holes in v1).
  await mkdir(dirname(logPath), { recursive: true });
  try {
    await unlink(logPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const logFile = await open(logPath, 'w');
  let child;
  try {
    child = spawn(bin, args, { stdio: ['ignore', logFile.fd, logFile.fd] });
  } catch (err) {
    await logFile.close(); // cleanup: spawn threw, the error below is the one that matters
    throw err;
  }
  // The listeners below are attached in the SAME tick as spawn(). An await before
  // them let a fast 'error' (ENOENT) fire with no listener and crash the process.

  let exited = false;
  let ready = false;
  /** @type {Promise<void> | null} */
  let stopping = null;
  /** @type {LlamaStartError | null} */
  let failure = null;
  let wake = () => {};
  child.once('exit', (code, signal) => {
    exited = true;
    const msg = `llama-server exited (code ${code}, signal ${signal}). See ${logPath}`;
    if (ready && !stopping) log.error(msg); // a crash after start; our own stop() is not an error
    failure ??= new LlamaStartError('exited', msg);
    wake();
  });
  child.on('error', (err) => {
    log.error(`llama-server: ${err.message}`);
    failure ??= err.code === 'ENOENT'
      ? new LlamaStartError('binary_missing', `${BINARY} not found: not in LLAMACPP_VENDOR_DIR (${c.LLAMACPP_VENDOR_DIR}) and not on PATH`, err)
      : new LlamaStartError('spawn_failed', `could not start ${bin}: ${err.message}`, err);
    wake();
  });

  await logFile.close(); // the child holds its own copy of the descriptor

  const onAppExit = () => { if (!exited) child.kill('SIGKILL'); };
  process.once('exit', onAppExit);

  const waitExit = (ms) => (exited ? Promise.resolve(true) : new Promise((r) => {
    const t = setTimeout(() => r(false), ms);
    child.once('exit', () => { clearTimeout(t); r(true); });
  }));
  /** SIGTERM, wait, SIGKILL. A second call waits on the first. */
  const stop = () => {
    stopping ??= (async () => {
      process.removeListener('exit', onAppExit);
      if (exited || child.pid === undefined) return;
      child.kill('SIGTERM');
      if (await waitExit(stopGraceMs)) return;
      log.warn(`llama-server ignored SIGTERM for ${stopGraceMs} ms; sending SIGKILL`);
      child.kill('SIGKILL');
      if (!(await waitExit(stopGraceMs))) log.error(`llama-server (pid ${child.pid}) did not exit after SIGKILL`);
    })();
    return stopping;
  };

  // 4. Wait for /health, the child's exit, or the start timeout.
  const deadline = Date.now() + c.LLAMACPP_START_TIMEOUT_MS;
  while (!failure && !ready) {
    const left = deadline - Date.now();
    if (left <= 0) {
      failure = new LlamaStartError('start_timeout', `llama-server did not become healthy within ${c.LLAMACPP_START_TIMEOUT_MS} ms. See ${logPath}`);
      break;
    }
    // Not listening yet (refused) is normal while the model loads: poll again.
    ready = await probe('/health').then((r) => r.status === 200, () => false);
    if (!ready && !failure) await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), (w) => { wake = w; });
  }

  // 5. The served context is the truth for the budget (L-M08).
  let servedCtx = null;
  if (!failure) {
    try {
      const props = await (await probe('/props')).json();
      servedCtx = props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? null;
    } catch (err) {
      failure = new LlamaStartError('props_failed', `could not read ${baseURL}/props: ${err.message}`, err);
    }
    if (!failure && !Number.isInteger(servedCtx)) failure = new LlamaStartError('props_failed', `${baseURL}/props reports no n_ctx`);
  }
  if (failure) {
    await stop();
    throw failure;
  }
  if (servedCtx !== ctx) log.warn(`llama-server serves n_ctx ${servedCtx}, asked for ${ctx}; the budget uses ${servedCtx}`);
  log.info?.(`llama-server ready on ${baseURL}: ctx ${servedCtx}, ${threads} threads, ${ggufPath}`);

  return { baseURL, ctx, servedCtx, threads, capabilities, ggufPath, logPath, stop };
}
