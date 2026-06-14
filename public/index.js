// ── Type config ──────────────────────────────────────────────
// Labels are looked up via t() at render time so they follow the active locale.
const TYPE_CONFIG = {
  fact:       { icon: "◈", labelKey: "type_facts" },
  preference: { icon: "◎", labelKey: "type_preferences" },
  project:    { icon: "◱", labelKey: "type_projects" },
  decision:   { icon: "◇", labelKey: "type_decisions" },
  solution:   { icon: "◈", labelKey: "type_solutions" },
  source:     { icon: "◉", labelKey: "type_sources" },
  person:     { icon: "◯", labelKey: "type_people" },
  inference:  { icon: "◌", labelKey: "type_inferences" },
};

// ── State ────────────────────────────────────────────────────
let ws, pendingSuggestion = null, isThinking = false, hasInitialized = false;
let allMemories = []; // Global store for the current modal session
let filteredMemories = []; // Subset of allMemories matching the current search query in the modal
let currentPage = 1;
const recordsPerPage = 10;
// Set by the provider message on connection; updated if the model changes at runtime.
let maxCtx = 0;

// ── DOM refs ─────────────────────────────────────────────────
const messagesEl   = document.getElementById("messages");
const chatInput    = document.getElementById("chatInput");
const sendBtn      = document.getElementById("sendBtn");
const stopBtn      = document.getElementById("stopBtn");
const statusDot    = document.getElementById("statusDot");
const statusText   = document.getElementById("statusText");
const memoriesList = document.getElementById("memoriesList");
const searchInput  = document.getElementById("searchInput");

// ── WebSocket ────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    document.getElementById("startup-thinking")?.remove();
    if (!hasInitialized) {
      hasInitialized = true;
      setStatus("thinking", t("status_loading"));
      addThinking(false);
      ws.send(JSON.stringify({ type: "init", lang: window.Aperio.getCurrentLang() }));
    } else {
      setStatus("connected", t("status_reconnected"));
      sendBtn.disabled = chatInput.value.trim() === "";
      const lang = window.Aperio.getCurrentLang();
      if (lang !== "en") ws.send(JSON.stringify({ type: "set_lang", lang }));
    }
  };

  ws.onclose = () => {
    setStatus("", t("status_disconnected"));
    sendBtn.disabled = true;
    setTimeout(connect, 3000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };
}

function setStatus(cls, text) {
  statusDot.className = "status-dot " + cls;
  statusText.textContent = text;
  if (cls === "thinking") {
    startTitleAnimation();
  } else {
    stopTitleAnimation();
  }
}

// Animated thinking title
let titleAnimFrame = null;
const titleDots = ["", ".", "..", "..."];
let titleDotIdx = 0;

function startTitleAnimation() {
  if (titleAnimFrame) return;
  titleDotIdx = 0;
  titleAnimFrame = setInterval(() => {
    document.title = t("title_thinking") + titleDots[titleDotIdx % titleDots.length];
    titleDotIdx++;
  }, 400);
}

function stopTitleAnimation() {
  if (titleAnimFrame) { clearInterval(titleAnimFrame); titleAnimFrame = null; }
  document.title = t("page_title");
}


function parseSuggestionBlock(text) {
  const div = document.createElement("div");
  div.className = "memory-suggestion";

  const title = document.createElement("div");
  title.className = "memory-suggestion-title";
  title.textContent = t("sug_title");
  div.appendChild(title);

  const lines = text.split("\n").filter(l => /^\d+\./.test(l.trim()));
  pendingSuggestion = { lines, indices: [] };

  lines.forEach((line, i) => {
    const item = document.createElement("div");
    item.className = "suggestion-item";
    item.innerHTML = `<div class="suggestion-num">${i+1}</div><span>${renderMarkdown(line.replace(/^\d+\.\s*/, ""))}</span>`;
    div.appendChild(item);
  });

  const actions = document.createElement("div");
  actions.className = "suggestion-actions";

  const saveAll = document.createElement("button");
  saveAll.className = "btn btn-primary";
  saveAll.textContent = t("sug_save_all");
  saveAll.onclick = () => sendSuggestionResponse("all", lines.map((_, i) => i+1));

  const none = document.createElement("button");
  none.className = "btn btn-ghost";
  none.textContent = t("sug_skip");
  none.onclick = () => sendSuggestionResponse("none", []);

  lines.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = t("sug_save_n", { n: i + 1 });
    btn.onclick = () => sendSuggestionResponse("pick", [i+1]);
    actions.appendChild(btn);
  });

  actions.prepend(none);
  actions.prepend(saveAll);
  div.appendChild(actions);

  return div;
}

