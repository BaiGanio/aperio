// T2.12 - v1 -> v2 memory import (spec S2.12).
//
// Ported from v1 (archive/v1-final) tests/integration/db/contract/import-export.test.js:
//   "importAll is idempotent - re-importing an already-present memory is skipped"
//   and the round-trip "the exact memory id carried over".
// Cut: exportAll, wiki / self-memory / jobs tables, listTables / readTable, Postgres
// (spec non-goals). New: dates kept, current-rows filter, rejected rows listed,
// v1 file untouched, re-embed with the v2 sig, temp copy removed.
//
// L-P03: every path is under a fresh temp folder, made before any store opens.
// The importer is pure (no config, no env), so no real DB is in reach.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '../../src/store/open-store.js';
import { ImportError, formatReport, importV1 } from '../../src/store/import-v1.js';

const DIMS = 4;
const SIG = 'fake|4|q8-cls';
const NOW = new Date('2026-11-12T12:00:00.000Z');
const CURRENT = ['m-001', 'm-002', 'm-003', 'm-004', 'm-005'];
const FIXTURE = new URL('../fixtures/v1-memories.sql', import.meta.url);
const quiet = { warn() {}, info() {} };

/** A fake embedder: deterministic vectors from the words, every call counted. */
function fakeEmbedder({ fail = false } = {}) {
  const calls = [];
  const vectorOf = (text) => {
    const t = text.toLowerCase();
    return [t.includes('oat') ? 5 : 0.1, t.includes('nimbus') ? 5 : 0.1, 1, t.length % 5];
  };
  return {
    sig: SIG, dims: DIMS, calls,
    async embed(text) {
      calls.push(text);
      if (fail) throw new Error('model is gone');
      return vectorOf(text);
    },
    async embedQuery(text) { return vectorOf(text); },
    async close() {},
  };
}

/** A recording log, so a test can count warnings. */
function recordingLog() {
  const warns = [];
  return { warns, warn: (m) => warns.push(m), info() {} };
}

/** A temp folder with: v1.db (built from the fixture), v2.db path, tmp/ for the importer's copy. */
async function setup({ sql } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aperio-t212-'));
  const tmpRoot = join(dir, 'tmp');
  await mkdir(tmpRoot);
  const v1Path = join(dir, 'v1.db');
  const v1 = new Database(v1Path);
  v1.exec(await readFile(FIXTURE, 'utf8'));
  if (sql) v1.exec(sql);
  v1.close();
  const store = await openStore({ path: join(dir, 'v2.db'), dims: DIMS, log: quiet });
  const run = (over = {}) => importV1({ v1Path, store, embedder: fakeEmbedder(), log: quiet, now: NOW, tmpRoot, ...over });
  const cleanup = async () => { await store.close(); await rm(dir, { recursive: true, force: true }); };
  return { dir, tmpRoot, v1Path, store, run, cleanup };
}

const v2Count = (store) => store.db.prepare('SELECT count(*) AS n FROM memories').get().n;
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

// --- rows and fields ---------------------------------------------------------

test('every current v1 row imports with id, fields and both dates unchanged (ported: id carried over)', async () => {
  const t = await setup();
  try {
    const report = await t.run();
    assert.equal(report.total, 7);
    assert.equal(report.imported, 5);
    assert.equal(report.skipped, 0);
    assert.deepEqual(report.rejected, []);

    const v1 = new Database(t.v1Path, { readonly: true });
    for (const id of CURRENT) {
      const old = v1.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      const now = await t.store.getById(id);
      assert.ok(now, `${id} is in v2`);
      assert.equal(now.type, old.type);
      assert.equal(now.title, old.title);
      assert.equal(now.content, old.content);
      assert.deepEqual(now.tags, JSON.parse(old.tags));
      assert.equal(now.importance, old.importance);
      assert.equal(now.source, old.source);
      assert.equal(now.createdAt, old.created_at);
      assert.equal(now.updatedAt, old.updated_at);
    }
    v1.close();
    assert.equal((await t.store.getById('m-002')).title, 'Любим град', 'Cyrillic survives');
  } finally { await t.cleanup(); }
});

test('superseded and expired rows are not written; they are counted; the sum holds', async () => {
  const t = await setup();
  try {
    const report = await t.run();
    assert.equal(await t.store.getById('m-006'), null);
    assert.equal(await t.store.getById('m-007'), null);
    assert.deepEqual(report.notCurrent, { superseded: 1, expired: 1 });
    const sum = report.imported + report.skipped + report.rejected.length + report.notCurrent.superseded + report.notCurrent.expired;
    assert.equal(sum, report.total);
  } finally { await t.cleanup(); }
});

