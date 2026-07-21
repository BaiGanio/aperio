// Sum of the known startup components (server-side estimates). The static
// greeting means there's no startup inference, so this is the best number we
// have until the first real turn reports a true provider count.
function _startupComponentsTotal(bd) {
  return (bd.identity || 0)
    + (bd.skills || []).reduce((n, s) => n + (s.tokens || 0), 0)
    + (bd.memoryTokens || 0)
    + (bd.toolSchemas || 0);
}

// This is an estimate rather than billable API usage. It gives providers such
// as Codex (whose CLI reports aggregate agent-loop work, not context occupancy)
// a useful initial navbar value without mislabelling aggregate work as context.
function _syncStartupContextBar() {
  const total = _startupBreakdown ? _startupComponentsTotal(_startupBreakdown) : 0;
  if (!total || typeof updateContextBar !== "function") return;
  updateContextBar(total, maxCtx, 0, false);
}

// Build the banner's inner HTML. When `realTotal` is given (after turn 1) the
// headline shows the true provider count and a "scaffolding" row reconciles the
// estimates to it; otherwise it's a labelled estimate.
function _startupBannerInner(bd, realTotal) {
  const est = _startupComponentsTotal(bd);
  const total = realTotal || est;

  const items = [[t("startup_bd_identity"), bd.identity || 0]];
  for (const s of (bd.skills || [])) items.push([t("startup_bd_skill_named", { name: s.name }), s.tokens || 0]);
  if (bd.toolSchemas)  items.push([t("startup_bd_tools"), bd.toolSchemas]);
  if (bd.memoryTokens) items.push([t("startup_bd_memory_pointer"), bd.memoryTokens]);
  if (realTotal) {
    const other = Math.max(0, realTotal - est);
    if (other) items.push([t("startup_bd_other"), other]);
  }
  const rows = items
    .map(([label, n]) => `<div class="ctx-bd-row"><span>${label}</span><span>~${n.toLocaleString()}</span></div>`)
    .join("");

  const headline = realTotal
    ? t("startup_tokens_from", { n: total.toLocaleString() })
    : t("startup_tokens_est", { n: total.toLocaleString() });

  return (
    `<div class="ctx-banner-row">` +
      `<span class="ctx-banner-text">${headline}</span>` +
      `<button class="ctx-banner-btn" data-action="toggleBannerBody">${t("startup_bd_toggle")}</button>` +
      `<button class="ctx-banner-btn" data-action="removeBanner">${t("ctx_dismiss")}</button>` +
    `</div>` +
    `<div class="ctx-bd csp-style-13">` +
      `<div class="ctx-bd-title">${t("startup_bd_title")}</div>` +
      rows +
      `<div class="ctx-bd-note">${t("startup_bd_note")}</div>` +
    `</div>`
  );
}

function _maybeShowStartupBanner() {
  if (startupBannerShown) return;
  const bd = _startupBreakdown;
  if (!bd || !_startupComponentsTotal(bd)) return;
  startupBannerShown = true;

  const banner = document.createElement("div");
  banner.className = "ctx-banner ctx-banner--memories";
  banner.innerHTML = _startupBannerInner(bd, null);
  document.querySelector(".chat-area")?.prepend(banner);
  _startupBannerEl = banner;
}

// Replace the startup estimate with the real provider input-token count once the
// first turn returns. Keeps the banner visible (no auto-dismiss) so the figure
// the user actually paid stays on screen until they dismiss it.
function _refineStartupBanner(inputTok, inputTokensKind = "context") {
  if (!inputTok || inputTokensKind === "aggregate" || _startupBannerRefined || !_startupBreakdown) return;
  if (!_startupBannerEl || !_startupBannerEl.isConnected) return;
  _startupBannerRefined = true;
  // Preserve whether the user had expanded the breakdown.
  const wasOpen = _startupBannerEl.querySelector(".ctx-bd")?.style.display === "block";
  _startupBannerEl.innerHTML = _startupBannerInner(_startupBreakdown, inputTok);
  if (wasOpen) {
    const bd = _startupBannerEl.querySelector(".ctx-bd");
    if (bd) bd.style.display = "block";
  }
}

