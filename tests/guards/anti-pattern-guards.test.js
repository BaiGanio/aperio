// T1.3 - the lint and CI guards must have teeth.
//
// For every anti-pattern guard AP1-AP7 and AP9 this suite plants one violating
// file, proves the guard fails and names the AP id, then proves an allowed
// shape still passes. A guard that has never been seen to fail is not a guard
// (lesson L-C02). AP8 - the WebSocket schema contract - arrives in step S2.11.
//
// Every planted file lives in a throwaway directory outside the repo tree, so
// a run leaves no stray state behind (lesson L-P02).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REPO = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES = path.join(REPO, 'tests', 'guards', 'fixtures');
const ESLINT_BIN = path.join(REPO, 'node_modules', 'eslint', 'bin', 'eslint.js');
const CONFIG = path.join(REPO, 'eslint.config.mjs');
const SIZE_GUARD = path.join(REPO, 'scripts', 'guard-file-size.mjs');
const NAME_GUARD = path.join(REPO, 'scripts', 'guard-duplicate-basenames.mjs');

/** @returns {Promise<string>} a fresh throwaway project root */
async function newProject() {
  return mkdtemp(path.join(tmpdir(), 'aperio-guard-'));
}

/**
 * Copy a committed fixture to the path the guard actually watches.
 * @param {string} root @param {string} fixture @param {string} target
 */
async function plant(root, fixture, target) {
  const dest = path.join(root, target);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(path.join(FIXTURES, fixture), dest);
  return target;
}

/**
 * @param {string} cwd @param {string[]} files
 * @returns {Promise<{code: number, messages: string[]}>}
 */
async function lint(cwd, files) {
  const args = ['--no-config-lookup', '--config', CONFIG, '--format', 'json', ...files];
  try {
    const { stdout } = await run(process.execPath, [ESLINT_BIN, ...args], { cwd });
    return { code: 0, messages: collect(stdout) };
  } catch (err) {
    return { code: err.code ?? 1, messages: collect(err.stdout ?? '[]') };
  }
}

/** @param {string} stdout */
function collect(stdout) {
  return JSON.parse(stdout).flatMap((f) => f.messages.map((m) => m.message));
}

