import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function makeReadOnly(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await makeReadOnly(file);
      await fs.chmod(file, 0o555);
    } else {
      await fs.chmod(file, 0o444);
    }
  }
}

async function makeWritable(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await makeWritable(file);
    await fs.chmod(file, entry.isDirectory() ? 0o755 : 0o644);
  }
  await fs.chmod(directory, 0o755);
}

export async function exercisePinnedFirstRecall(root, sha) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-flow-'));
  const tree = path.join(scratch, 'product');
  const archive = path.join(scratch, 'product.tar');
  await fs.mkdir(tree);
  let store;
  try {
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd: root });
    await exec('tar', ['-xf', archive, '-C', tree]);
    await fs.symlink(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    await makeReadOnly(tree);
    process.env.SQLITE_PATH = ':memory:';
    process.env.APERIO_DB_ENCRYPT = 'off';
    process.env.AI_PROVIDER = 'llamacpp';
    const { SqliteStore } = await import(pathToFileURL(path.join(tree, 'db/sqlite.js')));
    const { rememberHandler, recallHandler, forgetHandler } = await import(pathToFileURL(path.join(tree, 'lib/handlers/memory/memoryHandlers.js')));
    store = await SqliteStore.init();
    const context = () => ({ store, generateEmbedding: async () => null, vectorEnabled: () => false, providerIsLocal: true });
    const remembered = await rememberHandler(context(), { title: 'Manual preview review word', content: 'My review word is apricot.', tier: 1, source: 'manual-preview-synthetic' });
    const id = remembered.content[0].text.match(/id: ([0-9a-f-]+)/)?.[1];
    if (!id) throw new Error('pinned remember did not return a memory ID');
    const recalled = await recallHandler(context(), { query: 'apricot', search_mode: 'fulltext' });
    if (!recalled.content[0].text.includes('apricot')) throw new Error('fresh-context pinned recall did not return the synthetic word');
    const forgotten = await forgetHandler(context(), { id });
    const after = await recallHandler(context(), { query: 'apricot', search_mode: 'fulltext' });
    if (!forgotten.content[0].text.includes('Forgotten') || after.content[0].text !== 'No memories found.') throw new Error('pinned reversal did not remove the synthetic memory');
    return { identity: 'NON-RELEASE', productSha: sha, storage: ':memory:', remember: 'pass', freshContextRecall: 'pass', reversal: 'pass' };
  } finally {
    if (store) await store.close();
    await makeWritable(tree).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
