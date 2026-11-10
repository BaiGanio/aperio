// tests/eval/eval-adapter-contract.test.js — T2.1: the TargetAdapter /
// Session contract (spec S2.1 §2 "Shape"). The runner never imports a
// target's internals; it only talks to this shape.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTargetAdapter, assertSession, ADAPTER_METHODS, SESSION_METHODS } from '../../src/eval/adapter-contract.js';
import { makeFakeAdapter } from './fake-adapter.js';

describe('adapter contract', () => {
  test('a fake adapter satisfies the full TargetAdapter shape', () => {
    assert.doesNotThrow(() => assertTargetAdapter(makeFakeAdapter()));
  });

  test('a fake session satisfies the full Session shape', async () => {
    const adapter = makeFakeAdapter();
    const session = await adapter.start({});
    assert.doesNotThrow(() => assertSession(session));
    await adapter.stop();
  });

  test('the contract names exactly the spec methods', () => {
    assert.deepEqual([...ADAPTER_METHODS].sort(), ['start', 'stop']);
    assert.deepEqual([...SESSION_METHODS].sort(), ['recall', 'reset', 'seedMemories', 'turn']);
  });

  for (const method of ['start', 'stop']) {
    test(`an adapter with no ${method}() fails with the method name`, () => {
      const adapter = makeFakeAdapter();
      delete adapter[method];
      assert.throws(() => assertTargetAdapter(adapter), new RegExp(`\\b${method}\\b`));
    });
  }

  test('an adapter with no name fails with "name"', () => {
    const adapter = makeFakeAdapter();
    delete adapter.name;
    assert.throws(() => assertTargetAdapter(adapter), /\bname\b/);
  });

  for (const method of ['seedMemories', 'recall', 'turn', 'reset']) {
    test(`a session with no ${method}() fails with the method name`, async () => {
      const adapter = makeFakeAdapter();
      const session = await adapter.start({});
      delete session[method];
      assert.throws(() => assertSession(session), new RegExp(`\\b${method}\\b`));
      await adapter.stop();
    });
  }
});
