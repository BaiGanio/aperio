// bootstrap.js
import { spawn, execSync, exec } from 'child_process';
import { createWriteStream, existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { resolve, delimiter } from 'path';
import { EventEmitter } from 'events';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const bootstrapEvents = new EventEmitter();
bootstrapEvents.setMaxListeners(50);

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

const runSilently = (command, args = [], options = {}) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    proc.stdout.on('data', d => logger(d.toString().trim()));
    proc.stderr.on('data', d => logger(d.toString().trim()));
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))
    );
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

const checkModel = async (model = 'qwen2.5:3b') => {
  setStep('model', 'running', `Checking for ${model}…`);
  try {
    const list = execSync('ollama list', { encoding: 'utf8' });
    if (list.includes(model.split(':')[0])) {
      setStep('model', 'skipped', `${model} already present`);
      return;
    }
  } catch (_e) {}
  setStep('model', 'running', `Pulling ${model} — this may take a few minutes…`);
  await runSilently('ollama', ['pull', model]);
  setStep('model', 'done', `${model} ready`);
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

export const runBootstrap = async ({ model = 'qwen2.5:3b', skipOllama = false } = {}) => {
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
      await checkModel(model);
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