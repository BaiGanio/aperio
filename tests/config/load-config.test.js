// T2.2 - loadConfig: the boot entry. TR15 / L-P03 guard: config is read at
// call time, never frozen at import. Every .env file lives in a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config/load-config.js';

/** @param {import('node:test').TestContext} t @param {string} body */
async function envFile(t, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aperio-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  await writeFile(file, body);
  return file;
}

/** Set process.env keys for one test and restore them after. */
function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const quiet = () => {};

test('TR15: process.env set after import is used by the next loadConfig', async (t) => {
  const scratch = path.join(tmpdir(), 'scratch-aperio.db');
  withEnv(t, { SQLITE_PATH: scratch, APERIO_CONFIG_PRECEDENCE: undefined });
  const c = await loadConfig({ envPath: path.join(tmpdir(), 'no-such-dir', '.env'), log: quiet });
  assert.equal(c.values.SQLITE_PATH, scratch);
  assert.equal(c.sources.SQLITE_PATH, 'env');
});

test('.env values apply, the shell wins over the file, process.env is untouched', async (t) => {
  withEnv(t, { LLAMACPP_PORT: '9191', LLAMACPP_MODEL: undefined, APERIO_CONFIG_PRECEDENCE: undefined });
  const file = await envFile(t, 'LLAMACPP_MODEL=file-model\nLLAMACPP_PORT=8181\n');
  const c = await loadConfig({ envPath: file, log: quiet });
  assert.equal(c.values.LLAMACPP_MODEL, 'file-model');
  assert.equal(c.values.LLAMACPP_PORT, 9191);
  assert.equal(process.env.LLAMACPP_MODEL, undefined, 'loadConfig must not write process.env');
});

test('a missing .env is fine: defaults apply', async (t) => {
  withEnv(t, { LLAMACPP_MODEL: undefined, APERIO_CONFIG_PRECEDENCE: undefined });
  const c = await loadConfig({ envPath: path.join(tmpdir(), 'no-such-dir', '.env'), log: quiet });
  assert.equal(c.sources.LLAMACPP_MODEL, 'default');
});

test('logs warnings and shadow notices; a secret value is never logged', async (t) => {
  withEnv(t, { LLAMACPP_SERVE_CTX: undefined, APERIO_CONFIG_PRECEDENCE: undefined });
  const file = await envFile(t, 'LLAMACPP_SERVE_CTX=768\n');
  const lines = [];
  await loadConfig({
    envPath: file,
    settings: { LLAMACPP_SERVE_CTX: '1024', GONE_KEY: 'x' },
    log: (m) => lines.push(m),
  });
  assert.ok(lines.some((l) => l.includes('GONE_KEY')), 'unknown key not logged');
  const s = lines.find((l) => l.includes('LLAMACPP_SERVE_CTX') && l.includes('shadow'));
  assert.ok(s, `no shadow line in ${JSON.stringify(lines)}`);
  assert.match(s, /768/);
  assert.match(s, /1024/);
  assert.match(s, /APERIO_CONFIG_PRECEDENCE=env/);
});
