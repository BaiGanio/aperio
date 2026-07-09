// bootstrap.js
import { spawn, execSync, exec } from 'child_process';
import { createWriteStream, existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { resolve, delimiter } from 'path';
import { EventEmitter } from 'events';
import { promisify } from 'util';

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
  { id: 'ollama',     label: 'Ollama',             icon: 'ai' },
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

const parseOllamaModelNames = (text) =>
  text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(/\s+/)[0])
    .filter(Boolean);

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

// ── Vendored Ollama (macOS + Windows) ──────────────────────────────────────
// macOS and Windows have no headless CLI installer that fits a scripted, no-
// admin flow (ollama.com/install.sh is Linux-only), so we vendor the official
// signed binary: macOS = universal (x86_64 + arm64) tarball, Windows = amd64
// zip. Pinned + checksummed (from the release sha256sum.txt); bump deliberately.
const OLLAMA_VER        = 'v0.31.1';
const OLLAMA_BASE       = `https://github.com/ollama/ollama/releases/download/${OLLAMA_VER}`;
const OLLAMA_DARWIN_URL = `${OLLAMA_BASE}/ollama-darwin.tgz`;
const OLLAMA_SHA_DARWIN = '0c4f92389fcc1f651c17282e2eaffd68c8d3d06e1f7b307604102ad0e09a10c9';
const OLLAMA_WIN_URL    = `${OLLAMA_BASE}/ollama-windows-amd64.zip`;
const OLLAMA_SHA_WIN    = '9ecf5a631561c7dff3a143925f11e2008327be738a7279fcf0c5462b9c422700';
const VENDOR_OLLAMA_DIR = './vendor/ollama';
const OLLAMA_BIN        = process.platform === 'win32' ? 'ollama.exe' : 'ollama';

// If a prior run vendored Ollama, make it discoverable to execSync/spawn('ollama').
const ensureVendorOnPath = () => {
  if (!existsSync(`${VENDOR_OLLAMA_DIR}/${OLLAMA_BIN}`)) return;
  const abs = resolve(VENDOR_OLLAMA_DIR);
  if (!process.env.PATH.split(delimiter).includes(abs)) {
    process.env.PATH = `${abs}${delimiter}${process.env.PATH}`;
  }
};

// macOS: download → verify → extract the engine into ./vendor/ollama.
const installOllamaMac = async () => {
  setStep('ollama', 'running', 'Downloading the Ollama engine (~125 MB, one time)…');
  mkdirSync(VENDOR_OLLAMA_DIR, { recursive: true });
  const tgz = './var/ollama-darwin.tgz';
  await runSilently('sh', ['-c', `curl -fL "${OLLAMA_DARWIN_URL}" -o "${tgz}"`]);
  const got = execSync(`shasum -a 256 "${tgz}"`, { encoding: 'utf8' }).trim().split(/\s+/)[0];
  if (got !== OLLAMA_SHA_DARWIN) throw new Error('Ollama checksum mismatch — refusing to install');
  await runSilently('sh', ['-c',
    `tar -xzf "${tgz}" -C "${VENDOR_OLLAMA_DIR}" && rm -f "${tgz}" && chmod +x "${VENDOR_OLLAMA_DIR}/ollama"`
  ]);
  ensureVendorOnPath();
  setStep('ollama', 'done', 'Ollama engine installed (vendored)');
};

