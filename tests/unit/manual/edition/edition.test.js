import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadPreviewEdition, validateEdition } from '../../../../manual/lib/edition/index.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');

test('Part I preview has exact product identity but no release identity', async () => {
  const edition = await loadPreviewEdition(root);
  assert.equal(edition.product.version, '0.68.0');
  assert.equal(edition.product.sha, '65d45c971c51c9c83a7d3faf34def61dd4d841e0');
  assert.equal(edition.identity, 'NON-RELEASE');
  assert.equal(edition.releaseRevision, null);
});

test('preview rejects revisions, latest, and a missing paper', async () => {
  const edition = await loadPreviewEdition(root);
  assert.throws(() => validateEdition({ ...edition, releaseRevision: 1 }), /release identity/);
  assert.throws(() => validateEdition({ ...edition, product: { ...edition.product, tag: 'latest' } }), /explicit/);
  assert.throws(() => validateEdition({ ...edition, outputs: ['html', 'a4'] }), /letter/);
});