function sendSuggestionResponse(mode, nums) {
  const lines = pendingSuggestion?.lines ?? [];
  pendingSuggestion = null;
  document.querySelector(".memory-suggestion")?.remove();
  if (mode === "none") return;
  const items = nums
    .map(n => lines[n - 1])
    .filter(Boolean)
    .map(l => ({ text: l.replace(/^\d+\.\s*/, "").trim() }));
  if (!items.length) return;
  safeSend(JSON.stringify({ type: "save_suggestions", items }));
}

function addThinking(lockInput = true) {
  // The live activity cursor is a flat line, consistent with the persistent
  // phase breadcrumbs and tool cards (one terminal-style column). Keeps id
  // "thinking" and the .thinking-label hook so the streaming handlers can swap
  // its label (thinking… → typing…) unchanged.
  const el = document.createElement("div");
  el.className = "action-phase active";
  el.id = "thinking";
  el.innerHTML =
    `<span class="action-phase-mark live"></span>` +
    `<span class="thinking-label action-phase-label" data-i18n="chat_thinking_label">${t("chat_thinking_label")}</span>` +
    `<span class="thinking-time"></span>`;
  messagesEl.appendChild(el);
  if (lockInput) document.querySelector(".input-bar")?.classList.add("input-locked");
  document.getElementById("inputHint").textContent = t("chat_input_thinking");
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeThinking() {
  document.getElementById("thinking")?.remove();
  document.querySelector(".input-bar")?.classList.remove("input-locked");
  document.getElementById("preparing-answer")?.remove();
  const inputHint = document.getElementById("inputHint");
  if (inputHint) inputHint.innerHTML = t("chat_input_hint_html", { key: cmdKey });
}

let toolEl = null;
// Tool labels — maps MCP tool name → translation key. Looked up via t() at render
// time so the indicator follows the active language.
const TOOL_LABEL_KEYS = {
  recall:               "tool_recall",
  remember:             "tool_remember",
  forget:               "tool_forget",
  update_memory:        "tool_update_memory",
  backfill_embeddings:  "tool_backfill_embeddings",
  deduplicate_memories: "tool_deduplicate_memories",
  read_file:            "tool_read_file",
  scan_project:         "tool_scan_project",
  fetch_url:            "tool_fetch_url",
  write_file:           "tool_write_file",
  edit_file:            "tool_edit_file",
  append_file:          "tool_append_file",
  syntax_check:         "tool_syntax_check",
  run_node_script:      "tool_run_node_script",
  generate_xlsx:        "tool_generate_xlsx",
  wiki_write:           "tool_wiki_write",
  wiki_get:             "tool_wiki_get",
  wiki_search:          "tool_wiki_search",
  wiki_list:            "tool_wiki_list",
};

function addToolIndicator(name) {
  removeToolIndicator();
  toolEl = document.createElement("div");
  toolEl.className = "tool-indicator";
  const key = TOOL_LABEL_KEYS[name];
  const label = key ? t(key) : t("tool_generic", { name });
  toolEl.innerHTML = `<div class="tool-spinner"></div> ${label}`;
  messagesEl.appendChild(toolEl);
  scrollToBottom();
}

function removeToolIndicator() {
  toolEl?.remove();
  toolEl = null;
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ── WebSocket safe send ──────────────────────────────────────
function safeSend(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
}

// ── Send ─────────────────────────────────────────────────────
async function send() {
  const text = chatInput.value.trim();
  const files = window.attachedFiles || []; // Access the global array
  if ((!text && files.length === 0) || !ws) return;

  // Sending while a response is still streaming interrupts it. Tear down the
  // in-flight generation's UI locally (the server aborts the model call) and
  // flag the message so the agent is told it was cut off.
  const interrupting = isThinking;
  if (interrupting) {
    if (streamingBubble) { streamingBubble.wrap?.remove(); streamingBubble = null; streamingText = ""; }
    if (reasoningBubble) {
      if (reasoningBubble.statusSpan) reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble = null;
    }
    removeThinking();
    removeToolIndicator();
    document.getElementById("preparing-answer")?.remove();
  }

  // Prepare attachments payload
  const attachments = [];

  // Process each file
  for (const file of files) {
    const base64 = await fileToBase64(file);
    attachments.push({
      name: file.name,
      type: file.type,
      data: base64
    });
  }

  // AFTER
  const attachmentCards = getAttachmentsSnapshot();
  addUserMessage(text || (files.length > 0 ? t("chat_uploaded_files", { n: files.length }) : ""), attachmentCards); // ← new
  window.attachedFiles = [];   // must stay AFTER snapshot
  renderPreviews(); // Clear the file preview chips

  messagesEl.scrollTop = messagesEl.scrollHeight;
  chatInput.value = "";
  autoResize();
  sendBtn.disabled = true;
  isThinking = true;
  sendBtn.style.display = "none";
  stopBtn.style.display = "flex";
  requestAnimationFrame(() => {
    removeThinking();
    setStatus("thinking", t("status_thinking"));
    addThinking();
    startLiveTimer();
    const roundtable = typeof window.isRoundtableRequested === "function" && window.isRoundtableRequested();
    safeSend(JSON.stringify({ type: "chat", text, attachments, roundtable, interrupted: interrupting }));
  });
}

window.send       = send;
window.autoResize = autoResize;
window.wsSafeSend = (data) => safeSend(typeof data === "string" ? data : JSON.stringify(data));
sendBtn.onclick = send;
stopBtn.onclick = () => {
  safeSend(JSON.stringify({ type: "stop" }));
  stopLiveTimer();
  removeThinking();
  removeToolIndicator();
  document.getElementById("preparing-answer")?.remove();
  isThinking = false;
  sendBtn.style.display = "";
  stopBtn.style.display = "none";
  sendBtn.disabled = chatInput.value.trim() === "";
};

chatInput.addEventListener("keydown", (e) => {
  // Autocomplete keyboard navigation (takes priority when dropdown is open)
  if (handleAutocompleteKeydown(e)) return;

  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    send();
  }
});

chatInput.addEventListener("input", () => {
  autoResize();
  // Stay enabled even while a response streams — sending interrupts it.
  sendBtn.disabled = chatInput.value.trim() === "";
  checkAutocompleteTrigger();
});

function autoResize() {
  const el = chatInput;
  
  // 1. Reset height to allow it to shrink if text was deleted
  el.style.height = "auto";
  // 2. Get the new scrollHeight
  const newHeight = el.scrollHeight;
  // 3. Apply the height with a cap, 
  // but we use 'border-box' logic so it stays within 140px total
  el.style.height = Math.min(newHeight, 140) + "px";
  const counter = document.getElementById("charCounter");
  if (counter) {
    const len = chatInput.value.length;
    if (len > 200) {
      counter.textContent = `${len.toLocaleString()} chars`;
      counter.className = "char-counter visible" + (len > 2000 ? " verylong" : len > 800 ? " long" : "");
    } else {
      counter.className = "char-counter";
    }
  }
}

// Helper function to read files as Base64
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',')[1]); // Remove the data:image/png;base64, prefix
    reader.onerror = error => reject(error);
  });
}

