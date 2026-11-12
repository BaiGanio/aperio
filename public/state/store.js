// @ts-check
// public/state/store.js - the one place UI state changes (spec S3.0 §2.2).
// Components subscribe to a key; set() notifies only when the value changed.
// No module state: every createStore() call is its own store.

/**
 * @typedef {object} Store
 * @property {(key: string) => unknown} get
 * @property {(key: string, value: unknown) => void} set
 * @property {(key: string, fn: (value: unknown) => void) => () => void} subscribe  returns unsubscribe
 * @property {() => number} subscriberCount  every live subscription, on every key (the leak test)
 */

/**
 * @param {Record<string, unknown>} initial  the fixed key names (no unbounded map of keys)
 * @returns {Store}
 */
export function createStore(initial) {
  /** @type {Record<string, unknown>} */
  const state = { ...initial };
  const events = new EventTarget();
  let count = 0;

  return {
    get: (key) => (Object.hasOwn(state, key) ? state[key] : undefined),
    set(key, value) {
      if (Object.hasOwn(state, key) && Object.is(state[key], value)) return;
      state[key] = value;
      events.dispatchEvent(new CustomEvent(key, { detail: value }));
    },
    subscribe(key, fn) {
      /** @param {Event} e */
      const listener = (e) => fn(/** @type {CustomEvent} */ (e).detail);
      events.addEventListener(key, listener);
      count++;
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        events.removeEventListener(key, listener);
        count--;
      };
    },
    subscriberCount: () => count,
  };
}
