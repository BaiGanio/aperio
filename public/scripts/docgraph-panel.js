// public/scripts/docgraph-panel.js
// Right-side sidebar for the document knowledge graph — the doc-shaped sibling
// of codegraph-panel.js. Reuses the cg-* panel styles.
//
// Three views in one body, swapped in-place:
//   • repos    — indexed folders with doc/chunk counts (the empty state)
//   • search   — ranked chunk matches (doc_search) as you type
//   • document — a single section/chunk's text (doc_context)

(() => {
  const panel    = () => document.getElementById("docgraph-panel");
  const backdrop = () => document.getElementById("docgraph-backdrop");
  const body     = () => document.getElementById("dg-panel-body");
  const input    = () => document.getElementById("dgSearchInput");
  const folderSel = () => document.getElementById("dgFolderSelect");
  const mimeSel   = () => document.getElementById("dgMimeSelect");

  // Friendly labels for the mime badge + type filter.
  const MIME_LABEL = {
    "application/pdf": "PDF",
    "text/markdown": "MD",
    "text/plain": "TXT",
    "text/x-rst": "RST",
    "text/html": "HTML",
    "message/rfc822": "EML",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  };
  const mimeLabel = (m) => MIME_LABEL[m] || (m ? m.split("/").pop() : "doc");

  let searchTimer = null;
  let _enabled = null;     // null = unknown, false = no doc store, true = available
  let _repos = [];
  let _statusTimer = null;
  let _statusPolling = false;
  let _lastStatusPhase = null;

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
    try { return await get("/api/docgraph/status"); }
    catch { return null; }
  }
  function renderStatusBanner(status) {
    if (!status?.enabled || status.phase === "idle" || status.phase === "ready") return "";
    const done = status.roots.filter(r => r.phase === "ready").length;
    const total = status.roots.length;
    const active = status.roots.find(r => r.phase === "indexing");
    const label = status.phase === "error"
      ? `Indexing failed${status.error ? ": " + escapeHtml(status.error) : ""}`
      : `Indexing ${done}/${total} folder${total === 1 ? "" : "s"}${active ? " · " + escapeHtml(active.path.split("/").pop()) : ""}…`;
    return `<div class="cg-status-banner" data-phase="${escapeHtml(status.phase)}">${label}</div>`;
  }
  async function pollStatusOnce() {
    const status = await fetchStatus();
    const phase = status?.phase ?? "idle";
    const el = document.getElementById("dg-status-banner-mount");
    if (el) el.innerHTML = renderStatusBanner(status);
    if (_lastStatusPhase === "indexing" && phase === "ready") {
      await loadRepos();
      if (!input().value) renderRepos();
    }
    _lastStatusPhase = phase;
    if (phase === "indexing") _statusTimer = setTimeout(pollStatusOnce, 1500);
    else _statusPolling = false;
  }
  function startStatusPolling() {
    if (_statusPolling) return;
    _statusPolling = true;
    pollStatusOnce();
  }

  // ── Repos view (empty state when no search query) ─────────────────────────
  function renderRepos() {
    if (!_repos.length) {
      setBody(`<div id="dg-status-banner-mount"></div><div class="cg-empty">
        No documents indexed yet. Pick a folder below to index it,
        or set <code>APERIO_DOCGRAPH=on</code> in <code>.env</code> for live watching.
      </div>
      ${renderAddRepoForm()}`);
      wireAddRepoForm();
      startStatusPolling();
      return;
    }
    const items = _repos.map(r => {
      const types = Object.entries(r.by_mime || {})
        .map(([m, n]) => `${escapeHtml(mimeLabel(m))} ${escapeHtml(String(n))}`).join(" · ");
      return `
      <div class="cg-repo" data-root="${escapeHtml(r.root_path)}">
        <div class="cg-repo-header">
          <div class="cg-repo-path">${escapeHtml(r.root_path)}</div>
          <button class="cg-repo-del" title="Remove this folder and its allowed path">×</button>
        </div>
        <div class="cg-repo-meta">
          ${escapeHtml(String(r.docs ?? 0))} docs · ${escapeHtml(String(r.chunks ?? 0))} chunks
          ${r.last_indexed_at ? "· indexed " + escapeHtml(new Date(r.last_indexed_at).toISOString().slice(0, 16).replace("T", " ")) : ""}
          ${types ? `<div>${types}</div>` : ""}
        </div>
      </div>`;
    }).join("");
    setBody(`<div id="dg-status-banner-mount"></div><div class="cg-section-label">Indexed folders</div>${items}
      <div class="cg-hint">Type above to search across these documents.</div>
      ${renderAddRepoForm()}`);
    body().querySelectorAll(".cg-repo-del").forEach(btn => {
      btn.addEventListener("click", () => deleteRepo(btn.closest(".cg-repo").dataset.root));
    });
    wireAddRepoForm();
    startStatusPolling();
  }

  // ── Delete a folder ───────────────────────────────────────────────────────
  async function deleteRepo(rootPath) {
    if (!confirm(`Remove indexed folder:\n${rootPath}\n\nThis will also remove it from the allowed paths list.`)) return;
    try {
      const r = await fetch("/api/docgraph/repos", {
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

  // ── Add-a-folder form ─────────────────────────────────────────────────────
  function renderAddRepoForm() {
    return `
      <div class="cg-add-repo">
        <div class="cg-section-label">Index another folder</div>
        <div class="cg-add-repo-row">
          <input type="text" id="dgAddRepoInput" class="cg-search-input" placeholder="/abs/path/to/documents" />
          <button id="dgAddRepoPick"  class="cg-add-repo-btn" title="Pick a folder">📁</button>
          <button id="dgAddRepoApply" class="cg-add-repo-btn cg-add-repo-apply">Index</button>
        </div>
        <div id="dgAddRepoMsg" class="cg-add-repo-msg"></div>
      </div>`;
  }
  function wireAddRepoForm() {
    const inp   = document.getElementById("dgAddRepoInput");
    const pick  = document.getElementById("dgAddRepoPick");
    const apply = document.getElementById("dgAddRepoApply");
    const msg   = document.getElementById("dgAddRepoMsg");
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
      const covered = _repos.find(r => path === r.root_path || path.startsWith(r.root_path + "/"));
      if (covered) {
        msg.textContent = `⚠ Already covered by ${covered.root_path}`;
        return;
      }
      msg.textContent = "Starting index…";
      apply.disabled = true;
      try {
        const r = await fetch("/api/docgraph/index", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const d = await r.json();
        if (!r.ok) { msg.textContent = `⚠ ${d.error}`; return; }
        msg.textContent = `Indexing ${d.path}…`;
        inp.value = "";
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
      const folder = folderSel().value; if (folder) params.set("folder", folder);
      const mime   = mimeSel().value;   if (mime)   params.set("mime", mime);
      const data = await get(`/api/docgraph/search?${params}`);
      const matches = data.matches || [];
      if (!matches.length) {
        setBody(`<div class="cg-empty">No documents match “${escapeHtml(q)}”.</div>`);
        return;
      }
      const modeLabel = data.mode === "hybrid" ? "FTS + semantic" : "FTS only";
      setBody(`<div class="cg-section-label">${matches.length} match${matches.length === 1 ? "" : "es"} · ${modeLabel}</div>` +
        matches.map(m => `
          <div class="cg-match" data-path="${escapeHtml(m.document.rel_path)}" data-chunk="${escapeHtml(String(m.chunk_id))}" data-root="${escapeHtml(m.document.root_path)}">
            <div><span class="cg-match-kind">${escapeHtml(mimeLabel(m.document.mime))}</span><span class="cg-match-name">${escapeHtml(m.document.rel_path)}</span></div>
            <div class="cg-match-path">${escapeHtml(m.section.heading || "—")}</div>
            <div class="cg-match-sig">${escapeHtml(m.snippet || "")}</div>
          </div>`).join(""));
      body().querySelectorAll(".cg-match").forEach(el =>
        el.addEventListener("click", () => openDoc(el.dataset.path, el.dataset.chunk, el.dataset.root)));
    } catch (err) {
      setBody(`<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`);
    }
  }

  // ── Document view (a section/chunk's text) ────────────────────────────────
  async function openDoc(relPath, chunkId, rootPath) {
    setBody(`<div class="cg-hint">Loading…</div>`);
    try {
      const params = new URLSearchParams({ path: relPath, chunk_id: chunkId });
      if (rootPath) params.set("folder", rootPath);
      const ctx = await get(`/api/docgraph/context?${params}`);
      setBody(`
        <div class="cg-symbol-detail">
          <button class="cg-back-btn" id="dgBackBtn">← Back to search</button>
          <div class="cg-symbol-title">${escapeHtml(ctx.path)}</div>
          <div class="cg-symbol-sub">${escapeHtml(ctx.repo || "")}${ctx.heading ? " · " + escapeHtml(ctx.heading) : ""}</div>
          ${ctx.text ? `
            <div class="cg-source-wrap">
              <button class="cg-copy-btn" id="dgCopyBtn" title="Copy text"><i class="bi bi-clipboard"></i></button>
              <pre class="cg-source dg-source" id="dgSourcePre">${escapeHtml(ctx.text)}</pre>
            </div>` : `<div class="cg-empty">No text stored for this section.</div>`}
        </div>
      `);
      document.getElementById("dgBackBtn").addEventListener("click", () => runSearch(input().value));
      const copyBtn = document.getElementById("dgCopyBtn");
      if (copyBtn) copyBtn.addEventListener("click", async () => {
        const src = document.getElementById("dgSourcePre")?.innerText ?? "";
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
      const data = await get("/api/docgraph/repos");
      _enabled = data.enabled !== false;
      _repos   = data.repos || [];
      // Folder filter — value is the full root_path (exact, unambiguous).
      folderSel().innerHTML = `<option value="">All folders</option>` +
        _repos.map(r => `<option value="${escapeHtml(r.root_path)}">${escapeHtml(r.root_path.split("/").pop())}</option>`).join("");
      // Type filter — union of indexed mimes across folders.
      const mimes = new Set();
      _repos.forEach(r => Object.keys(r.by_mime || {}).forEach(m => mimes.add(m)));
      mimeSel().innerHTML = `<option value="">All types</option>` +
        [...mimes].sort().map(m => `<option value="${escapeHtml(m)}">${escapeHtml(mimeLabel(m))}</option>`).join("");
    } catch (err) {
      _enabled = false;
      _repos   = [];
    }
  }

  window.toggleDocgraphPanel = async function () {
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
        The document graph requires the SQLite or Postgres backend.
        Set <code>DB_BACKEND=sqlite</code> (zero-config) or <code>DB_BACKEND=postgres</code>,
        then index a folder below.
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
    folderSel().addEventListener("change", () => runSearch(input().value));
    mimeSel().addEventListener("change", () => runSearch(input().value));
  });
})();
