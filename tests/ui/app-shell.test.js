// T3.0 - <aperio-app> shows the connection word and leaks no subscription
// (spec S3.0 §2.4, §3 item 2). A tiny HTMLElement stub, no jsdom.
//
// Test choices where the spec is silent: the module exports `AppShell`; main.js
// hands it the store as the `store` property before it is attached. Flagged.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { importPublic, installDomStub } from './ui-helpers.js';

let AppShell;
let createStore;

before(async () => {
  installDomStub();
  ({ AppShell } = await importPublic('components/app-shell.js'));
  ({ createStore } = await importPublic('state/store.js'));
});

function mount(store) {
  const el = new AppShell();
  el.store = store;
  el.connectedCallback();
  return el;
}

test('attached: shows the connection word as text and follows the store', () => {
  const store = createStore({ connection: 'connecting' });
  const el = mount(store);
  assert.match(el.textContent, /\bconnecting\b/);
  store.set('connection', 'open');
  assert.match(el.textContent, /\bopen\b/);
  store.set('connection', 'closed');
  assert.match(el.textContent, /\bclosed\b/);
});

test('removed: subscriberCount is 0 and the element stops following the store', () => {
  const store = createStore({ connection: 'connecting' });
  const el = mount(store);
  assert.ok(store.subscriberCount() >= 1, 'it subscribes while attached');
  el.disconnectedCallback();
  assert.equal(store.subscriberCount(), 0);
  const text = el.textContent;
  store.set('connection', 'open');
  assert.equal(el.textContent, text);
});

test('attached, removed and attached again: still exactly one live subscription set', () => {
  const store = createStore({ connection: 'connecting' });
  const el = mount(store);
  const live = store.subscriberCount();
  el.disconnectedCallback();
  el.connectedCallback();
  assert.equal(store.subscriberCount(), live);
  el.disconnectedCallback();
  assert.equal(store.subscriberCount(), 0);
});

test('many mounts and removes leave nothing behind', () => {
  const store = createStore({ connection: 'connecting' });
  for (let i = 0; i < 100; i++) mount(store).disconnectedCallback();
  assert.equal(store.subscriberCount(), 0);
});
