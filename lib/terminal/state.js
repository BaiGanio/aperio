// lib/terminal/state.js
// Module-level state shared between the SIGINT/Esc handlers (signals.js) and
// whichever mode is running (proxy.js / standalone.js). A single mutable
// object — rather than five separate `let` exports — so every read/write
// site is a property access and there's no live-binding subtlety across
// module boundaries.
export const state = {
  standaloneAbort: null,   // AbortController set while standalone is generating
  proxyWaiting:    false,  // true while proxy client awaits a server response
  proxySafeSend:   null,   // proxy's safeSend fn, used by SIGINT to send "stop"
  sessionId:       null,   // current standalone session id
  sessionMessages: null,   // reference to standalone messages array
};