// ── Memories sidebar ─────────────────────────────────────────
function renderMemoriesFromMessage(memories) {
  allMemories = Array.isArray(memories) ? memories : [];
  renderMemories(allMemories);
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

const PREVIEW_COUNT = 3;
const expandedGroups = new Set();
const collapsedGroups = new Set(Object.keys(TYPE_CONFIG));

function renderMemories(memories) {
  if (!memories.length) {
    memoriesList.innerHTML = `
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

  memoriesList.innerHTML = "";
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
      renderMemories(allMemories);
    };
    group.appendChild(header);
    const body = document.createElement("div");
    body.className = `type-group-body ${isPinnedCollapsed ? "collapsed" : ""}`;
    pinned.forEach(m => body.appendChild(makeMemoryCard(m)));
    group.appendChild(body);
    memoriesList.appendChild(group);
  }

  Object.entries(grouped).forEach(([type, items]) => {
    const cfg = TYPE_CONFIG[type] || { icon: '<i class="bi bi-circle"></i>', labelKey: null };
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
      renderMemories(allMemories);
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
        btn.onclick = (e) => { e.stopPropagation(); expandedGroups.delete(type); renderMemories(allMemories); };
      } else {
        btn.textContent = t("sidebar_show_more", { n: items.length - PREVIEW_COUNT });
        btn.onclick = (e) => { e.stopPropagation(); expandedGroups.add(type); renderMemories(allMemories); };
      }
      body.appendChild(btn);
    }

    group.appendChild(body);
    memoriesList.appendChild(group);
  });
}

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
      allMemories = allMemories.map(mem => mem.id === m.id ? { ...mem, pinned } : mem);
      renderMemories(allMemories);
    } catch { /* silent */ }
  };

  card.querySelector(".delete-btn").onclick = (e) => {
    e.stopPropagation();
    if (!m.id) return;
    if (!confirm(t("mem_delete_confirm", { title: m.title }))) return;
    card.style.opacity = "0.4";
    card.style.pointerEvents = "none";
    safeSend(JSON.stringify({ type: "delete_memory", id: m.id }));
  };

  return card;
}

function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ── Search ───────────────────────────────────────────────────
searchInput.addEventListener("input", () => {
  const q = searchInput.value.toLowerCase().trim();
  if (!q) {
    Object.keys(TYPE_CONFIG).forEach(t => collapsedGroups.add(t));
    renderMemories(allMemories);
    return;
  }
  const filtered = allMemories.filter(m =>
    m.title.toLowerCase().includes(q) ||
    m.content.toLowerCase().includes(q) ||
    m.tags.some(t => t.toLowerCase().includes(q))
  );
  const matchedTypes = new Set(filtered.map(m => m.type));
  Object.keys(TYPE_CONFIG).forEach(t => {
    if (matchedTypes.has(t)) collapsedGroups.delete(t);
    else collapsedGroups.add(t);
  });
  renderMemories(filtered);
});

// ── Export brain ─────────────────────────────────────────────
document.getElementById("exportBtn").addEventListener("click", () => {
  if (!allMemories.length) return;
  if (!confirm(t("export_confirm", { n: allMemories.length }))) return;
  const exportData = allMemories.map(({ id, createdAt, ...rest }) => rest);
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
        safeSend(JSON.stringify({ type: "get_memories" }));
      }
    }
  } catch (err) {
    alert(t("import_error", { error: err.message }));
  }
});

// ── Memory table modal ───────────────────────────────────────
function openMemoryTable() {
  const modal = document.getElementById('memoryModal');
  if (!modal) return;
  modal.style.display = 'flex';
  refreshMemories();
}

// Opened from the DB panel's "Memories" row (see scripts/db-panel.js).
window.openMemoryTable = openMemoryTable;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('memoryModal');
    if (modal && modal.style.display === 'flex') closeModal();
  }
});

document.getElementById('memoryModal').addEventListener('click', (e) => {
  if (!e.target.closest('.mem-table-content')) closeModal();
});

// ── OS-aware shortcut labels ─────────────────────────────────
const isMac = navigator.userAgentData
  ? navigator.userAgentData.platform.toUpperCase().includes("MAC")
  : navigator.userAgent.toUpperCase().includes("MAC");
const cmdKey = isMac ? "⌘" : "Ctrl";

const inputHint = document.getElementById("inputHint");
const sendBtnEl = document.getElementById("sendBtn");
if (inputHint) inputHint.innerHTML = t("chat_input_hint_html", { key: cmdKey });
if (sendBtnEl) sendBtnEl.title = t("chat_send_title", { key: cmdKey });

// Re-apply the dynamic key/title strings whenever the language changes.
document.addEventListener("aperio:lang-changed", () => {
  if (inputHint) inputHint.innerHTML = t("chat_input_hint_html", { key: cmdKey });
  if (sendBtnEl) sendBtnEl.title = t("chat_send_title", { key: cmdKey });
  applySidebar();
  // Re-render the memory sidebar so type group labels follow the new language.
  if (Array.isArray(allMemories) && allMemories.length) renderMemories(allMemories);
});

// ── Sidebar toggle ───────────────────────────────────────────
const appEl = document.querySelector(".app");
const sidebarToggleBtn = document.getElementById("sidebarToggle");
let sidebarOpen = localStorage.getItem("aperio-sidebar") !== "closed";

function applySidebar() {
  appEl.classList.toggle("sidebar-collapsed", !sidebarOpen);
  sidebarToggleBtn.title = t(sidebarOpen ? "nav_toggle_sidebar_hide" : "nav_toggle_sidebar_show", { key: cmdKey });
  sidebarToggleBtn.querySelector("i").className = sidebarOpen
    ? "bi bi-layout-sidebar"
    : "bi bi-layout-sidebar-reverse";
  localStorage.setItem("aperio-sidebar", sidebarOpen ? "open" : "closed");
}

sidebarToggleBtn.addEventListener("click", () => {
  sidebarOpen = !sidebarOpen;
  applySidebar();
});

// Memories icon on the collapsed rail: expand the sidebar and focus search.
function expandSidebarToMemories() {
  if (!sidebarOpen) {
    sidebarOpen = true;
    applySidebar();
  }
  searchInput.focus();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    sidebarOpen = !sidebarOpen;
    applySidebar();
  }
});

applySidebar();

// ── Reasoning toggle ─────────────────────────────────────────
function showPreview(memory) {
    try {
        const mem = JSON.parse(memory);
        // Fill Title & Content
        document.querySelector('.mtitle').textContent = mem.title;
        document.querySelector('.mcontent').textContent = mem.content;

        // Visual Importance (Stars)
        // Generate the stars as HTML icons
        let starHTML = '';
        for (let i = 1; i <= 5; i++) {
            if (i <= mem.importance) {
                // Filled star icon
                starHTML += '<i class="bi bi-star-fill"></i>'; 
            } else {
                // Empty star icon
                starHTML += '<i class="bi bi-star"></i>';
            }
        }
        document.querySelector('.importance-rating').innerHTML = `Importance: <span class="stars">${starHTML}</span>`;

        // Tags (Chips)
        const tagHTML = mem.tags.map(tag => `<span>#${tag}</span>`).join('');
        document.querySelector('.mtags').innerHTML = tagHTML;
        
        // Type Badge
        const badge = document.querySelector('.type-badge');
        badge.textContent = mem.type.toUpperCase();
        badge.className = `type-badge ${mem.type}`; // Color it via CSS

        document.querySelector('.preview-modal').classList.add('active');
    } catch (e) {
        console.error("Could not parse memory data. Value was:", memory);
        return;
    }
}
function closePreview() {
  document.querySelector('.preview-modal').classList.remove('active');
}

document.addEventListener('click', (e) => {
  const modal = document.querySelector('.preview-modal');
  
  if (modal?.classList.contains('active') && !e.target.closest('.preview-content')) {
    closePreview();
  }
  
  const target = e.target.closest('.memory-preview');
  if (target) {
    const jsonStr = decodeURIComponent(escape(atob(target.dataset.memory)));
    showPreview(jsonStr);
  }
});


// Close modal when pressing ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelector('.preview-modal')?.classList.remove('active');
  }
});

