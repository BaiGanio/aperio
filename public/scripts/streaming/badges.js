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

  // Third element (when present) is which "more..." modal section the row's
  // own expand button opens — each row drills into its own modal, not a
  // shared one, so a skill row or the scaffolding row (no matching section)
  // gets no button at all.
  const items = [[t("startup_bd_identity"), bd.identity || 0, "identity"]];
  for (const s of (bd.skills || [])) items.push([t("startup_bd_skill_named", { name: s.name }), s.tokens || 0]);
  if (bd.toolSchemas)  items.push([t("startup_bd_tools"), bd.toolSchemas, "tools"]);
  if (bd.memoryTokens) items.push([t("startup_bd_memory_pointer"), bd.memoryTokens, "memory"]);
  if (realTotal) {
    const other = Math.max(0, realTotal - est);
    if (other) items.push([t("startup_bd_other"), other]);
  }
  const rows = items
    .map(([label, n, section]) => {
      const more = section
        ? ` <button class="ctx-bd-more" data-action="openStartupInfoModal" data-action-arg="${section}">${t("startup_bd_more")}</button>`
        : "";
      return `<div class="ctx-bd-row"><span>${label}</span><span>~${n.toLocaleString()}${more}</span></div>`;
    })
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
  btn.title = on ? "Hide reasoning" : "Show reasoning";
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

// Map a file extension to its display icon, type label and plate illustration.
// Falls back to a generic file icon with the uppercased extension so any
// generated artifact is labelled correctly (never mislabelled as "Excel").
function _fileKind(ext) {
  switch (ext) {
    case "pptx": case "ppt":            return { icon: "bi-file-earmark-slides",      label: "PowerPoint", art: "slides" };
    case "xlsx": case "xls":            return { icon: "bi-file-earmark-spreadsheet", label: "Excel",      art: "sheet" };
    case "csv": case "tsv":             return { icon: "bi-file-earmark-spreadsheet", label: ext.toUpperCase(), art: "sheet" };
    case "pdf":                         return { icon: "bi-file-earmark-pdf",         label: "PDF",        art: "doc" };
    case "docx": case "doc":            return { icon: "bi-file-earmark-word",        label: "Word",       art: "doc" };
    case "html": case "htm":            return { icon: "bi-filetype-html",            label: "HTML page",  art: "code" };
    case "md":                          return { icon: "bi-file-earmark-text",        label: "Markdown",   art: "doc" };
    case "png": case "jpg": case "jpeg":
    case "gif": case "webp": case "svg": return { icon: "bi-file-earmark-image",       label: ext.toUpperCase(), art: "image" };
    default:                            return { icon: "bi-file-earmark",             label: (ext || "FILE").toUpperCase(), art: "code" };
  }
}

// Source files carry no _fileKind entry of their own (they fall through to the
// generic branch), so name the language rather than shouting "JS" at the user.
const _LANG_LABEL = { js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", py: "Python", rb: "Ruby", go: "Go", rs: "Rust",
  java: "Java", c: "C", h: "C header", cpp: "C++", cs: "C#", php: "PHP", sql: "SQL",
  css: "CSS", scss: "Sass", json: "JSON", yml: "YAML", yaml: "YAML", toml: "TOML",
  xml: "XML", sh: "Shell", bash: "Shell", txt: "Text" };

