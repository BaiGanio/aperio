// public/scripts/codegraph-atlas.js
// Page controller for the Codegraph Atlas (#283 step 6) — the "Map" button in
// the Code Graph panel opens this page in a new tab. codegraph-map.js draws
// the sky itself; this file is the page chrome around it: theme bootstrap,
// the repo picker, the symbol search box, and the symbol-detail drawer that
// slides in over the sky so browsing several nodes never leaves the page.

(() => {
  // ── Theme — read the same localStorage key the main app writes, so the
  // atlas matches whatever theme is currently active. No UI here to change
  // it; that lives in Settings in the main app. ─────────────────────────────
  (function bootTheme() {
    const THEMES = ["light", "dark", "aurora", "system"];
    let theme = "system";
    try { theme = localStorage.getItem("aperio-theme") || "system"; } catch { /* storage blocked */ }
    if (!THEMES.includes(theme)) theme = "system";
    document.documentElement.setAttribute("data-theme", theme);
  })();

  const body        = () => document.getElementById("cgaBody");
  const detail       = () => document.getElementById("cgaDetail");
  const repoSel      = () => document.getElementById("cgaRepoSelect");
  const searchInput  = () => document.getElementById("cgaSearchInput");
  const searchResults = () => document.getElementById("cgaSearchResults");

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

  // ── Symbol detail drawer ───────────────────────────────────────────────────
  async function fetchSymbolDetail(qualified) {
    const [ctx, callers, callees] = await Promise.all([
      get(`/api/codegraph/context?qualified=${encodeURIComponent(qualified)}`),
      get(`/api/codegraph/callers?qualified=${encodeURIComponent(qualified)}`),
      get(`/api/codegraph/callees?qualified=${encodeURIComponent(qualified)}`),
    ]);
    return {
      ctx,
      cs: (callers.callers || []).filter(e => e.qualified !== qualified),
      ce: (callees.callees || []).filter(e => e.qualified !== qualified),
    };
  }
  function symbolDetailHtml({ ctx, cs, ce }) {
    const edgeRow = (e) => `
      <div class="cg-edge" data-qualified="${escapeHtml(e.qualified)}">
        <div>${escapeHtml(e.kind)} · ${escapeHtml(e.name)}</div>
        <div class="cg-edge-path">${escapeHtml(e.path)} : ${escapeHtml(String(e.line ?? "?"))}</div>
      </div>`;
    return `
      <div class="cg-symbol-detail">
        <button class="cg-back-btn">← Close</button>
        <div class="cg-symbol-title">${escapeHtml(ctx.qualified)}</div>
        <div class="cg-symbol-sub">${escapeHtml(ctx.kind)} · ${escapeHtml(ctx.path)} : ${escapeHtml(ctx.lines)}</div>
        ${ctx.doc ? `<div class="cg-symbol-doc">${escapeHtml(ctx.doc)}</div>` : ""}
        ${ctx.source ? `
          <div class="cg-source-wrap">
            <button class="cg-copy-btn" title="Copy source"><i class="bi bi-clipboard"></i></button>
            <pre class="cg-source">${escapeHtml(ctx.source)}</pre>
          </div>` : ""}
        <div class="cg-section-label">Callers (${cs.length})</div>
        ${cs.length ? `<div class="cg-edges">${cs.map(edgeRow).join("")}</div>` : `<div class="cg-empty">No known callers in the indexed repos.</div>`}
        <div class="cg-section-label">Callees (${ce.length})</div>
        ${ce.length ? `<div class="cg-edges">${ce.map(edgeRow).join("")}</div>` : `<div class="cg-empty">No outbound calls resolved to indexed symbols.</div>`}
      </div>
    `;
  }
  async function openSymbol(qualified) {
    const d = detail();
    d.hidden = false;
    d.classList.add("is-open");
    d.innerHTML = `<div class="cg-hint">Loading…</div>`;
    try {
      const data = await fetchSymbolDetail(qualified);
      d.innerHTML = symbolDetailHtml(data);
      d.querySelector(".cg-back-btn")?.addEventListener("click", closeDetail);
      d.querySelectorAll(".cg-edge").forEach(el =>
        el.addEventListener("click", () => openSymbol(el.dataset.qualified)));
      const copyBtn = d.querySelector(".cg-copy-btn");
      if (copyBtn) copyBtn.addEventListener("click", async () => {
        const src = d.querySelector(".cg-source")?.innerText ?? "";
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
      d.innerHTML = `<div class="cg-empty">Error: ${escapeHtml(err.message)}</div>`;
    }
  }
  function closeDetail() { detail().classList.remove("is-open"); }

  // ── Symbol search — jumps the camera to a pick via CodegraphMap.focusSymbol. ─
  let searchTimer = null;
  function hideSearchResults() { searchResults().hidden = true; searchResults().innerHTML = ""; }
  async function runSearch(q) {
    if (!q || q.trim().length < 2) { hideSearchResults(); return; }
    try {
      const params = new URLSearchParams({ q, limit: "20" });
      const repo = repoSel().value; if (repo) params.set("repo", repo);
      const data = await get(`/api/codegraph/search?${params}`);
      const matches = data.matches || [];
      const box = searchResults();
      if (!matches.length) {
        box.innerHTML = `<div class="cg-empty">No symbols match “${escapeHtml(q)}”.</div>`;
      } else {
        box.innerHTML = matches.map(m => `
          <div class="cg-match" data-qualified="${escapeHtml(m.qualified)}">
            <div><span class="cg-match-kind">${escapeHtml(m.kind)}</span><span class="cg-match-name">${escapeHtml(m.name)}</span></div>
            <div class="cg-match-path">${escapeHtml(m.path)} : ${escapeHtml(String(m.start_line))}-${escapeHtml(String(m.end_line))}</div>
          </div>`).join("");
        box.querySelectorAll(".cg-match").forEach(el => el.addEventListener("click", () => {
          hideSearchResults();
          window.CodegraphMap?.focusSymbol(el.dataset.qualified);
        }));
      }
      box.hidden = false;
    } catch { hideSearchResults(); }
  }

  // ── Repo picker ─────────────────────────────────────────────────────────
  function showRepoPrompt(message) {
    body().innerHTML = `<div class="cgm-state"><div class="cgm-state-box">
      <div class="cgm-state-icon">✦</div>
      <div class="cgm-state-sub">${escapeHtml(message)}</div>
    </div></div>`;
  }
  function mountRepo(repo) {
    document.title = repo ? `${repo} — Codegraph Atlas` : "Codegraph Atlas";
    window.CodegraphMap?.mount(body(), { repo, onSymbolClick: openSymbol });
  }
  async function loadRepos() {
    let repos = [];
    try {
      const data = await get("/api/codegraph/repos");
      if (data.enabled === false) { showRepoPrompt("The code graph backend is unavailable."); return; }
      repos = data.repos || [];
    } catch (err) {
      showRepoPrompt(`Error: ${err.message}`);
      return;
    }
    const sel = repoSel();
    sel.innerHTML = `<option value="">Choose a repo…</option>` +
      repos.map(r => {
        const short = r.root_path.split("/").pop();
        return `<option value="${escapeHtml(short)}">${escapeHtml(short)}</option>`;
      }).join("");

    const requested = new URLSearchParams(location.search).get("repo") || "";
    // Deep-link if valid, else auto-pick the sole repo, else prompt — a bare
    // "repo is required" server error is not a useful thing to land on.
    const initial = repos.some(r => r.root_path.split("/").pop() === requested)
      ? requested
      : (repos.length === 1 ? repos[0].root_path.split("/").pop() : "");
    if (!repos.length) { showRepoPrompt("No repos indexed yet. Index a folder from the Code Graph panel first."); return; }
    if (!initial) { showRepoPrompt("Choose a repo above to chart it."); sel.value = ""; return; }
    sel.value = initial;
    mountRepo(initial);
  }

  document.addEventListener("DOMContentLoaded", () => {
    repoSel().addEventListener("change", () => {
      const repo = repoSel().value;
      if (!repo) { window.CodegraphMap?.unmount(); showRepoPrompt("Choose a repo above to chart it."); return; }
      mountRepo(repo);
    });
    searchInput().addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(e.target.value), 200);
    });
    document.addEventListener("click", (e) => {
      if (!searchResults().hidden
          && !searchResults().contains(e.target)
          && e.target !== searchInput()) hideSearchResults();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!searchResults().hidden) { hideSearchResults(); return; }
      if (detail().classList.contains("is-open")) closeDetail();
    });
    loadRepos();
  });
})();
