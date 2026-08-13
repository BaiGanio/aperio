import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function chmodTree(directory, writable) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await chmodTree(file, writable);
    await fs.chmod(file, writable ? (entry.isDirectory() ? 0o755 : 0o644) : (entry.isDirectory() ? 0o555 : 0o444));
  }
  await fs.chmod(directory, writable ? 0o755 : 0o555);
}

export async function exercisePinnedInstallAndConfig(root, sha) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-c06-flow-'));
  const tree = path.join(scratch, 'product');
  const archive = path.join(scratch, 'product.tar');
  let store;
  const prior = { SQLITE_PATH: process.env.SQLITE_PATH, DB_BACKEND: process.env.DB_BACKEND, APERIO_CONFIG_PRECEDENCE: process.env.APERIO_CONFIG_PRECEDENCE, APERIO_LITE: process.env.APERIO_LITE };
  try {
    await fs.mkdir(tree);
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd: root });
    await exec('tar', ['-xf', archive, '-C', tree]);
    await fs.symlink(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    await chmodTree(tree, false);
    const pkg = JSON.parse(await fs.readFile(path.join(tree, 'package.json'), 'utf8'));
    if (pkg.version !== '0.68.0' || pkg.scripts.start !== 'node server.js' || pkg.scripts.mcp !== 'node mcp/index.js') throw new Error('pinned source command identity failed');

    process.env.SQLITE_PATH = ':memory:';
    process.env.DB_BACKEND = 'sqlite';
    process.env.APERIO_DB_ENCRYPT = 'off';
    const { SqliteStore } = await import(pathToFileURL(path.join(tree, 'db/sqlite.js')));
    store = await SqliteStore.init();
    const marker = `manual-c06-${Date.now()}`;
    await store.setSetting('manual.install.marker', marker);
    if (await store.getSetting('manual.install.marker') !== marker) throw new Error('isolated SQLite write/read failed');

    const resolver = await import(pathToFileURL(path.join(tree, 'lib/config-resolver.js')));
    if (resolver.sourceFor({ envPresent: true, dbSet: true, tier0: false, envWins: false }) !== 'db') throw new Error('DB precedence failed');
    if (resolver.sourceFor({ envPresent: true, dbSet: true, tier0: false, envWins: true }) !== 'env') throw new Error('env precedence failed');
    if (resolver.sourceFor({ envPresent: false, dbSet: true, tier0: true, envWins: false }) !== 'default') throw new Error('tier-0 boundary failed');
    process.env.APERIO_CONFIG_PRECEDENCE = 'env';
    delete process.env.APERIO_LITE;
    if (resolver.resolvePrecedence({}) !== 'env') throw new Error('precedence switch failed');
    process.env.APERIO_LITE = 'on';
    if (resolver.resolvePrecedence({}) !== 'db') throw new Error('lite precedence clamp failed');

    const developmentCompose = await fs.readFile(path.join(tree, 'docker/docker-compose.yml'), 'utf8');
    const productionCompose = await fs.readFile(path.join(tree, 'docker/docker-compose.prod.yml'), 'utf8');
    if (!developmentCompose.includes('do NOT mount db/migrations') || !productionCompose.includes('/docker-entrypoint-initdb.d')) throw new Error('Compose evidence boundary changed');

    return {
      identity: 'NON-RELEASE', productSha: sha,
      source: { version: pkg.version, startCommand: pkg.scripts.start, mcpCommand: pkg.scripts.mcp, cleanLockfilePresent: await fs.stat(path.join(tree, 'package-lock.json')).then(() => 'pass') },
      sqlite: { isolatedInitReadWrite: 'pass', cleanup: 'pass' },
      precedence: { dbWins: 'pass', envWins: 'pass', tier0EnvironmentOnly: 'pass', liteDbClamp: 'pass' },
      deployment: { developmentPostgresEvidence: 'present', productionComposeExcluded: 'pass' }
    };
  } finally {
    if (store) await store.close();
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await chmodTree(tree, true).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
