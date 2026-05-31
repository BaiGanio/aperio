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

  // ── Model selector ────────────────────────────────────────────────────────

  const PROVIDER_LABELS = { ollama: "Ollama (local)", anthropic: "Anthropic", deepseek: "DeepSeek", gemini: "Google Gemini" };

  async function loadModels() {
    const sel = document.getElementById("modelSelect");
    if (!sel) return;
    try {
      const data = await fetch("/api/models").then(r => r.json());
      sel.innerHTML = "";
      let hasOptions = false;
      for (const [prov, models] of Object.entries(data.providers || {})) {
        if (!models.length) continue;
        const grp = document.createElement("optgroup");
        grp.label = PROVIDER_LABELS[prov] || prov;
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = JSON.stringify({ provider: prov, model: m });
          opt.textContent = m;
          if (prov === data.provider && m === data.model) opt.selected = true;
          grp.appendChild(opt);
        }
        sel.appendChild(grp);
        hasOptions = true;
      }
      if (!hasOptions) {
        sel.innerHTML = "<option>No models found</option>";
        return;
      }
      // If the user picked a model while this fetch was in-flight, restore it.
      if (sel.dataset.pending) {
        for (const opt of sel.options) {
          if (opt.value === sel.dataset.pending) { opt.selected = true; break; }
        }
      }
      sel.disabled = false;
    } catch {
      sel.innerHTML = "<option>Failed to load models</option>";
    }
  }

  function getStatus(sel) {
    let status = sel.nextElementSibling;
    if (!status || !status.classList.contains("model-select-status")) {
      status = document.createElement("div");
      status.className = "model-select-status";
      sel.insertAdjacentElement("afterend", status);
    }
    return status;
  }

  function wireModelSelect() {
    const sel = document.getElementById("modelSelect");
    if (!sel || sel.dataset.wired) return;
    sel.dataset.wired = "1";
    sel.addEventListener("change", () => {
      let config;
      try { config = JSON.parse(sel.value); } catch { return; }
      // Remember the user's intent so a racing loadModels() doesn't reset it.
      sel.dataset.pending = sel.value;
      const status = getStatus(sel);
      status.textContent = "Switching…";
      status.className = "model-select-status";
      // Send via WebSocket so the server can clear cross-provider history and
      // re-emit the provider event (which updates the badge automatically).
      if (typeof window.wsSafeSend === "function") {
        window.wsSafeSend({ type: "switch_model", provider: config.provider, model: config.model });
        status.textContent = `Switched to ${config.model}`;
        status.className = "model-select-status is-ok";
      } else {
        status.textContent = "Not connected — reload and try again";
        status.className = "model-select-status is-err";
      }
    });
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  window.toggleSettingsPanel = function () {
    const p = panel(), b = backdrop();
    const opening = p.style.display === "none";
    if (opening) {
      wireSound();
      syncSound();
      wireModelSelect();
      loadModels();
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
