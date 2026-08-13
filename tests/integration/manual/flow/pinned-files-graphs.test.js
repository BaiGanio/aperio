import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exercisePinnedFilesAndGraphs } from '../../../../manual/verify/flow/pinned-files-graphs.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const sha = '65d45c971c51c9c83a7d3faf34def61dd4d841e0';

test('pinned file, artifact, codegraph, and docgraph flow stays isolated and cleans up', async () => {
  const report = await exercisePinnedFilesAndGraphs(root, sha);
  assert.equal(report.files.outsideDenial, 'pass');
  assert.equal(report.artifacts.sessionWorkspaceContainment, 'pass');
  assert.deepEqual(report.graphs, { codeIndexSearchContext: 'pass', docIndexSearchRefs: 'pass', rootCleanup: 'pass' });
});
