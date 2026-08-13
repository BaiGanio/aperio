import test from 'node:test'; import assert from 'node:assert/strict'; import path from 'node:path';
import { exercisePinnedStorageRecovery } from '../../../../manual/verify/flow/pinned-storage-recovery.mjs';
const root = path.resolve(import.meta.dirname, '../../../..'); const sha = '65d45c971c51c9c83a7d3faf34def61dd4d841e0';
test('offline SQLite recovery preserves data excluded from portable import', async () => { const report = await exercisePinnedStorageRecovery(root, sha); assert.equal(report.storage.nonportableSettingRestored, 'pass'); assert.equal(report.portability.fullBackupClaimRejected, 'pass'); assert.equal(report.lifecycle.isolatedCleanup, 'pass'); });
