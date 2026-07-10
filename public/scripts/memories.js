// ── Memories sidebar ─────────────────────────────────────────
function renderMemoriesFromMessage(memories) {
  window.allMemories = Array.isArray(memories) ? memories : [];
  renderMemories(window.allMemories);
}

// Simple HTML-escaping helper to prevent XSS when rendering untrusted content
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
window.escapeHtml = escapeHtml;

const PREVIEW_COUNT = 3;
const expandedGroups = new Set();
const collapsedGroups = new Set(Object.keys(window.TYPE_CONFIG));
let _activeTagFilter = null;

function renderMemories(memories) {
  // Apply active tag filter.
  const tagFilter = _activeTagFilter;
  const filtered = tagFilter
    ? memories.filter(m => (m.tags || []).some(t => t.toLowerCase() === tagFilter.toLowerCase()))
    : memories;

  if (!filtered.length) {
    window.memoriesList.innerHTML = `
      <div class="empty-state" style="padding:24px 16px; text-align:center; line-height:1.8;">
        <div style="font-size:22px; margin-bottom:8px; opacity:.4">◈</div>
        <div style="font-weight:500; margin-bottom:6px; color:var(--text)" data-i18n="sidebar_empty_title">${t("sidebar_empty_title")}</div>
        <div style="font-size:12px; color:var(--text-muted)" data-i18n-html="sidebar_empty_hint_html">${t("sidebar_empty_hint_html")}</div>
      </div>`;
    return;
  }

  const pinned  = filtered.filter(m => m.pinned);
  const grouped = {};
  filtered.filter(m => !m.pinned).forEach(m => {
    if (!grouped[m.type]) grouped[m.type] = [];
    grouped[m.type].push(m);
  });

  window.memoriesList.innerHTML = "";

  // Active tag filter chip.
  if (tagFilter) {
    const chip = document.createElement("div");
    chip.className = "tag-filter-chip";
    chip.innerHTML = `<span class="tag-filter-chip-label">${escapeHtml(t("mem_tag_filter") || "Tag:")}</span>` +
      `<span class="tag-filter-chip-value">${escapeHtml(tagFilter)}</span>` +
      `<button class="tag-filter-chip-clear" title="${escapeHtml(t("mem_tag_clear") || "Clear filter")}"><i class="bi bi-x-lg"></i></button>`;
    chip.querySelector(".tag-filter-chip-clear").onclick = () => {
      _activeTagFilter = null;
      renderMemories(window.allMemories);
    };
    window.memoriesList.appendChild(chip);
  }

  const countBadge = document.getElementById("memoryCountBadge");
  if (countBadge) countBadge.textContent = filtered.length ? `(${filtered.length})` : "";

  if (pinned.length) {
    const group = document.createElement("div");
    group.className = "type-group";
    const header = document.createElement("div");
    header.className = "type-header";
    const isPinnedCollapsed = collapsedGroups.has("__pinned__");
    header.innerHTML = `
      <span class="type-icon">📌</span>
      <span>${escapeHtml(t("mem_pinned_group"))}</span>
      <span class="type-count">${pinned.length}</span>
      <i class="bi bi-chevron-right type-chevron ${isPinnedCollapsed ? "" : "open"}"></i>`;
    header.onclick = () => {
      if (collapsedGroups.has("__pinned__")) collapsedGroups.delete("__pinned__");
      else collapsedGroups.add("__pinned__");
      renderMemories(window.allMemories);
    };
    group.appendChild(header);
    const body = document.createElement("div");
    body.className = `type-group-body ${isPinnedCollapsed ? "collapsed" : ""}`;
    pinned.forEach(m => body.appendChild(makeMemoryCard(m)));
    group.appendChild(body);
    window.memoriesList.appendChild(group);
  }

  Object.entries(grouped).forEach(([type, items]) => {
    const cfg = window.TYPE_CONFIG[type] || { icon: '<i class="bi bi-circle"></i>', labelKey: null };
    const label = cfg.labelKey ? t(cfg.labelKey) : type;
    const isCollapsed = collapsedGroups.has(type);
    const isExpanded = expandedGroups.has(type);
    const visible = isExpanded ? items : items.slice(0, PREVIEW_COUNT);
    const hasMore = items.length > PREVIEW_COUNT;

    const group = document.createElement("div");
    group.className = "type-group";

    const header = document.createElement("div");
    header.className = "type-header";
    header.innerHTML = `
      <span class="type-icon">${cfg.icon}</span>
      <span>${escapeHtml(label)}</span>
      <span class="type-count">${items.length}</span>
      <i class="bi bi-chevron-right type-chevron ${isCollapsed ? "" : "open"}"></i>`;
    header.onclick = () => {
      if (collapsedGroups.has(type)) collapsedGroups.delete(type);
      else collapsedGroups.add(type);
      renderMemories(window.allMemories);
    };
    group.appendChild(header);

    const body = document.createElement("div");
    body.className = `type-group-body ${isCollapsed ? "collapsed" : ""}`;

    visible.forEach(m => body.appendChild(makeMemoryCard(m)));

    if (hasMore) {
      const btn = document.createElement("button");
      btn.className = "show-more-btn";
      if (isExpanded) {
        btn.textContent = t("sidebar_show_less");
        btn.onclick = (e) => { e.stopPropagation(); expandedGroups.delete(type); renderMemories(window.allMemories); };
      } else {
        btn.textContent = t("sidebar_show_more", { n: items.length - PREVIEW_COUNT });
        btn.onclick = (e) => { e.stopPropagation(); expandedGroups.add(type); renderMemories(window.allMemories); };
      }
      body.appendChild(btn);
    }

    group.appendChild(body);
    window.memoriesList.appendChild(group);
  });
}
window.renderMemories = renderMemories;

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (Number.isNaN(date)) return "";
  const diff = Math.floor((Date.now() - date) / 1000);
  if (diff < 60)    return t("mem_just_now");
  if (diff < 3600)  return t("mem_min_ago",  { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("mem_hour_ago", { n: Math.floor(diff / 3600) });
  if (diff < 86400 * 30) return t("mem_day_ago", { n: Math.floor(diff / 86400) });
  return date.toLocaleDateString(window.Aperio.getCurrentLang());
}

function makeMemoryCard(m) {
  const card = document.createElement("div");
  card.className = "memory-card";

  const pips = Array.from({ length: 5 }, (_, i) =>
    `<div class="importance-pip ${i < m.importance ? "filled" : ""}"></div>`
  ).join("");

  const ts = timeAgo(m.createdAt);
  const jsonStr = JSON.stringify(m);
  const base64Data = btoa(unescape(encodeURIComponent(jsonStr)));
  card.innerHTML = `
    <div class="memory-card-header">
      <div class="memory-title">${escapeHtml(m.title)}</div>
      <button class="memory-pin-btn${m.pinned ? " memory-pin-btn--active" : ""}" title="${escapeHtml(m.pinned ? t("mem_unpin") : t("mem_pin"))}">
        <i class="bi ${m.pinned ? "bi-pin-fill" : "bi-pin"}"></i>
      </button>
      <button class="delete-btn" title="${escapeHtml(t("mem_delete_title"))}"><i class="bi bi-trash3"></i></button>
    </div>
    <div class="memory-preview" data-memory='${base64Data}'>${escapeHtml(m.content)}</div>
    ${m.tags.length ? `<div class="memory-tags">${m.tags.map(tg => `<span class="tag${_activeTagFilter === tg ? " tag--active" : ""}">${escapeHtml(tg)}</span>`).join("")}</div>` : ""}
    <div class="importance-bar">
      ${pips}
      ${ts ? `<span class="memory-ts">${ts}</span>` : ""}
    </div>
    ${m.source ? `<div class="memory-source">${escapeHtml(m.source)}</div>` : ""}`;

  card.querySelector(".memory-pin-btn").onclick = async (e) => {
    e.stopPropagation();
    if (!m.id) return;
    const pinned = !m.pinned;
    try {
      const res = await fetch(`/api/memories/${m.id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) throw new Error("Failed");
      window.allMemories = window.allMemories.map(mem => mem.id === m.id ? { ...mem, pinned } : mem);
      renderMemories(window.allMemories);
    } catch { /* silent */ }
  };

  // Click a tag to filter by it.
  card.querySelectorAll(".tag").forEach(tagEl => {
    tagEl.onclick = (e) => {
      e.stopPropagation();
      const tag = tagEl.textContent;
      _activeTagFilter = (_activeTagFilter === tag) ? null : tag;
      window.searchInput.value = "";
      renderMemories(window.allMemories);
    };
  });

  card.querySelector(".delete-btn").onclick = (e) => {
    e.stopPropagation();
    if (!m.id) return;
    if (!confirm(t("mem_delete_confirm", { title: m.title }))) return;
    card.style.opacity = "0.4";
    card.style.pointerEvents = "none";
    window.safeSend(JSON.stringify({ type: "delete_memory", id: m.id }));
  };

  return card;
}

// ── Inbox ─────────────────────────────────────────────────────
let _pendingCount = 0;

async function loadInboxCount() {
  try {
    const res = await fetch("/api/memories/pending/count");
    if (!res.ok) return;
    const data = await res.json();
    _pendingCount = data.count ?? 0;
    updateInboxBadge();
  } catch { /* non-essential */ }
}

function updateInboxBadge() {
  const badge = document.getElementById("inboxBadge");
  if (!badge) return;
  badge.textContent = _pendingCount > 0 ? _pendingCount : "";
  badge.style.display = _pendingCount > 0 ? "inline" : "none";
}

async function loadInboxPanel() {
  const section = document.getElementById("inboxSection");
  if (!section) return;
  try {
    const res = await fetch("/api/memories/pending");
    if (!res.ok) { section.innerHTML = ""; return; }
    const { pending } = await res.json();
    if (!pending?.length) { section.innerHTML = ""; return; }
    section.innerHTML =
      `<div class="inbox-header">📥 ${t("mem_inbox_title") || "Inbox"} (${pending.length})</div>` +
      pending.map(p => `
        <div class="inbox-item" data-id="${escapeHtml(p.id)}">
          <div class="inbox-item-title">${escapeHtml(p.title)}</div>
          <div class="inbox-item-content">${escapeHtml(p.content)}</div>
          <div class="inbox-item-meta">
            <span class="inbox-item-type">${escapeHtml(p.type)}</span>
            ${(p.tags || []).map(tg => `<span class="tag">${escapeHtml(tg)}</span>`).join("")}
          </div>
          <div class="inbox-item-actions">
            <button class="inbox-btn inbox-btn--approve" data-id="${escapeHtml(p.id)}">✓ ${t("mem_inbox_approve") || "Approve"}</button>
            <button class="inbox-btn inbox-btn--reject" data-id="${escapeHtml(p.id)}">✕ ${t("mem_inbox_reject") || "Reject"}</button>
          </div>
        </div>
      `).join("");
    wireInbox();
  } catch { section.innerHTML = ""; }
}

function wireInbox() {
  document.querySelectorAll(".inbox-btn--approve").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        await fetch(`/api/memories/pending/${id}/approve`, { method: "POST" });
        const item = document.querySelector(`.inbox-item[data-id="${CSS.escape(id)}"]`);
        if (item) item.remove();
        await loadInboxCount();
        // Refresh memory list in background.
        if (window.allMemories?.length) {
          const res = await fetch("/api/memories");
          const data = await res.json();
          if (data.raw) renderMemoriesFromMessage(data.raw);
        }
      } catch { btn.disabled = false; }
    };
  });
  document.querySelectorAll(".inbox-btn--reject").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        await fetch(`/api/memories/pending/${id}/reject`, { method: "POST" });
        const item = document.querySelector(`.inbox-item[data-id="${CSS.escape(id)}"]`);
        if (item) item.remove();
        await loadInboxCount();
      } catch { btn.disabled = false; }
    };
  });
}

// Insert inbox badge into the search box.
document.addEventListener("DOMContentLoaded", () => {
  const searchBox = document.querySelector(".search-box");
  if (searchBox) {
    const badge = document.createElement("span");
    badge.id = "inboxBadge";
    badge.className = "inbox-badge";
    badge.style.display = "none";
    searchBox.appendChild(badge);
  }
  // Insert inbox section before the memories list.
  const list = document.getElementById("memoriesList");
  if (list) {
    const section = document.createElement("div");
    section.id = "inboxSection";
    section.className = "inbox-section";
    list.parentNode.insertBefore(section, list);
  }
  loadInboxCount();
  loadInboxPanel();
  // Refresh inbox every 60 seconds.
  setInterval(() => { loadInboxCount(); loadInboxPanel(); }, 60000);
});

// ── Search ───────────────────────────────────────────────────
window.searchInput.addEventListener("input", () => {
  const q = window.searchInput.value.toLowerCase().trim();
  const tagFilter = _activeTagFilter;
  if (!q && !tagFilter) {
    Object.keys(window.TYPE_CONFIG).forEach(t => collapsedGroups.add(t));
    renderMemories(window.allMemories);
    return;
  }
  let filtered = window.allMemories;
  if (q) {
    filtered = filtered.filter(m =>
      m.title.toLowerCase().includes(q) ||
      m.content.toLowerCase().includes(q) ||
      m.tags.some(t => t.toLowerCase().includes(q))
    );
  }
  // Compose with active tag filter if any.
  if (tagFilter) {
    filtered = filtered.filter(m =>
      (m.tags || []).some(t => t.toLowerCase() === tagFilter.toLowerCase())
    );
  }
  const matchedTypes = new Set(filtered.map(m => m.type));
  Object.keys(window.TYPE_CONFIG).forEach(t => {
    if (matchedTypes.has(t)) collapsedGroups.delete(t);
    else collapsedGroups.add(t);
  });
  renderMemories(filtered);
});

// ── Confirm modal helpers ──────────────────────────────────────

function showConfirmModal(title, message, okLabel, onOk) {
  const modal = document.getElementById('confirmModal');
  if (!modal) return;
  // Ensure Cancel button is visible (may have been hidden by showErrorModal).
  const cancelBtn = modal.querySelector('.confirm-btn--cancel');
  if (cancelBtn) cancelBtn.style.display = '';
  document.getElementById('confirmOkBtn').onclick = null;
  modal.querySelector('.confirm-title').textContent = title;
  modal.querySelector('.confirm-message').textContent = message;
  const okBtn = document.getElementById('confirmOkBtn');
  okBtn.textContent = okLabel || 'OK';
  okBtn.onclick = () => {
    closeConfirmModal();
    if (onOk) onOk();
  };
  modal.classList.add('active');
}

function closeConfirmModal() {
  const modal = document.getElementById('confirmModal');
  if (modal) modal.classList.remove('active');
}

// Thin error-modal wrapper — reuses the confirm-modal with a single Close button.
function showErrorModal(msg) {
  const modal = document.getElementById('confirmModal');
  if (!modal) return;
  const cancelBtn = modal.querySelector('.confirm-btn--cancel');
  if (cancelBtn) cancelBtn.style.display = 'none';
  modal.querySelector('.confirm-title').textContent = 'Error';
  modal.querySelector('.confirm-message').textContent = msg;
  const okBtn = document.getElementById('confirmOkBtn');
  if (okBtn) {
    okBtn.textContent = 'Close';
    okBtn.onclick = () => closeConfirmModal();
  }
  modal.classList.add('active');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeConfirmModal(); closeExportModal(); }
});

document.getElementById('confirmModal')?.addEventListener('click', (e) => {
  if (!e.target.closest('.confirm-content')) closeConfirmModal();
});

// ── Export modal helpers ────────────────────────────────────────

let _exportPayload = null;

function showExportModal(payload) {
  _exportPayload = payload;
  const c = payload.counts;
  document.getElementById('exportCountMem').textContent = c.memories;
  document.getElementById('exportCountSelf').textContent = c.self_memories;
  document.getElementById('exportCountWiki').textContent = c.wiki_articles;
  document.getElementById('exportCountJobs').textContent = c.agent_jobs;
  document.getElementById('exportCountRuns').textContent = c.agent_runs;
  document.getElementById('exportModal').classList.add('active');
}

function closeExportModal() {
  document.getElementById('exportModal').classList.remove('active');
  _exportPayload = null;
}

document.getElementById('exportModal')?.addEventListener('click', (e) => {
  if (!e.target.closest('.confirm-content')) closeExportModal();
});

document.getElementById('exportDoBtn').addEventListener('click', () => {
  if (!_exportPayload) return;
  const includeSelf = document.getElementById('exportIncludeSelfMemories').checked;
  const includeWiki = document.getElementById('exportIncludeWiki').checked;
  const includeJobs = document.getElementById('exportIncludeJobs').checked;

  const out = {
    aperio_export: _exportPayload.aperio_export,
    exported_at: _exportPayload.exported_at,
    counts: {
      memories: _exportPayload.counts.memories,
      self_memories: includeSelf ? _exportPayload.counts.self_memories : 0,
      wiki_articles: includeWiki ? _exportPayload.counts.wiki_articles : 0,
      agent_jobs: includeJobs ? _exportPayload.counts.agent_jobs : 0,
      agent_runs: includeJobs ? _exportPayload.counts.agent_runs : 0,
    },
    memories: _exportPayload.memories,
    self_memories: includeSelf ? _exportPayload.self_memories : [],
    wiki_articles: includeWiki ? _exportPayload.wiki_articles : [],
    agent_jobs: includeJobs ? _exportPayload.agent_jobs : [],
    agent_runs: includeJobs ? _exportPayload.agent_runs : [],
  };

  const data = JSON.stringify(out, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aperio-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  closeExportModal();
});

// ── Export brain ─────────────────────────────────────────────
document.getElementById("exportBtn").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/data/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include_wiki: true, include_agent_jobs: true, include_self_memories: true }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || "Export failed");
    showExportModal(payload);
  } catch (err) {
    showErrorModal(t("export_error", { error: err.message }));
  }
});

// ── Import brain ─────────────────────────────────────────────
document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFileInput").click();
});

document.getElementById("importFileInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;

  let payload;
  try {
    const text = await file.text();
    payload = JSON.parse(text);
  } catch {
    showErrorModal(t("import_parse_failed"));
    return;
  }

  // Accept both full exports ({ memories, wiki_articles, self_memories }) and old exports (array).
  const memories = payload.memories ?? (Array.isArray(payload) ? payload : null);
  const wiki = payload.wiki_articles ?? [];
  const selfMemories = payload.self_memories ?? [];
  if (!Array.isArray(memories) || memories.length === 0) {
    showErrorModal(t("import_invalid_array"));
    return;
  }

  const confirmKey = (wiki.length > 0 || selfMemories.length > 0)
    ? "import_confirm_full"
    : (memories.length === 1 ? "import_confirm_one" : "import_confirm_many");
  const confirmMsg = t(confirmKey, { m: memories.length, w: wiki.length, s: selfMemories.length, n: memories.length, file: file.name });

  showConfirmModal("Import database", confirmMsg, "Import", async () => {
    try {
      const res = await fetch("/api/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memories, wiki_articles: wiki, self_memories: selfMemories }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Import failed");

    const imported = data.imported || {};
    const skipped = data.skipped || {};
    const parts = [
      t("import_done_memories", { n: imported.memories || 0 }),
    ];
    if (imported.wiki > 0) parts.push(t("import_done_wiki", { n: imported.wiki }));
    if (imported.self_memories > 0) parts.push(t("import_done_self_memories", { n: imported.self_memories }));
    if (skipped.memories > 0 || skipped.wiki > 0 || skipped.self_memories > 0) {
      parts.push(t("import_skipped", { m: skipped.memories || 0, w: skipped.wiki || 0, s: skipped.self_memories || 0 }));
    }
    showConfirmModal("Import complete", parts.join("\n"), "OK");

    if ((imported.memories || 0) > 0) {
      try {
        const memRes = await fetch("/api/memories");
        const memData = await memRes.json();
        renderMemoriesFromMessage(Array.isArray(memData.raw) ? memData.raw : []);
      } catch {
        window.safeSend(JSON.stringify({ type: "get_memories" }));
      }
    }
    } catch (err) {
      showErrorModal(t("import_error", { error: err.message }));
    }
  });
});
