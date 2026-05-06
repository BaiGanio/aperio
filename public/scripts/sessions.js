// ── Sessions panel ────────────────────────────────────────────
let sessionsPanelOpen = false;
let totalPages = 1;
const PAGE_SIZE = 10;

function toggleSessionsPanel() {
  sessionsPanelOpen = !sessionsPanelOpen;
  const panel    = document.getElementById("sessions-panel");
  const backdrop = document.getElementById("sessions-backdrop");
  const btn      = document.getElementById("historyBtn");

  panel.style.display    = sessionsPanelOpen ? "flex" : "none";
  backdrop.style.display = sessionsPanelOpen ? "block" : "none";
  if (btn) {
    btn.style.borderColor = sessionsPanelOpen ? "var(--accent)" : "var(--border)";
    btn.style.color       = sessionsPanelOpen ? "var(--accent)" : "var(--text-muted)";
  }

  if (sessionsPanelOpen) loadSessions(1);
}

async function loadSessions(page) {
  currentPage = page;
  const list = document.getElementById("sessions-list");
  list.innerHTML = `<div class="sessions-empty">Loading…</div>`;

  try {
    const res = await fetch(`/api/sessions?page=${page}&limit=${PAGE_SIZE}`);
    const data = await res.json();

    const sessions = Array.isArray(data) ? data : data.sessions;
    totalPages = data.pages ?? 1;

    if (!sessions.length) {
      list.innerHTML = `<div class="sessions-empty">No past sessions yet.<br>Conversations are saved when you close the tab.</div>`;
      return;
    }

    list.innerHTML = "";
    for (const s of sessions) {
      list.appendChild(makeSessionCard(s));
    }

    if (totalPages > 1) {
      list.appendChild(makePaginationControls());
    }
  } catch (err) {
    list.innerHTML = `<div class="sessions-empty" style="color:var(--error,#ef4444)">Failed to load sessions.</div>`;
  }
}

function makePaginationControls() {
  const wrap = document.createElement("div");
  wrap.className = "sessions-pagination";

  const prevBtn = document.createElement("button");
  prevBtn.className = "page-btn";
  prevBtn.innerHTML = `<i class="bi bi-chevron-left"></i>`;
  prevBtn.disabled = currentPage <= 1;
  prevBtn.addEventListener("click", () => loadSessions(currentPage - 1));

  const pages = getPageRange(currentPage, totalPages);
  const pageBtns = pages.map(p => {
    const btn = document.createElement("button");
    btn.className = "page-btn" + (p === currentPage ? " page-btn--active" : "") + (p === "..." ? " page-btn--ellipsis" : "");
    btn.textContent = p;
    if (p !== "...") {
      btn.addEventListener("click", () => loadSessions(p));
    } else {
      btn.disabled = true;
    }
    return btn;
  });

  const nextBtn = document.createElement("button");
  nextBtn.className = "page-btn";
  nextBtn.innerHTML = `<i class="bi bi-chevron-right"></i>`;
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.addEventListener("click", () => loadSessions(currentPage + 1));

  wrap.append(prevBtn, ...pageBtns, nextBtn);
  return wrap;
}

function getPageRange(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, "...", total];
  }
  if (current >= total - 3) {
    return [1, "...", total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, "...", current - 1, current, current + 1, "...", total];
}

function makeSessionCard(s) {
  const card = document.createElement("div");
  card.className = "session-card";
  card.dataset.id = s.id;

  const date = new Date(s.startedAt).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
  const duration = s.endedAt
    ? formatDuration(new Date(s.endedAt) - new Date(s.startedAt))
    : "in progress";

  card.innerHTML = `
    <div class="session-card-title-row" onclick="toggleSessionCard(this)">
      <span class="session-card-title">${escapeHtml(s.title ?? "Untitled")}</span>
      <i class="bi bi-chevron-right session-card-chevron"></i>
    </div>
    <div class="session-card-details">
      <div class="session-card-meta">${date} · ${duration}</div>
      <div class="session-card-stats">
        <span><i class="bi bi-chat-left-dots"></i> ${s.messageCount}</span>
        <span><i class="bi bi-file-text"></i> ${s.summaryCount} ${s.summaryCount === 1 ? "summary" : "summaries"}</span>
        <span class="session-card-model">${escapeHtml(s.model ?? "")}</span>
      </div>
      <div class="session-card-actions">
        <button class="session-btn session-btn--expand" onclick="expandSession(event, '${s.id}')">
          <i class="bi bi-chevron-down"></i> Summaries
        </button>
        <button class="session-btn session-btn--resume" onclick="resumeSession('${s.id}')">
          <i class="bi bi-arrow-counterclockwise"></i> Resume
        </button>
        <button class="session-btn session-btn--delete" onclick="deleteSession(event, '${s.id}')">
          <i class="bi bi-trash3"></i>
        </button>
      </div>
      <div class="session-card-body"></div>
    </div>`;

  return card;
}

