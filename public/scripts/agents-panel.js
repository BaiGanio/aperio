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
        <button class="ag-btn ag-new-job" id="agNewJob" title="Create a new background-agent job">+ New job</button>
      </div>`;
  }
  function wireMasterToggle() {
    const el = document.getElementById("agMasterToggle");
    if (el) el.addEventListener("click", toggleMaster);
    const nb = document.getElementById("agNewJob");
    if (nb) nb.addEventListener("click", () => renderForm(null));
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
      if (!res.ok) { showErrorModal(`Error: ${d.error || res.statusText}`); return; }
      _enabled = !!d.enabled;
      loadJobs();
    } catch (err) {
      showErrorModal(`Error: ${err.message}`);
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
          ${job.running ? `<span class="ag-tag running">running…</span>` : ""}
        </div>
        <div class="ag-job-meta">
          <span class="ag-tag">${escapeHtml(triggerLabel(job.trigger))}</span>
          <span class="ag-tag">${escapeHtml(jobMode(job))}</span>
          ${verdictBadge(lr?.verdict)}
          ${lr ? `<span>last run ${escapeHtml(fmtTime(lr.started_at))} ${escapeHtml(fmtDuration(lr.duration_ms))}</span>` : ""}
        </div>
        <div class="ag-job-actions">
          <button class="ag-btn primary ag-run-now" ${(_enabled && !job.running) ? "" : "disabled"}
            title="${job.running ? "Already running — wait for it to finish" : _enabled ? "Trigger this job immediately" : "Turn on background agents to run"}">Run now</button>
          <button class="ag-btn ag-history">History</button>
          <button class="ag-btn ag-edit">Edit</button>
          <button class="ag-btn ag-delete" title="Delete this job">Delete</button>
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
      card.querySelector(".ag-edit").addEventListener("click", () => openForm(id));
      card.querySelector(".ag-delete").addEventListener("click", () => deleteJob(id, card));
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

  // ── Delete ────────────────────────────────────────────────────────────────────
  async function deleteJob(id, card) {
    if (!window.confirm(`Delete job "${id}"? This cannot be undone.`)) return;
    const msg = card.querySelector("[data-msg]");
    if (msg) msg.textContent = "Deleting…";
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (msg) msg.textContent = `⚠ ${d.error || res.statusText}`; return; }
      loadJobs();
    } catch (err) {
      if (msg) msg.textContent = `Error: ${err.message}`;
    }
  }

  // ── Create / edit form ──────────────────────────────────────────────────────────
  // Starter jobs a non-coder can pick instead of inventing JSON. Each is a full,
  // valid definition that pre-fills the form; the user edits the id and anything
  // else before saving. Tools/triggers used here are real and known-valid.
  const TEMPLATES = {
    "nightly-maintenance": {
      id: "nightly-maintenance",
      enabled: false,
      trigger: { kind: "interval", everyMs: 86400000 },
      steps: [
        { tool: "backfill_embeddings", input: {} },
        { tool: "deduplicate_memories", input: { threshold: 0.97, dry_run: true } },
      ],
    },
    "doc-digest": {
      id: "doc-digest",
      enabled: true,
      trigger: { kind: "watcher", source: "docgraph", debounceMs: 5000 },
      prompt: "Summarise what changed in these documents in 3 bullets. Do not call write tools.",
      timeoutMs: 120000,
    },
    "memory-digest": {
      id: "weekly-memory-digest",
      enabled: true,
      trigger: { kind: "interval", everyMs: 604800000 },
      prompt: "Recall the most recent memories and write a 3-bullet summary of what we've been working on lately. Do not call write tools.",
      timeoutMs: 120000,
    },
  };

  // Fetch the existing definition, then render the form populated with it.
  async function openForm(id) {
    setBody(`<div class="cg-hint">Loading…</div>`);
    try {
      const job = await get(`/api/agents/${encodeURIComponent(id)}`);
      renderForm(job);
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  // job === null → create; otherwise edit (id is locked). Steps are edited as raw
  // JSON because a step's { tool, input } shape is heterogeneous; freeform jobs get
  // structured fields. Trigger-kind and mode selects toggle their sub-sections.
  function renderForm(job, isEdit, tplKey = "") {
    if (isEdit === undefined) isEdit = !!job;
    job = job || {};
    const t = job.trigger || {};
    const kind = t.kind || (isEdit ? "manual" : "interval");
    const mode = jobMode(job) === "freeform" ? "freeform" : "steps";
    const everyMin = t.everyMs ? Math.round(t.everyMs / 60000) : 60;
    const stepsJson = (Array.isArray(job.steps) && job.steps.length)
      ? JSON.stringify(job.steps, null, 2)
      : `[\n  { "tool": "backfill_embeddings", "input": {} }\n]`;
    const prov = job.provider || {};
    const sel = (a, b) => a === b ? " selected" : "";

    setBody(`
      <div class="ag-form">
        <button class="cg-back-btn" id="agFormBack">← Back to jobs</button>
        <div class="cg-symbol-title">${isEdit ? "Edit job" : "New job"}</div>
        ${isEdit ? "" : `
        <label class="ag-field">
          <span>Start from a template</span>
          <select id="agfTemplate">
            <option value=""${sel(tplKey, "")}>Blank — start from scratch</option>
            <option value="nightly-maintenance"${sel(tplKey, "nightly-maintenance")}>Nightly maintenance — re-embed + dedupe memories daily</option>
            <option value="doc-digest"${sel(tplKey, "doc-digest")}>Doc-change digest — summarise changed docs (watcher)</option>
            <option value="memory-digest"${sel(tplKey, "memory-digest")}>Weekly memory digest — summarise recent memories</option>
          </select>
          <span class="ag-hint">A template fills every field below with a working example. Edit anything (start with the id) before saving.</span>
        </label>`}

        <label class="ag-field">
          <span>Job id</span>
          <input id="agfId" type="text" placeholder="my-job" value="${escapeHtml(job.id || "")}" ${isEdit ? "disabled" : ""}>
        </label>

        <label class="ag-field ag-field-inline">
          <input id="agfEnabled" type="checkbox" ${job.enabled ? "checked" : ""}>
          <span>Enabled (interval/watcher scheduling fires)</span>
        </label>

        <label class="ag-field">
          <span>Trigger</span>
          <select id="agfKind">
            <option value="interval"${sel(kind, "interval")}>interval</option>
            <option value="watcher"${sel(kind, "watcher")}>watcher</option>
            <option value="manual"${sel(kind, "manual")}>manual (run-now only)</option>
          </select>
          <span class="ag-hint">When the job fires: on a timer (interval), when watched files change (watcher), or only when you press "Run now" (manual).</span>
        </label>

        <div id="agfInterval" class="ag-trigger-sub">
          <label class="ag-field">
            <span>Every (minutes)</span>
            <input id="agfEveryMin" type="number" min="1" value="${everyMin}">
          </label>
        </div>

        <div id="agfWatcher" class="ag-trigger-sub">
          <label class="ag-field">
            <span>Source</span>
            <select id="agfSource">
              <option value=""${sel(t.source || "", "")}>both</option>
              <option value="codegraph"${sel(t.source, "codegraph")}>codegraph</option>
              <option value="docgraph"${sel(t.source, "docgraph")}>docgraph</option>
            </select>
          </label>
          <label class="ag-field">
            <span>Debounce (ms)</span>
            <input id="agfDebounce" type="number" min="0" value="${t.debounceMs ?? 2000}">
          </label>
        </div>

        <label class="ag-field">
          <span>Mode</span>
          <select id="agfMode">
            <option value="steps"${sel(mode, "steps")}>steps (deterministic, no model)</option>
            <option value="freeform"${sel(mode, "freeform")}>freeform (runs a model)</option>
          </select>
          <span class="ag-hint">Steps = a fixed list of tools run in order, no model, no surprises. Freeform = a plain-English task a model carries out.</span>
        </label>

        <div id="agfSteps" class="ag-mode-sub">
          <label class="ag-field">
            <span>Steps (JSON array of { tool, input })</span>
            <textarea id="agfStepsJson" rows="6" spellcheck="false">${escapeHtml(stepsJson)}</textarea>
            <span class="ag-hint">Each entry runs one tool in order. Maintenance tools: <code>backfill_embeddings</code>, <code>deduplicate_memories</code>. Tip: load a template to see a real example.</span>
          </label>
        </div>

        <div id="agfFreeform" class="ag-mode-sub">
          <label class="ag-field">
            <span>Prompt</span>
            <textarea id="agfPrompt" rows="4" placeholder="Summarise what changed…">${escapeHtml(job.prompt || "")}</textarea>
            <span class="ag-hint">A plain-English task. The model can read memories, the wiki, and your code graph. Say "do not call write tools" if you only want a read-only summary.</span>
          </label>
          <label class="ag-field">
            <span>Provider name (blank = chat default)</span>
            <input id="agfProvName" type="text" placeholder="deepseek" value="${escapeHtml(prov.name || "")}">
          </label>
          <label class="ag-field">
            <span>Model</span>
            <input id="agfProvModel" type="text" placeholder="deepseek-v4-flash" value="${escapeHtml(prov.model || "")}">
          </label>
          <label class="ag-field">
            <span>Timeout (ms)</span>
            <input id="agfTimeout" type="number" min="1000" value="${job.timeoutMs ?? 300000}">
          </label>
        </div>

        <div class="ag-form-actions">
          <button class="ag-btn primary" id="agfSave">${isEdit ? "Save changes" : "Create job"}</button>
          <button class="ag-btn" id="agfCancel">Cancel</button>
        </div>
        <div class="ag-msg" id="agfMsg"></div>
      </div>`);

    // Show only the sub-sections relevant to the current trigger kind / mode.
    const syncVisibility = () => {
      const k = document.getElementById("agfKind").value;
      document.getElementById("agfInterval").style.display = k === "interval" ? "" : "none";
      document.getElementById("agfWatcher").style.display  = k === "watcher"  ? "" : "none";
      const m = document.getElementById("agfMode").value;
      document.getElementById("agfSteps").style.display    = m === "steps"    ? "" : "none";
      document.getElementById("agfFreeform").style.display = m === "freeform" ? "" : "none";
    };
    syncVisibility();
    document.getElementById("agfKind").addEventListener("change", syncVisibility);
    document.getElementById("agfMode").addEventListener("change", syncVisibility);
    document.getElementById("agFormBack").addEventListener("click", loadJobs);
    document.getElementById("agfCancel").addEventListener("click", loadJobs);
    document.getElementById("agfSave").addEventListener("click", () => saveJob(isEdit));
    // Picking a template re-renders the form (still in create mode) pre-filled.
    const tpl = document.getElementById("agfTemplate");
    if (tpl) tpl.addEventListener("change", (e) => {
      const key = e.target.value;
      renderForm(key ? TEMPLATES[key] : null, false, key);
    });
  }

  // Read the form into a job object, validate, and POST (create) or PUT (edit).
  async function saveJob(isEdit) {
    const msg = document.getElementById("agfMsg");
    const val = (id) => document.getElementById(id).value.trim();
    const id = val("agfId");
    if (!id) { msg.textContent = "⚠ job id is required"; return; }

    const job = { id, enabled: document.getElementById("agfEnabled").checked };

    const kind = document.getElementById("agfKind").value;
    if (kind === "interval") {
      const min = parseInt(val("agfEveryMin"), 10);
      if (!(min > 0)) { msg.textContent = "⚠ interval needs a positive number of minutes"; return; }
      job.trigger = { kind: "interval", everyMs: min * 60000 };
    } else if (kind === "watcher") {
      job.trigger = { kind: "watcher", debounceMs: parseInt(val("agfDebounce"), 10) || 2000 };
      const src = document.getElementById("agfSource").value;
      if (src) job.trigger.source = src;
    }
    // kind === "manual" → no trigger field (run-now only)

    const mode = document.getElementById("agfMode").value;
    if (mode === "steps") {
      let steps;
      try { steps = JSON.parse(val("agfStepsJson")); }
      catch (e) { msg.textContent = `⚠ steps is not valid JSON: ${e.message}`; return; }
      if (!Array.isArray(steps) || !steps.length) { msg.textContent = "⚠ steps must be a non-empty array"; return; }
      job.steps = steps;
    } else {
      const prompt = val("agfPrompt");
      if (!prompt) { msg.textContent = "⚠ freeform jobs need a prompt"; return; }
      job.prompt = prompt;
      const pn = val("agfProvName"), pm = val("agfProvModel");
      if (pn || pm) job.provider = { ...(pn ? { name: pn } : {}), ...(pm ? { model: pm } : {}) };
      const to = parseInt(val("agfTimeout"), 10);
      if (to > 0) job.timeoutMs = to;
    }

    msg.textContent = "Saving…";
    try {
      const url = isEdit ? `/api/agents/${encodeURIComponent(id)}` : "/api/agents";
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { msg.textContent = `⚠ ${d.error || res.statusText}`; return; }
      loadJobs();
    } catch (err) {
      msg.textContent = `Error: ${err.message}`;
    }
  }

  // ── Run export (Copy / Download .md) ──────────────────────────────────────────
  // The freeform answer is already markdown, so a run exports cleanly as a .md
  // note the user can paste into an issue or archive.
  function runToMarkdown(jobId, r) {
    const meta = [
      `- When: ${r.started_at || ""}`,
      `- Verdict: ${r.verdict || ""}`,
      r.model   ? `- Model: ${r.model}`                 : null,
      r.trigger ? `- Trigger: ${r.trigger}`             : null,
      r.tools?.length ? `- Tools: ${r.tools.join(", ")}` : null,
      r.artifact_count ? `- Offloaded artifacts: ${r.artifact_count} (${r.artifact_bytes || 0} bytes)` : null,
      r.interrupts?.length ? `- Sensitive actions: ${r.interrupts.map(i => `${i.tool}:${i.status}`).join(", ")}` : null,
    ].filter(Boolean).join("\n");
    return `# ${jobId}${r.model ? ` — ${r.model}` : ""}\n\n${meta}\n\n${r.error || r.answer || ""}\n`;
  }

  function wireRunExports(jobId, runs, page) {
    document.querySelectorAll(".ag-run-copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(runToMarkdown(jobId, runs[+btn.dataset.idx]));
          const prev = btn.textContent;
          btn.textContent = "Copied ✓";
          setTimeout(() => { btn.textContent = prev; }, 1500);
        } catch { btn.textContent = "Copy failed"; }
      });
    });
    document.querySelectorAll(".ag-run-dl").forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = runs[+btn.dataset.idx];
        const ts = (r.started_at || "run").replace(/[:.]/g, "-");
        const blob = new Blob([runToMarkdown(jobId, r)], { type: "text/markdown" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${jobId}-${ts}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
    });
    document.querySelectorAll(".ag-run-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const r = runs[+btn.dataset.idx];
        if (r.id == null) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/agents/${encodeURIComponent(jobId)}/runs/${r.id}`, { method: "DELETE" });
          if (!res.ok) { btn.textContent = "Delete failed"; btn.disabled = false; return; }
          // Re-fetch the now-shorter history and stay on the current page
          // (renderRuns clamps if that page no longer exists).
          const data = await get(`/api/agents/${encodeURIComponent(jobId)}/runs?limit=50`);
          renderRuns(jobId, data.runs || [], page);
        } catch { btn.textContent = "Delete failed"; btn.disabled = false; }
      });
    });
  }

  // ── Run history view ──────────────────────────────────────────────────────────
  // Runs are paginated 10-per-page and collapsed by default (native <details>),
  // so a long history doesn't flood the sidebar. Only the most recent run starts
  // expanded; the rest open on click.
  const RUNS_PER_PAGE = 10;

  async function openRuns(id) {
    setBody(`<div class="cg-hint">Loading runs…</div>`);
    try {
      const data = await get(`/api/agents/${encodeURIComponent(id)}/runs?limit=50`);
      renderRuns(id, data.runs || [], 0);
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  function renderRuns(id, runs, page) {
    const pageCount = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));
    page = Math.min(Math.max(0, page), pageCount - 1);
    const start = page * RUNS_PER_PAGE;
    const pageRuns = runs.slice(start, start + RUNS_PER_PAGE);

    const head = `
      <div class="cg-symbol-detail">
        <button class="cg-back-btn" id="agBackBtn">← Back to jobs</button>
        <div class="cg-symbol-title">${escapeHtml(id)}</div>
        <div class="cg-section-label">${runs.length} run${runs.length === 1 ? "" : "s"}</div>`;
    const list = !runs.length
      ? `<div class="cg-empty">No runs recorded yet.</div>`
      : pageRuns.map((r, j) => {
          const i = start + j;                 // absolute index into runs (for wireRunExports)
          const open = i === 0 ? " open" : ""; // only the most recent run starts expanded
          return `
            <details class="ag-run ${escapeHtml(r.verdict || "")}"${open}>
              <summary class="ag-run-head">
                ${verdictBadge(r.verdict)}
                <span>${escapeHtml(fmtTime(r.started_at))}</span>
                ${r.duration_ms != null ? `<span>${escapeHtml(fmtDuration(r.duration_ms))}</span>` : ""}
                ${r.trigger ? `<span>· ${escapeHtml(r.trigger)}</span>` : ""}
                ${r.mode ? `<span>· ${escapeHtml(r.mode)}</span>` : ""}
              </summary>
              ${r.model ? `<div class="ag-run-model">🤖 ${escapeHtml(r.model)}</div>` : ""}
              ${r.tools && r.tools.length ? `<div class="ag-run-tools">tools: ${escapeHtml(r.tools.join(", "))}</div>` : ""}
              ${r.artifact_count ? `<div class="ag-run-tools">offloaded: ${escapeHtml(String(r.artifact_count))} artifact(s), ${escapeHtml(String(r.artifact_bytes || 0))} bytes</div>` : ""}
              ${r.interrupts && r.interrupts.length ? `<div class="ag-run-tools">sensitive actions: ${escapeHtml(r.interrupts.map(i => `${i.tool}:${i.status}`).join(", "))}</div>` : ""}
              ${r.error ? `<div class="ag-run-body">${escapeHtml(r.error)}</div>`
                : r.answer ? `<div class="ag-run-body">${escapeHtml(r.answer)}</div>` : ""}
              <div class="ag-run-actions">
                ${(r.answer || r.error) ? `<button class="ag-btn ag-run-copy" data-idx="${i}" title="Copy this result to the clipboard">Copy</button>
                <button class="ag-btn ag-run-dl" data-idx="${i}" title="Download this result as Markdown">Download .md</button>` : ""}
                <button class="ag-btn ag-run-del" data-idx="${i}" title="Delete this run from the history">Delete</button>
              </div>
            </details>`;
        }).join("");
    const pager = runs.length > RUNS_PER_PAGE ? `
      <div class="ag-pager">
        <button class="ag-btn ag-pager-prev"${page === 0 ? " disabled" : ""}>← Prev</button>
        <span class="ag-pager-info">Page ${page + 1} of ${pageCount}</span>
        <button class="ag-btn ag-pager-next"${page >= pageCount - 1 ? " disabled" : ""}>Next →</button>
      </div>` : "";

    setBody(`${head}${list}${pager}</div>`);
    document.getElementById("agBackBtn").addEventListener("click", loadJobs);
    const prevBtn = document.querySelector(".ag-pager-prev");
    const nextBtn = document.querySelector(".ag-pager-next");
    if (prevBtn) prevBtn.addEventListener("click", () => renderRuns(id, runs, page - 1));
    if (nextBtn) nextBtn.addEventListener("click", () => renderRuns(id, runs, page + 1));
    wireRunExports(id, runs, page);
  }

  // ── Open/close ────────────────────────────────────────────────────────────────
  function isOpen() { return panel().style.display !== "none"; }

  window.toggleAgentsPanel = function () {
    if (isOpen()) {
      panel().style.display = "none";
      backdrop().style.display = "none";
      return;
    }
    panel().style.display = "flex";
    backdrop().style.display = "block";
    loadJobs();
  };

  // Refresh the jobs view when a run finishes (driven by the agent_job_done WS
  // message) so the "running…" badge clears live while the panel is open. Only
  // refreshes the jobs list, not the history/edit sub-views.
  window.refreshAgentsPanelIfOpen = function () {
    if (isOpen() && document.getElementById("agMasterToggle")) loadJobs();
  };
})();
