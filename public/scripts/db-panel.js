// public/scripts/db-panel.js
// Read-only browser for every data table in the database. Slide-in panel from the
// right (mirrors wiki-panel.js) listing tables with row counts; selecting a table
// opens it in a generic viewer (#dbTableModal) with client-side search + pagination.
//
// The "Memories" row delegates to the existing rich memory table (window.openMemoryTable)
// so its delete/pin actions stay intact. Export/Import (memories-only) live in the
// panel header; their click handlers are wired in index.js by element id.
//
// "Self-memories" (the agent's own walled-off notes) is injected client-side rather
// than coming from /api/db/tables — it's deliberately excluded from the generic table
// whitelist (db/tables.js) so the wall between user data and agent notes holds even at
// the DB-browser level. Its row delegates to window.openSelfMemoryTable, a bespoke
// modal backed by the dedicated GET/DELETE /api/self-memories endpoints.

(() => {
  const PAGE_SIZE = 25;

  const panel    = () => document.getElementById("db-panel");
  const backdrop = () => document.getElementById("db-backdrop");
  const body     = () => document.getElementById("db-panel-body");

  // Which connection the panel is browsing. "aperio" (the built-in store) keeps
  // the rich memories table + Export/Import; any other connection (e.g. the
  // sample shop) is browsed read-only through the generic viewer.
  const APERIO   = "aperio";
  let curConn    = APERIO;

  // ── Generic table modal state ──────────────────────────────────────────────
  let curName    = null;
  let curLabel   = "";
  let columns    = [];
  let allRows    = [];
  let filtered   = [];
  let page       = 1;

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function cellText(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  const isAperio = () => curConn === APERIO;

  // ── Connection picker ───────────────────────────────────────────────────────
  async function loadConnections() {
    const sel = document.getElementById("dbConnSelect");
    if (!sel) return;
    try {
      const r = await fetch("/api/database/connections");
      const data = await r.json();
      const conns = (data.connections || []);
      sel.innerHTML = conns.map((c) => {
        const label = c.name === APERIO ? "Aperio's data (built-in)" : c.name;
        return `<option value="${escapeHtml(c.name)}">${escapeHtml(label)}</option>`;
      }).join("");
      if (!conns.some((c) => c.name === curConn)) curConn = APERIO;
      sel.value = curConn;
    } catch {
      sel.innerHTML = `<option value="${APERIO}">Aperio's data (built-in)</option>`;
    }
    sel.onchange = () => { curConn = sel.value; reflectConn(); loadTables(); };
    reflectConn();
  }

  // Export/Import act on memories only — hide them for other connections.
  function reflectConn() {
    const show = isAperio() ? "" : "none";
    const tb = document.querySelector("#db-panel .db-panel-toolbar");
    if (tb) tb.style.display = show;
  }

  // ── Panel list ─────────────────────────────────────────────────────────────
  async function loadTables() {
    const el = body();
    el.innerHTML = `<div class="db-empty">Loading…</div>`;
    try {
      const url = isAperio()
        ? "/api/db/tables"
        : `/api/database/${encodeURIComponent(curConn)}/tables`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed to load tables");
      const tables = data.tables || [];
      if (isAperio()) tables.push({ name: "self_memories", label: "Self-memories", count: await fetchSelfMemoryCount() });
      renderTableList(tables);
    } catch (err) {
      el.innerHTML = `<div class="db-empty csp-style-24">${escapeHtml(err.message)}</div>`;
    }
  }

  // self_memories isn't in the whitelisted /api/db/tables response (see above), so its
  // row count comes from the dedicated oversight endpoint instead.
  async function fetchSelfMemoryCount() {
    try {
      const r = await fetch("/api/self-memories");
      const data = await r.json();
      return Array.isArray(data.raw) ? data.raw.length : null;
    } catch {
      return null;
    }
  }

  function renderTableList(tables) {
    const el = body();
    if (!tables.length) {
      el.innerHTML = `<div class="db-empty">No tables.</div>`;
      return;
    }
    el.innerHTML = tables.map(t => `
      <button class="db-table-row" data-name="${escapeHtml(t.name)}" data-label="${escapeHtml(t.label)}">
        <span class="db-table-name">${escapeHtml(t.label)}</span>
        <span class="db-table-count">${t.count == null ? "" : t.count}</span>
      </button>
    `).join("");
    el.querySelectorAll(".db-table-row").forEach(btn => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.name;
        if (isAperio() && name === "memories" && typeof window.openMemoryTable === "function") {
          window.openMemoryTable();
        } else if (isAperio() && name === "self_memories" && typeof window.openSelfMemoryTable === "function") {
          window.openSelfMemoryTable();
        } else {
          openDbTable(name, btn.dataset.label);
        }
      });
    });
  }

  // ── Generic table viewer ───────────────────────────────────────────────────
  async function openDbTable(name, label) {
    curName = name;
    curLabel = label;
    const modal = document.getElementById("dbTableModal");
    document.getElementById("dbt-title").textContent = label;
    document.getElementById("dbt-count").textContent = "";
    document.getElementById("dbt-search").value = "";
    // Per-table JSON export is wired for Aperio's own tables only.
    const exp = document.getElementById("dbt-export");
    if (isAperio()) {
      exp.style.display = "";
      exp.href = `/api/db/table/${encodeURIComponent(name)}/export`;
    } else {
      exp.style.display = "none";
    }
    document.getElementById("dbt-wrapper").innerHTML = `<div class="mem-empty">Loading…</div>`;
    modal.style.display = "flex";
    await loadRows();
  }

  async function loadRows() {
    try {
      const url = isAperio()
        ? `/api/db/table/${encodeURIComponent(curName)}`
        : `/api/database/${encodeURIComponent(curConn)}/table/${encodeURIComponent(curName)}`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed to load table");
      columns = data.columns || [];
      allRows = data.rows || [];
      filtered = [...allRows];
      page = 1;
      document.getElementById("dbt-count").textContent = allRows.length ? `(${allRows.length})` : "";
      document.getElementById("dbt-filter-info").textContent = "";
      renderPage();
    } catch (err) {
      document.getElementById("dbt-wrapper").innerHTML =
        `<div class="mem-empty csp-style-24">${escapeHtml(err.message)}</div>`;
    }
  }

  function applySearch() {
    const term = document.getElementById("dbt-search").value.toLowerCase();
    filtered = term
      ? allRows.filter(row => columns.some(c => cellText(row[c]).toLowerCase().includes(term)))
      : [...allRows];
    page = 1;
    document.getElementById("dbt-filter-info").textContent =
      term ? `${filtered.length} of ${allRows.length} rows` : "";
    renderPage();
  }

  function renderPage() {
    const wrapper = document.getElementById("dbt-wrapper");
    const controls = document.getElementById("dbt-pagination");
    const pageInfo = document.getElementById("dbt-page-info");
    wrapper.classList.remove("db-detail-mode");

    if (!filtered.length) {
      wrapper.innerHTML = `<div class="mem-empty">No rows found.</div>`;
      controls.style.display = "none";
      return;
    }

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(start, start + PAGE_SIZE);

    let html = `<table class="db-tbl"><thead><tr><th class="db-col-num">#</th>`;
    html += columns.map(c => `<th>${escapeHtml(c)}</th>`).join("");
    html += `<th class="db-col-chevron"></th></tr></thead><tbody>`;
    html += pageRows.map((row, i) => {
      const cells = columns.map(c => {
        const txt = cellText(row[c]);
        return `<td title="${escapeHtml(txt)}"><span class="db-cell">${escapeHtml(txt) || '<span class="db-null">—</span>'}</span></td>`;
      }).join("");
      return `<tr class="db-row" data-i="${start + i}">
        <td class="db-col-num">${start + i + 1}</td>${cells}
        <td class="db-col-chevron"><i class="bi bi-chevron-right"></i></td>
      </tr>`;
    }).join("");
    html += `</tbody></table>`;
    wrapper.innerHTML = html;

    wrapper.querySelectorAll(".db-row").forEach(tr => {
      tr.addEventListener("click", () => openDetail(filtered[Number(tr.dataset.i)]));
    });

    controls.style.display = "flex";
    pageInfo.textContent = `${page} / ${totalPages}  ·  ${filtered.length} rows`;
    document.getElementById("dbt-prev").disabled = page === 1;
    document.getElementById("dbt-next").disabled = page === totalPages;
  }

  // If a string is itself JSON (e.g. tags '["a","b"]', settings value), parse it
  // so the record renders as real arrays/objects instead of escaped strings.
  function normalizeForJson(row) {
    const out = {};
    for (const c of columns) {
      const v = row[c];
      if (typeof v === "string") {
        const t = v.trim();
        if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
          try { out[c] = JSON.parse(t); continue; } catch { /* keep raw */ }
        }
      }
      out[c] = v;
    }
    return out;
  }

  function openDetail(row) {
    const wrapper = document.getElementById("dbt-wrapper");
    document.getElementById("dbt-pagination").style.display = "none";
    wrapper.classList.add("db-detail-mode");

    const json = JSON.stringify(normalizeForJson(row), null, 2);
    wrapper.innerHTML = `
      <div class="db-detail">
        <div class="db-detail-bar">
          <button class="db-detail-back" id="dbt-back"><i class="bi bi-arrow-left"></i> Back to ${escapeHtml(curLabel)}</button>
          <button class="db-detail-copy" id="dbt-copy" title="Copy JSON"><i class="bi bi-clipboard"></i> Copy</button>
        </div>
        <pre class="db-json">${escapeHtml(json)}</pre>
      </div>`;
    document.getElementById("dbt-back").addEventListener("click", renderPage);
    document.getElementById("dbt-copy").addEventListener("click", (e) => {
      navigator.clipboard?.writeText(json);
      const btn = e.currentTarget;
      btn.innerHTML = '<i class="bi bi-check2"></i> Copied';
      setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy'; }, 1200);
    });
    wrapper.scrollTop = 0;
  }

  function changePage(step) {
    page += step;
    renderPage();
    const b = document.querySelector("#dbTableModal .mem-table-body");
    if (b) b.scrollTop = 0;
  }

  function closeDbTable() {
    document.getElementById("dbTableModal").style.display = "none";
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function wireOnce() {
    if (wireOnce.done) return;
    wireOnce.done = true;
    document.getElementById("dbt-search").addEventListener("input", applySearch);
    document.getElementById("dbt-refresh").addEventListener("click", loadRows);
    document.getElementById("dbt-close").addEventListener("click", closeDbTable);
    document.getElementById("dbt-prev").addEventListener("click", () => changePage(-1));
    document.getElementById("dbt-next").addEventListener("click", () => changePage(1));
    // Close only when the dim backdrop itself is clicked. We compare against the
    // modal element rather than walking up from e.target with .closest(), because
    // a row click re-renders the table (detaching e.target) before this delegated
    // handler runs — a detached node has no ancestors and would look "outside".
    document.getElementById("dbTableModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeDbTable();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.getElementById("dbTableModal").style.display === "flex") {
        closeDbTable();
      }
    });
  }

  window.toggleDbPanel = function () {
    const p = panel(), b = backdrop();
    const opening = p.style.display === "none";
    if (opening) {
      wireOnce();
      p.style.display = "flex";
      b.style.display = "block";
      loadConnections().then(loadTables);
    } else {
      p.style.display = "none";
      b.style.display = "none";
    }
  };
})();