function closeModal() {
  const modal = document.getElementById('memoryModal');
  if (modal) modal.style.display = 'none';
}

async function refreshMemories() {
  try {
    const res = await fetch('/api/memories');
    const data = await res.json();
    allMemories = Array.isArray(data.raw) ? data.raw : [];
    filteredMemories = [...allMemories];
    const searchInput = document.getElementById('memory-search');
    if (searchInput) searchInput.value = '';
    currentPage = 1;
    updateModalCount();
    renderTablePage();
  } catch (err) {
    const wrapper = document.getElementById('table-wrapper');
    if (wrapper) wrapper.innerHTML = `<div class="mem-empty" style="color:#ef4444;">${escapeHtml(err.message)}</div>`;
  }
}

function updateModalCount() {
  const el = document.getElementById('memTableCount');
  if (el) el.textContent = allMemories.length ? `(${allMemories.length})` : '';
  const info = document.getElementById('mem-filter-info');
  if (info) info.textContent = '';
}

function handleSearch() {
  const searchInput = document.getElementById('memory-search');
  if (!searchInput) return;
  const term = searchInput.value.toLowerCase();
  filteredMemories = allMemories.filter(m => {
    const meta = m.metadata || m;
    const tagsStr = parseTags(meta.tags);
    const blob = `${meta.title || ''} ${meta.content || ''} ${tagsStr}`.toLowerCase();
    return blob.includes(term);
  });
  currentPage = 1;
  const info = document.getElementById('mem-filter-info');
  if (info) {
    info.textContent = term
      ? `${filteredMemories.length} of ${allMemories.length} rows`
      : '';
  }
  renderTablePage();
}