test('dropped v1 columns with a non-default value are counted', async () => {
  const t = await setup();
  try {
    const report = await t.run();
    assert.deepEqual(report.dropped, { pinned: 1, tier: 1, lang: 1, confidence: 1, expiresAt: 1 });
  } finally { await t.cleanup(); }
});

test('a second run imports 0 and skips N (ported: importAll is idempotent)', async () => {
  const t = await setup();
  try {
    await t.run();
    const again = await t.run();
    assert.equal(again.imported, 0);
    assert.equal(again.skipped, 5);
    assert.equal(v2Count(t.store), 5, 'no duplicates');
  } finally { await t.cleanup(); }
});

test('a row over a v2 limit is rejected with id and field; the rest still import', async () => {
  const long = 'x'.repeat(8001);
  const tags = JSON.stringify(Array.from({ length: 21 }, (_, i) => `t${i}`));
  const t = await setup({ sql: `
    INSERT INTO memories (id, type, title, content) VALUES ('m-big', 'fact', 'Big', '${long}');
    INSERT INTO memories (id, type, title, content, tags) VALUES ('m-tags', 'fact', 'Tags', 'Many tags.', '${tags}');
    INSERT INTO memories (id, type, title, content, tags) VALUES ('m-obj', 'fact', 'Obj', 'Tags not a list.', '{"a":1}');
    INSERT INTO memories (id, type, title, content) VALUES ('m-blank', 'fact', '   ', 'Blank title.');` });
  try {
    const report = await t.run();
    const byId = Object.fromEntries(report.rejected.map((r) => [r.id, r]));
    assert.equal(byId['m-big'].field, 'content');
    assert.match(byId['m-big'].why, /8001.*8000/);
    assert.equal(byId['m-tags'].field, 'tags');
    assert.equal(byId['m-obj'].field, 'tags');
    assert.equal(byId['m-blank'].field, 'title');
    assert.equal(report.rejected.length, 4);
    assert.equal(report.imported, 5);
    assert.equal(await t.store.getById('m-big'), null);
    const sum = report.imported + report.skipped + report.rejected.length + report.notCurrent.superseded + report.notCurrent.expired;
    assert.equal(sum, report.total);
  } finally { await t.cleanup(); }
});

test('an empty v1 DB: total 0, nothing written, no error', async () => {
  const t = await setup({ sql: 'DELETE FROM memories;' });
  try {
    const report = await t.run();
    assert.equal(report.total, 0);
    assert.equal(report.imported, 0);
    assert.equal(v2Count(t.store), 0);
  } finally { await t.cleanup(); }
});

// --- vectors and recall ------------------------------------------------------

test('every imported row gets a vector with the v2 sig', async () => {
  const t = await setup();
  try {
    const report = await t.run();
    assert.equal(report.embedded, 5);
    assert.deepEqual(await t.store.counts(), { total: 5, embedded: 5 });
    assert.deepEqual(await t.store.listNeedingEmbedding(SIG, 50), []);
  } finally { await t.cleanup(); }
});

test('an embedder that throws: rows saved, embedded 0, the error logged once', async () => {
  const t = await setup();
  const log = recordingLog();
  try {
    const report = await t.run({ embedder: fakeEmbedder({ fail: true }), log });
    assert.equal(report.imported, 5);
    assert.equal(report.embedded, 0);
    assert.equal(v2Count(t.store), 5);
    assert.equal(log.warns.length, 1, log.warns.join(' | '));
    assert.match(log.warns[0], /model is gone/);
  } finally { await t.cleanup(); }
});

test('a recall on an imported row finds it (words and meaning)', async () => {
  const t = await setup();
  try {
    await t.run();
    const emb = fakeEmbedder();
    const words = await t.store.search({ query: 'oat milk', mode: 'fulltext', limit: 3 });
    assert.equal(words[0]?.id, 'm-001');
    const meaning = await t.store.search({
      query: 'Nimbus event bus', queryEmbedding: await emb.embedQuery('nimbus'), mode: 'auto', limit: 3, sig: SIG,
    });
    assert.equal(meaning[0]?.id, 'm-003');
  } finally { await t.cleanup(); }
});

// --- the v1 file is never touched --------------------------------------------

test('the v1 file and its -wal keep sha256 and mtime; rows only in the -wal import', async () => {
  const t = await setup();
  // A live v1 writer: WAL mode, no checkpoint, so m-wal lives only in the -wal file.
  const writer = new Database(t.v1Path);
  try {
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec("INSERT INTO memories (id, type, title, content) VALUES ('m-wal', 'fact', 'Wal row', 'Only in the wal.')");
    const files = [t.v1Path, `${t.v1Path}-wal`];
    const before = await Promise.all(files.map(async (f) => [await sha256(f), (await stat(f)).mtimeMs]));
    assert.ok((await stat(`${t.v1Path}-wal`)).size > 0, 'the -wal holds data');

    const report = await t.run();
    assert.ok(await t.store.getById('m-wal'), 'the -wal row is imported');
    assert.equal(report.imported, 6);

    const after = await Promise.all(files.map(async (f) => [await sha256(f), (await stat(f)).mtimeMs]));
    assert.deepEqual(after, before);
  } finally { writer.close(); await t.cleanup(); }
});

