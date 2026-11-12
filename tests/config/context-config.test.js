// T2.13 - the turn budget keys (spec S2.13 §2 "New config keys", §4 item 7).
// readConfig({}) reads no env and no file: the defaults only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../../src/config/registry.js';
import { readConfig, validateSetting } from '../../src/config/read-config.js';

const KEYS = { CONTEXT_OUTPUT_RESERVE: 2048, CONTEXT_TRIM_AT_PCT: 85, CONTEXT_TRIM_TO_PCT: 60, CONTEXT_TOOL_RESULT_PCT: 25 };

test('the 4 budget keys: tier 1 ints with the spec defaults', () => {
  const values = readConfig({}).values;
  for (const [key, def] of Object.entries(KEYS)) {
    const e = REGISTRY.find((x) => x.key === key);
    assert.ok(e, `${key} exists`);
    assert.equal(e.tier, 1, key);
    assert.equal(e.type, 'int', key);
    assert.equal(values[key], def, key);
    assert.match(e.help, /S2\.13/, `${key} help names the spec`);
  }
});

test('TRIM_TO is below TRIM_AT by default (hysteresis)', () => {
  const v = readConfig({}).values;
  assert.ok(v.CONTEXT_TRIM_TO_PCT < v.CONTEXT_TRIM_AT_PCT);
});

test('the Settings DB may set a mark; a fraction is rejected', () => {
  assert.equal(validateSetting('CONTEXT_TRIM_AT_PCT', '80'), '80');
  assert.throws(() => validateSetting('CONTEXT_TRIM_AT_PCT', '0.8'), /integer/);
});

test('LLAMACPP_SERVE_CTX default is 65536 (§4 item 7)', () => {
  assert.equal(readConfig({}).values.LLAMACPP_SERVE_CTX, 65536);
});
