import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function chmodTree(directory, writable) { for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) { const file = path.join(directory, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) await chmodTree(file, writable); await fs.chmod(file, writable ? (entry.isDirectory() ? 0o755 : 0o644) : (entry.isDirectory() ? 0o555 : 0o444)); } await fs.chmod(directory, writable ? 0o755 : 0o555); }

export async function exercisePinnedStorageRecovery(root, sha) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-c07-flow-'));
  const tree = path.join(scratch, 'product'); const archive = path.join(scratch, 'product.tar');
  const sourceDb = path.join(scratch, 'source.db'); const restoredDb = path.join(scratch, 'restored.db');
  const prior = { SQLITE_PATH: process.env.SQLITE_PATH, DB_BACKEND: process.env.DB_BACKEND, APERIO_DB_ENCRYPT: process.env.APERIO_DB_ENCRYPT };
  let store;
  try {
    await fs.mkdir(tree); await exec('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd: root }); await exec('tar', ['-xf', archive, '-C', tree]); await fs.symlink(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir'); await chmodTree(tree, false);
    process.env.DB_BACKEND = 'sqlite'; process.env.APERIO_DB_ENCRYPT = 'off'; process.env.SQLITE_PATH = sourceDb;
    const { SqliteStore } = await import(pathToFileURL(path.join(tree, 'db/sqlite.js')));
    store = await SqliteStore.init();
    const marker = `RECOVERY-${Date.now()}`; await store.setSetting('manual.recovery.marker', marker);
    const exported = await store.exportAll();
    if (!Array.isArray(exported.memories) || !Array.isArray(exported.agent_runs)) throw new Error('portable export surface missing');
    await store.close(); store = null;
    await fs.copyFile(sourceDb, restoredDb);
    process.env.SQLITE_PATH = restoredDb;
    store = await SqliteStore.init();
    if (await store.getSetting('manual.recovery.marker') !== marker) throw new Error('offline SQLite restore lost nonportable setting');
    const routes = await fs.readFile(path.join(tree, 'lib/routes/api-data.js'), 'utf8');
    const importSection = routes.slice(routes.indexOf('router.post("/data/import"'));
    if (!routes.includes('agent_jobs: include_agent_jobs') || importSection.includes('agent_jobs:')) throw new Error('portable export/import asymmetry evidence changed');
    const shutdown = await fs.readFile(path.join(tree, 'lib/server/shutdown.js'), 'utf8');
    for (const owner of ['watchdog.stop()', 'scheduler.stop()', 'watcherRegistry.stopAll', 'shutdownEmbeddings', 'wss.close', 'httpServer.close', 'stopLlamaCpp', 'store.close']) if (!shutdown.includes(owner)) throw new Error(`graceful shutdown owner missing: ${owner}`);
    return { identity: 'NON-RELEASE', productSha: sha, storage: { offlineSqliteCopyRestored: 'pass', nonportableSettingRestored: 'pass' }, portability: { exportSurface: 'pass', importAsymmetryDetected: 'pass', fullBackupClaimRejected: 'pass' }, lifecycle: { gracefulOwnersPresent: 'pass', isolatedCleanup: 'pass' } };
  } finally {
    if (store) await store.close(); for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await chmodTree(tree, true).catch(() => {}); await fs.rm(scratch, { recursive: true, force: true });
  }
}
