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

  function badge(configured) {
    const b = document.createElement("span");
    b.className = "settings-state" + (configured ? " is-on" : "");
    b.textContent = configured ? "SET" : "—";
    return b;
  }

  // Build the control for one field. Returns { row, read(), key } where read()
  // yields the value to PUT (or null = nothing to write / unchanged).
  function buildField(f) {
    const row = document.createElement("div");
    row.className = "config-field";
    row.dataset.hay = `${humanize(f.key)} ${f.key} ${f.help || ""}`.toLowerCase();

    const head = document.createElement("div");
    head.className = "config-field-head";
    const label = document.createElement("span");
    label.className = "config-field-label";
    label.textContent = humanize(f.key);
    const code = document.createElement("code");
    code.className = "config-field-key";
    code.textContent = f.key;
    head.append(label, code);
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
      row.appendChild(sel);
      read = () => sel.value === (f.value || "") ? null : sel.value;
    } else {
      const input = document.createElement("input");
      input.type = f.type === "number" ? "number" : "text";
      input.className = "paths-text-input";
      input.value = f.value || "";
      if (f.example) input.placeholder = f.example;
      row.appendChild(input);
      read = () => input.value === (f.value || "") ? null : input.value;
    }

    if (f.help) {
      const help = document.createElement("span");
      help.className = "paths-section-hint config-field-help";
      help.textContent = f.help;
      row.appendChild(help);
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

  function render(schema) {
    const host = $("configSections");
    if (!host) return;
    host.innerHTML = "";
    readers = [];
    subsections = [];

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
    for (const r of readers) {
      const value = r.read();
      if (value == null) continue;            // unchanged / blank secret
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
      await window.loadConfigPanel();         // re-read so values/badges refresh
      setStatus(`Saved ${n} change${n > 1 ? "s" : ""}`, true);
      if ($("configRestartBanner")) $("configRestartBanner").style.display = "flex";
    } catch (err) {
      setStatus(`Save failed: ${err.message}`, false);
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
