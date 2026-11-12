// T2.11 - the socket frame cap config key (spec S2.11 §4.4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../../src/config/registry.js';
import { readConfig, validateSetting } from '../../src/config/read-config.js';
import { DEFAULT_MAX_FRAME_BYTES } from '../../src/shared/ws-schema.js';

test('WS_MAX_FRAME_BYTES: tier 0 int, default 256 KiB, same as the schema default', () => {
  const e = REGISTRY.find((x) => x.key === 'WS_MAX_FRAME_BYTES');
  assert.ok(e, 'the key exists');
  assert.equal(e.tier, 0, 'a security limit: env only, the Settings DB cannot raise it');
  assert.equal(e.type, 'int');
  assert.equal(readConfig({}).values.WS_MAX_FRAME_BYTES, 256 * 1024);
  assert.equal(readConfig({}).values.WS_MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_BYTES);
  assert.equal(readConfig({ env: { WS_MAX_FRAME_BYTES: '1024' } }).values.WS_MAX_FRAME_BYTES, 1024);
  assert.throws(() => validateSetting('WS_MAX_FRAME_BYTES', '1000000'), /Tier-0/);
  assert.throws(() => readConfig({ env: { WS_MAX_FRAME_BYTES: '256k' } }), /integer/);
});

// T2.14 - the socket client cap (spec S2.14 §2 Limits, §4.5).
test('WS_MAX_CLIENTS: tier 0 int, default 4, env can set it, the Settings DB cannot', () => {
  const e = REGISTRY.find((x) => x.key === 'WS_MAX_CLIENTS');
  assert.ok(e, 'the key exists');
  assert.equal(e.tier, 0);
  assert.equal(e.type, 'int');
  assert.equal(readConfig({}).values.WS_MAX_CLIENTS, 4);
  assert.equal(readConfig({ env: { WS_MAX_CLIENTS: '2' } }).values.WS_MAX_CLIENTS, 2);
  assert.throws(() => validateSetting('WS_MAX_CLIENTS', '100'), /Tier-0/);
});
