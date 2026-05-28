// public/scripts/settings-panel.js
// Slide-in Settings drawer (right side, mirrors the wiki/sessions panels).
// Houses the preferences that used to clutter the sidebar footer: theme and
// voice responses. The theme buttons are wired by theme-and-timestamp.js; this
// module only drives the sound toggle and the open/close behaviour.
(() => {
  const panel    = () => document.getElementById("settings-panel");
  const backdrop = () => document.getElementById("settings-backdrop");
  const sound    = () => document.getElementById("settingsSoundToggle");

  // Reflect the current voice-response state on the switch + ON/OFF badge.
  function syncSound() {
    const on = window.Aperio?.settings?.get("aperio-tts") === "true";
    const el = sound();
    if (el) el.checked = on;
    const state = document.getElementById("settingsSoundState");
    if (state) {
      state.textContent = on ? "ON" : "OFF";
      state.classList.toggle("is-on", on);
    }
  }

  function wireSound() {
    const el = sound();
    if (!el || el.dataset.wired) return;
    el.dataset.wired = "1";
    el.addEventListener("change", () => {
      const desired = el.checked;
      const current = window.Aperio?.settings?.get("aperio-tts") === "true";
      // tts.toggle() flips + persists; only call it when state actually changes.
      if (desired !== current) window.Aperio?.tts?.toggle();
      syncSound();
    });
  }

  window.toggleSettingsPanel = function () {
    const p = panel(), b = backdrop();
    const opening = p.style.display === "none";
    if (opening) {
      wireSound();
      syncSound();
      p.style.display = "flex";
      b.style.display = "block";
    } else {
      p.style.display = "none";
      b.style.display = "none";
    }
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel()?.style.display !== "none") toggleSettingsPanel();
  });
})();
