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
      // A `provisioned` row (currently just the self-provisioned `extraction`
      // connection) is Aperio's own, created behind db_execute's confirm
      // flow — Edit/Test always 400 server-side for its reserved name, so
      // those controls are never offered. Delete stays available: unlike the
      // built-in `aperio` connection this one holds the user's OWN data and
      // they may reasonably want to wipe it.
      const actions = c.builtin
        ? `<span class="db-conn-builtin">built-in</span>`
        : c.provisioned
        ? `<span class="db-conn-builtin" title="Created by Aperio for document extraction — not editable">managed</span>
           <button class="db-conn-icon" data-del="${esc(c.name)}" title="Delete"><i class="bi bi-trash"></i></button>`
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
      b.addEventListener("click", () =>
        removeConn(b.dataset.del, connections.find((c) => c.name === b.dataset.del)?.provisioned === true)));

    const summary = $("dbConnSummary");
    if (summary) {
      const n = connections.filter((c) => !c.builtin).length;
      summary.textContent = n ? `${n} connection${n === 1 ? "" : "s"}` : "";
    }
  }

  // ── Sample "practice shop" ──────────────────────────────────────────────────
  // A disposable shop database (customers, orders, products) so non-technical
  // users can try the prompts from the databases tour without touching real
  // data. Creates two connections: `sample` (read-only) and `sample-rw`
  // (writable). Delete wipes both connections and the file — a clean reset.
  let sampleNote = "";
  let sampleNoteKind = "";

  // Feedback for create/delete shows right inside the sample bar (not the status
  // line at the very bottom of the panel, which is too far from the button).
  function setSampleNote(msg, kind = "") {
    sampleNote = msg || "";
    sampleNoteKind = kind;
    const el = $("dbSampleStatus");
    if (el) {
      el.textContent = sampleNote;
      el.className = "db-conn-sample-status" + (kind ? ` is-${kind}` : "");
    }
  }

  function renderSampleBar(connections) {
    const host = $("dbSampleBar");
    if (!host) return;
    const has = connections.some((c) => c.name === "sample" || c.name === "sample-rw");
    const top = has
      ? `<span class="db-conn-sample-note">Sample shop ready — try the prompts in the
           <a href="https://baiganio.github.io/aperio/tours/databases.html" target="_blank" rel="noopener">databases tour</a>.
           <code>sample</code> is read-only; <code>sample-rw</code> lets you practise changes.</span>
         <button class="db-conn-cancel" id="dbSampleDelete"><i class="bi bi-trash"></i> Delete sample database</button>`
      : `<span class="db-conn-sample-note">New to this? Create a safe practice shop (customers, orders, products) to try the examples — nothing real is touched.</span>
         <button class="paths-pick-btn" id="dbSampleCreate"><i class="bi bi-database-add"></i> Create sample database</button>`;
    host.innerHTML = `${top}<div id="dbSampleStatus" class="db-conn-sample-status${sampleNoteKind ? ` is-${sampleNoteKind}` : ""}">${esc(sampleNote)}</div>`;
    $("dbSampleCreate")?.addEventListener("click", (e) => { e.preventDefault(); createSample(); });
    $("dbSampleDelete")?.addEventListener("click", (e) => { e.preventDefault(); deleteSample(); });
  }

  // The sample endpoints live at /api/database/sample (sibling of the
  // connections CRUD, which `api()` is scoped to), so call them directly.
  async function sampleApi(method) {
    const r = await fetch("/api/database/sample", { method });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${method} /sample → ${r.status}`);
    return data;
  }

  async function createSample() {
    setSampleNote("Creating sample database…");
    try {
      await sampleApi("POST");
      setSampleNote("Sample database ready — added connections sample & sample-rw. Ask it a question in the chat.", "ok");
      await window.loadDbConnections();
    } catch (err) {
      setSampleNote(`✗ ${err.message}`, "error");
    }
  }

  async function deleteSample() {
    if (!await askConfirmModal("Delete sample database", "Delete the sample database? This removes the sample connections and wipes its file.", "Delete")) return;
    setSampleNote("Deleting sample database…");
    try {
      await sampleApi("DELETE");
      setSampleNote("Sample database deleted.", "ok");
      await window.loadDbConnections();
    } catch (err) {
      setSampleNote(`✗ ${err.message}`, "error");
    }
  }

  // ── Form ──────────────────────────────────────────────────────────────────
  function renderForm(conn) {
    const c = conn || { engine: "sqlite", readOnly: true };
    const sel = (e) => (c.engine === e ? " selected" : "");
    $("dbConnForm").innerHTML = `
      <div class="db-conn-form-title">${editing ? `Edit "${esc(editing)}"` : "Add a connection"}</div>
      <input type="text" id="dbcName" class="paths-text-input" placeholder="connection name (e.g. shop)"
             value="${esc(c.name || "")}" autocomplete="off" />
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
        <label class="db-conn-readonly" id="dbcBackslashRow">
          Backslash escaping in string literals
          <select id="dbcBackslashEscapes" class="paths-text-input">
            <option value=""${c.backslashEscapes == null ? " selected" : ""}>Default for this engine</option>
            <option value="true"${c.backslashEscapes === true ? " selected" : ""}>On (\\' escapes a quote)</option>
            <option value="false"${c.backslashEscapes === false ? " selected" : ""}>Off (standard SQL)</option>
          </select>
        </label>
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
      $("dbcBackslashRow").style.display = eng === "mysql" || eng === "postgres" ? "" : "none";
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
      if (engine === "mysql" || engine === "postgres") {
        const sel = $("dbcBackslashEscapes").value;
        conn.backslashEscapes = sel === "" ? null : sel === "true";
      }
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
      const conn = collectForm();
      // Renaming (P2 review finding): the regular upsert-by-name POST below
      // always resolves the row by the SUBMITTED name, so it can't express
      // "rename this row" — it would instead create a second, separate row
      // under the new name and leave the old one behind. Do the rename first
      // (server-side, so the still-encrypted password carries over without
      // being retyped); the POST that follows then updates that same,
      // already-renamed row with whatever else changed on the form.
      if (editing && conn.name && conn.name.toLowerCase() !== editing.toLowerCase()) {
        await api("POST", `/${encodeURIComponent(editing)}/rename`, { newName: conn.name });
      }
      await api("POST", "", conn);
      editing = null;
      status("Saved.", "ok");
      await window.loadDbConnections();
      renderForm(null);
    } catch (err) {
      status(`✗ ${err.message}`, "error");
    }
  }

  function startEdit(conn) {
    if (!conn || conn.builtin || conn.provisioned) return;
    editing = conn.name;
    renderForm(conn);
    status("");
  }

  async function removeConn(name, managed) {
    // A managed row's delete button doesn't just drop a settings entry — the
    // server also permanently deletes the on-disk database file and every
    // extracted document in it (P1 review finding: the generic "Delete
    // connection ...?" wording made that read as reversible config removal).
    const msg = managed
      ? `Delete the managed "${name}" database? This permanently deletes the extracted-document database file and everything in it — this cannot be undone.`
      : `Delete connection "${name}"?`;
    if (!await askConfirmModal("Delete database connection", msg, "Delete")) return;
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
      renderSampleBar(connections);
      renderList(connections);
      if (!$("dbConnForm").childElementCount) renderForm(null);
    } catch (err) {
      const host = $("dbConnList");
      if (host) host.innerHTML = `<div class="db-conn-empty">Could not load: ${esc(err.message)}</div>`;
    }
  };
})();
