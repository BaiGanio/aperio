// public/scripts/capabilities-panel.js
// "Extras" section inside the Settings panel. Shows the status of optional
// skill dependencies (the docx Python toolchain) and lets the user:
//   • auto-install pip deps (lxml, defusedxml) into the project venv
//   • copy a platform-specific command for system binaries we can't install
//     from the browser (LibreOffice, poppler), then Re-check.
// Detection + install are backed by /api/capabilities and /api/capabilities/install.
(() => {
  const tiersEl = () => document.getElementById("extras-tiers");
  const summary = () => document.getElementById("extrasSummary");
  let _loaded = false;

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  async function get(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  function depRow(dep) {
    if (dep.present) {
      return `<div class="extras-dep is-ok">✅ <span>${escapeHtml(dep.name)}</span></div>`;
    }
    if (dep.auto) {
      return `<div class="extras-dep">
        <span>◯ ${escapeHtml(dep.name)}</span>
        <button class="paths-apply-btn extras-install-btn" data-action="install">Install</button>
      </div>`;
    }
    // System binary: guided command + copy button.
    return `<div class="extras-dep extras-dep--guided">
      <span>◯ ${escapeHtml(dep.name)}</span>
      <code class="extras-cmd">${escapeHtml(dep.hint || "see docs")}</code>
      <button class="paths-pick-btn extras-copy-btn" data-copy="${escapeHtml(dep.hint || "")}" title="Copy command"><i class="bi bi-clipboard"></i></button>
    </div>`;
  }

  function tierRow(t) {
    const icon = t.ready ? "✅" : "◯";
    const deps = t.deps.map(depRow).join("");
    return `<div class="extras-tier" data-ready="${t.ready}">
      <div class="extras-tier-title">${icon} ${escapeHtml(t.label)}</div>
      <div class="paths-section-hint">${escapeHtml(t.note)}</div>
      ${deps}
    </div>`;
  }

  function render(data) {
    const ready = data.tiers.filter(t => t.ready).length;
    if (summary()) summary().textContent = `${ready}/${data.tiers.length} ready`;
    tiersEl().innerHTML =
      data.tiers.map(tierRow).join("") +
      `<button class="paths-pick-btn extras-recheck" data-action="recheck" style="margin-top:8px">
        <i class="bi bi-arrow-clockwise"></i> Re-check
      </button>`;
    wire();
  }

  async function load() {
    try {
      render(await get("/api/capabilities"));
      _loaded = true;
    } catch (err) {
      tiersEl().innerHTML = `<div class="paths-section-hint">Couldn't check capabilities: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function install(btn) {
    btn.disabled = true;
    btn.textContent = "Installing… (may take a minute)";
    try {
      const res = await fetch("/api/capabilities/install", { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `${res.status}`);
      render(d.capabilities);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Install";
      const msg = document.createElement("div");
      msg.className = "paths-section-hint";
      msg.textContent = `Install failed: ${err.message}`;
      btn.after(msg);
    }
  }

  async function copyCmd(btn) {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const old = btn.innerHTML;
      btn.innerHTML = '<i class="bi bi-clipboard-check"></i>';
      setTimeout(() => { btn.innerHTML = old; }, 1500);
    } catch (err) {
      btn.title = `Copy failed: ${err.message}`;
    }
  }

  function wire() {
    tiersEl().querySelectorAll('[data-action="install"]').forEach(b =>
      b.addEventListener("click", () => install(b)));
    tiersEl().querySelectorAll('[data-action="recheck"]').forEach(b =>
      b.addEventListener("click", load));
    tiersEl().querySelectorAll(".extras-copy-btn").forEach(b =>
      b.addEventListener("click", () => copyCmd(b)));
  }

  // Lazy-load on first expand of the Extras section.
  document.addEventListener("DOMContentLoaded", () => {
    const section = document.getElementById("extrasSection");
    section?.addEventListener("toggle", () => {
      if (section.open && !_loaded) load();
    });
  });
})();
