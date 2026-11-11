// T2.3 - store: migrations, vector table setup, and the try:search script.
//
// Ported from v1 (archive/v1-final): the "apply once, re-run is a no-op" and
// "a failed migration names its file" behaviour of db/migrate-sqlite.js
// (tests/integration/db/sqlite.test.js). The v1 sidecar-repair cases in
// tests/unit/db/vec-fallback.test.js are not ported: v2 keeps the vector
// table out of the migrations (spec S2.3 behaviour 4), so there is nothing
// to repair. The width-change case below replaces them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/store/open-store.js';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const quiet = { warn() {}, info() {} };
const fact = { type: 'fact', title: 'Coffee order', content: 'Flat white, oat milk.' };

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aperio-store-mig-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const applied = (store) => store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);

test('an empty DB gets the schema; a second open applies nothing and keeps the rows', () => withTemp(async (root) => {
  const path = join(root, 'a.db');
  const first = await openStore({ path, dims: 4, log: quiet });
  assert.deepEqual(applied(first), ['001_memories.sql']);
  const stamp = first.db.prepare('SELECT applied_at FROM schema_migrations').get().applied_at;
  await first.insert(fact, [1, 0, 0, 0], 'sig-a');
  await first.close();

  const second = await openStore({ path, dims: 4, log: quiet });
  assert.deepEqual(applied(second), ['001_memories.sql']);
  assert.equal(second.db.prepare('SELECT applied_at FROM schema_migrations').get().applied_at, stamp);
  assert.deepEqual(await second.counts(), { total: 1, embedded: 1 });
  await second.close();
}));

test('a broken migration rolls back, names its file, and leaves earlier ones applied', () => withTemp(async (root) => {
  const dir = join(root, 'migrations');
  await mkdir(dir);
  await writeFile(join(dir, '001_ok.sql'), 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY);');
  await writeFile(join(dir, '002_broken.sql'), 'CREATE TABLE half (id INTEGER PRIMARY KEY); THIS IS NOT SQL;');
  const path = join(root, 'b.db');
  await assert.rejects(openStore({ path, dims: 4, log: quiet, migrationsDir: dir }), /002_broken\.sql/);

  // Fix the file: the next open applies only what is missing.
  await writeFile(join(dir, '002_broken.sql'), 'CREATE TABLE half (id INTEGER PRIMARY KEY);');
  await writeFile(join(dir, '003_memories.sql'), await (await import('node:fs/promises')).readFile(join(REPO, 'src/store/migrations/001_memories.sql'), 'utf8'));
  const store = await openStore({ path, dims: 4, log: quiet, migrationsDir: dir });
  assert.deepEqual(applied(store), ['001_ok.sql', '002_broken.sql', '003_memories.sql']);
  await store.close();
}));

test('width change: reopening with other dims empties the vectors, clears every signature, warns once', () => withTemp(async (root) => {
  const path = join(root, 'c.db');
  const first = await openStore({ path, dims: 4, log: quiet });
  await first.insert(fact, [1, 0, 0, 0], 'sig-a');
  await first.close();

  const warnings = [];
  const second = await openStore({ path, dims: 8, log: { warn: (m) => warnings.push(m), info() {} } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /4/);
  assert.match(warnings[0], /8/);
  assert.deepEqual(await second.counts(), { total: 1, embedded: 0 });
  assert.equal(second.db.prepare('SELECT count(*) AS n FROM vec_memories').get().n, 0);
  assert.equal((await second.listNeedingEmbedding('sig-a', 10)).length, 1);
  assert.equal(await second.setEmbedding((await second.list({}))[0].id, [1, 0, 0, 0, 0, 0, 0, 0], 'sig-b'), true);
  await second.close();

  const third = await openStore({ path, dims: 8, log: { warn: (m) => warnings.push(m), info() {} } });
  assert.equal(warnings.length, 1, 'same width: no second warning');
  assert.deepEqual(await third.counts(), { total: 1, embedded: 1 });
  await third.close();
}));

test('openStore refuses a missing path or a bad dims value', async () => {
  await assert.rejects(openStore({ dims: 4, log: quiet }), /path/);
  await assert.rejects(openStore({ path: ':memory:', dims: 0, log: quiet }), /dims/);
  await assert.rejects(openStore({ path: ':memory:', dims: 'big', log: quiet }), /dims/);
});

test('try:search prints ranked rows for a sentence and creates no file', () => withTemp(async (root) => {
  const { stdout } = await run(process.execPath, [join(REPO, 'scripts/try-search.mjs'), 'What event bus does the Nimbus service use?'], { cwd: root });
  assert.match(stdout, /Nimbus uses NATS for events, not Kafka/);
  assert.match(stdout, /score/i);
  assert.match(stdout, /fts/);
  assert.deepEqual(await readdir(root), []);

  const none = await run(process.execPath, [join(REPO, 'scripts/try-search.mjs'), 'zzzqqqxxx'], { cwd: root });
  // S2.4: with the model, meaning search always returns the nearest rows, so a
  // nonsense sentence is no longer "no match". It still has no word match.
  // A minimum score for "no match" is S2.6 work (spec S2.3 decision 6).
  assert.doesNotMatch(none.stdout, /\bfts\b/);

  await assert.rejects(run(process.execPath, [join(REPO, 'scripts/try-search.mjs')], { cwd: root }), /Usage/);
}));
