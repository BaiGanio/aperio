// public/scripts/config-panel.js
// Configuration panel — schema-driven renderer (issue #167, Phase 2).
//
// A dedicated right-side panel (like Skills / Agents), separate from the Settings
// drawer so the full registry doesn't crowd it as more vars are added. Fetches
// GET /api/config/schema and builds one typed control per registry var, grouped
// by section. Writes go through PUT /api/settings/config.<KEY> (reusing the
// existing settings store + secret masking). Every Tier-1 var is "restart to
// apply", so any successful save shows a single unconditional restart banner.
//
// Tier-0 vars (DB creds, ports, security plumbing) are rendered read-only — they
// live in .env. Secret vars are write-only: we only learn whether one is set and
// show a badge; an empty field on save keeps the existing value.
(() => {
  const $ = (id) => document.getElementById(id);
  const panel    = () => $("config-panel");
  const backdrop = () => $("config-backdrop");
  const search   = () => $("cfgSearchInput");

  // Truthy tokens the consuming code checks for are var-specific (=== "on",
  // === "1", === "true"). The canonical ON token is the registry example (or a
  // truthy default); OFF is its matching falsy token so it overrides an env var
  // too (the resolver skips an empty string, so OFF can't just be "").
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

  // Humanize an env var name for a friendly label; the raw key is shown too.
  const humanize = (key) =>
    key.replace(/^APERIO_/, "").replace(/_/g, " ").toLowerCase()
       .replace(/\b\w/g, (c) => c.toUpperCase());

  // Provider reveal: the essentials section lists keys/models for every provider,
  // but only the one chosen in AI_PROVIDER is relevant. Map each provider-scoped
  // var to its provider so the renderer can hide the rest. Vars not listed here
  // (e.g. OPENAI_API_KEY) are never auto-hidden.
  const PROVIDER_FIELDS = {
    anthropic:     ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
    deepseek:      ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"],
    gemini:        ["GEMINI_API_KEY", "GEMINI_MODEL"],
    ollama:        ["OLLAMA_MODEL"],
    "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN"],
  };
  const FIELD_PROVIDER = {};
  for (const [p, keys] of Object.entries(PROVIDER_FIELDS))
    for (const k of keys) FIELD_PROVIDER[k] = p;

  const splitList = (v) =>
    String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

  // Changing either of these invalidates every stored vector: the dimensions
  // (or the model behind them) differ, so old embeddings can't be compared to
  // new queries. Saving one shows an extra "rebuild the index" warning on top of
  // the restart banner (the per-field help/blurb already hint at this).
  const REINDEX_KEYS = new Set(["EMBEDDING_PROVIDER", "EMBEDDING_DIMS"]);

  function badge(configured) {
    const b = document.createElement("span");
    b.className = "settings-state" + (configured ? " is-on" : "");
    b.textContent = configured ? "SET" : "—";
    return b;
  }

  // Provenance chip: where the effective value comes from under the current
  // APERIO_CONFIG_PRECEDENCE. Makes "this is set in .env" vs "this is a UI/DB
  // value with no .env entry" visible — the latter is easy to overlook because
  // many DB settings have no .env.example counterpart.
  const SOURCE_LABEL = { env: "from .env", db: "from UI", default: "default" };
  function sourceChip(source) {
    if (!source || !SOURCE_LABEL[source]) return null;
    const b = document.createElement("span");
    b.className = "config-field-source is-" + source;
    b.textContent = SOURCE_LABEL[source];
    return b;
  }

  // Build the control for one field. Returns { row, read(), key } where read()
  // yields the value to PUT (or null = nothing to write / unchanged).
  function buildField(f) {
    const row = document.createElement("div");
    row.className = "config-field";
    row.dataset.hay = `${humanize(f.key)} ${f.key} ${f.help || ""}`.toLowerCase();
    if (FIELD_PROVIDER[f.key]) row.dataset.provider = FIELD_PROVIDER[f.key];

    const head = document.createElement("div");
    head.className = "config-field-head";
    const label = document.createElement("span");
    label.className = "config-field-label";
    label.textContent = humanize(f.key);
    const code = document.createElement("code");
    code.className = "config-field-key";
    code.textContent = f.key;
    head.append(label, code);
    // Help text lives in a hover tooltip on an info icon, keeping rows compact.
    if (f.help) {
      const info = document.createElement("i");
      info.className = "bi bi-info-circle config-field-info";
      info.tabIndex = 0;
      info.title = f.help;
      head.appendChild(info);
    }
    const chip = sourceChip(f.source);
    if (chip) head.appendChild(chip);
    row.appendChild(head);

    let read = () => null;

    if (!f.editable) {
      // Tier-0: read-only. Secrets show a badge; others show their value.
      const ro = document.createElement("div");
      ro.className = "config-field-readonly";
      if (f.secret) ro.appendChild(badge(f.configured));
      else { ro.textContent = f.value || "(unset)"; }
      const note = document.createElement("span");
      note.className = "config-field-envnote";
      note.textContent = "edit in .env";
      head.appendChild(note);
      row.appendChild(ro);
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
      row.appendChild(wrap);
      read = () => input.checked === initialChecked ? null : (input.checked ? on : off);
    } else if (f.secret) {
      const input = document.createElement("input");
      input.type = "password";
      input.className = "paths-text-input";
      input.autocomplete = "off";
      input.placeholder = f.configured ? "•••• set (blank = keep)" : "not set";
      row.appendChild(input);
      read = () => { const v = input.value.trim(); return v ? v : null; };
    } else if (f.type === "select") {
      const sel = document.createElement("select");
      sel.className = "paths-text-input";
      for (const opt of (f.options || [])) {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        if (opt === f.value) o.selected = true;
        sel.appendChild(o);
      }
      // Allow an empty pick when the var has no value yet and "" isn't an option.
      if (!f.value && !(f.options || []).includes("")) {
        const o = document.createElement("option");
        o.value = ""; o.textContent = "(unset)"; o.selected = true;
        sel.insertBefore(o, sel.firstChild);
      }
      // The provider picker reveals/hides the matching provider's fields live.
      if (f.key === "AI_PROVIDER") {
        providerSelect = sel;
        sel.addEventListener("change", () => applyProviderReveal(sel.value));
      }
      row.appendChild(sel);
      read = () => sel.value === (f.value || "") ? null : sel.value;
    } else if (f.type === "list") {
      // Comma list rendered as removable chips + an add box (matches Allowed
      // folders). Stored back as the same comma-joined string the code parses.
      const items = splitList(f.value);
      const chips = document.createElement("div");
      chips.className = "paths-chips";
      const renderChips = () => {
        chips.innerHTML = "";
        if (!items.length) {
          chips.innerHTML = `<span class="paths-empty-hint">none</span>`;
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
          del.title = "Remove";
          del.onclick = () => { items.splice(i, 1); renderChips(); };
          chip.append(text, del);
          chips.appendChild(chip);
        });
      };
      const addRow = document.createElement("div");
      addRow.className = "paths-add-row";
      const input = document.createElement("input");
      input.className = "paths-text-input";
      if (f.example) input.placeholder = f.example;
      const addBtn = document.createElement("button");
      addBtn.className = "paths-add-btn";
      addBtn.type = "button";
      addBtn.textContent = "+";
      const add = () => {
        const v = input.value.trim();
        if (v && !items.includes(v)) { items.push(v); renderChips(); }
        input.value = "";
        input.focus();
      };
      addBtn.onclick = add;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); add(); }
      });
      addRow.append(input, addBtn);
      renderChips();
      row.append(chips, addRow);
      read = () => {
        const cur = items.join(",");
        return cur === (f.value || "") ? null : cur;
      };
    } else {
      const input = document.createElement("input");
      input.type = f.type === "number" ? "number" : "text";
      input.className = "paths-text-input";
      input.value = f.value || "";
      if (f.example) input.placeholder = f.example;
      row.appendChild(input);
      read = () => input.value === (f.value || "") ? null : input.value;
    }

    return { row, read: () => (f.editable ? read() : null), key: f.key };
  }

  // Sections whose vars already have a dedicated, live control elsewhere are
  // hidden here so there aren't two inputs for the same setting:
  //   • github → Settings → GitHub triage (writes github.token / .webhook_secret,
  //              which the tools prefer over the GITHUB_* env vars)
  //   • paths  → Settings → Allowed folders (the live allow-list; the registry
  //              APERIO_ALLOWED_PATHS_* vars only SEED it on first run, so editing
  //              them here would be a no-op)
  const HIDDEN_SECTIONS = new Set(["github", "paths"]);

  let readers = [];          // editable fields, for save
  let subsections = [];      // { det, rows: [el] }, for search filtering
  let providerSelect = null; // AI_PROVIDER <select>, drives provider reveal

  // Hide provider-scoped rows that don't match the chosen provider. An empty
  // selection reveals all (first-run discoverability). Independent of the search
  // filter — a hidden provider's fields stay out of the way until it's selected.
  function applyProviderReveal(provider) {
    for (const { rows } of subsections) {
      for (const row of rows) {
        const p = row.dataset.provider;
        if (!p) continue;
        row.classList.toggle("is-provider-hidden", provider ? p !== provider : false);
      }
    }
  }

  function render(schema) {
    const host = $("configSections");
    if (!host) return;

    // Surface env-precedence mode so it's obvious why "from .env" fields ignore
    // saves. Hidden in the default (db) mode.
    const notice = $("configPrecedenceNotice");
    if (notice) notice.style.display = schema.precedence === "env" ? "flex" : "none";

    host.innerHTML = "";
    readers = [];
    subsections = [];
    providerSelect = null;

    const bySection = new Map();
    for (const f of schema.fields) {
      if (!bySection.has(f.section)) bySection.set(f.section, []);
      bySection.get(f.section).push(f);
    }

    for (const sec of schema.sections) {
      if (HIDDEN_SECTIONS.has(sec.id)) continue;
      const fields = bySection.get(sec.id);
      if (!fields || !fields.length) continue;

      const det = document.createElement("details");
      det.className = "config-subsection";
      det.dataset.section = sec.id;
      if (sec.id === "essentials") det.open = true;
      const sum = document.createElement("summary");
      sum.textContent = sec.title;
      det.appendChild(sum);

      const body = document.createElement("div");
      body.className = "config-subsection-body";
      if (sec.blurb) {
        const blurb = document.createElement("span");
        blurb.className = "paths-section-hint";
        blurb.textContent = sec.blurb;
        body.appendChild(blurb);
      }
      const rows = [];
      for (const f of fields) {
        const built = buildField(f);
        body.appendChild(built.row);
        rows.push(built.row);
        if (f.editable) readers.push(built);
      }
      det.appendChild(body);
      host.appendChild(det);
      subsections.push({ det, rows });
    }
    applyProviderReveal(providerSelect ? providerSelect.value : "");
  }

  // Filter by visibility (not re-render) so unsaved edits survive a search.
  function applyFilter() {
    const q = (search()?.value || "").trim().toLowerCase();
    for (const { det, rows } of subsections) {
      let any = false;
      for (const row of rows) {
        const match = !q || row.dataset.hay.includes(q);
        row.classList.toggle("is-hidden", !match);
        if (match) any = true;
      }
      det.classList.toggle("is-hidden", !any);
      if (q) det.open = any;                       // reveal matches while searching
      else det.open = det.dataset.section === "essentials";
    }
  }

  window.loadConfigPanel = async function () {
    const host = $("configSections");
    if (!host) return;
    if ($("configRestartBanner")) $("configRestartBanner").style.display = "none";
    if ($("configReindexBanner")) $("configReindexBanner").style.display = "none";
    const status = $("configStatus");
    if (status) status.textContent = "";
    try {
      const schema = await fetch("/api/config/schema").then((r) => r.json());
      render(schema);
      applyFilter();
    } catch {
      host.innerHTML = `<span class="model-loading">Failed to load configuration</span>`;
    }
  };

  window.saveConfigSettings = async function () {
    const status = $("configStatus");
    const setStatus = (msg, ok) => {
      if (!status) return;
      status.textContent = msg;
      status.className = "model-select-status config-status " + (ok ? "is-ok" : "is-err");
    };

    const writes = [];
    const writtenKeys = [];
    for (const r of readers) {
      const value = r.read();
      if (value == null) continue;            // unchanged / blank secret
      writtenKeys.push(r.key);
      writes.push(
        fetch(`/api/settings/${encodeURIComponent("config." + r.key)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        }).then((res) => { if (!res.ok) throw new Error(`${r.key} → ${res.status}`); })
      );
    }

    if (!writes.length) { setStatus("No changes", true); return; }

    const n = writes.length;
    try {
      await Promise.all(writes);
      const reindex = writtenKeys.some((k) => REINDEX_KEYS.has(k));
      await window.loadConfigPanel();         // re-read so values/badges refresh
      setStatus(`Saved ${n} change${n > 1 ? "s" : ""}`, true);
      if ($("configRestartBanner")) $("configRestartBanner").style.display = "flex";
      if ($("configReindexBanner")) $("configReindexBanner").style.display = reindex ? "flex" : "none";
    } catch (err) {
      setStatus(`Save failed: ${err.message}`, false);
    }
  };

  // ── Restart ───────────────────────────────────────────────────────────────
  // Restart the server to apply saved config, then auto-reload once it's back.
  // The server handles the actual restart (supervised exit or self-respawn);
  // here we just show an overlay and poll /api/version — which only answers
  // after the new process finishes booting — then reload.
  window.restartAperio = async function () {
    const overlay = $("restartOverlay");
    const titleEl = $("restartOverlayTitle");
    const msgEl   = $("restartOverlayMsg");
    const show = (t, m) => { if (titleEl) titleEl.textContent = t; if (msgEl) msgEl.textContent = m; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ping  = async () => {
      try { return (await fetch("/api/version", { cache: "no-store" })).ok; }
      catch { return false; }
    };

    if (overlay) overlay.style.display = "flex";
    show("Restarting Aperio…", "Applying your changes. This usually takes a few seconds.");

    const btn = $("configRestartBtn");
    if (btn) btn.disabled = true;

    try {
      const res = await fetch("/api/restart", { method: "POST" });
      if (!res.ok) throw new Error(`restart → ${res.status}`);
    } catch {
      // The connection often drops as the server exits — that's expected.
    }

    const deadline = Date.now() + 90_000;
    // Phase 1: wait for the old server to stop answering, so we don't reload
    // into the still-draining process.
    while (Date.now() < deadline) {
      if (!(await ping())) break;
      await sleep(800);
    }
    // Phase 2: wait for the new server to finish booting, then reload.
    show("Reconnecting…", "Aperio is starting back up.");
    while (Date.now() < deadline) {
      if (await ping()) { location.reload(); return; }
      await sleep(1200);
    }

    show("Still starting…",
      "This is taking longer than usual — the page will reload automatically as soon as Aperio is back.");
    while (true) {                              // keep trying in the background
      await sleep(2500);
      if (await ping()) { location.reload(); return; }
    }
  };

  // ── Open / close ────────────────────────────────────────────────────────────
  window.toggleConfigPanel = function () {
    const open = panel().style.display !== "none";
    if (open) {
      panel().style.display = "none";
      backdrop().style.display = "none";
      return;
    }
    panel().style.display = "flex";
    backdrop().style.display = "block";
    window.loadConfigPanel();
    setTimeout(() => search()?.focus(), 50);
  };

  document.addEventListener("DOMContentLoaded", () => {
    search()?.addEventListener("input", applyFilter);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel()?.style.display !== "none") window.toggleConfigPanel();
  });
})();
