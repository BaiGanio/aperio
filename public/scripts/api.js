// ── Version ─────────────────────────────────────────────────────
fetch('/api/version')
  .then(res => res.json())
  .then(data => {
    document.getElementById('version-display').innerText = 'v' + data.version;
  })
  .catch(() => {});

// Pings /api/heartbeat on an interval (HEARTBEAT_INTERVAL_SECONDS, default 60 s).
// The server shuts itself (and llama.cpp) down if no ping arrives for
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

// ── Power menu (navbar) — Restart / Quit popover ─────────────────
(function initPowerMenu() {
  const menu = document.getElementById('powerMenu');
  const btn  = document.getElementById('powerBtn');
  if (!menu || !btn) return;

  const close  = () => { menu.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); };
  const toggle = () => {
    const open = menu.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', String(open));
  };

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // Under a supervisor (Docker/PM2/systemd) a quit is relaunched immediately —
  // disable the option and say why instead of pretending to stop.
  fetch('/api/restart/capability')
    .then(r => r.json())
    .then(({ supervised }) => {
      if (!supervised) return;
      const quitBtn = document.getElementById('powerQuitBtn');
      if (!quitBtn) return;
      quitBtn.disabled = true;
      quitBtn.title = t('power_quit_supervised');
    })
    .catch(() => {});
})();

// "Quit Aperio" — stop the server (and vendored llama.cpp) right now.
window.quitAperio = async function quitAperio() {
  if (!await askConfirmModal(t('nav_power_quit'), t('power_quit_confirm'), 'Quit')) return;
  let supervised = false;
  try {
    const res = await fetch('/api/quit', { method: 'POST' });
    if (res.status === 409) supervised = (await res.json()).supervised === true;
  } catch (_e) {}
  if (supervised) {
    showErrorModal(t('power_quit_supervised'));
    return;
  }
  document.body.innerHTML =
    '<div style="display:flex;height:100vh;align-items:center;justify-content:center;' +
    'font-family:system-ui,sans-serif;color:#888;text-align:center;padding:2rem">' +
    '<div><h2>' + t('power_stopped_title') + '</h2><p>' + t('power_stopped_msg') + '</p></div></div>';
};
