// T2.8 - contracts for the in-process tools (spec S2.8 §2, §3, §5).
// Fragile zone: the ctx shape is shared by every tool. This file freezes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MEMORY_TOOLS } from '../../src/tools/memory-tools.js';
import { makeToolCtx } from '../../src/tools/tool-loop.js';

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

test('5 tools in a fixed order, each { name, description, JSON schema, run() }, all frozen', () => {
  assert.deepEqual(MEMORY_TOOLS.map((t) => t.name), ['remember', 'recall', 'update', 'forget', 'list']);
  assert.ok(Object.isFrozen(MEMORY_TOOLS));
  for (const t of MEMORY_TOOLS) {
    assert.ok(Object.isFrozen(t), t.name);
    assert.ok(Object.isFrozen(t.parameters), t.name);
    assert.equal(typeof t.description, 'string');
    assert.equal(t.parameters.type, 'object');
    assert.equal(typeof t.run, 'function');
  }
});

test('required args: update and forget need id; list needs nothing', () => {
  const req = Object.fromEntries(MEMORY_TOOLS.map((t) => [t.name, t.parameters.required ?? []]));
  assert.deepEqual(req.update, ['id']);
  assert.deepEqual(req.forget, ['id']);
  assert.deepEqual(req.list, []);
  const list = MEMORY_TOOLS.find((t) => t.name === 'list').parameters.properties;
  assert.deepEqual(list.order.enum, ['importance', 'recent']);
});

test('ctx snapshot: exactly { config, embedder, log, store }, frozen', () => {
  const ctx = makeToolCtx({ store: {}, embedder: null, config: {}, log: console, extra: 1 });
  assert.deepEqual(Object.keys(ctx).sort(), ['config', 'embedder', 'log', 'store']);
  assert.ok(Object.isFrozen(ctx));
});

// S2.14: the per-turn code (and its ctx) moved from the eval adapter to the turn runner, which both call.
test('the turn runner builds ctx only through makeToolCtx; the adapter builds none', async () => {
  const runner = await readFile(root('src/chat/turn-runner.js'), 'utf8');
  assert.match(runner, /makeToolCtx\(/);
  assert.doesNotMatch(runner, /const ctx = \{/);
  const adapter = await readFile(root('src/eval/v2-live-adapter.js'), 'utf8');
  assert.doesNotMatch(adapter, /const ctx = \{/);
  assert.match(adapter, /createTurnRunner\(/);
});

test('no MCP: no @modelcontextprotocol dependency, no child_process in src/tools/', async () => {
  const pkg = JSON.parse(await readFile(root('package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
  assert.deepEqual(deps.filter((d) => d.startsWith('@modelcontextprotocol')), []);
  for (const name of await readdir(root('src/tools'))) {
    const src = await readFile(root(`src/tools/${name}`), 'utf8');
    assert.doesNotMatch(src, /child_process/, name);
  }
});
