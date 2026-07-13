// ── Sessions panel ────────────────────────────────────────────
let sessionsPanelOpen = false;
let totalPages = 1;
const PAGE_SIZE = 10;
let selectMode = false;
const selectedIds = new Set();

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

  if (!sessionsPanelOpen && selectMode) exitSelectMode();
  if (sessionsPanelOpen) loadSessions(1);
}

function toggleSelectMode() {
  selectMode ? exitSelectMode() : enterSelectMode();
}

function enterSelectMode() {
  selectMode = true;
  selectedIds.clear();
  document.getElementById("sessions-select-bar").style.display = "flex";
  const toggleBtn = document.getElementById("sessionsSelectBtn");
  if (toggleBtn) {
    toggleBtn.classList.add("sessions-select-toggle--active");
    toggleBtn.innerHTML = `<i class="bi bi-x"></i> ${t("sessions_cancel")}`;
  }
  document.querySelectorAll(".session-card").forEach(card => addCheckbox(card));
  updateSelectBar();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  document.getElementById("sessions-select-bar").style.display = "none";
  const toggleBtn = document.getElementById("sessionsSelectBtn");
  if (toggleBtn) {
    toggleBtn.classList.remove("sessions-select-toggle--active");
    toggleBtn.innerHTML = `<i class="bi bi-check2-square"></i> ${t("sessions_select")}`;
  }
  document.querySelectorAll(".session-card-checkbox").forEach(el => el.remove());
  document.querySelectorAll(".session-card").forEach(card => card.classList.remove("session-card--selected"));
}

function addCheckbox(card) {
  const titleRow = card.querySelector(".session-card-title-row");
  if (!titleRow || titleRow.querySelector(".session-card-checkbox")) return;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "session-card-checkbox";
  cb.checked = selectedIds.has(card.dataset.id);
  cb.addEventListener("change", (e) => {
    e.stopPropagation();
    if (cb.checked) {
      selectedIds.add(card.dataset.id);
      card.classList.add("session-card--selected");
    } else {
      selectedIds.delete(card.dataset.id);
      card.classList.remove("session-card--selected");
    }
    updateSelectBar();
  });
  titleRow.insertBefore(cb, titleRow.firstChild);
}

function updateSelectBar() {
  const n = selectedIds.size;
  const countEl = document.getElementById("sessions-select-count");
  const deleteBtn = document.getElementById("sessions-bulk-delete-btn");
  if (countEl) countEl.textContent = n === 1 ? t("sessions_count_one") : t("sessions_count_many", { n });
  if (deleteBtn) deleteBtn.disabled = n === 0;
}

async function bulkDeleteSessions() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const n = ids.length;
  if (!await askConfirmModal("Delete sessions", t("sessions_delete_many", { n }), "Delete")) return;

  const deleteBtn = document.getElementById("sessions-bulk-delete-btn");
  if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.innerHTML = `<i class="bi bi-hourglass-split"></i> ${t("sessions_deleting")}`; }

  const results = await Promise.allSettled(
    ids.map(id => fetch(`/api/sessions/${id}`, { method: "DELETE" }))
  );

  const failed = results.filter(r => r.status === "rejected" || !r.value?.ok).length;
  exitSelectMode();
  loadSessions(currentPage);
  if (failed) showErrorModal(t("sessions_delete_n_failed", { n: failed }));
}

