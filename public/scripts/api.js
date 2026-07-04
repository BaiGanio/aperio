// ── Version ─────────────────────────────────────────────────────
fetch('/api/version')
  .then(res => res.json())
  .then(data => {
    document.getElementById('version-display').innerText = 'v' + data.version;
  })
  .catch(() => {});

// Pings /api/heartbeat on an interval (HEARTBEAT_INTERVAL_SECONDS, default 60 s).
// The server shuts itself (and Ollama) down if no ping arrives for
// IDLE_TIMEOUT_SECONDS (default 180 s) — which happens naturally when every tab
// is closed. No beforeunload/sendBeacon needed.
(async function startHeartbeat() {
  const { heartbeatIntervalSeconds } = await fetch('/api/config/client').then(r => r.json());
  const INTERVAL_MS = heartbeatIntervalSeconds * 1000;

  function ping() {
    fetch('/api/heartbeat').catch(() => {}); // ignore — server may be stopping
  }

  setInterval(ping, INTERVAL_MS);
  // Background tabs throttle setInterval; ping the moment we're foregrounded
  // again so a returning user re-arms the idle timer immediately.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
  ping(); // immediate ping on load
})();

// "Quit Aperio" button — stop the server (and vendored Ollama) right now.
window.quitAperio = async function quitAperio() {
  if (!confirm('Quit Aperio? The server will stop and this tab will no longer work until you start it again.')) return;
  try { await fetch('/api/quit', { method: 'POST' }); } catch (_e) {}
  document.body.innerHTML =
    '<div style="display:flex;height:100vh;align-items:center;justify-content:center;' +
    'font-family:system-ui,sans-serif;color:#888;text-align:center;padding:2rem">' +
    '<div><h2>Aperio has stopped.</h2><p>You can close this tab.</p></div></div>';
};
