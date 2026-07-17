// public/scripts/settings-overlay.js
// Settings overlay (#252) — the one configuration surface, replacing the
// right-side Config panel (issue #167's Phase-2 renderer, absorbed here).
//
// Full-screen card (language-map pattern): left category nav, search across
// all categories, Simple↔Advanced toggle. Schema-driven from
// GET /api/config/schema — every editable var gets a typed control; writes go
// through PUT /api/settings/config.<KEY> (existing store + secret masking).
// Tier-0 vars render read-only (they live in .env); secrets are write-only:
// blank on save keeps the current value. Any successful save shows the
// restart bar (every Tier-1 var is restart-to-apply).
(() => {
  const $ = (id) => document.getElementById(id);
  const t = (...a) => window.t ? window.t(...a) : a[0];

  // ── Ported value/token helpers (see config-panel.js history) ─────────────
  const OFF_FOR = { on: "off", true: "false", 1: "0", "0": "0", yes: "no" };
  const TRUTHY = new Set(["1", "true", "on", "yes"]);
  const onToken = (f) => {
    const ex = String(f.example || "").trim();
    if (ex) return ex;
    const d = String(f.default || "").trim();
    return d && !["off", "false", "0", "no"].includes(d.toLowerCase()) ? d : "1";
  };
  const offToken = (on) => OFF_FOR[on.toLowerCase()] ?? "false";
  const isTruthy = (v) => TRUTHY.has(String(v || "").trim().toLowerCase());
  const humanize = (key) =>
    key.replace(/^APERIO_/, "").replace(/_/g, " ").toLowerCase()
       .replace(/\b\w/g, (c) => c.toUpperCase());
  const splitList = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

  // Provider reveal: only the chosen provider's key/model rows are shown.
  const PROVIDER_FIELDS = {
    anthropic:     ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
    deepseek:      ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"],
    gemini:        ["GEMINI_API_KEY", "GEMINI_MODEL"],
    "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN"],
    codex:         ["CODEX_MODEL", "CODEX_API_KEY", "CODEX_SANDBOX", "CODEX_APPROVAL_POLICY"],
  };
  const FIELD_PROVIDER = {};
  for (const [p, keys] of Object.entries(PROVIDER_FIELDS))
    for (const k of keys) FIELD_PROVIDER[k] = p;

  // Changing either invalidates every stored vector → extra reindex warning.
  const REINDEX_KEYS = new Set(["EMBEDDING_PROVIDER", "EMBEDDING_DIMS"]);

  // The live panels below own their flows; their seed/config registry rows stay
  // hidden so two controls never fight over one setting.
  const HIDDEN_SECTIONS = new Set(["github", "paths"]);
  const SPECIAL_CATEGORIES = [
    { id: "paths", label: "Allowed folders", icon: "bi-folder2-open" },
    { id: "dbconnections", label: "Database connections", icon: "bi-database" },
    { id: "github", label: "GitHub triage", icon: "bi-github" },
  ];

  const CAT_ICONS = {
    provider: "bi-cpu", memory: "bi-shield-lock", features: "bi-stars",
    network: "bi-hdd-network", advanced: "bi-three-dots",
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let schema = null;
  let readers = [];             // { key, read(), row }
  let rowsByCat = new Map();    // catId → [row]
  let activeCat = "provider";
  let mode = localStorage.getItem("aperio-settings-mode") === "advanced" ? "advanced" : "simple";
  let providerSelect = null;
  let savedNeedsRestart = false;

  const liteBasic = () => window.Aperio?.lite?.basic() === true;

  // ── Field rendering ───────────────────────────────────────────────────────
  const SOURCE_KEY = { env: "stov_src_env", db: "stov_src_db", default: "stov_src_default" };
  function sourceChip(f) {
    const b = document.createElement("span");
    if (!f.editable && f.tier === 0) {
      b.className = "stov-chip is-lock";
      b.textContent = "🔒 " + t("stov_readonly_env");
      return b;
    }
    if (!f.source || !SOURCE_KEY[f.source]) return null;
    b.className = "stov-chip is-" + f.source;
    b.textContent = t(SOURCE_KEY[f.source]);
    return b;
  }

  function badge(configured) {
    const b = document.createElement("span");
    b.className = "stov-badge" + (configured ? " is-on" : "");
    b.textContent = configured ? t("stov_secret_set") : t("stov_secret_unset");
    return b;
  }

  // Build one row. Returns { row, read(), key }.
  function buildField(f) {
    const row = document.createElement("div");
    row.className = "stov-row";
    row.dataset.hay = `${humanize(f.key)} ${f.key} ${f.help || ""}`.toLowerCase();
    if (FIELD_PROVIDER[f.key]) row.dataset.provider = FIELD_PROVIDER[f.key];

    const name = document.createElement("div");
    name.className = "stov-name";
    const label = document.createElement("span");
    label.textContent = humanize(f.key);
    const code = document.createElement("code");
    code.className = "stov-key";
    code.textContent = f.key;
    name.append(label, code);
    row.appendChild(name);

    const ctrl = document.createElement("div");
    ctrl.className = "stov-ctrl";
    const line = document.createElement("div");
    line.className = "stov-ctl-line";
    ctrl.appendChild(line);

    let read = () => null;

    if (!f.editable) {
      const ro = document.createElement("span");
      ro.className = "stov-readonly";
      if (f.secret) line.appendChild(badge(f.configured));
      else { ro.textContent = f.value || "—"; line.appendChild(ro); }
    } else if (f.type === "boolean") {
      const on = onToken(f), off = offToken(on);
      const initialChecked = isTruthy(f.value);
      const wrap = document.createElement("label");
      wrap.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = initialChecked;
      const track = document.createElement("span");
      track.className = "switch-track";
      wrap.append(input, track);
      line.appendChild(wrap);
      read = () => input.checked === initialChecked ? null : (input.checked ? on : off);
    } else if (f.secret) {
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = f.configured ? t("stov_secret_keep_ph") : t("stov_secret_unset_ph");
      line.appendChild(input);
      read = () => { const v = input.value.trim(); return v ? v : null; };
    } else if (f.type === "select") {
      const sel = document.createElement("select");
      for (const opt of (f.options || [])) {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        if (opt === f.value) o.selected = true;
        sel.appendChild(o);
      }
      if (!f.value && !(f.options || []).includes("")) {
        const o = document.createElement("option");
        o.value = ""; o.textContent = "—"; o.selected = true;
        sel.insertBefore(o, sel.firstChild);
      }
      if (f.key === "AI_PROVIDER") {
        providerSelect = sel;
        sel.addEventListener("change", () => applyProviderReveal(sel.value));
      }
      line.appendChild(sel);
      read = () => sel.value === (f.value || "") ? null : sel.value;
    } else if (f.type === "list") {
      const items = splitList(f.value);
      const chips = document.createElement("div");
      chips.className = "paths-chips";
      const renderChips = () => {
        chips.innerHTML = "";
        if (!items.length) {
          chips.innerHTML = `<span class="paths-empty-hint">${t("stov_none")}</span>`;
          return;
        }
        items.forEach((v, i) => {
          const chip = document.createElement("div");
          chip.className = "path-chip";
          const text = document.createElement("span");
          text.className = "path-chip-text";
          text.textContent = v;
          const del = document.createElement("button");
          del.className = "path-chip-del";
          del.textContent = "×";
          del.onclick = () => { items.splice(i, 1); renderChips(); updateFoot(); };
          chip.append(text, del);
          chips.appendChild(chip);
        });
      };
      const addRow = document.createElement("div");
      addRow.className = "paths-add-row";
      const input = document.createElement("input");
      input.type = "text";
      if (f.example) input.placeholder = f.example;
      const addBtn = document.createElement("button");
      addBtn.className = "paths-add-btn";
      addBtn.type = "button";
      addBtn.textContent = "+";
      const add = () => {
        const v = input.value.trim();
        if (v && !items.includes(v)) { items.push(v); renderChips(); updateFoot(); }
        input.value = "";
        input.focus();
      };
      addBtn.onclick = add;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); add(); }
      });
      addRow.append(input, addBtn);
      renderChips();
      const stack = document.createElement("div");
      stack.style.width = "100%";
      stack.append(chips, addRow);
      line.appendChild(stack);
      read = () => {
        const cur = items.join(",");
        return cur === (f.value || "") ? null : cur;
      };
    } else {
      const input = document.createElement("input");
      input.type = f.type === "number" ? "number" : "text";
      input.value = f.value || "";
      if (f.example) input.placeholder = f.example;
      line.appendChild(input);
      read = () => input.value === (f.value || "") ? null : input.value;
    }

    const chip = sourceChip(f);
    if (chip) line.appendChild(chip);
    row.appendChild(ctrl);

    if (f.help) {
      const help = document.createElement("div");
      help.className = "stov-help";
      help.textContent = f.help;
      row.appendChild(help);
    }

    // Plaintext-secrets hint: recommend at-rest encryption (or env-only keys)
    // while APERIO_DB_ENCRYPT is off.
    if (f.editable && f.secret && !isTruthy(fieldValue("APERIO_DB_ENCRYPT"))) {
      const hint = document.createElement("div");
      hint.className = "stov-hint";
      hint.textContent = "⚠ " + t("stov_encrypt_hint");
      row.appendChild(hint);
    }

    return { row, read: () => (f.editable ? read() : null), key: f.key };
  }

  const fieldValue = (key) => schema?.fields.find((x) => x.key === key)?.value;

  function applyProviderReveal(provider) {
    for (const rows of rowsByCat.values()) {
      for (const row of rows) {
        const p = row.dataset.provider;
        if (!p) continue;
        row.classList.toggle("is-provider-hidden", provider ? p !== provider : false);
      }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function catList() {
    let cats = schema.categories || [];
    if (liteBasic()) cats = cats.filter((c) => c.id !== "network" && c.id !== "advanced");
    return [...cats, ...(liteBasic() ? [] : SPECIAL_CATEGORIES)];
  }

  function fieldsFor(catId) {
    return schema.fields.filter((f) =>
      (f.category || "advanced") === catId && !HIDDEN_SECTIONS.has(f.section));
  }

  const inMode = (f) => mode === "advanced" || !(f.advanced ?? true);

  function render() {
    const navEl = $("stovNav"), bodyEl = $("stovBody");
    if (!navEl || !bodyEl || !schema) return;
    navEl.innerHTML = "";
    bodyEl.innerHTML = "";
    readers = [];
    rowsByCat = new Map();
    providerSelect = null;

    if (!catList().some((c) => c.id === activeCat)) activeCat = catList()[0]?.id;

    // Left nav
    for (const c of catList()) {
      const btn = document.createElement("button");
      btn.dataset.cat = c.id;
      if (c.id === activeCat) btn.classList.add("active");
      const icon = document.createElement("i");
      icon.className = `bi ${CAT_ICONS[c.id] || SPECIAL_CATEGORIES.find((x) => x.id === c.id)?.icon || "bi-dot"} stov-nav-icon`;
      const name = document.createElement("span");
      name.textContent = SPECIAL_CATEGORIES.find((x) => x.id === c.id)?.label || t(`stov_cat_${c.id}`);
      const count = document.createElement("span");
      count.className = "stov-count";
      count.textContent = SPECIAL_CATEGORIES.some((x) => x.id === c.id) ? "" : String(fieldsFor(c.id).filter(inMode).length);
      btn.append(icon, name, count);
      btn.addEventListener("click", () => {
        activeCat = c.id;
        const q = $("stovSearch");
        if (q) q.value = "";
        render();
      });
      navEl.appendChild(btn);
    }
    const note = document.createElement("div");
    note.className = "stov-nav-note";
    note.innerHTML = t("stov_nav_note_html");
    navEl.appendChild(note);

    // Warnings (cross-field + shadowed .env lines) — global, above the rows.
    renderWarnings(bodyEl);

    // Body: all categories rendered once; nav/search toggle visibility. Keeps
    // unsaved edits alive across navigation and filtering.
    for (const c of catList()) {
      const groupLabel = document.createElement("div");
      groupLabel.className = "stov-group-label";
      groupLabel.dataset.cat = c.id;
      groupLabel.textContent = t(`stov_cat_${c.id}`);
      bodyEl.appendChild(groupLabel);

      const blurb = document.createElement("div");
      blurb.className = "stov-blurb";
      blurb.dataset.cat = c.id;
      blurb.textContent = t(`stov_cat_${c.id}_blurb`);
      bodyEl.appendChild(blurb);

      const rows = [];
      for (const f of fieldsFor(c.id)) {
        if (liteBasic() && f.key === "APERIO_CONFIG_PRECEDENCE") continue;
        const built = buildField(f);
        built.row.dataset.cat = c.id;
        built.row.dataset.advanced = String(f.advanced ?? true);
        bodyEl.appendChild(built.row);
        rows.push(built.row);
        if (f.editable) readers.push(built);
      }
      rowsByCat.set(c.id, rows);
    }

    applyProviderReveal(providerSelect ? providerSelect.value : "");
    renderSpecialView();
    applyFilter();
    updateFoot();
  }

  function renderSpecialView() {
    const special = $("stovSpecialBody");
    if (!special) return;
    const active = SPECIAL_CATEGORIES.some((c) => c.id === activeCat) && !($('stovSearch')?.value || '').trim();
    special.classList.toggle("is-hidden", !active);
    if (!active) return;
    special.querySelectorAll(".stov-special-panel").forEach((p) =>
      p.classList.toggle("is-hidden", p.dataset.cat !== activeCat));
    if (activeCat === "paths") window.loadPaths?.();
    if (activeCat === "dbconnections") window.loadDbConnections?.();
    if (activeCat === "github") window.loadGithubTriageSettings?.();
  }

  // Visibility pass: active category (or search across all), Simple/Advanced.
  function applyFilter() {
    const bodyEl = $("stovBody");
    if (!bodyEl) return;
    const q = ($("stovSearch")?.value || "").trim().toLowerCase();
    const searching = q.length > 0;
    const special = $("stovSpecialBody");
    const specialActive = SPECIAL_CATEGORIES.some((c) => c.id === activeCat) && !searching;
    bodyEl.classList.toggle("is-hidden", specialActive);
    special?.classList.toggle("is-hidden", !specialActive);
    let anyVisible = false;

    for (const [catId, rows] of rowsByCat) {
      let catAny = false;
      for (const row of rows) {
        const advanced = row.dataset.advanced === "true";
        const modeOk = mode === "advanced" || !advanced;
        const catOk = searching || catId === activeCat;
        const qOk = !searching || row.dataset.hay.includes(q);
        const show = modeOk && catOk && qOk;
        row.classList.toggle("is-hidden", !show);
        if (show) catAny = true;
      }
      anyVisible = anyVisible || catAny;
      // Group label + blurb: label shows while searching (as a grouping cue);
      // blurb only in plain category view.
      for (const el of bodyEl.querySelectorAll(`.stov-group-label[data-cat="${catId}"]`))
        el.classList.toggle("is-hidden", searching ? !catAny : catId !== activeCat);
      for (const el of bodyEl.querySelectorAll(`.stov-blurb[data-cat="${catId}"]`))
        el.classList.toggle("is-hidden", searching || catId !== activeCat);
    }

    let empty = $("stovEmpty");
    if (!empty) {
      empty = document.createElement("div");
      empty.id = "stovEmpty";
      empty.className = "stov-empty";
      bodyEl.appendChild(empty);
    }
    empty.textContent = searching ? t("stov_empty_search", { q }) : t("stov_empty_simple");
    empty.classList.toggle("is-hidden", anyVisible);
    empty.classList.toggle("stov-row", false);
    if (specialActive) empty.classList.add("is-hidden");
  }

  function renderWarnings(host) {
    for (const w of schema.warnings || []) {
      const div = document.createElement("div");
      div.className = "stov-banner";
      const icon = document.createElement("i");
      icon.className = w.shadowed ? "bi bi-file-earmark-text" : "bi bi-exclamation-triangle";
      const span = document.createElement("span");
      span.textContent = w.message;
      div.append(icon, span);
      host.appendChild(div);
    }
    if (schema.precedence === "env") {
      const div = document.createElement("div");
      div.className = "stov-banner";
      div.innerHTML = `<i class="bi bi-file-earmark-text"></i><span>${t("stov_precedence_env_notice")}</span>`;
      host.appendChild(div);
    }
  }

  // ── Footer: unsaved count → save → restart ───────────────────────────────
  function dirtyCount() {
    let n = 0;
    for (const r of readers) if (r.read() != null) n++;
    return n;
  }

  function updateFoot() {
    const foot = $("stovFoot"), msg = $("stovFootMsg"),
          save = $("stovSaveBtn"), discard = $("stovDiscardBtn");
    if (!foot) return;
    if (savedNeedsRestart) {
      foot.classList.add("show", "is-restart");
      msg.textContent = t("stov_restart_needed");
      save.textContent = t("stov_restart_now");
      discard.textContent = t("stov_restart_later");
      return;
    }
    foot.classList.remove("is-restart");
    const n = dirtyCount();
    foot.classList.toggle("show", n > 0);
    if (n > 0) {
      msg.textContent = t("stov_unsaved", { n });
      save.textContent = t("stov_save");
      discard.textContent = t("stov_discard");
    }
  }

  async function saveAll() {
    if (savedNeedsRestart) { window.restartAperio(); return; }
    const writes = [];
    const writtenKeys = [];
    for (const r of readers) {
      const value = r.read();
      if (value == null) continue;
      writtenKeys.push(r.key);
      writes.push(
        fetch(`/api/settings/${encodeURIComponent("config." + r.key)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        }).then((res) => { if (!res.ok) throw new Error(`${r.key} → ${res.status}`); })
      );
    }
    if (!writes.length) return;
    const save = $("stovSaveBtn");
    save.disabled = true;
    try {
      await Promise.all(writes);
      const reindex = writtenKeys.some((k) => REINDEX_KEYS.has(k));
      await load();                          // re-read so values/chips refresh
      savedNeedsRestart = true;
      if (reindex) {
        const bodyEl = $("stovBody");
        const div = document.createElement("div");
        div.className = "stov-banner";
        div.innerHTML = `<i class="bi bi-database-exclamation"></i><span>${t("stov_reindex_warning")}</span>`;
        bodyEl.prepend(div);
      }
    } catch (err) {
      $("stovFootMsg").textContent = t("stov_save_failed", { err: err.message });
    } finally {
      save.disabled = false;
      updateFoot();
    }
  }

  function discardAll() {
    if (savedNeedsRestart) { savedNeedsRestart = false; updateFoot(); return; }
    render();                                // rebuild from last-loaded schema
  }

  // ── Load / open / close ───────────────────────────────────────────────────
  async function load() {
    const bodyEl = $("stovBody");
    try {
      schema = await fetch("/api/config/schema").then((r) => r.json());
      render();
    } catch {
      if (bodyEl) bodyEl.innerHTML = `<div class="stov-empty">${t("stov_load_failed")}</div>`;
    }
  }

  window.toggleSettingsOverlay = function () {
    const overlay = $("settingsOverlay");
    if (!overlay) return;
    const open = overlay.classList.contains("is-open");
    if (open) {
      overlay.classList.remove("is-open");
      overlay.style.display = "none";
      return;
    }
    savedNeedsRestart = false;
    if (liteBasic()) mode = "simple";
    syncModeButtons();
    overlay.style.display = "flex";
    overlay.classList.add("is-open");
    load();
    setTimeout(() => $("stovSearch")?.focus(), 60);
  };

  function syncModeButtons() {
    $("stovModeSimple")?.classList.toggle("active", mode === "simple");
    $("stovModeAdvanced")?.classList.toggle("active", mode === "advanced");
    const toggle = $("stovModeToggle");
    if (toggle) toggle.style.display = liteBasic() ? "none" : "";
  }

  function setMode(m) {
    mode = m;
    localStorage.setItem("aperio-settings-mode", m);
    syncModeButtons();
    render();                                 // nav counts follow the mode
  }

  // ── Restart plumbing (moved from config-panel.js; navbar power menu uses
  //    requestRestartAperio too) ─────────────────────────────────────────────
  window.restartAperio = async function () {
    const overlay = $("restartOverlay");
    const titleEl = $("restartOverlayTitle");
    const msgEl   = $("restartOverlayMsg");
    const show = (ti, m) => { if (titleEl) titleEl.textContent = ti; if (msgEl) msgEl.textContent = m; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ping  = async () => {
      try { return (await fetch("/api/version", { cache: "no-store" })).ok; }
      catch { return false; }
    };

    if (overlay) overlay.style.display = "flex";
    show(t("stov_restarting_title"), t("stov_restarting_msg"));

    try {
      const res = await fetch("/api/restart", { method: "POST" });
      if (!res.ok) throw new Error(`restart → ${res.status}`);
    } catch {
      // The connection often drops as the server exits — that's expected.
    }

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {           // old server stops answering
      if (!(await ping())) break;
      await sleep(800);
    }
    show(t("stov_reconnecting_title"), t("stov_reconnecting_msg"));
    while (Date.now() < deadline) {           // new server finishes booting
      if (await ping()) { location.reload(); return; }
      await sleep(1200);
    }
    show(t("stov_still_starting_title"), t("stov_still_starting_msg"));
    while (true) {
      await sleep(2500);
      if (await ping()) { location.reload(); return; }
    }
  };

  window.requestRestartAperio = async function () {
    if (await askConfirmModal(t("nav_power_restart"), t("power_restart_confirm"), "Restart"))
      window.restartAperio();
  };

  // ── Wiring ────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    $("stovSearch")?.addEventListener("input", applyFilter);
    $("stovModeSimple")?.addEventListener("click", () => setMode("simple"));
    $("stovModeAdvanced")?.addEventListener("click", () => setMode("advanced"));
    $("stovSaveBtn")?.addEventListener("click", saveAll);
    $("stovDiscardBtn")?.addEventListener("click", discardAll);
    const bodyEl = $("stovBody");
    bodyEl?.addEventListener("input", updateFoot);
    bodyEl?.addEventListener("change", updateFoot);
    // Click on the dimmed backdrop (not the card) closes.
    $("settingsOverlay")?.addEventListener("click", (e) => {
      if (e.target === $("settingsOverlay")) window.toggleSettingsOverlay();
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("settingsOverlay")?.classList.contains("is-open"))
      window.toggleSettingsOverlay();
  });
})();
