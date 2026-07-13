// public/scripts/codegraph-panel.js
// Right-side sidebar for the code knowledge graph. Text-only first pass —
// graph rendering can land later as a separate view inside this panel.
//
// Three views in one body, swapped in-place:
//   • repos        — indexed roots with counts (the empty state for search)
//   • search       — ranked symbol matches as you type
//   • symbol       — qualified symbol detail: source + callers + callees

(() => {
  const panel    = () => document.getElementById("codegraph-panel");
  const backdrop = () => document.getElementById("codegraph-backdrop");
  const body     = () => document.getElementById("cg-panel-body");
  const input    = () => document.getElementById("cgSearchInput");
  const repoSel  = () => document.getElementById("cgRepoSelect");
  const kindSel  = () => document.getElementById("cgKindSelect");

  let searchTimer = null;
  let _enabled    = null;     // null = unknown, false = no graph store, true = available
  let _repos      = [];
  let _statusTimer = null;
  let _statusPolling = false;
  let _lastStatusPhase = null;
  let _status = null;         // last /api/codegraph/status payload (drives the live region)

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  async function get(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  function setBody(html) { body().innerHTML = html; }

  // ── Indexing banner ───────────────────────────────────────────────────────
  async function fetchStatus() {
    try { return await get("/api/codegraph/status"); }
    catch { return null; }
  }
  const ROOT_ICON = { ready: '✓', indexing: '◐', pending: '·', error: '✕' };
  function renderStatusBanner(status) {
    if (!status?.enabled || status.phase === 'idle' || status.phase === 'ready') return "";
    const roots = status.roots || [];
    const done = roots.filter(r => r.phase === 'ready').length;
    const total = roots.length;
    const head = status.phase === 'error'
      ? `Indexing failed${status.error ? ': ' + escapeHtml(status.error) : ''}`
      : `Indexing ${done}/${total} folder${total === 1 ? '' : 's'}…`;
    // Per-folder rows with live file/symbol counts, so a long-running folder
    // shows movement instead of sitting at "0/N" with no detail.
    const rows = roots.map(r => {
      const name = escapeHtml(r.path.split('/').pop() || r.path);
      const counts = (r.files || r.symbols)
        ? `<span class="cg-status-counts">${escapeHtml(String(r.files))} files · ${escapeHtml(String(r.symbols))} symbols${r.phase === 'indexing' ? '…' : ''}</span>`
        : (r.phase === 'pending' ? `<span class="cg-status-counts">queued</span>` : '');
      const err = r.phase === 'error' && r.error ? ` <span class="cg-status-err">${escapeHtml(r.error)}</span>` : '';
      return `<div class="cg-status-root" data-phase="${escapeHtml(r.phase)}"><span class="cg-status-ic">${ROOT_ICON[r.phase] || '·'}</span> <span class="cg-status-name">${name}</span> ${counts}${err}</div>`;
    }).join("");
    return `<div class="cg-status-banner" data-phase="${escapeHtml(status.phase)}">
      <div class="cg-status-head">${head}</div>
      <div class="cg-status-roots">${rows}</div>
    </div>`;
  }
  async function pollStatusOnce() {
    _status = await fetchStatus();
    const phase = _status?.phase ?? 'idle';
    // While indexing (and once more on the final tick), refresh the repo list so
    // each folder appears the moment it commits, not only when the whole batch is
    // done. Cheap query; only runs during indexing.
    if (phase === 'indexing' || _lastStatusPhase === 'indexing') await loadRepos();
    // Update only the live region (banner + repos/empty) — never the add-folder
    // form below it, so the user's input/selection is preserved across ticks.
    if (!input().value) renderLiveRegion();
    _lastStatusPhase = phase;
    if (phase === 'indexing') {
      _statusTimer = setTimeout(pollStatusOnce, 1500);
    } else {
      _statusPolling = false;
    }
  }
  function startStatusPolling() {
    if (_statusPolling) return;     // already running — don't stack timers
    _statusPolling = true;
    pollStatusOnce();
  }

  // ── Repos view (empty state when no search query) ─────────────────────────
  // The add-folder form is rendered once; the live region above it (indexing
  // banner + indexed-repo list / empty message) is re-rendered on each status
  // poll so progress and freshly-indexed folders show up without disturbing the
  // form's input.
  function renderRepos() {
    setBody(`<div id="cg-live-region"></div>${renderAddRepoForm()}`);
    wireAddRepoForm();
    renderLiveRegion();
    startStatusPolling();
  }

  function reposListHtml() {
    if (_repos.length) {
      const items = _repos.map(r => `
        <div class="cg-repo" data-root="${escapeHtml(r.root_path)}">
          <div class="cg-repo-header">
            <div class="cg-repo-path">${escapeHtml(r.root_path)}</div>
            <button class="cg-repo-del" title="Remove this repo and its allowed path">×</button>
          </div>
          <div class="cg-repo-meta">
            ${escapeHtml(String(r.files ?? 0))} files · ${escapeHtml(String(r.symbols ?? 0))} symbols
            ${r.last_indexed_at ? "· indexed " + escapeHtml(new Date(r.last_indexed_at).toISOString().slice(0, 16).replace("T", " ")) : ""}
          </div>
        </div>`).join("");
      return `<div class="cg-section-label">Indexed repos</div>${items}
        <div class="cg-hint">Type above to search symbols across these repos.</div>`;
    }
    // Nothing indexed yet: only show the "pick a folder" guidance once indexing
    // is truly idle — while folders are still pending/indexing, say so instead.
    const indexing = _status && (_status.phase === 'indexing'
      || (_status.roots || []).some(r => r.phase === 'pending' || r.phase === 'indexing'));
    return indexing
      ? `<div class="cg-empty">Indexing in progress — folders appear here as soon as each one finishes.</div>`
      : `<div class="cg-empty">No repos indexed yet. Pick a folder below to graph it,
           or set <code>APERIO_CODEGRAPH=on</code> in <code>.env</code> for live watching.</div>`;
  }

  function renderLiveRegion() {
    const region = document.getElementById("cg-live-region");
    if (!region) return;
    region.innerHTML = renderStatusBanner(_status) + reposListHtml();
    region.querySelectorAll(".cg-repo-del").forEach(btn => {
      btn.addEventListener("click", () => deleteRepo(btn.closest(".cg-repo").dataset.root));
    });
  }

  // ── Delete a repo ─────────────────────────────────────────────────────────
  async function deleteRepo(rootPath) {
    if (!await askConfirmModal("Remove indexed repository", `Remove indexed repo:\n${rootPath}\n\nThis will also remove it from the allowed paths list.`, "Remove")) return;
    try {
      const r = await fetch("/api/codegraph/repos", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: rootPath }),
      });
      const d = await r.json();
      if (!r.ok) { showErrorModal(`Error: ${d.error}`); return; }
      await loadRepos();
      renderRepos();
    } catch (err) {
      showErrorModal(`Error: ${err.message}`);
    }
  }

  // ── Add-a-repo form (lets non-coders graph a different project) ───────────
  function renderAddRepoForm() {
    return `
      <div class="cg-add-repo">
        <div class="cg-section-label">Index another folder</div>
        <div class="cg-add-repo-row">
          <input type="text" id="cgAddRepoInput" class="cg-search-input" placeholder="/abs/path/to/project" />
          <button id="cgAddRepoPick"  class="cg-add-repo-btn" title="Pick a folder">📁</button>
          <button id="cgAddRepoApply" class="cg-add-repo-btn cg-add-repo-apply">Index</button>
        </div>
        <div id="cgAddRepoMsg" class="cg-add-repo-msg"></div>
      </div>`;
  }
  function wireAddRepoForm() {
    const inp   = document.getElementById("cgAddRepoInput");
    const pick  = document.getElementById("cgAddRepoPick");
    const apply = document.getElementById("cgAddRepoApply");
    const msg   = document.getElementById("cgAddRepoMsg");
    if (!inp || !apply) return;
    pick?.addEventListener("click", async () => {
      try {
        const r = await fetch("/api/pick-folder");
        const d = await r.json();
        if (d.path) inp.value = d.path;
      } catch (err) {
        msg.textContent = `Folder picker unavailable: ${err.message}`;
      }
    });
    const submit = async () => {
      const path = inp.value.trim();
      if (!path) return;
      // Client-side sub-path guard: give immediate feedback before hitting the server.
      const covered = _repos.find(r => path === r.root_path || path.startsWith(r.root_path + "/"));
      if (covered) {
        msg.textContent = `⚠ Already covered by ${covered.root_path}`;
        return;
      }
      msg.textContent = "Starting index…";
      apply.disabled = true;
      try {
        const r = await fetch("/api/codegraph/index", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const d = await r.json();
        if (!r.ok) { msg.textContent = `⚠ ${d.error}`; return; }
        msg.textContent = `Indexing ${d.path}…`;
        inp.value = "";
        // Kick the status poller so the banner updates immediately.
        _lastStatusPhase = null;
        startStatusPolling();
      } catch (err) {
        msg.textContent = `Error: ${err.message}`;
      } finally {
        apply.disabled = false;
      }
    };
    apply.addEventListener("click", submit);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  }

  // ── Search view ───────────────────────────────────────────────────────────
  async function runSearch(q) {
    if (!q || q.trim().length < 2) { renderRepos(); return; }
    setBody(`<div class="cg-hint">Searching…</div>`);
    try {
      const params = new URLSearchParams({ q, limit: "30" });
      const kind = kindSel().value;  if (kind) params.set("kind", kind);
      const repo = repoSel().value;  if (repo) params.set("repo", repo);
      const data = await get(`/api/codegraph/search?${params}`);
      const matches = data.matches || [];
      if (!matches.length) {
        setBody(`<div class="cg-empty">No symbols match “${escapeHtml(q)}”.</div>`);
        return;
      }
      const modeLabel = data.mode === "hybrid" ? "FTS + semantic" : "FTS only";
      setBody(`<div class="cg-section-label">${matches.length} match${matches.length === 1 ? "" : "es"} · ${modeLabel}</div>` +
        matches.map(m => `
          <div class="cg-match" data-qualified="${escapeHtml(m.qualified)}">
            <div><span class="cg-match-kind">${escapeHtml(m.kind)}</span><span class="cg-match-name">${escapeHtml(m.name)}</span></div>
            <div class="cg-match-path">${escapeHtml(m.path)} : ${escapeHtml(String(m.start_line))}-${escapeHtml(String(m.end_line))}</div>
            ${m.signature ? `<div class="cg-match-sig">${escapeHtml(m.signature)}</div>` : ""}
          </div>`).join(""));
      body().querySelectorAll(".cg-match").forEach(el =>
        el.addEventListener("click", () => openSymbol(el.dataset.qualified)));
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  // ── Symbol view (detail + callers + callees) ──────────────────────────────
  async function openSymbol(qualified) {
    setBody(`<div class="cg-hint">Loading…</div>`);
    try {
      const [ctx, callers, callees] = await Promise.all([
        get(`/api/codegraph/context?qualified=${encodeURIComponent(qualified)}`),
        get(`/api/codegraph/callers?qualified=${encodeURIComponent(qualified)}`),
        get(`/api/codegraph/callees?qualified=${encodeURIComponent(qualified)}`),
      ]);
      const edgeRow = (e) => `
        <div class="cg-edge" data-qualified="${escapeHtml(e.qualified)}">
          <div>${escapeHtml(e.kind)} · ${escapeHtml(e.name)}</div>
          <div class="cg-edge-path">${escapeHtml(e.path)} : ${escapeHtml(String(e.line ?? "?"))}</div>
        </div>`;
      const cs = (callers.callers || []).filter(e => e.qualified !== qualified);
      const ce = (callees.callees || []).filter(e => e.qualified !== qualified);
      setBody(`
        <div class="cg-symbol-detail">
          <button class="cg-back-btn" id="cgBackBtn">← Back to search</button>
          <div class="cg-symbol-title">${escapeHtml(ctx.qualified)}</div>
          <div class="cg-symbol-sub">${escapeHtml(ctx.kind)} · ${escapeHtml(ctx.path)} : ${escapeHtml(ctx.lines)}</div>
          ${ctx.doc ? `<div class="cg-symbol-doc">${escapeHtml(ctx.doc)}</div>` : ""}
          ${ctx.source ? `
            <div class="cg-source-wrap">
              <button class="cg-copy-btn" id="cgCopyBtn" title="Copy source"><i class="bi bi-clipboard"></i></button>
              <pre class="cg-source" id="cgSourcePre">${escapeHtml(ctx.source)}</pre>
            </div>` : ""}
          <div class="cg-section-label">Callers (${cs.length})</div>
          ${cs.length ? `<div class="cg-edges">${cs.map(edgeRow).join("")}</div>` : `<div class="cg-empty">No known callers in the indexed repos.</div>`}
          <div class="cg-section-label">Callees (${ce.length})</div>
          ${ce.length ? `<div class="cg-edges">${ce.map(edgeRow).join("")}</div>` : `<div class="cg-empty">No outbound calls resolved to indexed symbols.</div>`}
        </div>
      `);
      document.getElementById("cgBackBtn").addEventListener("click", () => runSearch(input().value));
      body().querySelectorAll(".cg-edge").forEach(el =>
        el.addEventListener("click", () => openSymbol(el.dataset.qualified)));
      const copyBtn = document.getElementById("cgCopyBtn");
      if (copyBtn) copyBtn.addEventListener("click", async () => {
        const src = document.getElementById("cgSourcePre")?.innerText ?? "";
        try {
          await navigator.clipboard.writeText(src);
          copyBtn.innerHTML = '<i class="bi bi-clipboard-check"></i>';
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
            copyBtn.classList.remove("copied");
          }, 1500);
        } catch (err) {
          copyBtn.title = `Copy failed: ${err.message}`;
        }
      });
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  async function loadRepos() {
    try {
      const data = await get("/api/codegraph/repos");
      _enabled = data.enabled !== false;
      _repos   = data.repos || [];
      // Populate repo selector
      const sel = repoSel();
      sel.innerHTML = `<option value="">All repos</option>` +
        _repos.map(r => {
          const short = r.root_path.split("/").pop();
          return `<option value="${escapeHtml(short)}">${escapeHtml(short)}</option>`;
        }).join("");
    } catch (err) {
      _enabled = false;
      _repos   = [];
    }
  }

  window.toggleCodegraphPanel = async function () {
    const open = panel().style.display !== "none";
    if (open) {
      panel().style.display = "none";
      backdrop().style.display = "none";
      clearTimeout(_statusTimer);
      _statusPolling = false;
      return;
    }
    panel().style.display = "flex";
    backdrop().style.display = "block";
    if (_enabled === null) await loadRepos();
    if (_enabled === false) {
      setBody(`<div class="cg-empty">
        The code graph requires the SQLite or Postgres backend.
        Set <code>DB_BACKEND=sqlite</code> (zero-config) or <code>DB_BACKEND=postgres</code>,
        then <code>node lib/codegraph/indexer.js .</code>
      </div>`);
      return;
    }
    if (input().value) runSearch(input().value);
    else renderRepos();
    setTimeout(() => input().focus(), 50);
  };

  // Wire toolbar
  document.addEventListener("DOMContentLoaded", () => {
    input().addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(e.target.value), 200);
    });
    repoSel().addEventListener("change", () => runSearch(input().value));
    kindSel().addEventListener("change", () => runSearch(input().value));
  });
})();