// The plate illustration. A file an agent made is a made thing, not a log row —
// so it gets a drawn page rather than a glyph. Painted in white-alpha (plus two
// fixed tints) because the plate is always a dark accent-derived gradient, in
// every theme.
function _fileArt(art) {
  const page =
    '<circle class="blob" cx="9" cy="60" r="15"/>' +
    '<circle class="blob" cx="55" cy="10" r="8"/>' +
    '<path class="sheet" d="M13 6h23l14 14v44a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z"/>' +
    '<path class="fold" d="M36 6l14 14H38a2 2 0 0 1-2-2z"/>';
  const svg = inner => `<svg class="gfc-art" viewBox="0 0 64 72" aria-hidden="true">${page}${inner}</svg>`;
  if (art === "sheet") {
    let cells = "";
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++)
      cells += `<rect class="ln${r === 0 ? " ln-a" : ""}" x="${18 + c * 10}" y="${30 + r * 8}" width="8" height="5" rx="1"/>`;
    return svg(cells);
  }
  if (art === "image") {
    return svg('<circle class="ln-b" cx="24" cy="34" r="4"/>' +
               '<path class="ln-a" d="M17 56l10-14 8 11 5-6 8 9z"/>');
  }
  if (art === "slides") {
    return svg('<rect class="ln" x="18" y="30" width="24" height="14" rx="2"/>' +
               '<rect class="ln-a" x="18" y="49" width="16" height="4" rx="2"/>' +
               '<rect class="ln" x="18" y="57" width="21" height="4" rx="2"/>');
  }
  const rows = (art === "doc"
    ? [[18, 30, 24], [18, 37, 22], [18, 44, 25], [18, 51, 18], [18, 58, 12]]
    : [[18, 30, 12], [18, 37, 20], [22, 44, 14, "a"], [18, 51, 18], [22, 58, 9, "b"]]
  ).map(([x, y, w, tint]) =>
    `<rect class="ln${tint ? " ln-" + tint : ""}" x="${x}" y="${y}" width="${w}" height="4" rx="2"/>`).join("");
  return svg(rows);
}

const _BINARY_EXT = new Set(["xlsx", "xls", "docx", "doc", "pdf", "pptx", "ppt",
                              "png", "jpg", "jpeg", "gif", "webp", "svg",
                              "zip", "tar", "gz", "exe", "wasm"]);

function _buildGeneratedFileCard({ filename, url, sizeKb }) {
  const name = filename || (url ? decodeURIComponent(url.split("/").pop()) : "file");
  const ext  = (name.split(".").pop() || "").toLowerCase();
  const { label, art } = _fileKind(ext);
  const kind = _LANG_LABEL[ext] || label;
  const canPreviewSpreadsheet = ext === "xlsx";
  const canPreviewPdf = ext === "pdf";
  const canPreview = !_BINARY_EXT.has(ext) || canPreviewSpreadsheet || canPreviewPdf;
  // Where the file actually landed — never a claim the card can't back up.
  const where = /\/uploads\//.test(url || "") ? "uploads" : "workspace";

  const card = document.createElement("div");
  card.className = "generated-file-card aperio-file-card";
  card.setAttribute("aria-label", `${name} artifact`);

  const previewBtn = canPreview
    ? `<button class="gfc-btn gfc-preview-btn" data-url="${escapeHtml(url)}" data-name="${escapeHtml(name)}">` +
        `<i class="bi bi-eye"></i> Preview` +
      `</button>`
    : "";

  card.innerHTML =
    `<div class="gfc-icon" aria-hidden="true">${_fileArt(art)}</div>` +
    `<div class="gfc-info">` +
      `<span class="gfc-name">${escapeHtml(name)}</span>` +
      `<span class="gfc-meta"><span class="gfc-kind">${escapeHtml(kind)}</span>` +
        (sizeKb ? `<span class="gfc-sep">·</span>${sizeKb} KB` : "") +
      `</span>` +
      `<span class="gfc-status"><span class="gfc-check"><i class="bi bi-check2"></i></span>` +
        `${canPreview ? "Ready to preview" : "Ready to download"}</span>` +
      `<span class="gfc-chip"><i class="bi bi-folder2"></i> ${where}</span>` +
    `</div>` +
    `<div class="gfc-actions">` +
      previewBtn +
      `<a class="gfc-btn gfc-download-btn" href="${escapeHtml(url)}" download="${escapeHtml(name)}">` +
        `<i class="bi bi-download"></i> Download` +
      `</a>` +
    `</div>`;

  if (canPreview) {
    card.querySelector(".gfc-preview-btn").addEventListener("click", () => {
      if (canPreviewSpreadsheet) openGeneratedSpreadsheetModal(url, name);
      else if (canPreviewPdf) openGeneratedPdfModal(url, name);
      else openGeneratedFileModal(url, name);
    });
  }

  return card;
}