/** @param {string} script @param {string} root */
async function guard(script, root) {
  try {
    const { stdout } = await run(process.execPath, [script, root]);
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.code ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// --- AP1-AP6 and the disable-comment edge case, through eslint -------------

/** @type {{id: string, fixture: string, target: string}[]} */
const RED = [
  { id: 'AP1', fixture: 'ap1/bad-reads-env.js', target: 'src/agent/env-reader.js' },
  { id: 'AP2', fixture: 'ap2/bad-provider-name.js', target: 'src/agent/provider-branch.js' },
  { id: 'AP3', fixture: 'ap3/bad-raw-fs.js', target: 'src/tools/read-note-tool.js' },
  { id: 'AP4', fixture: 'ap4/bad-sync-fs.js', target: 'src/agent/prompt-loader.js' },
  { id: 'AP5', fixture: 'ap5/bad-empty-handlers.js', target: 'src/agent/risky-call.js' },
  { id: 'AP6', fixture: 'ap6/bad-unbounded-cache.js', target: 'src/agent/memo-cache.js' },
  { id: 'AP0', fixture: 'disable/bad-bare-disable.js', target: 'src/agent/bare-disable.js' },
];

/** @type {{name: string, fixture: string, target: string}[]} */
const GREEN = [
  { name: 'AP1: the Tier-0 env file may read process.env', fixture: 'ap1/good-tier0-env.js', target: 'src/boot/tier0-env.js' },
  { name: 'AP2: asking for a capability is allowed', fixture: 'ap2/good-capability.js', target: 'src/agent/capability-ask.js' },
  { name: 'AP3: a tool using the file gate is allowed', fixture: 'ap3/good-gated-read.js', target: 'src/tools/read-note-gated.js' },
  { name: 'AP4: sync fs is allowed in boot code', fixture: 'ap4/good-sync-in-boot.js', target: 'src/boot/prompt-loader-boot.js' },
  { name: 'AP5: a marked cleanup handler is allowed', fixture: 'ap5/good-marked-cleanup.js', target: 'src/agent/risky-call-safe.js' },
  { name: 'AP6: a frozen lookup table is not a cache', fixture: 'ap6/good-frozen-table.js', target: 'src/agent/tool-name-table.js' },
  { name: 'AP0: a disable naming its AP id and reason is allowed', fixture: 'disable/good-explained-disable.js', target: 'src/agent/explained-disable.js' },
];

for (const { id, fixture, target } of RED) {
  test(`${id}: a planted violation fails lint and names ${id}`, async (t) => {
    const root = await newProject();
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = await plant(root, fixture, target);
    const { code, messages } = await lint(root, [file]);
    assert.equal(code, 1, `expected lint to fail for ${target}, got exit ${code}`);
    assert.ok(
      messages.some((m) => m.includes(id)),
      `no message named ${id}. Messages: ${JSON.stringify(messages)}`,
    );
  });
}

for (const { name, fixture, target } of GREEN) {
  test(`green - ${name}`, async (t) => {
    const root = await newProject();
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = await plant(root, fixture, target);
    const { code, messages } = await lint(root, [file]);
    assert.deepEqual(messages, [], `expected ${target} to lint clean`);
    assert.equal(code, 0);
  });
}

// --- AP7 file size --------------------------------------------------------

const BIG = `${Array.from({ length: 600 }, (_, i) => `export const line${i} = ${i};`).join('\n')}\n`;

test('AP7: a 600-line file with no // size-reason: header fails the guard', async (t) => {
  const root = await newProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'agent'), { recursive: true });
  await writeFile(path.join(root, 'src', 'agent', 'big-module.js'), BIG);
  const { code, output } = await guard(SIZE_GUARD, root);
  assert.equal(code, 1, 'expected the file-size guard to fail');
  assert.match(output, /AP7/);
  assert.match(output, /big-module\.js/);
});

test('green - AP7: the same file passes once it states a // size-reason:', async (t) => {
  const root = await newProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'agent'), { recursive: true });
  const reason = '// size-reason: one generated table; splitting it would hide the pattern.\n';
  await writeFile(path.join(root, 'src', 'agent', 'big-module.js'), reason + BIG);
  const { code, output } = await guard(SIZE_GUARD, root);
  assert.equal(code, 0, `expected the file-size guard to pass, output: ${output}`);
});

// --- AP9 duplicate basenames ---------------------------------------------

test('AP9: two files named server.js fail the guard', async (t) => {
  const root = await newProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'http'), { recursive: true });
  await writeFile(path.join(root, 'src', 'server.js'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'src', 'http', 'server.js'), 'export const b = 2;\n');
  const { code, output } = await guard(NAME_GUARD, root);
  assert.equal(code, 1, 'expected the duplicate-basename guard to fail');
  assert.match(output, /AP9/);
  assert.match(output, /server\.js/);
});

test('green - AP9: unique, descriptive names pass the guard', async (t) => {
  const root = await newProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'http'), { recursive: true });
  await writeFile(path.join(root, 'src', 'memory-server.js'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'src', 'http', 'http-listener.js'), 'export const b = 2;\n');
  const { code, output } = await guard(NAME_GUARD, root);
  assert.equal(code, 0, `expected the duplicate-basename guard to pass, output: ${output}`);
});

// --- the real repository must be green -----------------------------------

test('green - the repository itself passes lint and both guards', async () => {
  const { code, messages } = await lint(REPO, ['.']);
  assert.deepEqual(messages, [], 'the repository has lint errors');
  assert.equal(code, 0);

  for (const script of [SIZE_GUARD, NAME_GUARD]) {
    const result = await guard(script, REPO);
    assert.equal(result.code, 0, `${path.basename(script)} failed: ${result.output}`);
  }
});