async function loadSessions(page) {
  currentPage = page;
  const list = document.getElementById("sessions-list");
  list.innerHTML = `<div class="sessions-empty">${t("sessions_loading")}</div>`;

  try {
    const res = await fetch(`/api/sessions?page=${page}&limit=${PAGE_SIZE}`);
    const data = await res.json();

    const sessions = Array.isArray(data) ? data : data.sessions;
    totalPages = data.pages ?? 1;

    if (!sessions.length) {
      list.innerHTML = `<div class="sessions-empty">${t("sessions_empty_html")}</div>`;
      return;
    }

    list.innerHTML = "";
    for (const s of sessions) {
      const card = makeSessionCard(s);
      if (selectMode) addCheckbox(card);
      list.appendChild(card);
    }
    if (selectMode) updateSelectBar();

    if (totalPages > 1) {
      list.appendChild(makePaginationControls());
    }
  } catch (err) {
    list.innerHTML = `<div class="sessions-empty" style="color:var(--error,#ef4444)">${t("sessions_load_failed")}</div>`;
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

  const lang = window.Aperio?.getCurrentLang?.() || "en";
  const date = new Date(s.startedAt).toLocaleDateString(lang, {
    day: "2-digit", month: "short", year: "numeric",
  });
  const timeLabel = s.endedAt
    ? new Date(s.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : t("sessions_in_progress");

  const summaryWord = s.summaryCount === 1 ? t("sessions_summary_one") : t("sessions_summary_many");

  card.innerHTML = `
    <div class="session-card-title-row" onclick="toggleSessionCard(this)">
      <span class="session-card-title">${escapeHtml(s.title ?? t("sessions_untitled"))}</span>
      <i class="bi bi-chevron-right session-card-chevron"></i>
    </div>
    <div class="session-card-details">
      ${s.parentId ? `<div class="session-card-parent">↳ ${t("sessions_branched_from") || "branched"}</div>` : ""}
      <div class="session-card-meta">${date} · ${timeLabel}</div>
      <div class="session-card-stats">
        <span><i class="bi bi-chat-left-dots"></i> ${s.messageCount}</span>
        <span><i class="bi bi-file-text"></i> ${s.summaryCount} ${summaryWord}</span>
        <span class="session-card-model">${escapeHtml(s.model ?? "")}</span>
      </div>
      <div class="session-card-actions">
        <button class="session-btn session-btn--expand" onclick="expandSession(event, '${s.id}')">
          <i class="bi bi-chevron-down"></i> ${t("sessions_summaries")}
        </button>
        <button class="session-btn session-btn--resume" onclick="resumeSession('${s.id}')">
          <i class="bi bi-arrow-counterclockwise"></i> ${t("sessions_resume")}
        </button>
        <button class="session-btn session-btn--pin${s.pinned ? " session-btn--pin-active" : ""}" title="${s.pinned ? t("sessions_unpin") : t("sessions_pin")}" onclick="togglePinSession(event, '${s.id}', this)">
          <i class="bi ${s.pinned ? "bi-pin-fill" : "bi-pin"}"></i>
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
  if (selectMode) {
    const card = titleRow.closest(".session-card");
    const cb = titleRow.querySelector(".session-card-checkbox");
    if (cb) {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    }
    return;
  }
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
    btn.innerHTML = `<i class="bi bi-chevron-down"></i> ${t("sessions_summaries")}`;
    return;
  }

  btn.innerHTML = `<i class="bi bi-hourglass-split"></i> ${t("sessions_loading_short")}`;
  btn.disabled = true;

  try {
    const res = await fetch(`/api/sessions/${id}`);
    const session = await res.json();

    body.innerHTML = "";

    if (!session.summaries?.length) {
      body.innerHTML = `<div class="session-no-summaries">${t("sessions_no_summaries")}</div>`;
    } else {
      for (const sum of session.summaries) {
        const el = document.createElement("div");
        el.className = "session-summary";
        const ts = new Date(sum.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        el.innerHTML =
          `<div class="session-summary-meta">${t("sessions_summary_meta", { time: ts, n: sum.messageCount })}</div>` +
          `<div class="session-summary-content">${renderMarkdown(sum.content)}</div>`;
        body.appendChild(el);
      }
    }

    body.style.display = "flex";
    btn.innerHTML = `<i class="bi bi-chevron-up"></i> ${t("sessions_summaries")}`;
  } catch {
    body.innerHTML = `<div class="session-no-summaries" style="color:var(--error,#ef4444)">${t("sessions_load_failed")}</div>`;
    body.style.display = "flex";
    btn.innerHTML = `<i class="bi bi-chevron-down"></i> ${t("sessions_summaries")}`;
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
  const title = card?.querySelector(".session-card-title")?.textContent ?? t("sessions_untitled");

  if (!await askConfirmModal("Delete session", t("sessions_delete_one", { title }), "Delete")) return;

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
    showErrorModal(t("sessions_delete_failed", { error: err.message }));
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

async function togglePinSession(e, id, btn) {
  e.stopPropagation();
  const pinned = !btn.classList.contains("session-btn--pin-active");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/sessions/${id}/pin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
    if (!res.ok) throw new Error(await res.text());
    btn.classList.toggle("session-btn--pin-active", pinned);
    btn.title = pinned ? t("sessions_unpin") : t("sessions_pin");
    btn.querySelector("i").className = `bi ${pinned ? "bi-pin-fill" : "bi-pin"}`;
  } catch {
    // silently restore — non-critical action
  } finally {
    btn.disabled = false;
  }
}

function handleSessionResumed(msg) {
  const banner = document.createElement("div");
  banner.className = "ctx-banner";
  banner.style.cssText = "background:color-mix(in srgb,var(--accent) 8%,var(--bg));";
  banner.innerHTML =
    `<span class="ctx-banner-text">${t("sessions_resumed_html", { title: escapeHtml(msg.title ?? t("sessions_untitled")) })}</span>` +
    `<button class="ctx-banner-btn" onclick="this.parentElement.remove()">${t("sessions_dismiss")}</button>`;
  document.querySelector(".chat-area")?.prepend(banner);

  // Fetch the session and render the last few messages so the user can see the prior context.
  fetch(`/api/sessions/${msg.id}`)
    .then(r => r.json())
    .then(session => {
      if (!session.messages?.length) return;
      const tail = session.messages.slice(-6);
      const divider = document.createElement("div");
      divider.className = "session-history-divider";
      divider.textContent = `— ${escapeHtml(session.title ?? t("sessions_untitled"))} —`;
      messagesEl?.prepend(divider);
      for (let i = tail.length - 1; i >= 0; i--) {
        const m = tail[i];
        const attachments = (m.attachments ?? []).map(att => ({
          ...att,
          dataUrl: att.dataUrl || att.url || (att.thumbnail ? `data:image/jpeg;base64,${att.thumbnail}` : null),
        }));
        const el = buildHistoryMessage(m.role, m.content || "", attachments);
        divider.after(el);
      }
    })
    .catch(() => { /* non-fatal — banner already shown */ });
}

function buildHistoryMessage(role, text, attachments) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role === "user" ? "user" : "ai"} session-history-msg`;

  const avatar = document.createElement("div");
  avatar.className = `avatar ${role === "user" ? "user" : "ai"}`;
  avatar.textContent = role === "user" ? getUserInitial() : "A";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (text.trim()) {
    const textNode = document.createElement("div");
    textNode.innerHTML = renderMarkdown(text);
    bubble.appendChild(textNode);
  }
  if (role !== "user" && text.trim()) _attachBubbleCopyBtn(bubble, text);
  if (role === "user" && attachments?.length) {
    const attachRow = document.createElement("div");
    attachRow.className = "msg-attachments";
    attachments.forEach(att => attachRow.appendChild(buildAttachmentCard(att)));
    bubble.appendChild(attachRow);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);

  if (role !== "user") return wrap;

  const frag = document.createDocumentFragment();
  frag.appendChild(wrap);
  const chip = buildUserTokenChip(text, attachments);
  if (chip) frag.appendChild(chip);
  return frag;
}
