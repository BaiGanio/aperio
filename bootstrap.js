// bootstrap.js
import { spawn, execSync, exec } from 'child_process';
import { createWriteStream, existsSync, writeFileSync, readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const bootstrapEvents = new EventEmitter();
bootstrapEvents.setMaxListeners(50);

const logStream = createWriteStream('./bootstrap.log', { flags: 'a' });

const logger = (msg, level = 'info') => {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  logStream.write(line + '\n');
  bootstrapEvents.emit('progress', { message: msg, level, ts: Date.now() });
};

// ── State ─────────────────────────────────────────────────────────────────

export const STEPS = [
  { id: 'node',       label: 'Node.js & npm',     icon: 'node' },
  { id: 'deps',       label: 'Dependencies',       icon: 'package' },
  { id: 'ollama',     label: 'Ollama',             icon: 'ai' },
  { id: 'model',      label: 'AI Model',           icon: 'model' },
  { id: 'lancedb',    label: 'LanceDB & Embeddings', icon: 'db' },
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
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; }
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

// ── Step implementations ──────────────────────────────────────────────────

const checkNode = async () => {
  setStep('node', 'running', 'Checking Node.js…');
  if (isInstalled('node')) {
    const v = execSync('node -v', { encoding: 'utf8' }).trim();
    setStep('node', 'skipped', `Already installed (${v})`);
    return;
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
  if (!isInstalled('ollama')) {
    setStep('ollama', 'running', 'Installing Ollama…');
    await runSilently('sh', ['-c',
      `curl -fsSL https://ollama.com/install.sh -o /tmp/ollama_install.sh && \
       chmod +x /tmp/ollama_install.sh && \
       /tmp/ollama_install.sh`
    ]);
    setStep('ollama', 'done', 'Ollama installed');
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

const checkModel = async (model = 'gemma3:4b') => {
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

const checkLanceDB = async () => {
  setStep('lancedb', 'running', 'Checking LanceDB & embeddings…');
  // @lancedb/lancedb is declared in package.json — if node_modules exists it's already there.
  // We verify by resolving the package rather than installing a conflicting legacy name.
  try {
    execSync('node -e "require(\'@lancedb/lancedb\')"', { stdio: 'ignore' });
    setStep('lancedb', 'skipped', 'Already available');
  } catch (err) {
    setStep('lancedb', 'running', 'Installing @lancedb/lancedb…');
    await runSilently('npm', ['install', '@lancedb/lancedb', '--no-audit', '--no-fund']);
    setStep('lancedb', 'done', 'LanceDB installed');
  }
};

// ── Main ──────────────────────────────────────────────────────────────────

export const runBootstrap = async ({ model = 'gemma3:4b' } = {}) => {
  logger('=== Bootstrap starting ===');
  bootstrapEvents.emit('start');

  try {
    await checkNode();
    await checkDeps();
    await checkOllama();
    await checkModel(model);
    await checkLanceDB();

    logger('=== Bootstrap complete ===');
    writeFileSync('.bootstrap.lock', JSON.stringify({
      completedAt: new Date().toISOString(),
      model,
    }));
    bootstrapEvents.emit('complete');
  } catch (err) {
    logger(`Bootstrap failed: ${err.message}`, 'error');
    bootstrapEvents.emit('error', { message: err.message });
  }
};

export const isBootstrapped = () => existsSync('.bootstrap.lock');

export const getBootstrapMeta = () => {
  try {
    return JSON.parse(readFileSync('.bootstrap.lock', 'utf8'));
  } catch (_e) {
    return null;
  }
};