function parseTags(tags) {
  if (!tags) return '';
  if (Array.isArray(tags)) return tags.join(', ');
  if (typeof tags !== 'string') return '';
  const s = tags.trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1);
    const items = [];
    let cur = '', inQ = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { if (cur.trim()) items.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
    if (cur.trim()) items.push(cur.trim());
    return items.join(', ');
  }
  try { const p = JSON.parse(s); return Array.isArray(p) ? p.join(', ') : s; }
  catch { return s; }
}

function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toISOString().slice(0, 16).replace('T', ' ');
}

function impDots(importance) {
  const n = Math.min(Math.max(Number(importance) || 0, 0), 5);
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="mem-imp-dot${i < n ? ' on' : ''}"></span>`
  ).join('');
}

function renderTablePage() {
  const wrapper = document.getElementById('table-wrapper');
  const pageInfo = document.getElementById('page-info');
  const controls = document.getElementById('pagination-controls');
  if (!wrapper || !controls) return;

  if (filteredMemories.length === 0) {
    wrapper.innerHTML = '<div class="mem-empty">No memories found.</div>';
    controls.style.display = 'none';
    return;
  }

  const start = (currentPage - 1) * recordsPerPage;
  const end = start + recordsPerPage;
  const pageItems = filteredMemories.slice(start, end);
  const totalPages = Math.ceil(filteredMemories.length / recordsPerPage) || 1;

  controls.style.display = 'flex';
  if (pageInfo) {
    pageInfo.textContent = `${currentPage} / ${totalPages}  ·  ${filteredMemories.length} rows`;
  }

  let html = `<table class="mem-tbl">
    <thead>
      <tr>
        <th class="mem-col-num">#</th>
        <th class="mem-col-type">Type</th>
        <th>Memory</th>
        <th class="mem-col-imp">Imp.</th>
        <th class="mem-col-del"></th>
      </tr>
    </thead>
    <tbody>`;

  html += pageItems.map((m, i) => {
    const row = m.metadata || m;
    const rowNum = start + i + 1;

    const type       = row.type    || 'unknown';
    const title      = row.title   || 'Untitled';
    const content    = row.content || '';
    const tagsStr    = parseTags(row.tags);
    const importance = row.importance != null ? Number(row.importance) : 1;

    const id        = row.id || '';
    const createdAt = fmtDate(row.created_at || row.createdAt);
    const source    = row.source || '';
    const expiresAt = (row.expires_at || row.expiresAt) ? fmtDate(row.expires_at || row.expiresAt) : null;

    const safeType    = escapeHtml(type);
    const safeTitle   = escapeHtml(title);
    const safeContent = escapeHtml(content);
    const safeTags    = escapeHtml(tagsStr);

    const metaParts = [];
    if (id)        metaParts.push(`<span class="mem-meta-label">id</span> ${escapeHtml(id)}`);
    if (createdAt) metaParts.push(`<span class="mem-meta-label">created</span> ${escapeHtml(createdAt)}`);
    if (source)    metaParts.push(`<span class="mem-meta-label">source</span> ${escapeHtml(source)}`);
    if (expiresAt) metaParts.push(`<span class="mem-meta-label">expires</span> ${escapeHtml(expiresAt)}`);
    const metaHtml = metaParts.length
      ? `<div class="mem-meta-row">${metaParts.map(p => `<span>${p}</span>`).join('')}</div>`
      : '';

    return `<tr>
      <td class="mem-col-num mem-row-num">${rowNum}</td>
      <td class="mem-col-type"><span class="mem-type-badge">${safeType}</span></td>
      <td>
        <div class="mem-content-title">${safeTitle}</div>
        <div class="mem-content-body">${safeContent}</div>
        ${safeTags ? `<div class="mem-tags-row">🏷️ ${safeTags}</div>` : ''}
        ${metaHtml}
      </td>
      <td class="mem-col-imp mem-imp-cell" title="Importance: ${importance}/5">
        <span class="mem-imp-dots">${impDots(importance)}</span>
      </td>
      <td class="mem-col-del">
        <button class="mem-del-btn" data-id="${escapeHtml(id)}" data-title="${safeTitle}" title="Delete memory">
          <i class="bi bi-trash3"></i>
        </button>
      </td>
    </tr>`;
  }).join('');

  html += '</tbody></table>';
  wrapper.innerHTML = html;

  wrapper.querySelectorAll('.mem-del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const title = btn.dataset.title;
      if (!id) return;
      if (!confirm(t('mem_delete_confirm', { title }))) return;
      allMemories = allMemories.filter(m => (m.metadata || m).id !== id);
      filteredMemories = filteredMemories.filter(m => (m.metadata || m).id !== id);
      safeSend(JSON.stringify({ type: 'delete_memory', id }));
      updateModalCount();
      renderMemories(allMemories);
      renderTablePage();
    });
  });

  document.getElementById('prev-page').disabled = currentPage === 1;
  document.getElementById('next-page').disabled = currentPage === totalPages;
}


function changePage(step) {
  currentPage += step;
  renderTablePage();
  const body = document.querySelector('.mem-table-body');
  if (body) body.scrollTop = 0;
}


// ── Boot ─────────────────────────────────────────────────────
connect();


let _ctxHWM = 0; // high-water mark — only advances, never drops

function updateContextBar(used, max, outputTok = 0) {
  const text = document.getElementById("ctxText");
  const fill = document.getElementById("ctxFill");
  if (!text || !fill) return;

  // Take the higher of the API's reported input_tokens vs our running total,
  // then always add output_tokens — those tokens are now in context for the next call.
  _ctxHWM = Math.max(_ctxHWM, used) + outputTok;
  const display = _ctxHWM;

  if (!max || max <= 0) {
    text.textContent = `${display.toLocaleString()} / —`;
    fill.style.width = "0%";
    return;
  }

  const pct = Math.min(100, (display / max) * 100);
  const roundedPct = Math.round(pct);
  text.textContent = `${display.toLocaleString()} / ${max.toLocaleString()}`;
  fill.style.width = `${pct}%`;

  // Keep the context pressure banner in sync
  if (typeof ctxBannerEl !== "undefined" && ctxBannerEl) {
    const textEl = ctxBannerEl.querySelector(".ctx-banner-text");
    if (textEl) {
      const isTrimmed = ctxBannerEl.classList.contains("ctx-banner--trimmed");
      textEl.textContent = isTrimmed
        ? t("ctx_trimmed", { pct: roundedPct })
        : t("ctx_warn", { pct: roundedPct });
    }
  }
}

// ── Autocomplete: /skill and @ ───────────────────────────────────
(function initAutocomplete() {
  const inputBar = document.querySelector(".input-bar");
  if (!inputBar || !chatInput) return;

  // Create dropdown element
  const dropdown = document.createElement("div");
  dropdown.className = "autocomplete-dropdown";
  dropdown.id = "autocompleteDropdown";
  inputBar.appendChild(dropdown);

  const state = {
    mode: null,
    query: "",
    items: [],
    selectedIdx: -1,
    triggerStart: -1,
    fetchId: 0,
  };

  function hideDropdown() {
    dropdown.classList.remove("active");
    state.mode = null;
    state.items = [];
    state.selectedIdx = -1;
    state.query = "";
    state.triggerStart = -1;
  }

  function renderItems() {
    dropdown.innerHTML = "";
    if (state.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "autocomplete-empty";
      empty.textContent = state.mode === "skill"
        ? (state.query ? "No matching skills" : "Type to search skills\u2026")
        : (state.query.length < 2 ? "Type at least 2 characters\u2026" : "No matching files");
      dropdown.appendChild(empty);
      return;
    }
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      const div = document.createElement("div");
      div.className = "autocomplete-item" + (i === state.selectedIdx ? " selected" : "");
      const icon = document.createElement("span");
      icon.className = "autocomplete-icon";
      icon.textContent = state.mode === "skill" ? "\u26a1" : (item.isDir ? "\ud83d\udcc1" : "\ud83d\udcc4");
      const name = document.createElement("span");
      name.className = "autocomplete-name";
      name.textContent = item.name;
      div.appendChild(icon);
      div.appendChild(name);
      if (state.mode === "skill" && item.description) {
        const desc = document.createElement("span");
        desc.className = "autocomplete-desc";
        const s = item.description.split(/\.\s/)[0] + ".";
        desc.textContent = s.length > 60 ? s.slice(0, 57) + "\u2026" : s;
        div.appendChild(desc);
      }
      const idx = i;
      div.addEventListener("mousedown", function (e) { e.preventDefault(); selectItem(idx); });
      dropdown.appendChild(div);
    }
    dropdown.classList.add("active");
  }

  function selectItem(idx) {
    var item = state.items[idx];
    if (!item) return;
    var text = chatInput.value;
    if (state.mode === "skill") {
      var before = text.slice(0, state.triggerStart);
      var afterSlash = text.slice(state.triggerStart);
      var afterName = afterSlash.replace(/^\/skill\s+\S*/, "");
      var replacement = "/skill " + item.name;
      chatInput.value = before + replacement + (afterName.startsWith(" ") ? "" : " ") + afterName.trimStart();
      chatInput.setSelectionRange(before.length + replacement.length + 1, before.length + replacement.length + 1);
    } else {
      var before = text.slice(0, state.triggerStart);
      var afterAt = text.slice(state.triggerStart);
      var afterName = afterAt.replace(/^@\S*/, "");
      var replacement = "@" + item.name;
      chatInput.value = before + replacement + (afterName.startsWith(" ") ? "" : " ") + afterName.trimStart();
      chatInput.setSelectionRange(before.length + replacement.length + 1, before.length + replacement.length + 1);
    }
    hideDropdown();
    chatInput.focus();
    autoResize();
    sendBtn.disabled = chatInput.value.trim() === "";
  }

  async function fetchItems(mode, query) {
    state.fetchId++;
    var fetchId = state.fetchId;
    state.selectedIdx = -1;
    var url = mode === "skill" ? "/api/skills" : "/api/files?q=" + encodeURIComponent(query);
    try {
      var resp = await fetch(url);
      if (fetchId !== state.fetchId) return;
      var data = await resp.json();
      if (fetchId !== state.fetchId) return;
      var items = mode === "skill"
        ? (data.skills || []).filter(function (s) { return s.name.toLowerCase().includes(query.toLowerCase()); }).slice(0, 10)
        : (data.files || []).slice(0, 10);
      state.items = items;
      renderItems();
    } catch (e) {
      state.items = [];
      renderItems();
    }
  }

  window.checkAutocompleteTrigger = function () {
    var text = chatInput.value;
    var pos = chatInput.selectionStart;
    var slashMatch = text.slice(0, pos).match(/(?:^|\s)(\/skill\s+)([a-zA-Z][a-zA-Z0-9-]*)$/);
    if (slashMatch) {
      var query = slashMatch[2];
      var triggerStart = slashMatch.index + slashMatch[1].length - ("/skill ".length);
      if (state.mode !== "skill" || state.query !== query) {
        state.mode = "skill";
        state.query = query;
        state.triggerStart = triggerStart;
        fetchItems("skill", query);
      }
      return;
    }
    var atMatch = text.slice(0, pos).match(/(?:^|\s)(@)(\S*)$/);
    if (atMatch) {
      var query = atMatch[2];
      var triggerStart = atMatch.index + atMatch[1].length - 1;
      if (state.mode !== "file" || state.query !== query) {
        state.mode = "file";
        state.query = query;
        state.triggerStart = triggerStart;
        if (query.length >= 2) { fetchItems("file", query); }
        else { state.items = []; renderItems(); }
      }
      return;
    }
    if (state.mode) hideDropdown();
  };

  window.handleAutocompleteKeydown = function (e) {
    if (!dropdown.classList.contains("active")) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); state.selectedIdx = Math.min(state.selectedIdx + 1, state.items.length - 1); renderItems(); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); state.selectedIdx = Math.max(state.selectedIdx - 1, 0); renderItems(); return true; }
    if (e.key === "Enter" || e.key === "Tab") {
      if (state.selectedIdx >= 0 && state.items.length > 0) { e.preventDefault(); selectItem(state.selectedIdx); return true; }
      if (state.items.length === 1 && e.key === "Tab") { e.preventDefault(); selectItem(0); return true; }
    }
    if (e.key === "Escape") { e.preventDefault(); hideDropdown(); return true; }
    return false;
  };

  document.addEventListener("click", function (e) {
    if (!dropdown.contains(e.target) && e.target !== chatInput) hideDropdown();
  });

  chatInput.addEventListener("blur", function () {
    setTimeout(function () { if (!dropdown.contains(document.activeElement)) hideDropdown(); }, 150);
  });
})();

