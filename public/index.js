// ── Type config ──────────────────────────────────────────────
const TYPE_CONFIG = {
  fact:       { icon: "◈", label: "Facts" },
  preference: { icon: "◎", label: "Preferences" },
  project:    { icon: "◱", label: "Projects" },
  decision:   { icon: "◇", label: "Decisions" },
  solution:   { icon: "◈", label: "Solutions" },
  source:     { icon: "◉", label: "Sources" },
  person:     { icon: "◯", label: "People" },
};

// ── State ────────────────────────────────────────────────────
let ws, pendingSuggestion = null, isThinking = false, hasInitialized = false;
let allMemories = []; // Global store for the current modal session
filteredMemories = []; // Subset of allMemories matching the current search query in the modal
let currentPage = 1;
const recordsPerPage = 3;
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
      setStatus("thinking", "loading…");
      addThinking();
      ws.send(JSON.stringify({ type: "init" }));
    } else {
      setStatus("connected", "reconnected");
      sendBtn.disabled = chatInput.value.trim() === "" || isThinking;
    }
  };

  ws.onclose = () => {
    setStatus("", "disconnected");
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
    document.title = "● Aperio is thinking" + titleDots[titleDotIdx % titleDots.length];
    titleDotIdx++;
  }, 400);
}

function stopTitleAnimation() {
  if (titleAnimFrame) { clearInterval(titleAnimFrame); titleAnimFrame = null; }
  document.title = "Aperio";
}


function parseSuggestionBlock(text) {
  const div = document.createElement("div");
  div.className = "memory-suggestion";

  const title = document.createElement("div");
  title.className = "memory-suggestion-title";
  title.textContent = "✦ Memory suggestions";
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
  saveAll.textContent = "Save all";
  saveAll.onclick = () => sendSuggestionResponse("all", lines.map((_, i) => i+1));

  const none = document.createElement("button");
  none.className = "btn btn-ghost";
  none.textContent = "Skip";
  none.onclick = () => sendSuggestionResponse("none", []);

  lines.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = `Save ${i+1}`;
    btn.onclick = () => sendSuggestionResponse("pick", [i+1]);
    actions.appendChild(btn);
  });

  actions.prepend(none);
  actions.prepend(saveAll);
  div.appendChild(actions);

  return div;
}

function sendSuggestionResponse(mode, nums) {
  if (!ws) return;
  const text = mode === "none" ? "none" : nums.join(" ");
  addMessage("user", mode === "none" ? "Skip — don't save" : `Save suggestions: ${nums.join(", ")}`);
  ws.send(JSON.stringify({ type: "chat", text: `Please save memory suggestions: ${text}` }));
  pendingSuggestion = null;
}

function addThinking() {
  const el = document.createElement("div");
  el.className = "thinking";
  el.id = "thinking";
  el.innerHTML = `
    <div class="avatar ai">A</div>
    <div class="thinking-dots">
      <div class="thinking-dots-row">
        <div class="thinking-dot"></div>
        <div class="thinking-dot"></div>
        <div class="thinking-dot"></div>
      </div>
      <div class="thinking-label">thinking…</div>
    </div>`;
  messagesEl.appendChild(el);
  document.querySelector(".input-bar")?.classList.add("input-locked");
  document.getElementById("inputHint").textContent = "Aperio is thinking…";
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeThinking() {
  document.getElementById("thinking")?.remove();
  document.querySelector(".input-bar")?.classList.remove("input-locked");
  document.getElementById("preparing-answer")?.remove();
  const inputHint = document.getElementById("inputHint");
  if (inputHint) inputHint.innerHTML = `${cmdKey}↵ to send &nbsp;·&nbsp; Shift↵ for newline`;
}

let toolEl = null;
const TOOL_LABELS = {
  recall:             "Searching memories…",
  remember:           "Saving memory…",
  forget:             "Deleting memory…",
  update_memory:      "Updating memory…",
  backfill_embeddings:"Generating embeddings…",
  deduplicate_memories:     "Checking for duplicates…",
  read_file:          "Reading file…",
  scan_project:       "Scanning project…",
  fetch_url:          "Fetching URL…",
};

function addToolIndicator(name) {
  removeToolIndicator();
  toolEl = document.createElement("div");
  toolEl.className = "tool-indicator";
  const label = TOOL_LABELS[name] || `Using ${name}…`;
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
  if (!text && files.length === 0 || isThinking || !ws) return;

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
  addUserMessage(text || (files.length > 0 ? `Uploaded ${files.length} file(s)` : ""), attachmentCards); // ← new
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
    setStatus("thinking", "thinking…");
    addThinking();
    safeSend(JSON.stringify({ type: "chat", text, attachments }));
  });
}