// Windows: download → verify → extract via PowerShell into ./vendor/ollama.
const installOllamaWin = async () => {
  setStep('ollama', 'running', 'Downloading the Ollama engine (one time)…');
  mkdirSync(VENDOR_OLLAMA_DIR, { recursive: true });
  const zip = './var/ollama-windows.zip';
  const ps = (cmd) => runSilently('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
  await ps(`Invoke-WebRequest -Uri '${OLLAMA_WIN_URL}' -OutFile '${zip}'`);
  const got = execSync(`powershell -NoProfile -Command "(Get-FileHash '${zip}' -Algorithm SHA256).Hash"`, { encoding: 'utf8' }).trim().toLowerCase();
  if (got !== OLLAMA_SHA_WIN) throw new Error('Ollama checksum mismatch — refusing to install');
  await ps(`Expand-Archive -Path '${zip}' -DestinationPath '${VENDOR_OLLAMA_DIR}' -Force; Remove-Item '${zip}'`);
  ensureVendorOnPath();
  setStep('ollama', 'done', 'Ollama engine installed (vendored)');
};

// ── Vendored llama.cpp (macOS + Windows + Linux) ───────────────────────────
// Same rationale as the Ollama block above: no headless, no-admin installer
// fits every platform, so we vendor the official prebuilt `llama-server`
// release asset. Pinned to a single build (b9938) + sha256 verified against
// GitHub's reported digest (see llamacpp.md Phase 0 spike report); bump
// deliberately. Windows/Linux ship the Vulkan build (broadest single choice
// per the spike's risk-table decision — CPU-only assets exist as a documented
// fallback for power users, not wired here). macOS ships arm64/Metal only
// (Intel Mac out of scope, matching the plan's binary matrix).
// NOT YET WIRED into runBootstrap() — the wizard still installs Ollama; a
// later phase adds the 'llamacpp' step + AI_PROVIDER=llamacpp branch that
// calls checkLlamaCpp() instead of checkOllama().
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
  setStep('llamacpp', 'running', 'Downloading the llama.cpp engine (~50 MB, one time)…');
  mkdirSync(VENDOR_LLAMACPP_DIR, { recursive: true });
  const tgz = './var/llamacpp-macos.tgz';
  await runSilently('sh', ['-c', `curl -fL "${LLAMACPP_MAC_URL}" -o "${tgz}"`]);
  const got = execSync(`shasum -a 256 "${tgz}"`, { encoding: 'utf8' }).trim().split(/\s+/)[0];
  if (got !== LLAMACPP_SHA_MAC) throw new Error('llama.cpp checksum mismatch — refusing to install');
  await runSilently('sh', ['-c',
    `tar -xzf "${tgz}" -C "${VENDOR_LLAMACPP_DIR}" --strip-components=1 && rm -f "${tgz}" && chmod +x "${VENDOR_LLAMACPP_DIR}/llama-server"`
  ]);
  ensureLlamaCppVendorOnPath();
  setStep('llamacpp', 'done', 'llama.cpp engine installed (vendored)');
};

