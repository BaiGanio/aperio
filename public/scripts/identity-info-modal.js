// public/scripts/identity-info-modal.js
// Each expandable row of the startup banner (Identity, Tool schemas, Memory
// index) carries its own "more..." button — clicking one opens a modal
// scoped to just that row, not a single combined dialog. Identity
// (id/whoami.md) is editable in place — saving PUTs to /api/identity/whoami,
// which re-reads the file into the running agent's system prompt so the
// change lands on the very next turn.
(() => {
  let overlay = null;

  const SECTION_TITLE = {
    identity: () => t("idm_identity_heading"),
    tools:    () => t("idm_tools_heading"),
    memory:   () => t("idm_memory_heading"),
  };

  function ensureModal() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "identityInfoModal";
    overlay.className = "idm-overlay";
    overlay.innerHTML =
      `<div class="idm-dialog" role="dialog" aria-modal="true" aria-labelledby="idmTitle">` +
        `<div class="fpm-header">` +
          `<div class="fpm-title-group">` +
            `<span class="fpm-icon">◈</span>` +
            `<span class="fpm-filename" id="idmTitle"></span>` +
          `</div>` +
          `<div class="fpm-actions">` +
            `<button class="fpm-close-btn" id="idmClose" title="Close (Esc)"><i class="bi bi-x-lg"></i></button>` +
          `</div>` +
        `</div>` +
        `<div class="idm-body">` +
          `<section class="idm-section" data-section="identity">` +
            `<p class="idm-identity-hint">${t("idm_identity_hint")}</p>` +
            `<textarea id="idmWhoami" class="idm-textarea" spellcheck="false"></textarea>` +
            `<div class="idm-section-footer">` +
              `<span class="idm-status" id="idmIdentityStatus"></span>` +
              `<button class="sk-btn sk-btn--primary" id="idmSave">${t("skills_panel_save")}</button>` +
            `</div>` +
          `</section>` +
          `<section class="idm-section" data-section="tools">` +
            `<div class="idm-tool-list" id="idmTools"><span class="idm-empty">…</span></div>` +
          `</section>` +
          `<section class="idm-section" data-section="memory">` +
            `<p class="idm-memory-summary" id="idmMemory"></p>` +
            `<button class="sk-btn sk-btn--ghost" id="idmOpenMemory">${t("idm_memory_open_browser")}</button>` +
          `</section>` +
        `</div>` +
      `</div>`;

    const close = () => overlay.classList.remove("open");
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector("#idmClose").addEventListener("click", close);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && overlay.classList.contains("open")) close();
    });
    overlay.querySelector("#idmOpenMemory").addEventListener("click", () => {
      close();
      window.openMemoryTable?.();
    });
    overlay.querySelector("#idmSave").addEventListener("click", saveWhoami);
    document.body.appendChild(overlay);
    return overlay;
  }

  function showOnly(section) {
    overlay.querySelectorAll(".idm-section").forEach(el => {
      el.hidden = el.dataset.section !== section;
    });
    overlay.querySelector("#idmTitle").textContent = SECTION_TITLE[section]?.() || t("idm_title");
  }

  async function saveWhoami() {
    const status  = overlay.querySelector("#idmIdentityStatus");
    const saveBtn = overlay.querySelector("#idmSave");
    const content = overlay.querySelector("#idmWhoami").value;
    saveBtn.disabled = true;
    status.className = "idm-status";
    status.textContent = "";
    try {
      const res = await fetch("/api/identity/whoami", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status}`);
      status.className = "idm-status is-ok";
      status.textContent = t("idm_identity_saved");
    } catch {
      status.className = "idm-status is-error";
      status.textContent = t("idm_identity_save_error");
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function loadIdentity() {
    const whoami = overlay.querySelector("#idmWhoami");
    const status = overlay.querySelector("#idmIdentityStatus");
    status.className = "idm-status";
    status.textContent = "";
    whoami.value = "…";
    try {
      const res = await fetch("/api/identity/whoami");
      if (!res.ok) throw new Error(String(res.status));
      whoami.value = (await res.json()).content || "";
    } catch {
      whoami.value = "";
      status.className = "idm-status is-error";
      status.textContent = t("idm_load_error");
    }
  }

  async function loadTools() {
    const list = overlay.querySelector("#idmTools");
    list.innerHTML = `<span class="idm-empty">…</span>`;
    let tools = [];
    try {
      const res = await fetch("/api/tools");
      if (!res.ok) throw new Error(String(res.status));
      tools = (await res.json()).tools || [];
    } catch {
      list.innerHTML = `<span class="idm-empty">${t("idm_load_error")}</span>`;
      return;
    }
    if (!tools.length) {
      list.innerHTML = `<span class="idm-empty">${t("idm_tools_empty")}</span>`;
      return;
    }
    list.innerHTML = tools.map(tool =>
      `<div class="idm-tool-row">` +
        `<span class="idm-tool-name">${window.escapeHtml(tool.name)}</span>` +
        `<span class="idm-tool-desc">${window.escapeHtml(tool.description || "")}</span>` +
      `</div>`
    ).join("");
  }

  function loadMemory() {
    const el = overlay.querySelector("#idmMemory");
    const bd = typeof _startupBreakdown !== "undefined" ? _startupBreakdown : null;
    el.textContent = bd?.memoryTokens
      ? t("startup_bd_memory_pointer") + " — ~" + bd.memoryTokens.toLocaleString() + " tokens"
      : t("startup_bd_memory_pointer");
  }

  // Called via data-action="openStartupInfoModal" data-action-arg="identity|tools|memory"
  // from a single row's own "more..." button — opens straight to that section.
  window.openStartupInfoModal = async function (_event, el) {
    const section = el?.dataset?.actionArg || "identity";
    const modal = ensureModal();
    showOnly(section);
    modal.classList.add("open");
    if (section === "identity") await loadIdentity();
    else if (section === "tools") await loadTools();
    else if (section === "memory") loadMemory();
  };
})();
