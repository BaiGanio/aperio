// T2.6 - evals/off-topic.json self-test (spec S2.6 §3): 12 prompts, 8 train /
// 4 holdout, unique ids, plain chat that never names a tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../../evals/off-topic.json', import.meta.url));
const { prompts } = JSON.parse(await readFile(file, 'utf8'));

test('12 prompts, 8 train / 4 holdout', () => {
  assert.equal(prompts.length, 12);
  assert.equal(prompts.filter((p) => p.split === 'train').length, 8);
  assert.equal(prompts.filter((p) => p.split === 'holdout').length, 4);
});

test('ids are unique, every prompt has text', () => {
  assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length);
  for (const p of prompts) assert.ok(typeof p.text === 'string' && p.text.trim(), p.id);
});

test('no prompt names a memory topic word or a tool', () => {
  const banned = /\b(maya|nimbus|beacon|recall|remember|memory|memories)\b/i;
  for (const p of prompts) assert.ok(!banned.test(p.text), `${p.id}: ${p.text}`);
});
