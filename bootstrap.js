// bootstrap.js
import { spawn, execSync, exec } from 'child_process';
import { createWriteStream, existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { resolve, delimiter } from 'path';
import { EventEmitter } from 'events';
import net from 'net';
import { promisify } from 'util';
import { resolveModelCacheDir } from './lib/helpers/modelCache.js';

const execAsync = promisify(exec);

export const bootstrapEvents = new EventEmitter();
bootstrapEvents.setMaxListeners(50);
// Node treats an `error` event with no listeners as a thrown exception. The
// browser setup stream attaches its own listener while connected, but the
// existing-.env auto-bootstrap path can fail before any SSE client connects.
bootstrapEvents.on('error', () => {});

mkdirSync('./var', { recursive: true });
let logStream = null;

const logger = (msg, level = 'info') => {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  if (!logStream) logStream = createWriteStream('./var/bootstrap.log', { flags: 'a' });
  logStream.write(line + '\n');
  bootstrapEvents.emit('progress', { message: msg, level, ts: Date.now() });
};

// ── State ─────────────────────────────────────────────────────────────────

export const STEPS = [
  { id: 'node',       label: 'Node.js & npm',     icon: 'node' },
  { id: 'deps',       label: 'Dependencies',       icon: 'package' },
  { id: 'engine',     label: 'AI Engine',          icon: 'ai' },
  { id: 'model',      label: 'AI Model',           icon: 'model' },
  { id: 'sqlite',     label: 'SQLite & Embeddings', icon: 'db' },
];

// 'idle' | 'running' | 'done' | 'skipped' | 'error'
export const stepState = Object.fromEntries(STEPS.map(s => [s.id, 'idle']));

const setStep = (id, status, detail = '') => {
  stepState[id] = status;
  bootstrapEvents.emit('step', { id, status, detail, ts: Date.now() });
  if (detail) logger(`[${id}] ${detail}`);
};

// ── Helpers ───────────────────────────────────────────────────────────────

const isInstalled = (cmd) => {
  const probe = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
  try { execSync(probe, { stdio: 'ignore' }); return true; }
  catch (_e) { return false; }
};

const cleanCommandOutput = (text) =>
  text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

const commandFailureDetail = (text) => {
  const lines = cleanCommandOutput(text);
  return [...lines].reverse().find(line => /^error:/i.test(line))
    || [...lines].reverse().find(line => /permission denied|operation not permitted|not found|failed/i.test(line))
    || '';
};

const runSilently = (command, args = [], options = {}) =>
  new Promise((resolve, reject) => {
    let output = '';
    const remember = (chunk) => {
      output = `${output}${chunk}`;
      if (output.length > 4000) output = output.slice(-4000);
    };
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    proc.stdout.on('data', d => { const s = d.toString(); remember(s); logger(s.trim()); });
    proc.stderr.on('data', d => { const s = d.toString(); remember(s); logger(s.trim()); });
    proc.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = commandFailureDetail(output);
      reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ''}`));
    });
    proc.on('error', reject);
  });

// ── Vendored llama.cpp (macOS + Windows + Linux) ───────────────────────────
// No headless, no-admin installer fits every platform, so we vendor the
// official prebuilt `llama-server` release asset. Pinned to a single build
// (b9938) + sha256 verified against GitHub's reported digest (see
// llamacpp.md Phase 0 spike report); bump deliberately. Windows/Linux ship
// the Vulkan build (broadest single choice per the spike's risk-table
// decision — CPU-only assets exist as a documented fallback for power users,
// not wired here). macOS ships arm64/Metal only (Intel Mac out of scope,
// matching the plan's binary matrix).
// Wired into runBootstrap() via the 'engine' step (see the `engine` param).
const LLAMACPP_VER            = 'b9938';
const LLAMACPP_BASE           = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMACPP_VER}`;
const LLAMACPP_MAC_URL        = `${LLAMACPP_BASE}/llama-${LLAMACPP_VER}-bin-macos-arm64.tar.gz`;
const LLAMACPP_SHA_MAC        = '9290822c15c1275ff6edaba0801e0c9db1aceec6919792efcadda260c79a04a3';
const LLAMACPP_WIN_URL        = `${LLAMACPP_BASE}/llama-${LLAMACPP_VER}-bin-win-vulkan-x64.zip`;
const LLAMACPP_SHA_WIN        = '9afc70c01aed1e6847de572bd00bcb2783cfd8100d22c1a7310d5c1ad0961b35';
const LLAMACPP_LINUX_URL      = `${LLAMACPP_BASE}/llama-${LLAMACPP_VER}-bin-ubuntu-vulkan-x64.tar.gz`;
const LLAMACPP_SHA_LINUX      = 'a79ff739931ca3da1401250892a5e0a492bfc81743b925a7afd05ba4cc538cd9';
const VENDOR_LLAMACPP_DIR     = './vendor/llamacpp';
const LLAMACPP_BIN            = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

// If a prior run vendored llama.cpp, make it discoverable to execSync/spawn('llama-server').
const ensureLlamaCppVendorOnPath = () => {
  if (!existsSync(`${VENDOR_LLAMACPP_DIR}/${LLAMACPP_BIN}`)) return;
  const abs = resolve(VENDOR_LLAMACPP_DIR);
  if (!process.env.PATH.split(delimiter).includes(abs)) {
    process.env.PATH = `${abs}${delimiter}${process.env.PATH}`;
  }
};

// macOS: download → verify → extract into ./vendor/llamacpp. The release tar
// nests everything under a `llama-<tag>/` folder; --strip-components=1 flattens
// it to match Ollama's vendor-dir layout (binary directly at VENDOR_DIR/llama-server).
const installLlamaCppMac = async () => {
  setStep('engine', 'running', 'Downloading the llama.cpp engine (~50 MB, one time)…');
  mkdirSync(VENDOR_LLAMACPP_DIR, { recursive: true });
  const tgz = './var/llamacpp-macos.tgz';
  await runSilently('sh', ['-c', `curl -fL "${LLAMACPP_MAC_URL}" -o "${tgz}"`]);
  const got = execSync(`shasum -a 256 "${tgz}"`, { encoding: 'utf8' }).trim().split(/\s+/)[0];
  if (got !== LLAMACPP_SHA_MAC) throw new Error('llama.cpp checksum mismatch — refusing to install');
  await runSilently('sh', ['-c',
    `tar -xzf "${tgz}" -C "${VENDOR_LLAMACPP_DIR}" --strip-components=1 && rm -f "${tgz}" && chmod +x "${VENDOR_LLAMACPP_DIR}/llama-server"`
  ]);
  ensureLlamaCppVendorOnPath();
  setStep('engine', 'done', 'llama.cpp engine installed (vendored)');
};

// Windows: download → verify → extract via PowerShell into ./vendor/llamacpp.
// The Windows zip has no wrapper folder, so this is a plain Expand-Archive.
const installLlamaCppWin = async () => {
  setStep('engine', 'running', 'Downloading the llama.cpp engine (one time)…');
  mkdirSync(VENDOR_LLAMACPP_DIR, { recursive: true });
  const zip = './var/llamacpp-windows.zip';
  const ps = (cmd) => runSilently('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
  await ps(`Invoke-WebRequest -Uri '${LLAMACPP_WIN_URL}' -OutFile '${zip}'`);
  const got = execSync(`powershell -NoProfile -Command "(Get-FileHash '${zip}' -Algorithm SHA256).Hash"`, { encoding: 'utf8' }).trim().toLowerCase();
  if (got !== LLAMACPP_SHA_WIN) throw new Error('llama.cpp checksum mismatch — refusing to install');
  await ps(`Expand-Archive -Path '${zip}' -DestinationPath '${VENDOR_LLAMACPP_DIR}' -Force; Remove-Item '${zip}'`);
  ensureLlamaCppVendorOnPath();
  setStep('engine', 'done', 'llama.cpp engine installed (vendored)');
};

// Linux: llama.cpp has no installer script, so vendor here too. Same
// nested-folder tar layout as macOS.
const installLlamaCppLinux = async () => {
  setStep('engine', 'running', 'Downloading the llama.cpp engine (~80 MB, one time)…');
  mkdirSync(VENDOR_LLAMACPP_DIR, { recursive: true });
  const tgz = './var/llamacpp-linux.tgz';
  await runSilently('sh', ['-c', `curl -fL "${LLAMACPP_LINUX_URL}" -o "${tgz}"`]);
  const got = execSync(`sha256sum "${tgz}"`, { encoding: 'utf8' }).trim().split(/\s+/)[0];
  if (got !== LLAMACPP_SHA_LINUX) throw new Error('llama.cpp checksum mismatch — refusing to install');
  await runSilently('sh', ['-c',
    `tar -xzf "${tgz}" -C "${VENDOR_LLAMACPP_DIR}" --strip-components=1 && rm -f "${tgz}" && chmod +x "${VENDOR_LLAMACPP_DIR}/llama-server"`
  ]);
  ensureLlamaCppVendorOnPath();
  setStep('engine', 'done', 'llama.cpp engine installed (vendored)');
};

// Install if missing.
const checkLlamaCpp = async () => {
  setStep('engine', 'running', 'Checking llama.cpp…');
  ensureLlamaCppVendorOnPath();
  if (isInstalled('llama-server')) {
    setStep('engine', 'skipped', 'llama.cpp already installed');
    return;
  }
  if (process.platform === 'darwin') await installLlamaCppMac();
  else if (process.platform === 'win32') await installLlamaCppWin();
  else await installLlamaCppLinux();
};

// ── Step implementations ──────────────────────────────────────────────────

// Returns true if Node.js was already on the machine (we didn't install it),
// so uninstall messaging can be honest about what it should leave behind.
const checkNode = async () => {
  setStep('node', 'running', 'Checking Node.js…');
  if (isInstalled('node')) {
    const v = execSync('node -v', { encoding: 'utf8' }).trim();
    setStep('node', 'skipped', `Already installed (${v})`);
    return true;
  }
  setStep('node', 'running', 'Installing Node.js via nvm…');
  const nmvDir = `${process.env.HOME}/.nvm`;
  if (!existsSync(`${nmvDir}/nvm.sh`)) {
    await runSilently('sh', ['-c',
      'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | sh'
    ]);
  }
  await runSilently('sh', ['-c',
    `export NVM_DIR="${nmvDir}" && source "$NVM_DIR/nvm.sh" && nvm install --lts`
  ]);
  setStep('node', 'done', 'Node.js installed');
  return false;
};

const checkDeps = async () => {
  setStep('deps', 'running', 'Checking node_modules…');
  if (existsSync('./node_modules/.package-lock.json') || existsSync('./node_modules')) {
    setStep('deps', 'skipped', 'Already installed');
    return;
  }
  setStep('deps', 'running', 'Running npm install…');
  await runSilently('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund']);
  setStep('deps', 'done', 'Dependencies installed');
};

// ── llama.cpp model acquisition ────────────────────────────────────────────
// llama-server has no standalone "just download" command — it fetches a
// model the first time something actually requests it (router mode loads
// lazily). Ollama-style "pull, then done" needs *something* to be that first
// request, so we spawn a throwaway llama-server bound to a scratch port
// purely to trigger (and wait out) the -hf download + load, then kill it.
// This reuses llama-server's own fetch/resume/checksum logic instead of
// reimplementing an HF downloader, and its stdout/stderr — piped here, unlike
// the long-lived server's stdio:'ignore' in startLlamaCpp.js — becomes the
// wizard's progress detail lines, same role `ollama pull`'s output plays above.
// Standard HF hub cache (see lib/helpers/modelCache.js) — never a project-local
// dir, so the wizard checks/primes the same models the user already has instead
// of downloading a duplicate copy into the repo.
const LLAMA_CACHE_DIR = resolveModelCacheDir();

// llama-server's on-disk HF hub cache layout (confirmed in the Phase 0 spike):
// models--<org>--<repo>/{blobs,refs,snapshots}. The optional ":quant" suffix
// selects a file within the repo, not a separate cache folder.
const hfCacheDirName = (repoWithQuant) =>
  `models--${repoWithQuant.split(':')[0].replace(/\//g, '--')}`;

// Presence check: prefer asking a server that's already up (covers a setup
// retried after a prior partial run), else fall back to the cache dir on disk.
const isModelCached = async (repoWithQuant) => {
  const base = process.env.LLAMACPP_BASE_URL || `http://127.0.0.1:${process.env.LLAMACPP_PORT || '8080'}`;
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      const data = await r.json();
      if ((data?.data ?? []).some(m => m.id === repoWithQuant)) return true;
    }
  } catch { /* no server up yet — fall through to the cache check */ }
  try {
    return existsSync(`${LLAMA_CACHE_DIR}/${hfCacheDirName(repoWithQuant)}/snapshots`);
  } catch { return false; }
};

