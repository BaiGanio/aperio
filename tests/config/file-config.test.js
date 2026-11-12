// T2.9 — file gate config keys (spec S2.9 §2 Limits).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../../src/config/registry.js';
import { readConfig } from '../../src/config/read-config.js';

const entry = (key) => REGISTRY.find((x) => x.key === key);

test('APERIO_ALLOWED_PATHS: tier 0, empty by default (no folder is allowed)', () => {
  const e = entry('APERIO_ALLOWED_PATHS');
  assert.ok(e);
  assert.equal(e.tier, 0);
  assert.equal(readConfig({}).values.APERIO_ALLOWED_PATHS, '');
});

for (const key of ['FILE_READ_MAX_BYTES', 'FILE_WRITE_MAX_BYTES']) {
  test(`${key}: tier 1 int, default 512000 (v1's 500 KB)`, () => {
    const e = entry(key);
    assert.ok(e, 'the key exists');
    assert.equal(e.tier, 1);
    assert.equal(e.type, 'int');
    assert.equal(readConfig({}).values[key], 512000);
  });
}
