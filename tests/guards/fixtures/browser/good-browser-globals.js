// @ts-check
// Allowed in public/: the browser globals a component and a service need.
export class UsesBrowser extends HTMLElement {
  connectedCallback() {
    this.textContent = document.title;
  }
}
export const open = (url) => new WebSocket(url);
export const define = () => customElements.define('uses-browser', UsesBrowser);