function _annotateTokenBadges(inputTok, thinkTok) {
  lastUserMsgWrap = null;
  if (inputTok) prevInputTokens = inputTok;
  if (lastReasoningWrapForTok && thinkTok > 0) {
    const tok = document.createElement("span");
    tok.className = "reasoning-tok";
    tok.textContent = `🧠 +${thinkTok.toLocaleString()}`;
    const flatLabel = lastReasoningWrapForTok.querySelector(".reasoning-flat-label");
    const summary   = lastReasoningWrapForTok.querySelector("summary");
    (flatLabel || summary)?.appendChild(tok);
    lastReasoningWrapForTok = null;
  }
}

function toggleReasoning() {
  const cur = localStorage.getItem("aperio-reasoning") !== "false";
  window.Aperio?.settings?.set("aperio-reasoning", cur ? "false" : "true");
  updateReasoningBtn();
}

function updateReasoningBtn() {
  const on  = localStorage.getItem("aperio-reasoning") !== "false";
  const btn = document.getElementById("reasoningToggle");
  if (!btn) return;
  btn.classList.toggle("is-on", on);
  btn.title = on ? "Disable reasoning" : "Enable reasoning";
}

// Adopt a server value picked up at boot (localStorage already synced).
window.Aperio?.settings?.register("aperio-reasoning", updateReasoningBtn);

window.addEventListener("DOMContentLoaded", updateReasoningBtn);

function _humanExpiry(isoStr) {
  const days = Math.round((new Date(isoStr) - Date.now()) / 86400000);
  if (days <= 0) return t("ttl_chip_expired");
  if (days === 1) return t("ttl_chip_tomorrow");
  return t("ttl_chip_in_days", { n: days });
}

function _renderTtlChip({ id, memType, title, expires_at }) {
  const chip = document.createElement("div");
  chip.className = "ttl-chip";
  chip.innerHTML =
    `<span class="ttl-chip-icon">⏳</span>` +
    `<div class="ttl-chip-info">` +
      `<span class="ttl-chip-type">${escapeHtml(memType)}</span>` +
      `<span class="ttl-chip-title">${escapeHtml(title)}</span>` +
      `<span class="ttl-chip-expiry">${_humanExpiry(expires_at)}</span>` +
    `</div>` +
    `<div class="ttl-chip-actions">` +
      `<button class="ttl-btn ttl-btn--confirm">${t("ttl_chip_keep")}</button>` +
      `<button class="ttl-btn ttl-btn--remove">${t("ttl_chip_permanent")}</button>` +
    `</div>`;

  chip.querySelector(".ttl-btn--confirm").onclick = () => chip.remove();

  chip.querySelector(".ttl-btn--remove").onclick = async () => {
    const btn = chip.querySelector(".ttl-btn--remove");
    btn.disabled = true;
    btn.textContent = t("ttl_chip_removing");
    try {
      await fetch(`/api/memories/${id}/expiry`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expires_at: null }),
      });
    } catch { /* silent — chip still dismisses */ }
    chip.remove();
  };

  messagesEl.appendChild(chip);
  scrollToBottom();
}

// Map a file extension to its display icon + type label. Falls back to a
// generic file icon with the uppercased extension so any generated artifact
// is labelled correctly (never mislabelled as "Excel").
function _fileKind(ext) {
  switch (ext) {
    case "pptx": case "ppt":            return { icon: "bi-file-earmark-slides",      label: "PowerPoint" };
    case "xlsx": case "xls":            return { icon: "bi-file-earmark-spreadsheet", label: "Excel" };
    case "csv": case "tsv":             return { icon: "bi-file-earmark-spreadsheet", label: ext.toUpperCase() };
    case "pdf":                         return { icon: "bi-file-earmark-pdf",         label: "PDF" };
    case "docx": case "doc":            return { icon: "bi-file-earmark-word",        label: "Word" };
    case "html": case "htm":            return { icon: "bi-filetype-html",            label: "HTML page" };
    case "md":                          return { icon: "bi-file-earmark-text",        label: "Markdown" };
    case "png": case "jpg": case "jpeg":
    case "gif": case "webp": case "svg": return { icon: "bi-file-earmark-image",       label: ext.toUpperCase() };
    default:                            return { icon: "bi-file-earmark",             label: (ext || "FILE").toUpperCase() };
  }
}

const _BINARY_EXT = new Set(["xlsx", "xls", "docx", "doc", "pdf", "pptx", "ppt",
                              "png", "jpg", "jpeg", "gif", "webp", "svg",
                              "zip", "tar", "gz", "exe", "wasm"]);