// --- errors ------------------------------------------------------------------

test('random bytes (an encrypted v1 file) -> clear error, v2 unchanged', async () => {
  const t = await setup();
  try {
    await writeFile(t.v1Path, randomBytes(4096));
    await assert.rejects(t.run(), (err) => err instanceof ImportError && /APERIO_DB_ENCRYPT/.test(err.message));
    assert.equal(v2Count(t.store), 0);
  } finally { await t.cleanup(); }
});

test('a text file -> clear error, v2 unchanged', async () => {
  const t = await setup();
  try {
    await writeFile(t.v1Path, 'hello, I am not a database\n');
    await assert.rejects(t.run(), (err) => err instanceof ImportError && /not a plain SQLite/.test(err.message));
    assert.equal(v2Count(t.store), 0);
  } finally { await t.cleanup(); }
});

test('a missing file -> clear error', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.run({ v1Path: join(t.dir, 'nope.db') }), (err) => err instanceof ImportError && /not found/.test(err.message));
  } finally { await t.cleanup(); }
});

test('no memories table -> clear error, v2 unchanged', async () => {
  const t = await setup({ sql: 'DROP TABLE memories; CREATE TABLE other (x INTEGER);' });
  try {
    await assert.rejects(t.run(), (err) => err instanceof ImportError && /memories/.test(err.message));
    assert.equal(v2Count(t.store), 0);
  } finally { await t.cleanup(); }
});

// --- dry run and temp copy ---------------------------------------------------

test('--dry-run fills the report and writes nothing', async () => {
  const t = await setup();
  try {
    const report = await t.run({ dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.imported, 5);
    assert.equal(report.embedded, 0);
    assert.equal(v2Count(t.store), 0);
  } finally { await t.cleanup(); }
});

test('the temp copy folder is gone after success and after a thrown error', async () => {
  const t = await setup();
  try {
    await t.run();
    assert.deepEqual(await readdir(t.tmpRoot), []);
    await writeFile(t.v1Path, 'not sqlite');
    await assert.rejects(t.run());
    assert.deepEqual(await readdir(t.tmpRoot), []);
  } finally { await t.cleanup(); }
});

test('formatReport prints the counts in plain text', async () => {
  const t = await setup({ sql: "INSERT INTO memories (id, type, title, content) VALUES ('m-big', 'fact', 'Big', '" + 'y'.repeat(9000) + "');" });
  try {
    const text = formatReport(await t.run());
    assert.match(text, /imported\s+5/);
    assert.match(text, /m-big.*content/);
    assert.match(text, /superseded\s+1/);
  } finally { await t.cleanup(); }
});

// --- store.importRows --------------------------------------------------------

const row = (over = {}) => ({
  id: 'r-1', type: 'fact', title: 'T', content: 'C', tags: ['a'], importance: 3, source: 'v1',
  createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-02-01T00:00:00.000Z', ...over,
});

test('importRows keeps id and both dates; skips a known id; rejects a bad row with its field', async () => {
  const store = await openStore({ path: ':memory:', dims: DIMS, log: quiet });
  try {
    const first = store.importRows([row(), row({ id: 'r-2', updatedAt: 'not a date' })]);
    assert.equal(first.imported, 1);
    assert.deepEqual(first.rejected.map((r) => [r.id, r.field]), [['r-2', 'updatedAt']]);
    const saved = await store.getById('r-1');
    assert.equal(saved.createdAt, '2025-01-01T00:00:00.000Z');
    assert.equal(saved.updatedAt, '2025-02-01T00:00:00.000Z');
    const again = store.importRows([row()]);
    assert.deepEqual([again.imported, again.skipped], [0, 1]);
  } finally { await store.close(); }
});

test('importRows: dryRun and a throwing beforeCommit both roll back', async () => {
  const store = await openStore({ path: ':memory:', dims: DIMS, log: quiet });
  try {
    const dry = store.importRows([row()], { dryRun: true });
    assert.equal(dry.imported, 1);
    assert.equal(v2Count(store), 0);
    assert.throws(() => store.importRows([row()], { beforeCommit: () => { throw new Error('sum is off'); } }), /sum is off/);
    assert.equal(v2Count(store), 0);
  } finally { await store.close(); }
});
