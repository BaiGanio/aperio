import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exercisePinnedDailyUse } from '../../../../manual/verify/flow/pinned-daily-use.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const sha = '65d45c971c51c9c83a7d3faf34def61dd4d841e0';

test('pinned daily-use flow versions memory, deletes exact state, and exercises session CRUD', async () => {
  const report = await exercisePinnedDailyUse(root, sha);
  assert.deepEqual(report.memory, { store: 'pass', search: 'pass', versionedCorrection: 'pass', exactIdDeletion: 'pass' });
  assert.deepEqual(report.knowledge, { searchBeforeWrite: 'pass', citedSynthesis: 'pass', stableSlugRevision: 'pass', isolatedCleanup: 'pass' });
  assert.deepEqual(report.session, { browserCreateGet: 'pass', terminalCreateGet: 'pass', pinAndList: 'pass', branchAndResumeContext: 'pass', childOnlyDeletion: 'pass', exactIdDeletion: 'pass' });
  assert.deepEqual(report.agent, { inactiveDefinition: 'pass', emptyRunHistory: 'pass', exactIdDeletion: 'pass' });
  assert.deepEqual(report.providerLanes, { localTierVisibility: 'pass', cloudSensitiveWithhold: 'pass', privateNeverLeaves: 'pass' });
});
