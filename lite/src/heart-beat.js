// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS TO YOUR server.js (Express side)
// ─────────────────────────────────────────────────────────────────────────────
//
// The Deno launcher polls this endpoint every 5 seconds.
// Your browser SPA also calls it every 10 seconds to keep the session alive.
// When neither caller has pinged for 35 seconds, the launcher shuts everything down.

// Paste this route into your Express app setup, before app.listen():

app.get('/api/heartbeat', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});


// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS TO YOUR SPA (browser-side, e.g. main.js or App.jsx/App.svelte/etc.)
// ─────────────────────────────────────────────────────────────────────────────
//
// Paste this block into your SPA entry point.
// It runs a keepalive ping every 10 seconds while the tab is visible,
// and sends a final ping on beforeunload so the launcher knows immediately
// when the user closes or navigates away.

(function startHeartbeat() {
  const INTERVAL_MS = 10_000;
  let timer = null;

  async function ping() {
    try {
      await fetch('/api/heartbeat');
    } catch {
      // ignore — server may be shutting down
    }
  }

  function start() {
    if (!timer) timer = setInterval(ping, INTERVAL_MS);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Pause when tab is hidden, resume when visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ping();   // immediate ping on return
      start();
    } else {
      stop();
    }
  });

  // Final ping on close/navigate — uses sendBeacon so it actually fires
  window.addEventListener('beforeunload', () => {
    navigator.sendBeacon('/api/heartbeat');
    stop();
  });

  // Kick off on load
  ping();
  start();
})();