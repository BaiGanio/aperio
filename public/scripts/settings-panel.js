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

  // ── Busy words ────────────────────────────────────────────────────────────
  // User-added words to cycle next to the live cursor. Stored as a newline list
  // in the DB-backed settings store; chat.js merges them with its defaults live.
  function wireBusyWords() {
    const ta = document.getElementById("busyWordsInput");
    if (!ta || ta.dataset.wired) return;
    ta.dataset.wired = "1";
    ta.value = window.Aperio?.settings?.get("aperio-busy-words") || "";
    ta.addEventListener("input", () => {
      window.Aperio?.settings?.set("aperio-busy-words", ta.value);
    });
  }

  // ── Model selector ────────────────────────────────────────────────────────

  const PROVIDER_LABELS = { ollama: "Ollama (local)", anthropic: "Anthropic", deepseek: "DeepSeek" /*, gemini: "Google Gemini" */ };

  // Reflect the active model name in the collapsed summary, so the current pick
  // is visible without expanding the section.
  function updateModelCurrent() {
    const cur = document.getElementById("modelCurrent");
    if (!cur) return;
    const active = document.querySelector(".model-option.is-active .model-option-name");
    cur.textContent = active ? active.textContent : "";
  }

  // Mark the matching row active. Exposed for streaming.js to sync on the
  // provider event (e.g. after the server confirms or auto-switches a model).
  window.syncModelSelection = function (provider, model) {
    const list = document.getElementById("modelList");
    if (!list) return;
    list.querySelectorAll(".model-option").forEach(o =>
      o.classList.toggle("is-active", o.dataset.provider === provider && o.dataset.model === model));
    updateModelCurrent();
  };

  async function loadModels() {
    const list = document.getElementById("modelList");
    if (!list) return;
    try {
      const data = await fetch("/api/models").then(r => r.json());
      list.innerHTML = "";
      let hasOptions = false;
      for (const [prov, models] of Object.entries(data.providers || {})) {
        if (!models.length) continue;
        const grp = document.createElement("div");
        grp.className = "model-group";
        const head = document.createElement("div");
        head.className = "model-group-label";
        head.textContent = PROVIDER_LABELS[prov] || prov;
        grp.appendChild(head);
        for (const m of models) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "model-option";
          row.dataset.provider = prov;
          row.dataset.model = m;
          if (prov === data.provider && m === data.model) row.classList.add("is-active");
          const name = document.createElement("span");
          name.className = "model-option-name";
          name.textContent = m;
          const check = document.createElement("i");
          check.className = "bi bi-check-lg model-option-check";
          row.append(name, check);
          row.addEventListener("click", () => selectModel(prov, m));
          grp.appendChild(row);
        }
        list.appendChild(grp);
        hasOptions = true;
      }
      if (!hasOptions) {
        list.innerHTML = `<span class="model-loading">No models found</span>`;
        return;
      }
      updateModelCurrent();
    } catch {
      list.innerHTML = `<span class="model-loading">Failed to load models</span>`;
    }
  }

  function selectModel(provider, model) {
    window.syncModelSelection(provider, model);
    const status = document.getElementById("modelStatus");
    if (!status) return;
    // Send via WebSocket so the server can clear cross-provider history and
    // re-emit the provider event (which updates the badge automatically).
    if (typeof window.wsSafeSend === "function") {
      window.wsSafeSend({ type: "switch_model", provider, model });
      status.textContent = `Switched to ${model}`;
      status.className = "model-select-status is-ok";
    } else {
      status.textContent = "Not connected — reload and try again";
      status.className = "model-select-status is-err";
    }
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  window.toggleSettingsPanel = function () {
    const p = panel(), b = backdrop();
    const opening = p.style.display === "none";
    if (opening) {
      wireSound();
      syncSound();
      wireBusyWords();
      loadModels();
      window.loadGithubTriageSettings?.();
      window.loadDbConnections?.();
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
