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

function text(result) { return result.content?.[0]?.text ?? ''; }
function json(result) { return JSON.parse(text(result)); }

export async function exercisePinnedFilesAndGraphs(root, sha) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-c04-flow-'));
  const tree = path.join(scratch, 'product');
  const archive = path.join(scratch, 'product.tar');
  const workspacePath = path.join(scratch, 'workspace');
  let store;
  try {
    await fs.mkdir(tree);
    await fs.mkdir(workspacePath);
    const workspace = await fs.realpath(workspacePath);
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd: root });
    await exec('tar', ['-xf', archive, '-C', tree]);
    await fs.symlink(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    await chmodTree(tree, false);
    process.env.SQLITE_PATH = ':memory:';
    process.env.APERIO_DB_ENCRYPT = 'off';
    process.env.APERIO_BENCHMARK_RUN = '0';

    const paths = await import(pathToFileURL(path.join(tree, 'lib/routes/paths.js')));
    const fileTools = await import(pathToFileURL(path.join(tree, 'mcp/tools/files.js')));
    const { decideFileInterrupt } = await import(pathToFileURL(path.join(tree, 'mcp/tools/files/interrupt.js')));
    const signalFile = path.join(workspace, 'signal.js');
    const noteFile = path.join(workspace, 'notes.md');
    let spreadsheetPath;
    await paths.runWithPaths([workspace], [workspace], workspace, async () => {
      const written = await fileTools.writeFileHandler({}, { path: signalFile, content: 'export function tuneSignal(value) { return value + 1; }\n' });
      if (!/(Created|Wrote)/.test(text(written))) throw new Error(`file write failed: ${text(written)}`);
      await fileTools.writeFileHandler({}, { path: noteFile, content: '# Receiver\n\nSynthetic reference INV-17000 carries the violet signal.\n' });
      const read = await fileTools.readFileHandler({ path: signalFile });
      if (!text(read).includes('tuneSignal')) throw new Error('allowed file read failed');
      const denied = await fileTools.readFileHandler({ path: path.join(scratch, 'outside.txt') });
      if (!text(denied).includes('Read not allowed')) throw new Error('outside path was not denied');
      const edited = await fileTools.editFileHandler({}, { path: signalFile, old_string: 'value + 1', new_string: 'value + 2' });
      if (!text(edited).includes('Edited')) throw new Error(`exact edit failed: ${text(edited)}`);
      const generated = await fileTools.generateXlsxHandler({ filename: 'review.xlsx', sheets: [{ name: 'Signal', headers: ['name', 'value'], rows: [['violet', 17]] }] });
      const payload = JSON.parse(text(generated).replace(/^APERIO_FILE:/, ''));
      spreadsheetPath = payload.path;
      if (!spreadsheetPath.startsWith(workspace + path.sep) || !(await fs.stat(spreadsheetPath)).isFile()) throw new Error('artifact escaped or was not created');
      const proposed = await fileTools.deleteFileHandler({ path: signalFile }, {});
      const token = text(proposed).match(/Token: (del_[a-z0-9]+)/)?.[1];
      if (!token || !(await fs.stat(signalFile)).isFile()) throw new Error('delete confirmation proposal failed');
      const approved = await decideFileInterrupt({}, token, { decision: 'approve' });
      if (!text(approved.result).includes('Deleted')) throw new Error('confirmed deletion failed');
      await fileTools.writeFileHandler({}, { path: signalFile, content: 'export function tuneSignal(value) { return value + 2; }\n' });
    });

    const { SqliteStore } = await import(pathToFileURL(path.join(tree, 'db/sqlite.js')));
    const codeIndex = await import(pathToFileURL(path.join(tree, 'lib/codegraph/indexer.js')));
    const docIndex = await import(pathToFileURL(path.join(tree, 'lib/docgraph/indexer.js')));
    const codeHandlers = await import(pathToFileURL(path.join(tree, 'lib/handlers/codegraph/codegraphHandlers.js')));
    const docHandlers = await import(pathToFileURL(path.join(tree, 'lib/handlers/docgraph/docgraphHandlers.js')));
    store = await SqliteStore.init();
    const context = { store, generateEmbedding: async () => null, vectorEnabled: () => false };
    await paths.runWithPaths([workspace], [workspace], workspace, async () => {
      const codeCounts = await codeIndex.indexRepo(store, workspace, { generateEmbedding: async () => null });
      const docCounts = await docIndex.indexRepo(store, workspace, { generateEmbedding: async () => null });
      if (codeCounts.symbols < 1 || docCounts.chunks < 1) throw new Error('synthetic graph indexing produced no searchable units');
      const codeSearch = json(await codeHandlers.searchHandler(context, { query: 'tuneSignal' }));
      const symbol = codeSearch.results?.[0] ?? codeSearch.matches?.[0] ?? codeSearch[0];
      if (!symbol?.qualified) throw new Error('code_search did not return the synthetic symbol');
      const codeContext = json(await codeHandlers.contextHandler(context, { qualified: symbol.qualified, repo: workspace }));
      if (!codeContext.source.includes('value + 2')) throw new Error('code_context did not return current source');
      const docSearch = json(await docHandlers.searchHandler(context, { query: 'violet signal' }));
      const hit = docSearch.results?.[0] ?? docSearch.matches?.[0] ?? docSearch[0];
      if (!hit) throw new Error('doc_search did not return the synthetic passage');
      const refs = json(await docHandlers.refsHandler(context, { ref: 'INV-17000' }));
      if (!JSON.stringify(refs).includes('notes.md')) throw new Error('doc_refs did not return the synthetic reference');
      await codeIndex.pickBackend(store).mod.deleteRepo(store, workspace);
      await docIndex.deleteRepo(store, workspace);
      const codeRepos = json(await codeHandlers.reposHandler(context));
      const docRepos = json(await docHandlers.reposHandler(context));
      if (JSON.stringify(codeRepos).includes(workspace) || JSON.stringify(docRepos).includes(workspace)) throw new Error('graph cleanup left the disposable root');
    });

    return {
      identity: 'NON-RELEASE', productSha: sha,
      files: { allowedWriteReadEdit: 'pass', outsideDenial: 'pass', confirmedDelete: 'pass', cleanup: 'pass' },
      artifacts: { sessionWorkspaceContainment: 'pass', xlsxOpenedFromReturnedPath: spreadsheetPath ? 'pass' : 'fail' },
      graphs: { codeIndexSearchContext: 'pass', docIndexSearchRefs: 'pass', rootCleanup: 'pass' }
    };
  } finally {
    if (store) await store.close();
    await chmodTree(tree, true).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
