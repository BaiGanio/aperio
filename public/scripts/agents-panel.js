// public/scripts/agents-panel.js
// Right-side sidebar for background agents — the scheduled/triggered jobs that
// run on Aperio's store without a chat turn. Reuses the cg-* panel chrome.
//
// Two views in one body, swapped in-place:
//   • jobs    — a master on/off switch (APERIO_AGENT_JOBS, toggled live) plus
//               every job with its trigger, mode, last-run verdict, and a
//               "Run now" button (enabled only when the master switch is on)
//   • runs    — one job's run history (GET /api/agents/:id/runs)
//
// Backend: lib/routes/api-agents.js. Jobs live in the agent_jobs DB table.

(() => {
  const panel    = () => document.getElementById("agents-panel");
  const backdrop = () => document.getElementById("agents-backdrop");
  const body     = () => document.getElementById("ag-panel-body");

  let _enabled = false;   // master switch: APERIO_AGENT_JOBS=on

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function setBody(html) { body().innerHTML = html; }

  async function get(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // ── Formatting helpers ──────────────────────────────────────────────────────
  function fmtTime(t) {
    if (!t) return "—";
    const d = new Date(t);
    return isNaN(d) ? "—" : d.toISOString().slice(0, 16).replace("T", " ");
  }
  function fmtDuration(ms) {
    if (ms == null) return "";
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }
  function jobMode(job) {
    if (Array.isArray(job.steps) && job.steps.length) return "steps";
    if (typeof job.prompt === "string" && job.prompt.trim()) return "freeform";
    return "—";
  }
  function triggerLabel(t) {
    if (!t) return "manual";
    if (t.kind === "interval") {
      const m = Math.round((t.everyMs || 0) / 60000);
      return m >= 60 ? `interval · ${Math.round(m / 60)}h` : `interval · ${m}m`;
    }
    if (t.kind === "watcher") return `watcher${t.source ? " · " + t.source : ""}`;
    return t.kind || "manual";
  }
  function verdictBadge(verdict) {
    const v = verdict || "none";
    const label = v === "ok" ? "ok" : v === "error" ? "error" : "never run";
    return `<span class="ag-verdict ${v}">${label}</span>`;
  }

  // ── Master switch (APERIO_AGENT_JOBS) ───────────────────────────────────────
  function masterToggle() {
    return `
      <div class="ag-master-row">
        <label class="reasoning-toggle ag-master ${_enabled ? "is-on" : ""}" id="agMasterToggle"
          title="${_enabled ? "Disable background agents" : "Enable scheduling and Run now"}">
          <span class="reasoning-toggle-label">Background agents</span>
          <span class="reasoning-toggle-track"><span class="reasoning-toggle-thumb"></span></span>
        </label>
        <span class="ag-master-hint">${_enabled ? "auto-run on" : "auto-run off — Run now disabled"}</span>
      </div>`;
  }
  function wireMasterToggle() {
    const el = document.getElementById("agMasterToggle");
    if (el) el.addEventListener("click", toggleMaster);
  }
  async function toggleMaster() {
    const next = !_enabled;
    try {
      const res = await fetch("/api/agents/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { alert(`Error: ${d.error || res.statusText}`); return; }
      _enabled = !!d.enabled;
      loadJobs();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  // ── Jobs view ───────────────────────────────────────────────────────────────
  function renderJobs(jobs) {
    if (!jobs.length) {
      setBody(`${masterToggle()}<div class="cg-empty">No background-agent jobs defined.</div>`);
      wireMasterToggle();
      return;
    }
    const cards = jobs.map(job => {
      const lr = job.lastRun;
      return `
      <div class="cg-repo" data-id="${escapeHtml(job.id)}">
        <div class="ag-job-head">
          <span class="ag-job-id">${escapeHtml(job.id)}</span>
          <span class="ag-tag ${job.enabled ? "on" : "off"}">${job.enabled ? "enabled" : "disabled"}</span>
        </div>
        <div class="ag-job-meta">
          <span class="ag-tag">${escapeHtml(triggerLabel(job.trigger))}</span>
          <span class="ag-tag">${escapeHtml(jobMode(job))}</span>
          ${verdictBadge(lr?.verdict)}
          ${lr ? `<span>last run ${escapeHtml(fmtTime(lr.started_at))} ${escapeHtml(fmtDuration(lr.duration_ms))}</span>` : ""}
        </div>
        <div class="ag-job-actions">
          <button class="ag-btn primary ag-run-now" ${_enabled ? "" : "disabled"}
            title="${_enabled ? "Trigger this job immediately" : "Turn on background agents to run"}">Run now</button>
          <button class="ag-btn ag-history">History</button>
        </div>
        <div class="ag-msg" data-msg></div>
      </div>`;
    }).join("");
    setBody(`${masterToggle()}${cards}`);
    wireMasterToggle();
    body().querySelectorAll(".cg-repo").forEach(card => {
      const id = card.dataset.id;
      card.querySelector(".ag-run-now").addEventListener("click", () => runNow(id, card));
      card.querySelector(".ag-history").addEventListener("click", () => openRuns(id));
    });
  }

  async function loadJobs() {
    setBody(`<div class="cg-hint">Loading…</div>`);
    try {
      const data = await get("/api/agents");
      _enabled = !!data.enabled;
      renderJobs(data.jobs || []);
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  // ── Run now ─────────────────────────────────────────────────────────────────
  async function runNow(id, card) {
    const btn = card.querySelector(".ag-run-now");
    const msg = card.querySelector("[data-msg]");
    btn.disabled = true;
    msg.textContent = "Running…";
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/run`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { msg.textContent = `⚠ ${d.error || res.statusText}`; return; }
      msg.textContent = d.verdict === "ok"
        ? `✓ ${d.mode} ok${d.answer ? " — " + d.answer.slice(0, 80) : ""}`
        : `⚠ ${d.error || "failed"}`;
      // Refresh the card's last-run line after a short beat.
      setTimeout(loadJobs, 600);
    } catch (err) {
      msg.textContent = `Error: ${err.message}`;
    } finally {
      btn.disabled = !_enabled;
    }
  }

  // ── Run history view ──────────────────────────────────────────────────────────
  async function openRuns(id) {
    setBody(`<div class="cg-hint">Loading runs…</div>`);
    try {
      const data = await get(`/api/agents/${encodeURIComponent(id)}/runs?limit=50`);
      const runs = data.runs || [];
      const head = `
        <div class="cg-symbol-detail">
          <button class="cg-back-btn" id="agBackBtn">← Back to jobs</button>
          <div class="cg-symbol-title">${escapeHtml(id)}</div>
          <div class="cg-section-label">${runs.length} run${runs.length === 1 ? "" : "s"}</div>`;
      const list = !runs.length
        ? `<div class="cg-empty">No runs recorded yet.</div>`
        : runs.map(r => `
            <div class="ag-run ${escapeHtml(r.verdict || "")}">
              <div class="ag-run-head">
                ${verdictBadge(r.verdict)}
                <span>${escapeHtml(fmtTime(r.started_at))}</span>
                ${r.duration_ms != null ? `<span>${escapeHtml(fmtDuration(r.duration_ms))}</span>` : ""}
                ${r.trigger ? `<span>· ${escapeHtml(r.trigger)}</span>` : ""}
                ${r.mode ? `<span>· ${escapeHtml(r.mode)}</span>` : ""}
              </div>
              ${r.tools && r.tools.length ? `<div class="ag-run-tools">tools: ${escapeHtml(r.tools.join(", "))}</div>` : ""}
              ${r.error ? `<div class="ag-run-body">${escapeHtml(r.error)}</div>`
                : r.answer ? `<div class="ag-run-body">${escapeHtml(r.answer)}</div>` : ""}
            </div>`).join("");
      setBody(`${head}${list}</div>`);
      document.getElementById("agBackBtn").addEventListener("click", loadJobs);
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  // ── Open/close ────────────────────────────────────────────────────────────────
  window.toggleAgentsPanel = function () {
    const open = panel().style.display !== "none";
    if (open) {
      panel().style.display = "none";
      backdrop().style.display = "none";
      return;
    }
    panel().style.display = "flex";
    backdrop().style.display = "block";
    loadJobs();
  };
})();
