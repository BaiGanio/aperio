// T2.6 - the new RECALL_MIN_SCORE key (spec S2.6 §4 decision 2).
// The registry has no float type, so the key is a whole percent: 50 = cosine 0.50.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../../src/config/registry.js';
import { readConfig, validateSetting } from '../../src/config/read-config.js';

test('RECALL_MIN_SCORE: tier 1, int percent, default in 1..99', () => {
  const e = REGISTRY.find((x) => x.key === 'RECALL_MIN_SCORE');
  assert.ok(e, 'the key exists');
  assert.equal(e.tier, 1);
  assert.equal(e.type, 'int');
  const v = readConfig({}).values.RECALL_MIN_SCORE;
  assert.ok(Number.isInteger(v) && v >= 1 && v <= 99, `default ${v}`);
  assert.match(e.help, /percent/i, 'help says the unit');
});

test('RECALL_MIN_SCORE: the Settings DB may set it; a fraction is rejected', () => {
  assert.equal(validateSetting('RECALL_MIN_SCORE', '55'), '55');
  assert.throws(() => validateSetting('RECALL_MIN_SCORE', '0.55'), /integer/);
});
