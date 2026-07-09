// public/scripts/skills-panel.js
// Skills manager: a right-side panel that lets non-technical users see every
// skill their agent has, edit it in place, toggle "always-on", create new ones
// and remove the ones they don't want — all without touching project files.
//
// Backed by:
//   GET    /api/skills/manage     — list (incl. disabled) with source/flags
//   GET    /api/skill/edit?name=  — editable body + fields
//   POST   /api/skill             — create new
//   PUT    /api/skill             — edit / toggle always-on
//   DELETE /api/skill?name=       — remove (user) or disable (shipped)
//   POST   /api/skill/reset       — restore a shipped skill to its default
//
// Edits are written to var/skills/ overlay files; the shipped skills/ tree is
// never modified, so app updates stay clean and "reset" just drops the overlay.
(() => {
  const panel    = () => document.getElementById("skills-panel");
  const backdrop = () => document.getElementById("skills-backdrop");
  const body     = () => document.getElementById("sk-panel-body");
  const search   = () => document.getElementById("skSearchInput");

  let _skills = [];

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ── List ────────────────────────────────────────────────────────────────────
  async function load() {
    try {
      const data = await api("/api/skills/manage");
      _skills = data.skills || [];
      render();
    } catch (err) {
      body().innerHTML = `<div class="sk-empty">${escapeHtml(t("skills_panel_load_failed", { error: err.message }))}</div>`;
    }
  }

  function render() {
    const q = (search().value || "").toLowerCase().trim();
    const rows = _skills.filter(s =>
      !q || s.name.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q));
    if (!rows.length) {
      body().innerHTML = `<div class="sk-empty">${t(q ? "skills_panel_empty_filtered" : "skills_panel_empty_none")}</div>`;
      return;
    }
    body().innerHTML = rows.map(rowHtml).join("");
    wire();
  }

  function rowHtml(s) {
    const badges =
      (s.overridden || s.source === "user" && !s.disabled ? `<span class="sk-badge sk-badge--custom">${t("skills_panel_badge_customized")}</span>` : "") +
      (s.source === "user" && !s.overridden ? `<span class="sk-badge sk-badge--custom">${t("skills_panel_badge_yours")}</span>` : "") +
      (s.disabled ? `<span class="sk-badge sk-badge--off">${t("skills_panel_badge_off")}</span>` : "");
    const alwaysOn = s.load === "always";
    // A user-created skill (no shipped original) can be deleted outright; a
    // shipped skill is disabled instead. "Restore" only appears once a shipped
    // skill carries an overlay (edited or disabled).
    const restore = (s.source === "user" && (s.overridden || s.disabled))
      ? `<button class="sk-icon-btn" data-act="reset" data-name="${escapeHtml(s.name)}" title="${escapeHtml(t("skills_panel_restore_title"))}"><i class="bi bi-arrow-counterclockwise"></i></button>` : "";
    return `<div class="sk-row" data-disabled="${s.disabled}">
      <div class="sk-row-main">
        <div class="sk-row-name">${escapeHtml(s.name)} ${badges}</div>
        <div class="sk-row-desc">${escapeHtml(s.description || "—")}</div>
        <label class="sk-switch" title="${escapeHtml(t("skills_panel_switch_title"))}" style="margin-top:8px">
          <input type="checkbox" data-act="always" data-name="${escapeHtml(s.name)}" ${alwaysOn ? "checked" : ""} ${s.disabled ? "disabled" : ""}>
          <span class="sk-switch-track"></span>
          <span class="sk-switch-label">${t("skills_always_badge")}</span>
        </label>
      </div>
      <div class="sk-row-actions">
        <button class="sk-icon-btn" data-act="edit" data-name="${escapeHtml(s.name)}" title="${escapeHtml(t("skills_panel_edit_title"))}"><i class="bi bi-pencil"></i></button>
        ${restore}
        <button class="sk-icon-btn sk-danger" data-act="remove" data-name="${escapeHtml(s.name)}" data-shipped="${s.source === "bundled" || s.overridden}" title="${escapeHtml(t("skills_panel_remove_title"))}"><i class="bi bi-trash"></i></button>
      </div>
    </div>`;
  }

  function wire() {
    body().querySelectorAll('[data-act="edit"]').forEach(b =>
      b.addEventListener("click", () => openSkillEditor(b.dataset.name)));
    body().querySelectorAll('[data-act="always"]').forEach(b =>
      b.addEventListener("change", () => toggleAlwaysOn(b.dataset.name, b.checked, b)));
    body().querySelectorAll('[data-act="remove"]').forEach(b =>
      b.addEventListener("click", () => removeSkill(b.dataset.name, b.dataset.shipped === "true")));
    body().querySelectorAll('[data-act="reset"]').forEach(b =>
      b.addEventListener("click", () => resetSkill(b.dataset.name)));
  }

  // ── Row actions ───────────────────────────────────────────────────────────────
  // Flip always-on in a single call; the server preserves the skill's body.
  async function toggleAlwaysOn(name, on, input) {
    input.disabled = true;
    try {
      await api("/api/skill/load", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, load: on ? "always" : "on-demand" }),
      });
      await load();
    } catch (err) {
      input.checked = !on;
      showErrorModal(t("skills_panel_update_failed", { error: err.message }));
    } finally {
      input.disabled = false;
    }
  }

  async function removeSkill(name, shipped) {
    const msg = t(shipped ? "skills_panel_disable_confirm" : "skills_panel_delete_confirm", { name });
    if (!confirm(msg)) return;
    try {
      await api(`/api/skill?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      await load();
    } catch (err) { showErrorModal(t("skills_panel_remove_failed", { error: err.message })); }
  }

  async function resetSkill(name) {
    if (!confirm(t("skills_panel_reset_confirm", { name }))) return;
    try {
      await api("/api/skill/reset", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await load();
    } catch (err) { showErrorModal(t("skills_panel_reset_failed", { error: err.message })); }
  }

  // ── Editor modal ──────────────────────────────────────────────────────────────
  function ensureEditor() {
    let overlay = document.getElementById("skill-edit-modal");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "skill-edit-modal";
    overlay.className = "fpm-overlay";
    overlay.innerHTML =
      `<div class="fpm-dialog">
        <div class="fpm-header">
          <div class="fpm-title-group">
            <span class="fpm-icon">✦</span>
            <span class="fpm-filename" id="skEditTitle"></span>
          </div>
          <div class="fpm-actions">
            <button class="fpm-close-btn" id="skEditClose" title="${escapeHtml(t("skills_panel_close_title"))}"><i class="bi bi-x-lg"></i></button>
          </div>
        </div>
        <div class="fpm-body">
          <div class="sk-edit-field">
            <label>${t("skills_panel_field_name")}</label>
            <input type="text" id="skEditName" placeholder="${escapeHtml(t("skills_panel_name_ph"))}" autocomplete="off">
            <div class="sk-edit-hint">${t("skills_panel_name_hint")}</div>
          </div>
          <div class="sk-edit-field">
            <label>${t("skills_panel_field_desc")}</label>
            <input type="text" id="skEditDesc" placeholder="${escapeHtml(t("skills_panel_desc_ph"))}" autocomplete="off">
          </div>
          <div class="sk-edit-field">
            <label>${t("skills_panel_field_keywords")}</label>
            <input type="text" id="skEditKeywords" placeholder="${escapeHtml(t("skills_panel_keywords_ph"))}" autocomplete="off">
          </div>
          <div class="sk-edit-field">
            <label>${t("skills_panel_field_load")}</label>
            <select id="skEditLoad">
              <option value="on-demand">${t("skills_panel_load_on_demand")}</option>
              <option value="always">${t("skills_panel_load_always")}</option>
              <option value="never">${t("skills_panel_load_never")}</option>
            </select>
          </div>
          <div class="sk-edit-field">
            <label>${t("skills_panel_field_body")}</label>
            <textarea id="skEditBody" placeholder="${escapeHtml(t("skills_panel_body_ph"))}"></textarea>
          </div>
          <div class="sk-edit-error" id="skEditError" style="display:none"></div>
          <div class="sk-edit-footer">
            <span class="sk-spacer"></span>
            <button class="sk-btn sk-btn--ghost" id="skEditCancel">${t("skills_panel_cancel")}</button>
            <button class="sk-btn sk-btn--primary" id="skEditSave">${t("skills_panel_save")}</button>
          </div>
        </div>
      </div>`;
    const close = () => overlay.classList.remove("open");
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector("#skEditClose").addEventListener("click", close);
    overlay.querySelector("#skEditCancel").addEventListener("click", close);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && overlay.classList.contains("open")) close();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  // Exposed globally so the in-chat skill chip can open the editor too.
  window.openSkillEditor = async function (name, { isNew = false } = {}) {
    const overlay = ensureEditor();
    const $ = id => overlay.querySelector(id);
    const err = $("#skEditError");
    err.style.display = "none";

    let data = { name: "", description: "", keywords: "", load: "on-demand", body: "" };
    if (!isNew && name) {
      try { data = await api(`/api/skill/edit?name=${encodeURIComponent(name)}`); }
      catch (e) { showErrorModal(t("skills_panel_open_failed", { error: e.message })); return; }
    }

    $("#skEditTitle").textContent = isNew ? t("skills_panel_new_title") : data.name;
    $("#skEditName").value = data.name;
    $("#skEditName").readOnly = !isNew;       // identity is fixed once created
    $("#skEditDesc").value = data.description || "";
    $("#skEditKeywords").value = data.keywords || "";
    $("#skEditLoad").value = data.load || "on-demand";
    $("#skEditBody").value = data.body || "";

    const saveBtn = $("#skEditSave");
    saveBtn.onclick = async () => {
      const payload = {
        name: $("#skEditName").value.trim(),
        description: $("#skEditDesc").value.trim(),
        keywords: $("#skEditKeywords").value.trim(),
        load: $("#skEditLoad").value,
        body: $("#skEditBody").value,
      };
      saveBtn.disabled = true;
      err.style.display = "none";
      try {
        await api("/api/skill", {
          method: isNew ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        overlay.classList.remove("open");
        await load();
      } catch (e) {
        err.textContent = e.message;
        err.style.display = "block";
      } finally {
        saveBtn.disabled = false;
      }
    };

    overlay.classList.add("open");
    setTimeout(() => $(isNew ? "#skEditName" : "#skEditBody").focus(), 50);
  };

  // ── Toggle ────────────────────────────────────────────────────────────────────
  window.toggleSkillsPanel = function () {
    const open = panel().style.display !== "none";
    if (open) {
      panel().style.display = "none";
      backdrop().style.display = "none";
      return;
    }
    panel().style.display = "flex";
    backdrop().style.display = "block";
    load();
    setTimeout(() => search().focus(), 50);
  };

  document.addEventListener("DOMContentLoaded", () => {
    search()?.addEventListener("input", render);
    document.getElementById("skNewBtn")?.addEventListener("click", () => openSkillEditor(null, { isNew: true }));
  });

  // Row chrome (badges, button titles) and the editor modal are built from
  // t() once; on a language switch, re-render the list and drop the cached
  // modal so it's rebuilt in the new language next time it opens.
  document.addEventListener("aperio:lang-changed", () => {
    if (panel().style.display !== "none") render();
    document.getElementById("skill-edit-modal")?.remove();
  });
})();