// Models routinely write a file AND paste its full source into the answer. The
// card already carries that file — preview, download, the lot — so the inline
// copy is duplicate chrome around content the user never asked to read twice.
// Drop the block, but only on proof: fetch what was actually saved and remove a
// block only when its text is genuinely part of the file. A usage example or a
// snippet from a different file never matches, so it stays.
const _DEDUPE_MAX_KB = 256;          // don't refetch a large artifact to compare
async function _dropInlineDuplicateOfFile(container, { url, sizeKb }) {
  if (!url || (sizeKb || 0) > _DEDUPE_MAX_KB) return;
  const bubble = container.closest?.(".bubble") || container;
  const blocks = [...bubble.querySelectorAll(".code-block")].filter(b => {
    const text = b.querySelector("code")?.textContent || "";
    // A one-liner can be a substring of anything; only substantial blocks are
    // safe to call a duplicate.
    return text.split("\n").length >= 5 || text.length >= 200;
  });
  if (!blocks.length) return;

  let fileText;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    fileText = await res.text();
  } catch { return; }                 // offline / evicted file — leave the block

  const norm = s => s.replace(/\s+/g, " ").trim();
  const saved = norm(fileText);
  if (!saved) return;
  for (const block of blocks) {
    const inline = norm(block.querySelector("code")?.textContent || "");
    if (inline && (saved.includes(inline) || inline.includes(saved))) block.remove();
  }
}

// Files arrive one event at a time, but a turn that wrote five of them should
// read as one shelf, not a five-storey column. Cards go into a shared rack that
// lays them out 2–3 per row; the rack switches the cards to their compact form
// (`data-cards` drives the CSS) as soon as there is more than one.
function _appendGeneratedFileCard(container, msg) {
  let rack = container.lastElementChild;
  if (!rack?.classList?.contains("gfc-rack")) {
    rack = document.createElement("div");
    rack.className = "gfc-rack";
    container.appendChild(rack);
  }
  rack.appendChild(_buildGeneratedFileCard(msg));
  const n = rack.childElementCount;
  rack.dataset.cards = n >= 3 ? "3+" : String(n);
  _dropInlineDuplicateOfFile(container, msg);   // fire-and-forget; card is already up
  return rack;
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

// Reuses the no-tool-use chip's styling — same amber, dismissible pattern —
// for the tool-repeat breaker (lib/agent/providers/llamacpp.js, deepseek.js):
// the model kept issuing an identical tool call, so tools were taken away for
// this turn. Without this the user just sees the assistant go quiet on tools.
function _renderToolRepeatBreakWarning(model, repeats) {
  const chip = document.createElement("div");
  chip.className = "no-tool-warning";
  chip.innerHTML =
    `<span class="no-tool-warning-icon">⚠</span>` +
    `<span class="no-tool-warning-text">${escapeHtml(t("tool_repeat_break_notice", { model, repeats }))}</span>` +
    `<button class="no-tool-warning-dismiss" title="Dismiss">✕</button>`;
  chip.querySelector(".no-tool-warning-dismiss").onclick = () => chip.remove();
  messagesEl.appendChild(chip);
  scrollToBottom();
}

// Same chip again, for the per-turn tool-step cap (APERIO_TURN_MAX_TOOL_STEPS,
// applied by every native provider loop): the reply used up its allowance of
// tool-calling passes, so tools were withdrawn and the model had to answer.
// Distinct from the repeat breaker above — this one fires on volume, not on the
// same call being repeated.
function _renderToolStepLimitWarning(model, steps, limit) {
  const chip = document.createElement("div");
  chip.className = "no-tool-warning";
  chip.innerHTML =
    `<span class="no-tool-warning-icon">⚠</span>` +
    `<span class="no-tool-warning-text">${escapeHtml(t("tool_step_limit_notice", { model, steps, limit }))}</span>` +
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
