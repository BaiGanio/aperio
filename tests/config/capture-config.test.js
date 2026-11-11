// T2.7 - the capture config keys (spec S2.7 §2 Limits).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../../src/config/registry.js';
import { readConfig, validateSetting } from '../../src/config/read-config.js';

const entry = (key) => REGISTRY.find((x) => x.key === key);

test('CAPTURE_MODE: tier 1 select on|off, default on', () => {
  const e = entry('CAPTURE_MODE');
  assert.ok(e, 'the key exists');
  assert.equal(e.tier, 1);
  assert.equal(e.type, 'select');
  assert.deepEqual(e.options, ['on', 'off']);
  assert.equal(readConfig({}).values.CAPTURE_MODE, 'on');
  assert.throws(() => validateSetting('CAPTURE_MODE', 'inbox'));
});

test('CAPTURE_DUP_SCORE: tier 1 int percent, default 85; a fraction is rejected', () => {
  const e = entry('CAPTURE_DUP_SCORE');
  assert.ok(e, 'the key exists');
  assert.equal(e.tier, 1);
  assert.equal(e.type, 'int');
  assert.match(e.help, /percent/i);
  assert.equal(readConfig({}).values.CAPTURE_DUP_SCORE, 85);
  assert.throws(() => validateSetting('CAPTURE_DUP_SCORE', '0.85'), /integer/);
});

test('CAPTURE_MAX_PER_TURN: tier 1 int, default 3', () => {
  const e = entry('CAPTURE_MAX_PER_TURN');
  assert.ok(e, 'the key exists');
  assert.equal(e.tier, 1);
  assert.equal(e.type, 'int');
  assert.equal(readConfig({}).values.CAPTURE_MAX_PER_TURN, 3);
});
