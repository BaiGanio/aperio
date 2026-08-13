import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exercisePinnedInstallAndConfig } from '../../../../manual/verify/flow/pinned-install-config.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const sha = '65d45c971c51c9c83a7d3faf34def61dd4d841e0';

test('pinned source, isolated SQLite, and configuration precedence remain coherent', async () => {
  const report = await exercisePinnedInstallAndConfig(root, sha);
  assert.equal(report.source.version, '0.68.0');
  assert.equal(report.sqlite.isolatedInitReadWrite, 'pass');
  assert.equal(report.precedence.envWins, 'pass');
  assert.equal(report.deployment.productionComposeExcluded, 'pass');
});
