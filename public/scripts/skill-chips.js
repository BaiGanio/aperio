// public/scripts/skill-chips.js
// Quick-access skill chips in the chat — click a chip to inject /skill <name>
// into the chat input. Skills are fetched from GET /api/skills.
//
// The bar shows a single row of chips: as many as fit, then one accent
// "+N more" chip carrying the overflow. Clicking it expands the bar into a
// wrapped panel ("− less" collapses it back). The visible count is measured
// against the container width and recomputed on resize, so nothing is ever
// stranded off-screen behind a hidden scrollbar (issue C).
(() => {
  const bar    = () => document.getElementById("skillChipsBar");
  const chips  = () => document.getElementById("skillChips");
  const toggle = () => document.getElementById("skillChipsToggle");
  const input  = () => document.getElementById("chatInput");

  let _skills = [];
  let _visible = false;
  let _expanded = false;
  let _rzTimer = null;

  async function load() {
    try {
      const res = await fetch("/api/skills");
      if (!res.ok) return;
      const data = await res.json();
      _skills = (data.skills || []).filter(s => s.name);
      if (_visible) render();
    } catch {
      // Silently degrade — chips are optional convenience.
    }
  }

  function makeChip(s) {
    const el = document.createElement("span");
    el.className = "skill-chip";
    el.dataset.skill = s.name;
    el.title = s.description || s.name;
    el.textContent = s.name;
    el.addEventListener("click", () => injectSkill(s.name));
    return el;
  }

  // Render one row of chips + a "+N more" chip carrying any overflow. When
  // expanded, all chips wrap and the trailing chip becomes "− less".
  function render() {
    const c = chips();
    if (!c) return;
    c.classList.add("skill-chips--collapsible");
    bar()?.classList.add("skill-chips-bar--expandable");
    c.classList.toggle("expanded", _expanded);
    c.innerHTML = "";

    const chipEls = _skills.map(makeChip);
    chipEls.forEach(el => c.appendChild(el));

    const more = document.createElement("span");
    more.className = "skill-chip skill-chip--more";
    c.appendChild(more);

    if (_expanded) {
      more.textContent = t("skill_chips_less");
      more.addEventListener("click", () => { _expanded = false; render(); });
      return;
    }

    // Measure in the single-row (nowrap) state: reserve worst-case width for the
    // more-chip, then hide every chip whose right edge overflows the row.
    more.textContent = t("skill_chips_more", { n: _skills.length });
    const limit = c.clientWidth - more.offsetWidth - 6;
    let hidden = 0;
    for (const el of chipEls) {
      if (el.offsetLeft + el.offsetWidth > limit) {
        el.classList.add("skill-chip--hidden");
        hidden++;
      }
    }
    if (hidden === 0) { more.remove(); return; }
    more.textContent = t("skill_chips_more", { n: hidden });
    more.addEventListener("click", () => { _expanded = true; render(); });
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
    render(); // measure now that the bar has layout
  }

  function hide() {
    _visible = false;
    bar().style.display = "none";
    toggle().classList.remove("skill-chips-toggle--active");
  }

  toggle()?.addEventListener("click", () => {
    if (_visible) hide(); else show();
  });

  // Recompute the visible count when the window resizes (debounced).
  addEventListener("resize", () => {
    clearTimeout(_rzTimer);
    _rzTimer = setTimeout(() => { if (_visible && !_expanded) render(); }, 120);
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
