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
  if (Array.isArray(window.allMemories) && window.allMemories.length) window.renderMemories(window.allMemories);
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
  window.searchInput.focus();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    sidebarOpen = !sidebarOpen;
    applySidebar();
  }
});

applySidebar();

// ── Nav density (compact icon strip ⇄ full labels) ───────────
// Compact by default so the memory list gets the height back. The toggle
// (and stored preference) lets label-navigators opt back into the full list.
const sidebarNav = document.getElementById("sidebarNav");
const navDensityToggle = document.getElementById("navDensityToggle");
let navCompact = localStorage.getItem("aperio-nav-compact") !== "off";

function applyNavDensity() {
  sidebarNav.classList.toggle("is-compact", navCompact);
  navDensityToggle.querySelector("i").className = navCompact
    ? "bi bi-arrows-expand sidebar-nav-icon"
    : "bi bi-arrows-collapse sidebar-nav-icon";
  navDensityToggle.querySelector(".sidebar-nav-label").textContent = navCompact ? "Expand" : "Compact";
  navDensityToggle.title = navCompact ? "Expand to full list" : "Compact into a grid";
  localStorage.setItem("aperio-nav-compact", navCompact ? "on" : "off");
}

navDensityToggle.addEventListener("click", () => {
  navCompact = !navCompact;
  applyNavDensity();
});

applyNavDensity();

// ── Reasoning toggle / memory preview ────────────────────────
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

// ── Boot ─────────────────────────────────────────────────────
window.connect();

// ── Context bar ──────────────────────────────────────────────
let _ctxHWM = 0; // high-water mark — only advances, never drops
let _sessionCost = 0;
let _currentProvider = null;
let _currentModel = null;

// Approximate per-1M-token costs (USD). Local = free.
const _COST_RATES = {
  "deepseek-v4-pro":    { in: 0.55, out: 2.19 },
  "deepseek-v4-flash":  { in: 0.27, out: 1.10 },
  "claude-opus-4-8":    { in: 15.00, out: 75.00 },
  "claude-sonnet-4-6":  { in: 3.00, out: 15.00 },
  "claude-haiku-4-5":   { in: 0.80, out: 4.00 },
  "gemini-2.5-flash":   { in: 0.15, out: 0.60 },
  "gemini-2.5-pro":     { in: 1.25, out: 5.00 },
};

function setCostProvider(name, model) {
  _currentProvider = name;
  _currentModel = model;
}

function updateContextBar(used, max, outputTok = 0) {
  const text = document.getElementById("ctxText");
  const fill = document.getElementById("ctxFill");
  const costEl = document.getElementById("costText");
  if (!text || !fill) return;

  // Take the higher of the API's reported input_tokens vs our running total,
  // then always add output_tokens — those tokens are now in context for the next call.
  _ctxHWM = Math.max(_ctxHWM, used) + outputTok;
  const display = _ctxHWM;

  // Cost calculation.
  const isLocal = _currentProvider === "llamacpp";
  if (!isLocal && used > 0 && costEl) {
    const rates = _COST_RATES[_currentModel] || { in: 0.5, out: 2.0 };
    const turnCost = ((used / 1_000_000) * rates.in) + ((outputTok / 1_000_000) * rates.out);
    _sessionCost += turnCost;
    costEl.textContent = `$${_sessionCost.toFixed(4)}`;
    costEl.style.display = "inline";
    costEl.title = `This session: ~$${_sessionCost.toFixed(4)} (${_currentModel || "unknown"})`;
  } else if (isLocal && costEl) {
    costEl.textContent = "local";
    costEl.style.display = "inline";
    costEl.title = "Running locally — no API cost";
  }

  if (!max || max <= 0) {
    text.textContent = `${display.toLocaleString()} / —`;
    fill.style.width = "0%";
    return;
  }

  const pct = Math.min(100, (display / max) * 100);
  const roundedPct = Math.round(pct);
  const capPct = window.maxCtxCapacityPct;
  const showCap = typeof capPct === "number" && capPct > 0;
  text.textContent = `${display.toLocaleString()} / ${max.toLocaleString()}${showCap ? ` (${capPct}%)` : ""}`;
  text.title = showCap ? t("ctx_capacity_tip", { pct: capPct }) : "";
  fill.style.width = `${pct}%`;

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
window.updateContextBar = updateContextBar;
window.setCostProvider = setCostProvider;
