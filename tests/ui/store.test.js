// T3.0 - the UI store (spec S3.0 §2.2, §3 item 1). The one place UI state
// changes; components subscribe to keys. Plain ESM from public/, no build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importPublic } from './ui-helpers.js';

const { createStore } = await importPublic('state/store.js');

test('get returns the initial value; an unknown key is undefined', () => {
  const s = createStore({ connection: 'connecting' });
  assert.equal(s.get('connection'), 'connecting');
  assert.equal(s.get('nope'), undefined);
});

test('set notifies each subscriber of that key once, with the new value', () => {
  const s = createStore({ connection: 'connecting' });
  const seen = [];
  s.subscribe('connection', (v) => seen.push(v));
  s.set('connection', 'open');
  assert.deepEqual(seen, ['open']);
  assert.equal(s.get('connection'), 'open');
});

test('set does not notify subscribers of other keys', () => {
  const s = createStore({ connection: 'connecting', lastError: null });
  let calls = 0;
  s.subscribe('lastError', () => calls++);
  s.set('connection', 'open');
  assert.equal(calls, 0);
});

test('the same value (Object.is) does not notify', () => {
  const s = createStore({ connection: 'open', n: Number.NaN });
  let calls = 0;
  s.subscribe('connection', () => calls++);
  s.subscribe('n', () => calls++);
  s.set('connection', 'open');
  s.set('n', Number.NaN);
  assert.equal(calls, 0);
});

test('unsubscribe stops the calls and lowers subscriberCount', () => {
  const s = createStore({ connection: 'connecting' });
  let calls = 0;
  const off = s.subscribe('connection', () => calls++);
  assert.equal(s.subscriberCount(), 1);
  off();
  assert.equal(s.subscriberCount(), 0);
  s.set('connection', 'open');
  assert.equal(calls, 0);
  off(); // twice is harmless
  assert.equal(s.subscriberCount(), 0);
});

test('subscriberCount counts every subscription on every key', () => {
  const s = createStore({ a: 1, b: 2 });
  const offs = [s.subscribe('a', () => {}), s.subscribe('a', () => {}), s.subscribe('b', () => {})];
  assert.equal(s.subscriberCount(), 3);
  for (const off of offs) off();
  assert.equal(s.subscriberCount(), 0);
});

test('two stores do not share state (no module state)', () => {
  const a = createStore({ connection: 'connecting' });
  const b = createStore({ connection: 'connecting' });
  a.set('connection', 'open');
  assert.equal(b.get('connection'), 'connecting');
});
