// @ts-check
// public/components/app-shell.js - <aperio-app>: shows the connection word (spec S3.0 §2.4).
// It gets the store as `el.store` (set by main.js before attach); it never sees
// the socket. Text only (textContent), never innerHTML.

/** @typedef {import('../state/store.js').Store} Store */

export class AppShell extends HTMLElement {
  constructor() {
    super();
    // main.js may set `store` before define() upgrades this element: keep it.
    const preset = /** @type {{ store?: Store }} */ (/** @type {unknown} */ (this)).store;
    /** @type {Store | null} */
    this.store = preset ?? null;
    /** @type {Array<() => void>} */
    this.offs = [];
  }

  connectedCallback() {
    this.release();
    const store = this.store;
    if (!store) return;
    /** @param {unknown} state */
    const show = (state) => {
      this.textContent = `Aperio: ${String(state)}`;
    };
    show(store.get('connection'));
    this.offs.push(store.subscribe('connection', show));
  }

  disconnectedCallback() {
    this.release();
  }

  /** Drop every subscription this element holds. */
  release() {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
