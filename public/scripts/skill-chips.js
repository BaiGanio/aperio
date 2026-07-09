// public/scripts/skill-chips.js
// Quick-access skill chips in the chat — click a chip to inject /skill <name>
// into the chat input. Skills are fetched from GET /api/skills.
(() => {
  const bar    = () => document.getElementById("skillChipsBar");
  const chips  = () => document.getElementById("skillChips");
  const toggle = () => document.getElementById("skillChipsToggle");
  const input  = () => document.getElementById("chatInput");

  let _skills = [];
  let _visible = false;

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  async function load() {
    try {
      const res = await fetch("/api/skills");
      if (!res.ok) return;
      const data = await res.json();
      _skills = (data.skills || []).filter(s => s.name);
      render();
    } catch {
      // Silently degrade — chips are optional convenience.
    }
  }

  function render() {
    if (!chips()) return;
    chips().innerHTML = _skills.map(s =>
      `<span class="skill-chip" data-skill="${escapeHtml(s.name)}" title="${escapeHtml(s.description || s.name)}">${escapeHtml(s.name)}</span>`
    ).join("");
    wireChips();
  }

  function wireChips() {
    chips().querySelectorAll(".skill-chip").forEach(el => {
      el.addEventListener("click", () => injectSkill(el.dataset.skill));
    });
  }

  function injectSkill(name) {
    const ta = input();
    if (!ta) return;
    const prefix = `/skill ${name} `;
    const current = ta.value;

    // If the input already starts with a /skill prefix, replace it.
    const existing = current.match(/^(\/skill\s+[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*\s+)/i);
    if (existing) {
      ta.value = prefix + current.slice(existing[0].length);
    } else {
      ta.value = prefix + current;
    }

    ta.focus();
    // Trigger input event so char counter/send button update.
    ta.dispatchEvent(new Event("input", { bubbles: true }));

    // Brief visual feedback on the chip that was clicked.
    const chip = chips().querySelector(`[data-skill="${CSS.escape(name)}"]`);
    if (chip) {
      chip.classList.add("skill-chip--flash");
      setTimeout(() => chip.classList.remove("skill-chip--flash"), 400);
    }
  }

  function show() {
    _visible = true;
    bar().style.display = "flex";
    toggle().classList.add("skill-chips-toggle--active");
  }

  function hide() {
    _visible = false;
    bar().style.display = "none";
    toggle().classList.remove("skill-chips-toggle--active");
  }

  toggle()?.addEventListener("click", () => {
    if (_visible) hide(); else show();
  });

  // Initial load — show the bar once skills are loaded.
  document.addEventListener("DOMContentLoaded", async () => {
    await load();
    if (_skills.length) show();
  });

  // Re-fetch on language change (descriptions may be localized conceptually,
  // but mainly to stay consistent with the rest of the UI lifecycle).
  document.addEventListener("aperio:lang-changed", () => {
    load();
  });
})();