function _buildGeneratedFileCard({ filename, url, sizeKb }) {
  const name = filename || (url ? decodeURIComponent(url.split("/").pop()) : "file");
  const ext  = (name.split(".").pop() || "").toLowerCase();
  const { icon, label } = _fileKind(ext);
  const canPreview = !_BINARY_EXT.has(ext);

  const card = document.createElement("div");
  card.className = "generated-file-card";

  const previewBtn = canPreview
    ? `<button class="gfc-btn gfc-preview-btn" data-url="${escapeHtml(url)}" data-name="${escapeHtml(name)}">` +
        `<i class="bi bi-eye"></i> Preview` +
      `</button>`
    : "";

  card.innerHTML =
    `<div class="gfc-icon"><i class="bi ${icon}"></i></div>` +
    `<div class="gfc-info">` +
      `<span class="gfc-name">${escapeHtml(name)}</span>` +
      `<span class="gfc-meta">${escapeHtml(label)}${sizeKb ? ` · ${sizeKb} KB` : ""}</span>` +
    `</div>` +
    previewBtn +
    `<a class="gfc-btn" href="${escapeHtml(url)}" download="${escapeHtml(name)}">` +
      `<i class="bi bi-download"></i> Download` +
    `</a>`;

  if (canPreview) {
    card.querySelector(".gfc-preview-btn").addEventListener("click", () => {
      openGeneratedFileModal(url, name);
    });
  }

  return card;
}

// ── Capability notice ────────────────────────────────────────────────────────
// One-shot, non-dismissible line for a turn-level capability gap (e.g. an
// attached image the active provider silently can't see) — the plan's WS6/F1:
// tell the user instead of letting the attachment vanish with no explanation.
function _renderCapabilityNotice(text) {
  const note = document.createElement("div");
  note.className = "capability-notice";
  note.innerHTML = `<span class="recall-asterisk">⚠</span><span class="recall-pill-label">${escapeHtml(text)}</span>`;
  messagesEl.appendChild(note);
  scrollToBottom();
}

// ── Skills chip ─────────────────────────────────────────────────────────────
// Skills are injected into the system prompt (not executed), so this chip is
// the only signal the user gets about which ones steered the turn.
function _renderSkillsChip(skills) {
  const chip = document.createElement("div");
  chip.className = "recall-pill skills-chip";

  // Header is a plain label — no toggle. The combined per-turn token cost of all
  // injected skills, so "skills" isn't an invisible token sink.
  const totalTok = skills.reduce((n, s) => n + (s.tokens || 0), 0);
  const tokTxt = totalTok ? ` <span class="skills-total-tok">(${t("chip_tokens", { n: totalTok.toLocaleString() }).trim()})</span>` : "";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "recall-pill-toggle skills-label";
  header.innerHTML =
    `<span class="recall-asterisk">✦</span>` +
    `<span class="recall-pill-label">${t("skills_chip_label")}${tokTxt}:</span>` +
    `<span class="recall-pill-chevron">▾</span>`;
  chip.appendChild(header);

  // The list collapses to keep things tidy when several skills load. Once open,
  // each row is itself expandable: clicking it reveals a brief description + a
  // "more…" that opens the full SKILL.md (fetched on demand, not streamed).
  const details = document.createElement("div");
  details.className = "recall-pill-details skills-details";
  skills.forEach(s => {
    const kb  = s.bytes  ? `${(s.bytes / 1024).toFixed(1)} KB` : "";
    const tok = s.tokens ? t("chip_tokens", { n: s.tokens.toLocaleString() }).trim() : "";
    const meta = [kb, tok].filter(Boolean).join(" · ");
    const item = document.createElement("details");
    item.className = "skill-row";
    item.innerHTML =
      `<summary class="skill-row-head">` +
        `<span class="skill-row-arrow">↳</span>` +
        `<span class="skill-row-name">${escapeHtml(s.name)}</span>` +
        (s.always ? `<span class="skill-always-badge">${t("skills_always_badge")}</span>` : "") +
        (meta ? `<span class="skill-row-meta">${escapeHtml(meta)}</span>` : "") +
        `<span class="skill-row-chevron">▾</span>` +
      `</summary>` +
      `<div class="skill-row-body">` +
        (s.description ? `<span class="skill-brief">${escapeHtml(s.description)}</span> ` : "") +
        `<button type="button" class="skill-more">${t("skills_more")}</button>` +
      `</div>`;
    item.querySelector(".skill-more").onclick = e => { e.preventDefault(); _openSkillDoc(s.name); };
    details.appendChild(item);
  });
  chip.appendChild(details);

  header.onclick = () => {
    const open = details.classList.toggle("open");
    header.querySelector(".recall-pill-chevron").textContent = open ? "▴" : "▾";
  };

  messagesEl.appendChild(chip);
  scrollToBottom();
}

