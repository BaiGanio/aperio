// T3.0 helpers: run the browser modules in public/ under Node with no jsdom.
//
// 1. A resolve hook: in the browser, a file in public/ loads the shared schema at
//    /shared/ws-schema.js (the S2.14 route). On disk it is src/shared/ws-schema.js.
//    The hook maps both spellings, so the tests import the real public/ files.
// 2. A fake WebSocket the test drives by hand (open, message, drop).
// 3. A tiny HTMLElement stub (spec S3.0 §3: "tiny stub, no jsdom").

import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { Event, EventTarget } = globalThis; // Node globals the lint config does not list

export const REPO = path.resolve(import.meta.dirname, '..', '..');
export const PUBLIC_DIR = path.join(REPO, 'public');
const SCHEMA_URL = pathToFileURL(path.join(REPO, 'src', 'shared', 'ws-schema.js')).href;

let hooked = false;
/** Map /shared/ws-schema.js (and public/shared/ws-schema.js) to the real file. Safe to call twice. */
export function installSchemaHook() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      const fromPublic = context.parentURL?.includes('/public/');
      if (specifier === '/shared/ws-schema.js' || (fromPublic && specifier.endsWith('shared/ws-schema.js'))) {
        return { url: SCHEMA_URL, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}

/** Import a module from public/ by its path under public/. */
export async function importPublic(rel) {
  installSchemaHook();
  return import(pathToFileURL(path.join(PUBLIC_DIR, rel)).href);
}

/** An Event with extra fields (Node has no settable MessageEvent / CloseEvent fields). */
function makeEvent(type, fields = {}) {
  const e = new Event(type);
  for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v, enumerable: true });
  return e;
}

/**
 * A WebSocket the test drives. Fires both addEventListener listeners and on* props,
 * so the service may use either. Every instance is kept in FakeWebSocket.instances.
 */
export class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {FakeWebSocket[]} */
  static instances = [];
  static reset() { FakeWebSocket.instances = []; }

  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  /** @param {string} url */
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    /** @type {string[]} */
    this.sent = [];
    this.closeCalls = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  fire(type, fields) {
    const e = makeEvent(type, fields);
    this.dispatchEvent(e);
    const prop = this[`on${type}`];
    if (typeof prop === 'function') prop.call(this, e);
  }

  // --- driven by the test ---
  open() { this.readyState = 1; this.fire('open'); }
  /** @param {unknown} data  a string is sent as is; anything else as JSON */
  message(data) { this.fire('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  /** The server goes away: error (optional) then close. */
  drop({ code = 1006, error = true } = {}) {
    if (this.readyState === 3) return;
    if (error) this.fire('error');
    this.readyState = 3;
    this.fire('close', { code, reason: '', wasClean: false });
  }

  // --- called by the service ---
  /** @param {string} data */
  send(data) {
    if (this.readyState !== 1) throw new Error('FakeWebSocket: send while not open');
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closeCalls++;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', { code, reason: '', wasClean: true });
  }
}

/** The newest fake socket. */
export const lastSocket = () => FakeWebSocket.instances.at(-1);

let stubbed = false;
/**
 * Just enough DOM for a Web Component class to load and run its callbacks:
 * HTMLElement (with textContent) and a customElements registry. No jsdom.
 */
export function installDomStub() {
  if (stubbed) return;
  stubbed = true;
  globalThis.HTMLElement ??= class HTMLElement extends EventTarget {
    constructor() {
      super();
      this.textContent = '';
    }
  };
  const registry = new Map();
  globalThis.customElements ??= {
    define: (name, cls) => {
      if (registry.has(name)) throw new Error(`${name} already defined`);
      registry.set(name, cls);
    },
    get: (name) => registry.get(name),
  };
}
