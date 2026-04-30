// ── Version ─────────────────────────────────────────────────────
fetch('/api/version')
  .then(res => res.json())
  .then(data => {
    document.getElementById('version-display').innerText = 'v' + data.version;
  })
  .catch(() => {});

// Pings /api/heartbeat every 10 s unconditionally.
// The server shuts itself (and Ollama) down if no ping arrives for 30 s —
// which happens naturally when every tab is closed. No beforeunload needed.
(async function startHeartbeat() {
  const { heartbeatIntervalSeconds } = await fetch('/api/config/client').then(r => r.json());
  const INTERVAL_MS = heartbeatIntervalSeconds * 1000;

  function ping() {
    fetch('/api/heartbeat').catch(() => {}); // ignore — server may be stopping
  }

  setInterval(ping, INTERVAL_MS);
  ping(); // immediate ping on load
})();