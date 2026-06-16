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

function renderMemories(memories) {
  if (!memories.length) {
    window.memoriesList.innerHTML = `
      <div class="empty-state" style="padding:24px 16px; text-align:center; line-height:1.8;">
        <div style="font-size:22px; margin-bottom:8px; opacity:.4">◈</div>
        <div style="font-weight:500; margin-bottom:6px; color:var(--text)" data-i18n="sidebar_empty_title">${t("sidebar_empty_title")}</div>
        <div style="font-size:12px; color:var(--text-muted)" data-i18n-html="sidebar_empty_hint_html">${t("sidebar_empty_hint_html")}</div>
      </div>`;
    return;
  }

  const pinned  = memories.filter(m => m.pinned);
  const grouped = {};
  memories.filter(m => !m.pinned).forEach(m => {
    if (!grouped[m.type]) grouped[m.type] = [];
    grouped[m.type].push(m);
  });

  window.memoriesList.innerHTML = "";
  const countBadge = document.getElementById("memoryCountBadge");
  if (countBadge) countBadge.textContent = memories.length ? `(${memories.length})` : "";

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
    ${m.tags.length ? `<div class="memory-tags">${m.tags.map(tg => `<span class="tag">${escapeHtml(tg)}</span>`).join("")}</div>` : ""}
    <div class="importance-bar">
      ${pips}
      ${ts ? `<span class="memory-ts">${ts}</span>` : ""}
    </div>`;

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

// ── Search ───────────────────────────────────────────────────
window.searchInput.addEventListener("input", () => {
  const q = window.searchInput.value.toLowerCase().trim();
  if (!q) {
    Object.keys(window.TYPE_CONFIG).forEach(t => collapsedGroups.add(t));
    renderMemories(window.allMemories);
    return;
  }
  const filtered = window.allMemories.filter(m =>
    m.title.toLowerCase().includes(q) ||
    m.content.toLowerCase().includes(q) ||
    m.tags.some(t => t.toLowerCase().includes(q))
  );
  const matchedTypes = new Set(filtered.map(m => m.type));
  Object.keys(window.TYPE_CONFIG).forEach(t => {
    if (matchedTypes.has(t)) collapsedGroups.delete(t);
    else collapsedGroups.add(t);
  });
  renderMemories(filtered);
});

// ── Export brain ─────────────────────────────────────────────
document.getElementById("exportBtn").addEventListener("click", () => {
  if (!window.allMemories.length) return;
  if (!confirm(t("export_confirm", { n: window.allMemories.length }))) return;
  const exportData = window.allMemories.map(({ id, createdAt, ...rest }) => rest);
  const data = JSON.stringify(exportData, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aperio-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Import brain ─────────────────────────────────────────────
document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFileInput").click();
});

document.getElementById("importFileInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;

  let memories;
  try {
    const text = await file.text();
    memories = JSON.parse(text);
  } catch {
    alert(t("import_parse_failed"));
    return;
  }

  if (!Array.isArray(memories) || memories.length === 0) {
    alert(t("import_invalid_array"));
    return;
  }

  const confirmKey = memories.length === 1 ? "import_confirm_one" : "import_confirm_many";
  if (!confirm(t(confirmKey, { n: memories.length, file: file.name }))) return;

  try {
    const res = await fetch("/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memories }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Import failed");

    const msg = data.errors?.length
      ? t("import_done_with_errors", { n: data.imported, e: data.errors.length })
      : t(data.imported === 1 ? "import_done_one" : "import_done_many", { n: data.imported });
    alert(msg);

    if (data.imported > 0) {
      // Fetch directly from REST — avoids the MCP subprocess cache which
      // doesn't know about memories written by the REST import endpoint.
      try {
        const memRes = await fetch("/api/memories");
        const memData = await memRes.json();
        renderMemoriesFromMessage(Array.isArray(memData.raw) ? memData.raw : []);
      } catch {
        window.safeSend(JSON.stringify({ type: "get_memories" }));
      }
    }
  } catch (err) {
    alert(t("import_error", { error: err.message }));
  }
});