function toggleSessionCard(titleRow) {
  const card    = titleRow.closest(".session-card");
  const details = card.querySelector(".session-card-details");
  const chevron = titleRow.querySelector(".session-card-chevron");
  const open    = card.classList.toggle("session-card--open");
  details.style.display = open ? "block" : "none";
  chevron.style.transform = open ? "rotate(90deg)" : "";
}

async function expandSession(e, id) {
  const btn  = e.currentTarget;
  const card = btn.closest(".session-card");
  const body = card.querySelector(".session-card-body");

  if (body.style.display === "flex") {
    body.style.display = "none";
    btn.innerHTML = `<i class="bi bi-chevron-down"></i> Summaries`;
    return;
  }

  btn.innerHTML = `<i class="bi bi-hourglass-split"></i> Loading…`;
  btn.disabled = true;

  try {
    const res = await fetch(`/api/sessions/${id}`);
    const session = await res.json();

    body.innerHTML = "";

    if (!session.summaries?.length) {
      body.innerHTML = `<div class="session-no-summaries">No summaries yet for this session.</div>`;
    } else {
      for (const sum of session.summaries) {
        const el = document.createElement("div");
        el.className = "session-summary";
        const ts = new Date(sum.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        el.innerHTML =
          `<div class="session-summary-meta">${ts} · ${sum.messageCount} messages at checkpoint</div>` +
          `<div class="session-summary-content">${renderMarkdown(sum.content)}</div>`;
        body.appendChild(el);
      }
    }

    body.style.display = "flex";
    btn.innerHTML = `<i class="bi bi-chevron-up"></i> Summaries`;
  } catch {
    body.innerHTML = `<div class="session-no-summaries" style="color:var(--error,#ef4444)">Failed to load.</div>`;
    body.style.display = "flex";
    btn.innerHTML = `<i class="bi bi-chevron-down"></i> Summaries`;
  } finally {
    btn.disabled = false;
  }
}

function resumeSession(id) {
  toggleSessionsPanel();
  if (typeof safeSend === "function") {
    safeSend(JSON.stringify({ type: "resume_session", id }));
  }
}

async function deleteSession(e, id) {
  e.stopPropagation();
  const card = e.currentTarget.closest(".session-card");
  const title = card?.querySelector(".session-card-title")?.textContent ?? "Untitled";

  if (!confirm(`Delete session "${title}"?\nThis cannot be undone.`)) return;

  if (card) card.style.opacity = "0.35";

  try {
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());

    if (card) card.remove();
    const remaining = document.querySelectorAll(".session-card").length;

    if (remaining === 0 && currentPage > 1) {
      loadSessions(currentPage - 1);
    } else {
      loadSessions(currentPage);
    }
  } catch (err) {
    if (card) card.style.opacity = "1";
    alert(`Failed to delete session: ${err.message}`);
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function handleSessionResumed(msg) {
  const banner = document.createElement("div");
  banner.className = "ctx-banner";
  banner.style.cssText = "background:color-mix(in srgb,var(--accent) 8%,var(--bg));";
  banner.innerHTML =
    `<span class="ctx-banner-text"><i class="bi bi-arrow-counterclockwise"></i> Resumed: <strong>${escapeHtml(msg.title ?? "session")}</strong></span>` +
    `<button class="ctx-banner-btn" onclick="this.parentElement.remove()">Dismiss</button>`;
  document.querySelector(".chat-area")?.prepend(banner);
}
