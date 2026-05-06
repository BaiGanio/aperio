// ── Sessions panel ────────────────────────────────────────────
let sessionsPanelOpen = false;

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

  if (sessionsPanelOpen) loadSessions();
}

async function loadSessions() {
  const list = document.getElementById("sessions-list");
  list.innerHTML = `<div class="sessions-empty">Loading…</div>`;

  try {
    const res = await fetch("/api/sessions");
    const sessions = await res.json();

    if (!sessions.length) {
      list.innerHTML = `<div class="sessions-empty">No past sessions yet.<br>Conversations are saved when you close the tab.</div>`;
      return;
    }

    list.innerHTML = "";
    for (const s of sessions) {
      list.appendChild(makeSessionCard(s));
    }
  } catch (err) {
    list.innerHTML = `<div class="sessions-empty" style="color:var(--error,#ef4444)">Failed to load sessions.</div>`;
  }
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
    <div class="session-card-header">
      <div class="session-card-title">${escapeHtml(s.title ?? "Untitled")}</div>
      <div class="session-card-meta">${date} · ${duration}</div>
      <div class="session-card-stats">
        <span><i class="bi bi-chat-left-dots"></i> ${s.messageCount}</span>
        <span><i class="bi bi-file-text"></i> ${s.summaryCount} ${s.summaryCount === 1 ? "summary" : "summaries"}</span>
        <span class="session-card-model">${escapeHtml(s.model ?? "")}</span>
      </div>
    </div>
    <div class="session-card-body" style="display:none;"></div>
    <div class="session-card-actions">
      <button class="session-btn session-btn--expand" onclick="expandSession(event, '${s.id}')">
        <i class="bi bi-chevron-down"></i> Summaries
      </button>
      <button class="session-btn session-btn--resume" onclick="resumeSession('${s.id}')">
        <i class="bi bi-arrow-counterclockwise"></i> Resume
      </button>
    </div>`;

  return card;
}

async function expandSession(e, id) {
  const btn  = e.currentTarget;
  const card = btn.closest(".session-card");
  const body = card.querySelector(".session-card-body");

  if (body.style.display === "block") {
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

    body.style.display = "block";
    btn.innerHTML = `<i class="bi bi-chevron-up"></i> Summaries`;
  } catch {
    body.innerHTML = `<div class="session-no-summaries" style="color:var(--error,#ef4444)">Failed to load.</div>`;
    body.style.display = "block";
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

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Handle session_resumed event from the server
function handleSessionResumed(msg) {
  const banner = document.createElement("div");
  banner.className = "ctx-banner";
  banner.style.cssText = "background:color-mix(in srgb,var(--accent) 8%,var(--bg));";
  banner.innerHTML =
    `<span class="ctx-banner-text"><i class="bi bi-arrow-counterclockwise"></i> Resumed: <strong>${escapeHtml(msg.title ?? "session")}</strong></span>` +
    `<button class="ctx-banner-btn" onclick="this.parentElement.remove()">Dismiss</button>`;
  document.querySelector(".chat-area")?.prepend(banner);
}
