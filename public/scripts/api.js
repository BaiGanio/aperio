// ── Version ─────────────────────────────────────────────────────
fetch('/api/version')
  .then(res => res.json())
  .then(data => {
    document.getElementById('version-display').innerText = 'v' + data.version;
  })
  .catch(() => {});


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