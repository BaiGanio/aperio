// ── Settings (DB-backed preferences) ────────────────────────────────────────
// Bridges the client preference toggles (theme, sound, voice, reasoning) to the
// server-side settings store (GET/PUT /api/settings), so they persist in the DB
// instead of only in this browser's localStorage.
//
// Strategy — local-first with a boot sync:
//   • Reads stay synchronous off localStorage (no network flash on load).
//   • set() writes localStorage immediately, then PUTs to the server in the
//     background (fire-and-forget — the local value is the fast path).
//   • On boot, init() reconciles with the server:
//       – server has the key → server wins: copy to localStorage + apply().
//       – server lacks it but localStorage has one → seed it up to the server
//         once (migrating this device's existing preference into the DB).
//
// Consumers register an apply(value) hook so a server value picked up at boot
// (e.g. set on another device) is reflected in the UI without a manual reload.
(function () {
  window.Aperio = window.Aperio || {};

  // localStorage keys that mirror to the DB. Device-local view state
  // (aperio-sidebar, wiki-collapsed, language) is intentionally excluded.
  const KEYS = ["aperio-theme", "aperio-tts", "aperio-voice-continuous", "aperio-reasoning", "aperio-busy-words"];

  const appliers = new Map();

  /** Synchronous, local-first read. */
  function get(key, fallback = null) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  }

  /** Write-through: localStorage now, server in the background. */
  function set(key, value) {
    const str = String(value);
    localStorage.setItem(key, str);
    fetch(`/api/settings/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: str }),
    }).catch(() => {}); // local value already applied; server sync is best-effort
  }

  /** Register a UI hook so a server value adopted at boot is reflected live. */
  function register(key, apply) {
    appliers.set(key, apply);
  }

  async function init() {
    let server;
    try {
      server = await fetch("/api/settings").then(r => r.json());
    } catch {
      return; // offline / server starting — keep using localStorage values
    }
    for (const key of KEYS) {
      if (key in server) {
        // Server wins. Values are stored as strings to match localStorage.
        const val = String(server[key]);
        if (localStorage.getItem(key) !== val) {
          localStorage.setItem(key, val);
          appliers.get(key)?.(val);
        }
      } else if (localStorage.getItem(key) !== null) {
        // One-time migration: push this device's existing preference to the DB.
        set(key, localStorage.getItem(key));
      }
    }
  }

  window.Aperio.settings = { get, set, register, init };
  document.addEventListener("DOMContentLoaded", init);
})();
