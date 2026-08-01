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
  let _jobTools = [];
  let _jobToolsPromise = null;

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
  // Plain-English label for a timeout preset (30s / 1m / 2m / 5m / 10m).
  function fmtTimeoutLabel(ms) {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    const m = ms / 60000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  }
  // Common timeout choices, plus the job's current value if it doesn't match
  // one of them (e.g. set via the API) so the select never silently changes it.
  function timeoutOptions(currentMs) {
    const presets = [30000, 60000, 120000, 300000, 600000];
    const all = presets.includes(currentMs) ? presets : [...presets, currentMs].sort((a, b) => a - b);
    return all.map(ms =>
      `<option value="${ms}"${ms === currentMs ? " selected" : ""}>${fmtTimeoutLabel(ms)}</option>`
    ).join("");
  }
  // Turn a raw JSON.parse SyntaxError into a line/column pointer when the
  // engine's message includes a character offset ("...at position 42").
  function jsonErrorDetail(text, err) {
    const m = /position (\d+)/.exec(err.message);
    if (!m) return err.message;
    const pos = Math.min(Number(m[1]), text.length);
    const before = text.slice(0, pos);
    const line = before.split("\n").length;
    const col = pos - before.lastIndexOf("\n");
    return `line ${line}, column ${col} — ${err.message}`;
  }
  async function ensureJobTools() {
    if (!_jobToolsPromise) {
      _jobToolsPromise = get("/api/agents/tools")
        .then(data => {
          _jobTools = Array.isArray(data.tools) ? data.tools : [];
          return _jobTools;
        })
        .catch(err => {
          _jobToolsPromise = null;
          throw err;
        });
    }
    return _jobToolsPromise;
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
    if (nb) nb.addEventListener("click", openNewForm);
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
      <div class="cg-repo" data-id="${escapeHtml(job.id)}" role="article" aria-label="Job ${escapeHtml(job.id)}">
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
    if (!await askConfirmModal("Delete scheduled job", `Delete job "${id}"? This cannot be undone.`, "Delete")) return;
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
    "hourly-dedup-check": {
      id: "hourly-dedup-check",
      enabled: false,
      trigger: { kind: "interval", everyMs: 3600000 },
      steps: [
        { tool: "deduplicate_memories", input: { threshold: 0.97, dry_run: true } },
      ],
    },
    "daily-backup": {
      id: "daily-backup",
      enabled: false,
      trigger: { kind: "interval", everyMs: 86400000 },
      steps: [
        { tool: "export_data", input: {} },
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
    "daily-priority-summary": {
      id: "daily-priority-summary",
      enabled: true,
      trigger: { kind: "interval", everyMs: 86400000 },
      prompt: "Recall my current top-priority memories and write a short summary I can start my day with. Do not call write tools.",
      timeoutMs: 120000,
    },
    "code-changelog": {
      id: "code-changelog-notes",
      enabled: false,
      trigger: { kind: "watcher", source: "codegraph", debounceMs: 5000 },
      prompt: "Summarise the code that just changed in 2-3 bullets, then append a new entry describing the change in plain English under \"## Unreleased\" in CHANGELOG.md.",
      timeoutMs: 120000,
    },
  };

  async function openNewForm() {
    setBody(`<div class="cg-hint">Loading tools…</div>`);
    try {
      await ensureJobTools();
      renderForm(null);
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  // Fetch the existing definition and tool catalog, then render the populated form.
  async function openForm(id) {
    setBody(`<div class="cg-hint">Loading…</div>`);
    try {
      const [job] = await Promise.all([
        get(`/api/agents/${encodeURIComponent(id)}`),
        ensureJobTools(),
      ]);
      renderForm(job);
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  // job === null → create; otherwise edit (id is locked). Deterministic jobs use
  // a schema-driven row builder with synchronized raw JSON for power users.
  function renderForm(job, isEdit, tplKey = "") {
    if (isEdit === undefined) isEdit = !!job;
    job = job || {};
    const t = job.trigger || {};
    const kind = t.kind || (isEdit ? "manual" : "interval");
    const mode = jobMode(job) === "freeform" ? "freeform" : "steps";
    const everyMin = t.everyMs ? Math.round(t.everyMs / 60000) : 60;
    const initialSteps = (Array.isArray(job.steps) && job.steps.length)
      ? job.steps
      : _jobTools.length ? [{ tool: _jobTools[0].name, input: {} }] : [];
    const prov = job.provider || {};
    const sel = (a, b) => a === b ? " selected" : "";

    setBody(`
      <div class="ag-form">
        <button class="cg-back-btn" id="agFormBack">← Back to jobs</button>
        <div class="cg-symbol-title">${isEdit ? "Edit job" : "New job"}</div>
        ${isEdit ? "" : `
        <label class="ag-field ag-wizard">
          <span>Describe what you want</span>
          <textarea id="agfWizardText" rows="2" placeholder="e.g. Every night, clean up duplicate memories and regenerate their embeddings"></textarea>
          <div class="ag-wizard-actions">
            <button type="button" class="ag-btn" id="agfWizardGo">Suggest a job</button>
            <span class="ag-wizard-msg" id="agfWizardMsg" role="status"></span>
          </div>
          <span class="ag-hint">Drafts the fields below from your active model. Off by default — review everything before enabling or saving.</span>
        </label>`}
        ${isEdit ? "" : `
        <label class="ag-field">
          <span>Start from a template</span>
          <select id="agfTemplate">
            <option value=""${sel(tplKey, "")}>Blank — start from scratch</option>
            <option value="nightly-maintenance"${sel(tplKey, "nightly-maintenance")}>Every night: clean up duplicate memories</option>
            <option value="hourly-dedup-check"${sel(tplKey, "hourly-dedup-check")}>Every hour: check for duplicate memories and report them</option>
            <option value="daily-backup"${sel(tplKey, "daily-backup")}>Every day: back up my data</option>
            <option value="doc-digest"${sel(tplKey, "doc-digest")}>When a document changes: summarise what's new</option>
            <option value="memory-digest"${sel(tplKey, "memory-digest")}>Every week: a summary of what I've been working on</option>
            <option value="daily-priority-summary"${sel(tplKey, "daily-priority-summary")}>Every day: a summary of my top-priority memories</option>
            <option value="code-changelog"${sel(tplKey, "code-changelog")}>When code changes: write a changelog entry</option>
          </select>
          <span class="ag-hint">A template fills every field below with a working example. Edit anything (start with the id) before saving.</span>
        </label>`}

        <label class="ag-field">
          <span>Job id</span>
          <input id="agfId" type="text" placeholder="my-job" value="${escapeHtml(job.id || "")}" ${isEdit ? "disabled" : ""}>
          <span class="ag-hint">Any short name — letters, numbers, dashes. Must be unique among your jobs; avoid spaces and slashes since it's used in the job's URL.</span>
        </label>

        <label class="ag-field ag-field-inline">
          <input id="agfEnabled" type="checkbox" ${job.enabled ? "checked" : ""}>
          <span>Enabled (interval/watcher scheduling fires)</span>
        </label>

        <label class="ag-field">
          <span>Trigger</span>
          <select id="agfKind" aria-label="Trigger">
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
            <span class="ag-hint">codegraph = your indexed code, docgraph = your indexed documents (notes, PDFs, reports). Leave on "both" if you're not sure.</span>
          </label>
          <label class="ag-field">
            <span>Wait after a change (seconds)</span>
            <input id="agfDebounceSec" type="number" min="0" value="${Math.round((t.debounceMs ?? 2000) / 1000)}">
            <span class="ag-hint">Waits this long after the last change before running, so a burst of edits triggers one run instead of many.</span>
          </label>
        </div>

        <label class="ag-field">
          <span>Mode</span>
          <select id="agfMode" aria-label="Mode">
            <option value="steps"${sel(mode, "steps")}>steps (deterministic, no model)</option>
            <option value="freeform"${sel(mode, "freeform")}>freeform (runs a model)</option>
          </select>
          <span class="ag-hint">Steps = a fixed list of tools run in order, no model, no surprises. Freeform = a plain-English task a model carries out.</span>
        </label>

        <div id="agfSteps" class="ag-mode-sub">
          <div class="ag-steps-heading">
            <span>Steps</span>
            <small>Run in this order</small>
          </div>
          <div id="agfStepList" class="ag-step-list"></div>
          <button type="button" class="ag-btn ag-add-step" id="agfAddStep">+ Add step</button>
          <details class="ag-advanced ag-raw-steps">
            <summary>Raw JSON — power users</summary>
            <p class="ag-hint">Changes are synchronized with the visual builder. Registered tools that are not offered above can still be preserved here.</p>
            <label class="ag-field">
              <textarea id="agfStepsJson" rows="7" spellcheck="false" aria-label="Raw JSON steps"></textarea>
            </label>
          </details>
        </div>

        <div id="agfFreeform" class="ag-mode-sub">
          <label class="ag-field">
            <span>Prompt</span>
            <textarea id="agfPrompt" rows="4" placeholder="Summarise what changed…">${escapeHtml(job.prompt || "")}</textarea>
            <span class="ag-hint">A plain-English task. The model can read memories, the wiki, and your code graph. Say "do not call write tools" if you only want a read-only summary.</span>
          </label>
          <details class="ag-advanced"${(prov.name || prov.model) ? " open" : ""}>
            <summary>Advanced (provider, model, timeout)</summary>
            <label class="ag-field">
              <span>Provider name (blank = chat default)</span>
              <input id="agfProvName" type="text" placeholder="deepseek" value="${escapeHtml(prov.name || "")}">
            </label>
            <label class="ag-field">
              <span>Model</span>
              <input id="agfProvModel" type="text" placeholder="deepseek-v4-flash" value="${escapeHtml(prov.model || "")}">
            </label>
            <label class="ag-field">
              <span>Timeout</span>
              <select id="agfTimeout">${timeoutOptions(job.timeoutMs ?? 300000)}</select>
              <span class="ag-hint">How long a run may take before it's stopped as stuck.</span>
            </label>
          </details>
        </div>

        <div class="ag-form-actions">
          <button class="ag-btn primary" id="agfSave">${isEdit ? "Save changes" : "Create job"}</button>
          <button class="ag-btn" id="agfCancel">Cancel</button>
        </div>
        <div class="ag-msg" id="agfMsg" role="alert"></div>
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
    const wizGo = document.getElementById("agfWizardGo");
    if (wizGo) wizGo.addEventListener("click", suggestWizardJob);
    window.createAgentStepsBuilder({
      tools: _jobTools,
      initialSteps,
      list: document.getElementById("agfStepList"),
      raw: document.getElementById("agfStepsJson"),
      addButton: document.getElementById("agfAddStep"),
      message: document.getElementById("agfMsg"),
      escapeHtml,
      jsonErrorDetail,
    });
  }

  // "What should this job do?" wizard — sends the plain-English description to
  // the active model and re-renders the (still create-mode) form pre-filled
  // with its suggestion, exactly like picking a template does.
  async function suggestWizardJob() {
    const msg = document.getElementById("agfWizardMsg");
    const btn = document.getElementById("agfWizardGo");
    const description = document.getElementById("agfWizardText").value.trim();
    if (!description) { msg.textContent = "⚠ describe the job first"; return; }
    btn.disabled = true;
    msg.textContent = "Thinking…";
    try {
      const res = await fetch("/api/agents/wizard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { msg.textContent = `⚠ ${d.error || res.statusText}`; btn.disabled = false; return; }
      renderForm(d.job, false);
      const formMsg = document.getElementById("agfMsg");
      if (formMsg) {
        formMsg.textContent = d.warnings?.length
          ? `⚠ Review before saving: ${d.warnings.join("; ")}`
          : "Suggestion drafted — review every field before saving.";
      }
    } catch (err) {
      msg.textContent = `Error: ${err.message}`;
      btn.disabled = false;
    }
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
      const sec = parseInt(val("agfDebounceSec"), 10);
      job.trigger = { kind: "watcher", debounceMs: (sec >= 0 ? sec : 2) * 1000 };
      const src = document.getElementById("agfSource").value;
      if (src) job.trigger.source = src;
    }
    // kind === "manual" → no trigger field (run-now only)

    const mode = document.getElementById("agfMode").value;
    if (mode === "steps") {
      let steps;
      const stepsText = val("agfStepsJson");
      try { steps = JSON.parse(stepsText); }
      catch (e) { msg.textContent = `⚠ steps is not valid JSON — ${jsonErrorDetail(stepsText, e)}`; return; }
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
  function isOpen() { return getComputedStyle(panel()).display !== "none"; }

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