// Open a skill's SKILL.md rendered as markdown in a modal — so the user can see
// *what* is in the system prompt and *why* it steered the turn. Content is
// fetched on demand (not streamed every turn). Reuses the file-preview modal
// shell (.fpm-*); the body carries `.bubble` for markdown styling.
function _openSkillDoc(name) {
  let overlay = document.getElementById("skill-doc-modal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "skill-doc-modal";
    overlay.className = "fpm-overlay";
    overlay.innerHTML =
      `<div class="fpm-dialog">` +
        `<div class="fpm-header">` +
          `<div class="fpm-title-group">` +
            `<span class="fpm-icon">✦</span>` +
            `<span class="fpm-filename skill-doc-name"></span>` +
            `<span class="fpm-ext-badge">SKILL.md</span>` +
          `</div>` +
          `<div class="fpm-actions">` +
            `<button class="fpm-edit-btn sk-btn sk-btn--ghost" title="Edit this skill">Edit</button>` +
            `<button class="fpm-close-btn" title="Close (Esc)"><i class="bi bi-x-lg"></i></button>` +
          `</div>` +
        `</div>` +
        `<div class="fpm-body bubble skill-doc-body"></div>` +
      `</div>`;
    const close = () => overlay.classList.remove("open");
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector(".fpm-close-btn").addEventListener("click", close);
    overlay.querySelector(".fpm-edit-btn").addEventListener("click", () => {
      const name = overlay.querySelector(".skill-doc-name").textContent;
      close();
      window.openSkillEditor?.(name);
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && overlay.classList.contains("open")) close();
    });
    document.body.appendChild(overlay);
  }
  overlay.querySelector(".skill-doc-name").textContent = name;
  const body = overlay.querySelector(".skill-doc-body");
  body.textContent = "…";
  overlay.classList.add("open");
  fetch(`/api/skill?name=${encodeURIComponent(name)}`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
    .then(doc => {
      body.innerHTML = renderMarkdown(doc.content || "");
      if (window.Prism) Prism.highlightAll();
      body.scrollTop = 0;
    })
    .catch(() => { body.textContent = t("skills_load_error"); });
}

function _renderNoToolWarning(model) {
  const chip = document.createElement("div");
  chip.className = "no-tool-warning";
  chip.innerHTML =
    `<span class="no-tool-warning-icon">⚠</span>` +
    `<span class="no-tool-warning-text">` +
      `<strong>${escapeHtml(model)}</strong> answered with code instead of writing files. ` +
      `Small local models sometimes describe code rather than calling tools, especially when the target is vague. ` +
      `Try naming the file to create/edit, or switch to a larger model for reliable file operations.` +
    `</span>` +
    `<button class="no-tool-warning-dismiss" title="Dismiss">✕</button>`;
  chip.querySelector(".no-tool-warning-dismiss").onclick = () => chip.remove();
  messagesEl.appendChild(chip);
  scrollToBottom();
}

// llamacpp.md Phase 5: reuses the no-tool-use chip's styling (generic amber
// warning, not tool-specific) rather than inventing a new UI mechanism.
function _renderSlowTurnWarning(model, genTps, hint) {
  const chip = document.createElement("div");
  chip.className = "no-tool-warning";
  chip.innerHTML =
    `<span class="no-tool-warning-icon">🐢</span>` +
    `<span class="no-tool-warning-text">` +
      `<strong>${escapeHtml(model)}</strong> is generating slowly (~${genTps} tok/s). ` +
      `${escapeHtml(hint || "Try the fast-low-vram profile.")}` +
    `</span>` +
    `<button class="no-tool-warning-dismiss" title="Dismiss">✕</button>`;
  chip.querySelector(".no-tool-warning-dismiss").onclick = () => chip.remove();
  messagesEl.appendChild(chip);
  scrollToBottom();
}