sendBtn.onclick = send;
stopBtn.onclick = () => {
  safeSend(JSON.stringify({ type: "stop" }));
  removeThinking();
  removeToolIndicator();
  document.getElementById("preparing-answer")?.remove();
  isThinking = false;
  sendBtn.style.display = "";
  stopBtn.style.display = "none";
  sendBtn.disabled = chatInput.value.trim() === "";
};

chatInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    send();
  }
});

chatInput.addEventListener("input", () => {
  autoResize();
  sendBtn.disabled = chatInput.value.trim() === "" || isThinking;
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
        <div style="font-weight:500; margin-bottom:6px; color:var(--text)">No memories yet</div>
        <div style="font-size:12px; color:var(--text-muted)">
          Tell Aperio something worth keeping.<br>
          Try: <em>"Remember that I prefer TypeScript"</em>
        </div>
      </div>`;
    return;
  }

  const grouped = {};
  memories.forEach(m => {
    if (!grouped[m.type]) grouped[m.type] = [];
    grouped[m.type].push(m);
  });

  memoriesList.innerHTML = "";
  const countEl = document.getElementById("memoryCount");
  if (countEl) countEl.textContent = memories.length ? `(${memories.length})` : "";

  Object.entries(grouped).forEach(([type, items]) => {
    const cfg = TYPE_CONFIG[type] || { icon: '<i class="bi bi-circle"></i>', label: type };
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
      <span>${cfg.label}</span>
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
        btn.textContent = "▴ show less";
        btn.onclick = (e) => { e.stopPropagation(); expandedGroups.delete(type); renderMemories(allMemories); };
      } else {
        btn.textContent = `▾ ${items.length - PREVIEW_COUNT} more`;
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
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
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
      <button class="delete-btn" title="Delete memory"><i class="bi bi-trash3"></i></button>
    </div>
    <div class="memory-preview" data-memory='${base64Data}'>${escapeHtml(m.content)}</div>
    ${m.tags.length ? `<div class="memory-tags">${m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    <div class="importance-bar">
      ${pips}
      ${ts ? `<span class="memory-ts">${ts}</span>` : ""}
    </div>`;

  card.querySelector(".delete-btn").onclick = (e) => {
    e.stopPropagation();
    if (!m.id) return;
    if (!confirm(`Delete "${m.title}"?`)) return;
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
  if (!confirm(`Aperio will export ${allMemories.length} memories in JSON file?`)) return;
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
    alert("Could not parse file — make sure it is a valid Aperio JSON export.");
    return;
  }

  if (!Array.isArray(memories) || memories.length === 0) {
    alert("The file does not contain a valid memories array.");
    return;
  }

  if (!confirm(`Import ${memories.length} memor${memories.length === 1 ? "y" : "ies"} from "${file.name}"?`)) return;

  try {
    const res = await fetch("/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memories }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Import failed");

    const msg = data.errors?.length
      ? `Imported ${data.imported} memor${data.imported === 1 ? "y" : "ies"}. ${data.errors.length} skipped.`
      : `Imported ${data.imported} memor${data.imported === 1 ? "y" : "ies"} successfully.`;
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
    alert(`Import error: ${err.message}`);
  }
});

// ── OS-aware shortcut labels ─────────────────────────────────
const isMac = navigator.userAgentData
  ? navigator.userAgentData.platform.toUpperCase().includes("MAC")
  : navigator.userAgent.toUpperCase().includes("MAC");
const cmdKey = isMac ? "⌘" : "Ctrl";

const inputHint = document.getElementById("inputHint");
const sendBtnEl = document.getElementById("sendBtn");
if (inputHint) inputHint.innerHTML = `${cmdKey}↵ to send &nbsp;·&nbsp; Shift↵ for newline`;
if (sendBtnEl) sendBtnEl.title = `Send (${cmdKey}+Enter)`;

// ── Sidebar toggle ───────────────────────────────────────────
const appEl = document.querySelector(".app");
const sidebarToggleBtn = document.getElementById("sidebarToggle");
let sidebarOpen = localStorage.getItem("aperio-sidebar") !== "closed";

function applySidebar() {
  appEl.classList.toggle("sidebar-collapsed", !sidebarOpen);
  sidebarToggleBtn.title = sidebarOpen ? `Hide sidebar (${cmdKey}B)` : `Show sidebar (${cmdKey}B)`;
  sidebarToggleBtn.querySelector("i").className = sidebarOpen
    ? "bi bi-layout-sidebar"
    : "bi bi-layout-sidebar-reverse";
  localStorage.setItem("aperio-sidebar", sidebarOpen ? "open" : "closed");
}

sidebarToggleBtn.addEventListener("click", () => {
  sidebarOpen = !sidebarOpen;
  applySidebar();
});

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
    document.getElementById('memoryModal').style.display = 'none';
}

async function refreshMemories() {
    try {
        const res = await fetch('/api/memories');
        const data = await res.json();
        
        // Save to both arrays initially
        allMemories = Array.isArray(data.raw) ? data.raw : [];
        filteredMemories = [...allMemories]; 
        
        // Reset search input
        const searchInput = document.getElementById('memory-search');
        if (searchInput) searchInput.value = '';
        currentPage = 1;
        renderTablePage();
    } catch (err) {
        document.getElementById('table-wrapper').innerHTML = `<p style="color:red;">${err.message}</p>`;
    }
}

function handleSearch() {
    const searchInput = document.getElementById('memory-search');
    if (!searchInput) return;
    
    const term = searchInput.value.toLowerCase();
    
    filteredMemories = allMemories.filter(m => {
        const meta = m.metadata || m;
        
        // --- SAFE TAG CONVERSION ---
        let tagsString = "";
        if (Array.isArray(meta.tags)) {
            tagsString = meta.tags.join(' ');
        } else if (typeof meta.tags === 'string') {
            tagsString = meta.tags;
        }

        // Combine all searchable text
        const searchBlob = `${meta.title || ''} ${meta.content || ''} ${tagsString}`.toLowerCase();
        
        return searchBlob.includes(term);
    });

    currentPage = 1;
    renderTablePage();
}


function renderTablePage() {
    // 1. Re-define the elements so this function can see them
    const wrapper = document.getElementById('table-wrapper');
    const pageInfo = document.getElementById('page-info');
    const controls = document.getElementById('pagination-controls'); // THIS WAS MISSING
    
    // Safety check: if we aren't on a page with a modal, stop
    if (!wrapper || !controls) return;

    if (filteredMemories.length === 0) {
        wrapper.innerHTML = '<p style="text-align:center; padding:20px; opacity:0.6;">no_results_found</p>';
        controls.style.display = 'none';
        return;
    }

    const start = (currentPage - 1) * recordsPerPage;
    const end = start + recordsPerPage;
    const pageItems = filteredMemories.slice(start, end);
    const totalPages = Math.ceil(filteredMemories.length / recordsPerPage) || 1;

    // 2. Now 'controls' is defined and won't crash
    controls.style.display = 'flex';
    if (pageInfo) {
        pageInfo.innerText = `page ${currentPage}/${totalPages} (${filteredMemories.length} results)`;
    }

    let html = `<table style="width:100%; border-collapse:collapse; font-size:14px;">
        <thead style="background:#f4f4f4;">
            <tr>
                <th style="padding:10px; text-align:left; width:80px;">Type</th>
                <th style="padding:10px; text-align:left;">Memory</th>
                <th style="padding:10px; text-align:center; width:40px;">Importance</th>
            </tr>
        </thead>
        <tbody>`;

    html += pageItems.map(m => {
        const meta = m.metadata || m;
        // Convert importance (1-5) into star symbols
        // Ensure importance is a safe integer between 1 and 5 (inclusive)
        let rawImportance = Number.parseInt(meta.importance, 10);
        if (!Number.isFinite(rawImportance) || Number.isNaN(rawImportance)) {
            rawImportance = 1;
        }
        const importance = Math.min(Math.max(Math.floor(rawImportance), 1), 5);
        const stars = "⭐".repeat(importance);
        // --- BULLETPROOF TAGS ---
        let tagsArray = [];
        if (Array.isArray(meta.tags)) {
            tagsArray = meta.tags;
        } else if (typeof meta.tags === 'string') {
            // If it's a string, try to parse it or just split it
            try {
                const parsed = JSON.parse(meta.tags);
                tagsArray = Array.isArray(parsed) ? parsed : [meta.tags];
            } catch {
                tagsArray = meta.tags.split(',').map(t => t.trim());
            }
        }

        // Escape user-controlled fields before injecting into HTML
        const safeType = escapeHtml(meta.type || 'fact');
        const safeTitle = escapeHtml(meta.title || 'Untitled');
        const safeContent = escapeHtml(meta.content || '');
        const safeTags = tagsArray.map(t => escapeHtml(t)).join(', ');

        return `<tr style="border-bottom:1px solid #eee;">
            <td style="padding:8px; vertical-align:top;"><code>${safeType}</code></td>
            <td style="padding:8px;">
                <div style="font-weight:bold; margin-bottom:4px;">${safeTitle}</div>
                <div style="color:#555;">${safeContent}</div>
                <div style="margin-top:5px;"><small style="color:#888;">🏷️ ${safeTags}</small></div>
            </td>
            <!-- ⭐ Updated Importance Column -->
            <td style="padding: 10px; text-align: center; vertical-align: top; white-space: nowrap; font-size: 14px;">
                <span title="Importance: ${importance}/5">${stars}</span>
            </td>
        </tr>`;
    }).join('');

    html += '</tbody></table>';
    wrapper.innerHTML = html;

    document.getElementById('prev-page').disabled = currentPage === 1;
    document.getElementById('next-page').disabled = currentPage === totalPages;
}


function changePage(step) {
    currentPage += step;
    renderTablePage();
    // Scroll modal to top when changing page
    document.querySelector('#memoryModal > div').scrollTop = 0;
}

async function checkDatabaseBackend() {
  const btn = document.getElementById('view-memories-btn');
  if (!btn) return;

  try {
    const res = await fetch('/api/config');
    const config = await res.json();

    // ONLY show if it's LanceDB. Hide if it's Postgres or anything else.
    if (config.backend === 'lancedb') {
        btn.style.display = 'inline-block';
    } else {
        btn.style.display = 'none';
    }
  } catch (err) {
    // Fallback: Hide if we can't determine the backend
    btn.style.display = 'none';
  }
}

// Run the check when the page loads
document.addEventListener('DOMContentLoaded', checkDatabaseBackend);

// ── Boot ─────────────────────────────────────────────────────
connect();


function updateContextBar(used, max) {
  const text = document.getElementById("ctxText");
  const fill = document.getElementById("ctxFill");
  if (!text || !fill) return;

  if (!max || max <= 0) {
    text.textContent = `${used.toLocaleString()} / —`;
    fill.style.width = "0%";
    return;
  }

  const pct = Math.min(100, (used / max) * 100);
  text.textContent = `${used.toLocaleString()} / ${max.toLocaleString()}`;
  fill.style.width = `${pct}%`;
}



