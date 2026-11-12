// T2.10 - the system prompt: base + fixed rule blocks (spec S2.10 §2, §3, §4.1 = A).
// Offline: order, same bytes for the same input, unknown name throws, token
// budget, and no block names a tool or feature v2 does not have.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, BLOCK_NAMES, buildSystem } from '../../src/context/system-prompt.js';
import { TEST_SYSTEM } from '../../src/eval/v2-live-adapter.js';
import { estimateTokens } from '../../src/context/recall-block.js';
import { MEMORY_TOOLS } from '../../src/tools/memory-tools.js';

describe('buildSystem (spec S2.10 §2)', () => {
  test('the 3 rule blocks, in a fixed order', () => {
    assert.deepEqual(BLOCK_NAMES, ['conduct', 'memory', 'conversation']);
    assert.deepEqual(Object.keys(BLOCKS), ['base', ...BLOCK_NAMES]);
    assert.ok(Object.isFrozen(BLOCKS));
  });

  test('default = base + every block, base first, blocks in the fixed order', () => {
    const all = buildSystem();
    assert.equal(all, [BLOCKS.base, BLOCKS.conduct, BLOCKS.memory, BLOCKS.conversation].join('\n\n'));
  });

  test('the caller order does not change the bytes', () => {
    assert.equal(buildSystem(['conversation', 'conduct']), buildSystem(['conduct', 'conversation']));
    assert.equal(buildSystem(['memory', 'memory']), buildSystem(['memory']));
  });

  test('same input, same bytes (no clock, no state)', () => {
    assert.equal(buildSystem(), buildSystem());
    assert.equal(buildSystem(['memory']), buildSystem(['memory']));
  });

  test('no blocks = the eval baseline TEST_SYSTEM, so leave-one-out measures one block', () => {
    assert.equal(BLOCKS.base, TEST_SYSTEM);
    assert.equal(buildSystem([]), TEST_SYSTEM);
  });

  test('an unknown block name throws, with the name', () => {
    assert.throws(() => buildSystem(['conduct', 'workng-with-files']), /workng-with-files/);
    assert.throws(() => buildSystem(['base']), /base/, 'base is always in, never asked for');
  });
});

describe('token budget (spec S2.10 §2 Limits, budget rule 7)', () => {
  test('the full prompt is <= 1.5k tokens (chars / 3)', () => {
    assert.ok(estimateTokens(buildSystem()) <= 1500, `${estimateTokens(buildSystem())} tokens`);
  });

  test('each rule block is <= ~250 tokens', () => {
    for (const name of BLOCK_NAMES) {
      assert.ok(estimateTokens(BLOCKS[name]) <= 250, `${name}: ${estimateTokens(BLOCKS[name])} tokens`);
    }
  });
});

describe('the text says only what v2 can do (spec S2.10 §2.3, L-M15)', () => {
  const NOT_IN_V2 = [
    /read_file|write_file|delete_file|edit_file/i, /update_memory|recall_memory|forget_memory|list_memories/i,
    /\bself_/i, /\bsql\b/i, /postgres/i, /voyage/i, /\bimportance\b/i, /\btags?\b/i,
    /deduplicate|backfill/i, /\bweb\b|\bfetch\b|\bscript/i, /\bmcp\b/i, /<tool_call>.*\{/i,
  ];

  test('no block names a tool or feature v2 does not have', () => {
    for (const [name, text] of Object.entries(BLOCKS)) {
      for (const re of NOT_IN_V2) assert.ok(!re.test(text), `${name} matches ${re}`);
    }
  });

  test('every snake_case word is a real tool name', () => {
    const tools = new Set(MEMORY_TOOLS.map((t) => t.name));
    for (const [name, text] of Object.entries(BLOCKS)) {
      for (const word of text.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) assert.ok(tools.has(word), `${name}: ${word}`);
    }
  });

  test('no v1 preload scripts ("say Saved.", "do not call recall at the start")', () => {
    const all = buildSystem();
    assert.doesNotMatch(all, /say ["']?saved/i);
    assert.doesNotMatch(all, /do not call recall/i);
    assert.doesNotMatch(all, /memory suggestions/i, 'dropped, spec §4.2');
  });

  test('each block names the failure it targets (spec §2 "Keeps from v1")', () => {
    assert.match(BLOCKS.conduct, /tool/i);
    assert.match(BLOCKS.conduct, /not (orders|instructions|commands)/i);
    assert.match(BLOCKS.memory, /secret/i);
    assert.match(BLOCKS.memory, /forget/);
    assert.match(BLOCKS.conversation, /contradict/i);
  });
});
