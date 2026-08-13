import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadPreviewEdition } from '../../../../manual/lib/edition/index.mjs';
import { extractPartIFacts } from '../../../../manual/generators/authority/index.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');

test('Part I authority resolves only from exact v0.68.0 composition roots', async () => {
  const edition = await loadPreviewEdition(root);
  const dataset = await extractPartIFacts(root, edition);
  assert.equal(dataset.rows.find((row) => row.id === 'mcp.remember').status, 'verified');
  assert.equal(dataset.rows.find((row) => row.id === 'mcp.recall').status, 'verified');
  assert.equal(dataset.rows.find((row) => row.id === 'support.node-source-install').status, 'present-unverified');
  assert.equal(dataset.rows.find((row) => row.id === 'mcp.update_memory').status, 'verified');
  assert.equal(dataset.rows.find((row) => row.id === 'route.sessions').status, 'verified');
  assert.equal(dataset.rows.find((row) => row.id === 'route.agent-jobs').status, 'verified');
  assert.equal(dataset.rows.find((row) => row.id === 'mcp.read_file').status, 'verified');
  assert.equal(dataset.rows.find((row) => row.id === 'mcp.code_search').status, 'verified');
  assert.equal(dataset.rows.find((row) => row.id === 'mcp.doc_search').status, 'verified');
  assert.equal(dataset.rows.some((row) => row.id === 'command.test:harness'), false);
  assert.match(dataset.provenance.productSha, /^[0-9a-f]{40}$/);
});
