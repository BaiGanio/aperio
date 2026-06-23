// public/scripts/db-connections-panel.js
// Settings → Database connections. CRUD over /api/database/connections for the
// named SQL connections the db_* tools query. Passwords are write-only: the
// server never returns them, and a blank password field on save keeps the
// stored one. The built-in `aperio` connection is shown read-only and is not
// editable/deletable.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  let editing = null; // name being edited, or null for "add new"

  function status(msg, kind = "") {
    const el = $("dbConnStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = kind === "error" ? "var(--danger, #e53935)"
      : kind === "ok" ? "var(--accent, #4caf50)" : "var(--text-muted, #888)";
  }

  async function api(method, path, body) {
    const r = await fetch(`/api/database/connections${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${method} ${path} → ${r.status}`);
    return data;
  }

  // ── List ──────────────────────────────────────────────────────────────────
  function renderList(connections) {
    const host = $("dbConnList");
    if (!host) return;
    const rows = connections.map((c) => {
      const badge = c.readOnly === false
        ? `<span class="db-conn-badge db-conn-badge--rw">writable</span>`
        : `<span class="db-conn-badge">read-only</span>`;
      const actions = c.builtin
        ? `<span class="db-conn-builtin">built-in</span>`
        : `<button class="db-conn-icon" data-edit="${esc(c.name)}" title="Edit"><i class="bi bi-pencil"></i></button>
           <button class="db-conn-icon" data-del="${esc(c.name)}" title="Delete"><i class="bi bi-trash"></i></button>`;
      return `<div class="db-conn-row">
        <span class="db-conn-name">${esc(c.name)}</span>
        <span class="db-conn-engine">${esc(c.engine)}</span>
        ${badge}
        <span class="db-conn-actions">${actions}</span>
      </div>`;
    }).join("");
    host.innerHTML = rows || `<div class="db-conn-empty">No connections yet.</div>`;
    host.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => startEdit(connections.find((c) => c.name === b.dataset.edit))));
    host.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => removeConn(b.dataset.del)));

    const summary = $("dbConnSummary");
    if (summary) {
      const n = connections.filter((c) => !c.builtin).length;
      summary.textContent = n ? `${n} connection${n === 1 ? "" : "s"}` : "";
    }
  }

  // ── Form ──────────────────────────────────────────────────────────────────
  function renderForm(conn) {
    const c = conn || { engine: "sqlite", readOnly: true };
    const sel = (e) => (c.engine === e ? " selected" : "");
    $("dbConnForm").innerHTML = `
      <div class="db-conn-form-title">${editing ? `Edit "${esc(editing)}"` : "Add a connection"}</div>
      <input type="text" id="dbcName" class="paths-text-input" placeholder="connection name (e.g. shop)"
             value="${esc(c.name || "")}" ${editing ? "readonly" : ""} autocomplete="off" />
      <select id="dbcEngine" class="paths-text-input">
        <option value="sqlite"${sel("sqlite")}>SQLite</option>
        <option value="postgres"${sel("postgres")}>Postgres</option>
        <option value="mysql"${sel("mysql")}>MySQL</option>
        <option value="mssql"${sel("mssql")}>SQL Server (MSSQL)</option>
      </select>
      <div id="dbcSqlite" class="db-conn-fields">
        <input type="text" id="dbcFile" class="paths-text-input" placeholder="/path/to/database.db"
               value="${esc(c.file || "")}" autocomplete="off" />
      </div>
      <div id="dbcServer" class="db-conn-fields">
        <input type="text" id="dbcHost" class="paths-text-input" placeholder="host (e.g. localhost)" value="${esc(c.host || "")}" autocomplete="off" />
        <input type="number" id="dbcPort" class="paths-text-input" placeholder="port" value="${esc(c.port || "")}" />
        <input type="text" id="dbcDatabase" class="paths-text-input" placeholder="database name" value="${esc(c.database || "")}" autocomplete="off" />
        <input type="text" id="dbcUser" class="paths-text-input" placeholder="user" value="${esc(c.user || "")}" autocomplete="off" />
        <input type="password" id="dbcPassword" class="paths-text-input" autocomplete="off"
               placeholder="${c.hasPassword ? "password (leave blank to keep current)" : "password"}" />
      </div>
      <label class="db-conn-readonly">
        <input type="checkbox" id="dbcReadOnly" ${c.readOnly === false ? "" : "checked"} />
        Read-only (recommended — writes still need per-statement confirmation)
      </label>
      <div class="db-conn-form-actions">
        <button class="paths-pick-btn" id="dbcTest" title="Test connection"><i class="bi bi-plug"></i> Test</button>
        <button class="paths-apply-btn" id="dbcSave"><i class="bi bi-check-lg"></i> ${editing ? "Update" : "Add"}</button>
        ${editing ? `<button class="db-conn-cancel" id="dbcCancel">Cancel</button>` : ""}
      </div>`;

    const toggle = () => {
      const eng = $("dbcEngine").value;
      $("dbcSqlite").style.display = eng === "sqlite" ? "" : "none";
      $("dbcServer").style.display = eng === "sqlite" ? "none" : "";
    };
    $("dbcEngine").addEventListener("change", toggle);
    toggle();
    $("dbcTest").addEventListener("click", (e) => { e.preventDefault(); testForm(); });
    $("dbcSave").addEventListener("click", (e) => { e.preventDefault(); saveForm(); });
    $("dbcCancel")?.addEventListener("click", (e) => { e.preventDefault(); editing = null; renderForm(null); status(""); });
  }

  function collectForm() {
    const engine = $("dbcEngine").value;
    const conn = {
      name: $("dbcName").value.trim(),
      engine,
      readOnly: $("dbcReadOnly").checked,
    };
    if (engine === "sqlite") {
      conn.file = $("dbcFile").value.trim();
    } else {
      conn.host = $("dbcHost").value.trim();
      conn.port = $("dbcPort").value.trim();
      conn.database = $("dbcDatabase").value.trim();
      conn.user = $("dbcUser").value.trim();
      const pw = $("dbcPassword").value;
      if (pw) conn.password = pw;
    }
    return conn;
  }

  async function testForm() {
    status("Testing…");
    try {
      const r = await api("POST", "/test", collectForm());
      status(`✓ Connected — ${r.tableCount} table(s) visible.`, "ok");
    } catch (err) {
      status(`✗ ${err.message}`, "error");
    }
  }

  async function saveForm() {
    status("Saving…");
    try {
      await api("POST", "", collectForm());
      editing = null;
      status("Saved.", "ok");
      await window.loadDbConnections();
      renderForm(null);
    } catch (err) {
      status(`✗ ${err.message}`, "error");
    }
  }

  function startEdit(conn) {
    if (!conn || conn.builtin) return;
    editing = conn.name;
    renderForm(conn);
    status("");
  }

  async function removeConn(name) {
    if (!confirm(`Delete connection "${name}"?`)) return;
    try {
      await api("DELETE", `/${encodeURIComponent(name)}`);
      if (editing === name) { editing = null; renderForm(null); }
      await window.loadDbConnections();
      status("Deleted.", "ok");
    } catch (err) {
      status(`✗ ${err.message}`, "error");
    }
  }

  window.loadDbConnections = async function () {
    try {
      const { connections } = await api("GET", "");
      renderList(connections);
      if (!$("dbConnForm").childElementCount) renderForm(null);
    } catch (err) {
      const host = $("dbConnList");
      if (host) host.innerHTML = `<div class="db-conn-empty">Could not load: ${esc(err.message)}</div>`;
    }
  };
})();