// Windows: download → verify → extract via PowerShell into ./vendor/llamacpp.
// The Windows zip has no wrapper folder, so this is a plain Expand-Archive.
const installLlamaCppWin = async () => {
  setStep('llamacpp', 'running', 'Downloading the llama.cpp engine (one time)…');
  mkdirSync(VENDOR_LLAMACPP_DIR, { recursive: true });
  const zip = './var/llamacpp-windows.zip';
  const ps = (cmd) => runSilently('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
  await ps(`Invoke-WebRequest -Uri '${LLAMACPP_WIN_URL}' -OutFile '${zip}'`);
  const got = execSync(`powershell -NoProfile -Command "(Get-FileHash '${zip}' -Algorithm SHA256).Hash"`, { encoding: 'utf8' }).trim().toLowerCase();
  if (got !== LLAMACPP_SHA_WIN) throw new Error('llama.cpp checksum mismatch — refusing to install');
  await ps(`Expand-Archive -Path '${zip}' -DestinationPath '${VENDOR_LLAMACPP_DIR}' -Force; Remove-Item '${zip}'`);
  ensureLlamaCppVendorOnPath();
  setStep('llamacpp', 'done', 'llama.cpp engine installed (vendored)');
};

// Linux: install.sh-free headless flow (unlike Ollama, llama.cpp has no Linux
// installer script), so vendor here too. Same nested-folder tar layout as macOS.
const installLlamaCppLinux = async () => {
  setStep('llamacpp', 'running', 'Downloading the llama.cpp engine (~80 MB, one time)…');
  mkdirSync(VENDOR_LLAMACPP_DIR, { recursive: true });
  const tgz = './var/llamacpp-linux.tgz';
  await runSilently('sh', ['-c', `curl -fL "${LLAMACPP_LINUX_URL}" -o "${tgz}"`]);
  const got = execSync(`sha256sum "${tgz}"`, { encoding: 'utf8' }).trim().split(/\s+/)[0];
  if (got !== LLAMACPP_SHA_LINUX) throw new Error('llama.cpp checksum mismatch — refusing to install');
  await runSilently('sh', ['-c',
    `tar -xzf "${tgz}" -C "${VENDOR_LLAMACPP_DIR}" --strip-components=1 && rm -f "${tgz}" && chmod +x "${VENDOR_LLAMACPP_DIR}/llama-server"`
  ]);
  ensureLlamaCppVendorOnPath();
  setStep('llamacpp', 'done', 'llama.cpp engine installed (vendored)');
};

// Install if missing, mirroring checkOllama's shape (not yet called from
// runBootstrap — see note above the vendoring block).
const checkLlamaCpp = async () => {
  setStep('llamacpp', 'running', 'Checking llama.cpp…');
  ensureLlamaCppVendorOnPath();
  if (isInstalled('llama-server')) {
    setStep('llamacpp', 'skipped', 'llama.cpp already installed');
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

const checkOllama = async () => {
  setStep('ollama', 'running', 'Checking Ollama…');
  ensureVendorOnPath();                       // pick up a binary vendored on a prior run
  if (!isInstalled('ollama')) {
    if (process.platform === 'darwin') {
      await installOllamaMac();               // install.sh is Linux-only; vendor on macOS
    } else if (process.platform === 'win32') {
      await installOllamaWin();               // vendor on Windows too
    } else {
      setStep('ollama', 'running', 'Installing Ollama…');
      await runSilently('sh', ['-c',
        `curl -fsSL https://ollama.com/install.sh -o /tmp/ollama_install.sh && \
         chmod +x /tmp/ollama_install.sh && \
         /tmp/ollama_install.sh`
      ]);
      setStep('ollama', 'done', 'Ollama installed');
    }
  } else {
    setStep('ollama', 'running', 'Ollama found — checking service…');
  }

  // Ensure the service is running
  try {
    execSync('ollama list', { stdio: 'ignore', timeout: 3000 });
    setStep('ollama', 'skipped', 'Service already running');
  } catch (_e) {
    setStep('ollama', 'running', 'Starting Ollama service…');
    const svc = spawn('ollama', ['serve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    svc.stdout.on('data', d => logger(`[ollama] ${d.toString().trim()}`));
    svc.stderr.on('data', d => logger(`[ollama] ${d.toString().trim()}`));
    svc.unref();
    await new Promise(r => setTimeout(r, 2500));
    setStep('ollama', 'done', 'Service started');
  }
};

const checkModel = async (model = 'qwen2.5:3b', { pullIfMissing = false } = {}) => {
  setStep('model', 'running', `Checking for ${model}…`);
  try {
    const models = parseOllamaModelNames(execSync('ollama list', { encoding: 'utf8' }));
    if (models.includes(model)) {
      setStep('model', 'skipped', `${model} already present`);
      return;
    }
  } catch (err) {
    if (!pullIfMissing) {
      setStep('model', 'error', `Could not list Ollama models: ${err.message}`);
      throw err;
    }
  }

  if (!pullIfMissing) {
    const err = new Error(`Selected Ollama model is not installed: ${model}`);
    setStep('model', 'error', err.message);
    throw err;
  }

  setStep('model', 'running', `Downloading ${model} — this may take a few minutes…`);
  try {
    await runSilently('ollama', ['pull', model]);
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

export const runBootstrap = async ({ model = 'qwen2.5:3b', skipOllama = false, pullModel = false } = {}) => {
  for (const step of STEPS) stepState[step.id] = 'idle';
  logger('=== Bootstrap starting ===');
  bootstrapEvents.emit('start');

  try {
    const nodePreexisting = await checkNode();
    await checkDeps();
    if (skipOllama) {
      // Cloud provider chosen in the wizard — no local model needed.
      setStep('ollama', 'skipped', 'Using a cloud provider');
      setStep('model',  'skipped', 'Using a cloud provider');
    } else {
      await checkOllama();
      await checkModel(model, { pullIfMissing: pullModel });
    }
    await checkSqlite();

    logger('=== Bootstrap complete ===');
    writeFileSync('var/bootstrap.lock', JSON.stringify({
      completedAt: new Date().toISOString(),
      model,
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
