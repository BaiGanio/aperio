import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exercisePinnedFirstRecall } from '../../../../manual/verify/flow/pinned-first-recall.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const sha = '65d45c971c51c9c83a7d3faf34def61dd4d841e0';

test('pinned first-recall flow stores, recalls in a fresh context, and reverses synthetic state', async () => {
  const report = await exercisePinnedFirstRecall(root, sha);
  assert.deepEqual(report, { identity: 'NON-RELEASE', productSha: sha, storage: ':memory:', remember: 'pass', freshContextRecall: 'pass', reversal: 'pass' });
});
