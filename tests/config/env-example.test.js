// T2.2 - the .env.example generator. Every run writes into a temp dir; the
// repo's own .env.example is only ever read (--check), never written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { renderEnvExample } from '../../src/config/env-example.js';
import { REGISTRY } from '../../src/config/registry.js';

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..', '..');
const GEN = path.join(REPO, 'scripts', 'gen-env-example.mjs');

/** @param {string[]} args */
async function gen(args) {
  try {
    const { stdout } = await run(process.execPath, [GEN, ...args]);
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.code ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aperio-envgen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('render lists every registry key once and is deterministic', () => {
  const a = renderEnvExample(REGISTRY);
  assert.equal(a, renderEnvExample(REGISTRY));
  for (const { key } of REGISTRY) {
    const hits = a.split('\n').filter((l) => new RegExp(`^#? ?${key}=`).test(l));
    assert.equal(hits.length, 1, `${key} appears ${hits.length} times`);
  }
  assert.ok(a.endsWith('\n'));
});

test('a secret default is never written', () => {
  const stub = [{ key: 'TOKEN', tier: 1, type: 'text', secret: true, default: 'sk-live', help: 'x' }];
  assert.ok(!renderEnvExample(stub).includes('sk-live'));
});

test('generator: two runs are byte-identical', async (t) => {
  const dir = await tempDir(t);
  assert.equal((await gen(['--out-dir', dir])).code, 0);
  const first = await readFile(path.join(dir, '.env.example'), 'utf8');
  assert.equal((await gen(['--out-dir', dir])).code, 0);
  assert.equal(await readFile(path.join(dir, '.env.example'), 'utf8'), first);
});

test('generator --check: 1 when stale, 0 after regen', async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, '.env.example'), '# stale\n');
  const stale = await gen(['--check', '--out-dir', dir]);
  assert.equal(stale.code, 1);
  assert.match(stale.output, /stale/i);
  await gen(['--out-dir', dir]);
  assert.equal((await gen(['--check', '--out-dir', dir])).code, 0);
});

test('the committed .env.example is current', async () => {
  assert.equal((await gen(['--check'])).code, 0);
});
