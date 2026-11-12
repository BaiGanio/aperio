// T2.7 rev 3 - the memory-tool config keys (spec S2.7 rev 3 §2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../../src/config/registry.js';
import { readConfig, validateSetting } from '../../src/config/read-config.js';

const entry = (key) => REGISTRY.find((x) => x.key === key);

test('REMEMBER_DUP_SCORE: tier 1 int percent, default 80 (measured in rev 2); a fraction is rejected', () => {
  const e = entry('REMEMBER_DUP_SCORE');
  assert.ok(e, 'the key exists');
  assert.equal(e.tier, 1);
  assert.equal(e.type, 'int');
  assert.match(e.help, /percent/i);
  assert.equal(readConfig({}).values.REMEMBER_DUP_SCORE, 80);
  assert.throws(() => validateSetting('REMEMBER_DUP_SCORE', '0.8'), /integer/);
});

test('RECALL_TOP_K stays: the recall tool default limit', () => {
  assert.equal(readConfig({}).values.RECALL_TOP_K, 5);
});

test('code capture and code auto-recall keys are gone (the model decides)', () => {
  for (const key of ['CAPTURE_MODE', 'CAPTURE_DUP_SCORE', 'CAPTURE_MAX_PER_TURN', 'RECALL_TOKEN_BUDGET', 'RECALL_MIN_SCORE']) {
    assert.equal(entry(key), undefined, key);
  }
});

test('LIST_LIMIT: tier 1 int, default 20 (the list tool default; hard max 50 in the tool) — spec S2.8', () => {
  const e = entry('LIST_LIMIT');
  assert.ok(e, 'the key exists');
  assert.equal(e.tier, 1);
  assert.equal(e.type, 'int');
  assert.equal(readConfig({}).values.LIST_LIMIT, 20);
});