export const getEphemeralPort = ({ createServer = net.createServer } = {}) => new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once('error', rejectPort);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    server.close(err => {
      if (err) rejectPort(err);
      else if (!port) rejectPort(new Error('OS did not assign a scratch port'));
      else resolvePort(port);
    });
  });
});

const primeLlamaCppModelOnPort = (repoWithQuant, scratchPort) => new Promise((resolvePrime, rejectPrime) => {
  mkdirSync(LLAMA_CACHE_DIR, { recursive: true });

  const proc = spawn('llama-server', [
    '-hf', repoWithQuant,
    '--host', '127.0.0.1',
    '--port', String(scratchPort),
    '--jinja',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LLAMA_CACHE: resolve(LLAMA_CACHE_DIR) },
  });

  let settled = false;
  let poll;
  const finish = (fn, arg) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    fn(arg);
  };

  proc.stdout.on('data', d => logger(d.toString().trim()));
  proc.stderr.on('data', d => logger(d.toString().trim()));
  proc.on('error', err => finish(rejectPrime, err));
  proc.on('close', code => {
    if (!settled) finish(rejectPrime, new Error(`llama-server exited with code ${code} while downloading ${repoWithQuant}`));
  });

  const deadline = Date.now() + 20 * 60 * 1000; // large GGUFs can take a while
  poll = setInterval(async () => {
    if (Date.now() > deadline) { finish(rejectPrime, new Error(`Timed out downloading ${repoWithQuant}`)); return; }
    try {
      const r = await fetch(`http://127.0.0.1:${scratchPort}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) finish(resolvePrime, undefined);
    } catch { /* not ready yet */ }
  }, 1000);
});

export async function primeLlamaCppModel(repoWithQuant, {
  pickPort = getEphemeralPort,
  primeOnPort = primeLlamaCppModelOnPort,
} = {}) {
  let attemptedPort = null;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      attemptedPort = await pickPort();
      await primeOnPort(repoWithQuant, attemptedPort);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Failed to prime ${repoWithQuant} on scratch port ${attemptedPort ?? 'unavailable'}: ${lastError?.message || 'unknown error'}`,
    { cause: lastError },
  );
}

const checkLlamaCppModel = async (model, { pullIfMissing = false } = {}) => {
  setStep('model', 'running', `Checking for ${model}…`);
  if (await isModelCached(model)) {
    setStep('model', 'skipped', `${model} already present`);
    return;
  }

  if (!pullIfMissing) {
    const err = new Error(`Selected model is not downloaded yet: ${model}`);
    setStep('model', 'error', err.message);
    throw err;
  }

  setStep('model', 'running', `Downloading ${model} — this may take a few minutes…`);
  try {
    await primeLlamaCppModel(model);
  } catch (err) {
    setStep('model', 'error', `Model download failed: ${err.message}`);
    throw err;
  }
  setStep('model', 'done', `${model} downloaded`);
};

const checkSqlite = async () => {
  setStep('sqlite', 'running', 'Checking SQLite native bindings…');
  // better-sqlite3 + sqlite-vec are normal deps; `npm install` (the 'deps'
  // step above) already covers them. We just verify they resolve so we surface
  // a clean message if the prebuilt binary isn't compatible with this Node ABI.
  try {
    execSync('node -e "require(\'better-sqlite3\'); require(\'sqlite-vec\')"', { stdio: 'ignore' });
    setStep('sqlite', 'done', 'better-sqlite3 + sqlite-vec ready');
  } catch (err) {
    setStep('sqlite', 'error', `Native binding failed: ${err.message}`);
    throw err;
  }
};

// ── Main ──────────────────────────────────────────────────────────────────

// `engine` is the local AI engine the wizard picked: 'llamacpp' | null (cloud
// provider — no local engine/model steps to run).
export const runBootstrap = async ({ model, engine = null, pullModel = false } = {}) => {
  for (const step of STEPS) stepState[step.id] = 'idle';
  logger('=== Bootstrap starting ===');
  bootstrapEvents.emit('start');

  let resolvedModel = model;
  try {
    const nodePreexisting = await checkNode();
    await checkDeps();
    if (!engine) {
      // Cloud provider chosen in the wizard — no local engine/model needed.
      setStep('engine', 'skipped', 'Using a cloud provider');
      setStep('model',  'skipped', 'Using a cloud provider');
    } else if (engine === 'llamacpp') {
      resolvedModel = model || 'Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M';
      await checkLlamaCpp();
      await checkLlamaCppModel(resolvedModel, { pullIfMissing: pullModel });
    }
    await checkSqlite();

    logger('=== Bootstrap complete ===');
    writeFileSync('var/bootstrap.lock', JSON.stringify({
      completedAt: new Date().toISOString(),
      model: resolvedModel,
      engine,
      nodePreexisting,
    }));
    bootstrapEvents.emit('complete');
  } catch (err) {
    logger(`Bootstrap failed: ${err.message}`, 'error');
    bootstrapEvents.emit('error', { message: err.message });
  }
};

export const isBootstrapped = () => existsSync('var/bootstrap.lock');

export const getBootstrapMeta = () => {
  try {
    return JSON.parse(readFileSync('var/bootstrap.lock', 'utf8'));
  } catch (_e) {
    return null;
  }
};
