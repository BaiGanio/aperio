// src/eval/adapter-contract.js — the TargetAdapter / Session shape (spec
// S2.1 "Shape"). The runner talks only to this shape and never imports a
// target's internals. A missing method fails with its name.
//
// TargetAdapter = { name, start(opts): Promise<Session>, stop(): Promise<void> }
// Session = {
//   seedMemories(rows), recall(query, k, { mode }?) -> { titles },
//   turn(text) -> { events, text, assembled? }, reset()   // reset keeps the store
// }

export const ADAPTER_METHODS = Object.freeze(['start', 'stop']);
export const SESSION_METHODS = Object.freeze(['seedMemories', 'recall', 'turn', 'reset']);

function assertMethods(obj, methods, what) {
  if (!obj || typeof obj !== 'object') throw new Error(`${what}: not an object`);
  for (const method of methods) {
    if (typeof obj[method] !== 'function') throw new Error(`${what}: missing method ${method}()`);
  }
}

export function assertTargetAdapter(adapter) {
  assertMethods(adapter, ADAPTER_METHODS, 'TargetAdapter');
  if (typeof adapter.name !== 'string' || !adapter.name) throw new Error('TargetAdapter: missing name');
  return adapter;
}

export function assertSession(session) {
  assertMethods(session, SESSION_METHODS, 'Session');
  return session;
}
