// T3.0 - `tsc --noEmit` checks public/ and the shared schema (spec S3.0 §2.6, §3 item 7).
// A guard that has never been seen to fail is not a guard (L-C02): a planted JSDoc
// type error, in a throwaway copy outside the repo (L-P02), must make tsc fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { REPO } from './ui-helpers.js';

const run = promisify(execFile);
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

/** @returns {Promise<{ code: number, output: string }>} */
async function tsc(project) {
  try {
    const { stdout, stderr } = await run(process.execPath, [TSC, '--noEmit', '-p', project], { timeout: 120_000 });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}` };
  }
}

test('package.json: typescript is a dev dependency; npm run check runs the typecheck', async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(pkg.devDependencies?.typescript, 'typescript in devDependencies');
  assert.ok(!pkg.dependencies?.typescript, 'typescript is not a runtime dependency');
  assert.match(pkg.scripts?.typecheck ?? '', /\btsc\b.*--noEmit/);
  assert.match(pkg.scripts?.check ?? '', /npm run typecheck/);
});

test('tsconfig.json: checkJs, noEmit, strict, the DOM lib, public/** and ws-schema.js', async () => {
  const cfg = JSON.parse(await readFile(path.join(REPO, 'tsconfig.json'), 'utf8'));
  const o = cfg.compilerOptions ?? {};
  assert.equal(o.checkJs, true);
  assert.equal(o.noEmit, true);
  assert.equal(o.strict, true);
  assert.ok((o.lib ?? []).map((l) => l.toLowerCase()).includes('dom'), 'lib has dom');
  const inc = cfg.include ?? [];
  assert.ok(inc.some((p) => p.startsWith('public/')), 'includes public/');
  assert.ok(inc.includes('src/shared/ws-schema.js'), 'includes the shared schema');
  assert.ok(!inc.some((p) => p === 'src/**' || p === 'src/**/*' || p === 'src/**/*.js'), 'src/** is not in scope yet (§4.4)');
});

test('tsc --noEmit is green on the repo', async () => {
  const r = await tsc(path.join(REPO, 'tsconfig.json'));
  assert.equal(r.code, 0, r.output);
});

test('a planted JSDoc type error in a copy makes tsc fail and names the file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'aperio-tsc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(REPO, 'tsconfig.json'), path.join(root, 'tsconfig.json'));
  await cp(path.join(REPO, 'public'), path.join(root, 'public'), { recursive: true });
  await cp(path.join(REPO, 'src', 'shared'), path.join(root, 'src', 'shared'), { recursive: true });
  await writeFile(path.join(root, 'public', 'planted-error.js'),
    "// @ts-check\n/** @type {number} */\nexport const count = 'not a number';\n");
  const r = await tsc(path.join(root, 'tsconfig.json'));
  assert.notEqual(r.code, 0, 'tsc must fail on a planted type error');
  assert.match(r.output, /planted-error\.js/);
});
