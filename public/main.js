// @ts-check
// public/main.js - the only file that wires the store, the socket service and
// the element (spec S3.0 §2.5).

import { createStore } from './state/store.js';
import { createSocketService } from './services/socket-service.js';
import { AppShell } from './components/app-shell.js';

const store = createStore({ connection: 'connecting', lastError: null, lastFrame: null });
const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/`;
const service = createSocketService({ store, url, WebSocket });
addEventListener('pagehide', () => service.dispose());

/** @param {Element} el */
const giveStore = (el) => {
  /** @type {AppShell} */ (el).store = store;
};
for (const el of document.querySelectorAll('aperio-app')) giveStore(el);
customElements.define('aperio-app', AppShell);
