import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exercisePinnedConnectionsAndIntegrations } from '../../../../manual/verify/flow/pinned-connections-integrations.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const sha = '65d45c971c51c9c83a7d3faf34def61dd4d841e0';

test('pinned connection and guarded integration flow rejects mutation and observes cancellation', async () => {
  const report = await exercisePinnedConnectionsAndIntegrations(root, sha);
  assert.equal(report.productSha, sha);
  assert.equal(report.connection.catalogDiscovery, 'pass');
  assert.equal(report.interrupts.rejectedMutationNotExecuted, 'pass');
  assert.equal(report.automation.controlledCancellationObserved, 'pass');
  assert.equal(report.cleanup, 'pass');
});
