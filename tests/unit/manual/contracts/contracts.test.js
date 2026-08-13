import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadContracts, strengthenContract } from '../../../../manual/lib/contracts/index.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');

test('source classes and immutable preview boundaries validate', async () => {
  const { classes, contract } = await loadContracts(root);
  assert.deepEqual(Object.keys(classes.classes), ['authored', 'generated', 'imported', 'asset', 'evidence', 'preview', 'candidate', 'published']);
  assert.equal(contract.invariants.oneBuildEntryPoint, 'npm run manual:build');
  assert.equal(contract.invariants.previewMayPublish, false);
});

test('later contracts may strengthen but not weaken an invariant', () => {
  assert.equal(strengthenContract({ taggedPdf: true }, { specialistReview: true }).specialistReview, true);
  assert.throws(() => strengthenContract({ taggedPdf: true }, { taggedPdf: false }), /weakening/);
  assert.throws(() => strengthenContract({ previewMayPublish: false }, { previewMayPublish: true }), /weakening/);
});
