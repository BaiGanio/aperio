import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOverlay, normalizeDataset, project, stableId } from '../../../../manual/lib/data/index.mjs';

const provenance = { productSha: 'a'.repeat(40), sourceBlobs: ['x:y'], schemaVersion: 1, generator: 'test@1', generatedAt: 'ignored' };

test('stable IDs, deterministic ordering, and identical projections', () => {
  assert.equal(stableId('config', 'AI_PROVIDER'), 'config.AI_PROVIDER');
  const dataset = normalizeDataset([{ id: 'mcp.recall', family: 'mcp', name: 'recall' }, { id: 'mcp.remember', family: 'mcp', name: 'remember' }], provenance);
  assert.deepEqual(project(dataset, { ids: ['mcp.recall'] })[0], dataset.rows[0]);
  assert.equal(normalizeDataset([...dataset.rows], provenance).provenance.semanticHash, dataset.provenance.semanticHash);
});

test('duplicate, unknown, invalid predicate, empty, and factual overlay writes fail', () => {
  assert.throws(() => normalizeDataset([{ id: 'mcp.recall' }, { id: 'mcp.recall' }], provenance), /duplicate/);
  const dataset = normalizeDataset([{ id: 'mcp.recall', family: 'mcp', name: 'recall' }], provenance);
  assert.throws(() => project(dataset, { ids: ['mcp.absent'] }), /unknown/);
  assert.throws(() => project(dataset, { invented: true }), /invalid/);
  assert.throws(() => project(dataset, { family: 'config' }), /empty/);
  assert.throws(() => applyOverlay(dataset.rows[0], { status: 'verified' }), /factual/);
});
