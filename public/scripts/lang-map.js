/**
 * lang-map.js — world-map language switcher overlay.
 *
 * Opens from the navbar globe button. A world map (framed on Europe) where
 * countries whose language Aperio speaks glow in the accent color, planned
 * languages render dashed, and everything else stays muted. Clicking a
 * country (or a row in the list pane) switches the UI language via
 * window.Aperio.setLang and tells the agent over WebSocket (set_lang).
 *
 * Country shapes (scripts/world-paths.js, ~880 KB) are lazy-loaded on first
 * open. Regenerate them with scripts/gen-world-paths.js.
 * Depends on i18n.js being loaded first.
 */
(function () {
  // Which countries each available language lights up. Adding a language =
  // one line here + its locale file. Codes are ISO 3166-1 alpha-2; a country
  // may appear under several languages (Belgium, Switzerland, Ireland…) —
  // clicking it then offers a chooser.
  const LANG_COUNTRIES = {
    en: ["GB", "IE", "US", "CA", "AU", "NZ", "MT"],
    bg: ["BG"],
    de: ["DE", "AT", "CH", "LU"],
    fr: ["FR", "BE", "LU", "CH"],
    es: ["ES", "MX", "AR", "CO", "PE", "CL", "VE", "EC", "GT", "CU", "BO", "DO", "UY", "PY", "CR", "PA", "SV", "HN", "NI"],
    it: ["IT", "CH"],
    pt: ["PT", "BR"],
    nl: ["NL", "BE"],
    pl: ["PL"],
    ro: ["RO", "MD"],
    el: ["GR", "CY"],
    sv: ["SE"],
    da: ["DK"],
    fi: ["FI"],
    cs: ["CZ"],
    sk: ["SK"],
    sl: ["SI"],
    hr: ["HR"],
    hu: ["HU"],
    et: ["EE"],
    lv: ["LV"],
    lt: ["LT"],
    mt: ["MT"],
    ga: ["IE"],
    zh: ["CN"],
    ja: ["JP"],
  };
  // Not translated yet — dashed on the map, greyed in the list. Native names
  // are shown as-is (they are language names in their own script).
  const PLANNED = {
    ru: { flag: "🇷🇺", name: "Русский",    countries: ["RU", "BY", "KZ"] },
    uk: { flag: "🇺🇦", name: "Українська", countries: ["UA"] },
    tr: { flag: "🇹🇷", name: "Türkçe",     countries: ["TR"] },
    ar: { flag: "🇸🇦", name: "العربية",     countries: ["SA", "AE", "EG", "MA", "DZ", "TN", "LY", "IQ"] },
    sw: { flag: "🇹🇿", name: "Kiswahili",  countries: ["TZ", "KE", "UG", "CD"] },
    ha: { flag: "🇳🇬", name: "Hausa",      countries: ["NG", "NE"] },
    hi: { flag: "🇮🇳", name: "हिन्दी",       countries: ["IN"] },
    ko: { flag: "🇰🇷", name: "한국어",     countries: ["KR"] },
  };
  // Micro-states too small to click at Europe zoom get a leader-line chip.
  const MICRO_CHIPS = [
    { a2: "MT", dx: -26, dy: 30 },
    { a2: "LU", dx: -30, dy: -22 },
    { a2: "CY", dx: 26, dy: 26 },
  ];
  const WORLD_VB  = { x: 0, y: 0, w: 4000, h: 2073 };
  const EUROPE_VB = { x: 1845, y: 175, w: 620, h: 460 };
  const NS = "http://www.w3.org/2000/svg";

  function init() {
    const overlay = document.getElementById("langMapOverlay");
    const openBtn = document.getElementById("langMapBtn");
    if (!overlay || !openBtn) return;

    const svg     = document.getElementById("langMapSvg");
    const loading = document.getElementById("langMapLoading");
    const tip     = document.getElementById("langMapTip");
    const chooser = document.getElementById("langMapChooser");
    const toast   = document.getElementById("langMapToast");
    const listEl  = document.getElementById("langMapList");
    const search  = document.getElementById("langMapSearch");
    const countEl = document.getElementById("langMapCount");
    const btnEU   = document.getElementById("langMapViewEurope");
    const btnW    = document.getElementById("langMapViewWorld");

    const meta = window.Aperio.LOCALE_META;
    const t = window.t;

    // country → available langs (inverted LANG_COUNTRIES)
    const COUNTRY_LANGS = {};
    for (const [lang, countries] of Object.entries(LANG_COUNTRIES))
      for (const c of countries) (COUNTRY_LANGS[c] ??= []).push(lang);
    const PLANNED_BY_COUNTRY = {};
    for (const [lang, m] of Object.entries(PLANNED))
      for (const c of m.countries) PLANNED_BY_COUNTRY[c] ??= lang;

    // ── Camera (viewBox): presets + drag pan + wheel zoom ────────────────
    let vb = { ...EUROPE_VB };
    let gMicro = null;
    const setVB = () => svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);

    function scaleMicro() {
      if (!gMicro) return;
      const zoom = EUROPE_VB.w / vb.w; // 1 at the Europe preset
      const r  = Math.max(4.5, Math.min(13, 11 / zoom));
      const fs = Math.max(3.5, Math.min(10.5, 9 / zoom));
      const hidden = vb.w > 2400; // fade chips out once the world is in view
      gMicro.style.opacity = hidden ? 0 : 1;
      gMicro.style.pointerEvents = hidden ? "none" : "auto";
      for (const c of gMicro.querySelectorAll("circle")) c.setAttribute("r", r);
      for (const x of gMicro.querySelectorAll("text")) x.setAttribute("font-size", fs);
    }

    function animateVB(to, ms = 550) {
      const from = { ...vb }, t0 = performance.now();
      const ease = (x) => x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
      (function step(now) {
        const p = Math.min(1, (now - t0) / ms), e = ease(p);
        for (const k of ["x", "y", "w", "h"]) vb[k] = from[k] + (to[k] - from[k]) * e;
        setVB(); scaleMicro();
        if (p < 1) requestAnimationFrame(step);
      })(performance.now());
    }

    function setActiveView(btn) {
      for (const b of [btnEU, btnW]) b.classList.toggle("active", b === btn);
    }
    btnEU.addEventListener("click", () => { setActiveView(btnEU); animateVB(EUROPE_VB); });
    btnW .addEventListener("click", () => { setActiveView(btnW);  animateVB(WORLD_VB); });

    let drag = null;
    svg.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, vb: { ...vb }, moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const rect = svg.getBoundingClientRect();
      const dx = (e.clientX - drag.x) * (vb.w / rect.width);
      const dy = (e.clientY - drag.y) * (vb.h / rect.height);
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      vb.x = drag.vb.x - dx; vb.y = drag.vb.y - dy;
      setVB();
      if (drag.moved) svg.classList.add("dragging");
    });
    svg.addEventListener("pointerup", () => {
      svg.classList.remove("dragging");
      setTimeout(() => { drag = null; }, 0); // let click see drag.moved first
    });
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = vb.x + (e.clientX - rect.left) / rect.width * vb.w;
      const my = vb.y + (e.clientY - rect.top) / rect.height * vb.h;
      const f = e.deltaY > 0 ? 1.16 : 1 / 1.16;
      const w = Math.max(120, Math.min(4400, vb.w * f));
      const k = w / vb.w;
      vb = { x: mx - (mx - vb.x) * k, y: my - (my - vb.y) * k, w, h: vb.h * k };
      setVB(); scaleMicro();
    }, { passive: false });

    // ── Map construction (once, after the shape data lazy-loads) ─────────
    let dataPromise = null;
    function ensureData() {
      if (window.APERIO_WORLD_PATHS) return Promise.resolve();
      dataPromise ??= new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "scripts/world-paths.js";
        s.onload = resolve;
        s.onerror = () => { dataPromise = null; reject(new Error("world-paths.js failed to load")); };
        document.head.appendChild(s);
      });
      return dataPromise;
    }

    let built = false;
    function buildMap() {
      if (built) return;
      built = true;
      loading.style.display = "none";

      const gCountries = document.createElementNS(NS, "g");
      svg.appendChild(gCountries);
      const byA2 = {};
      for (const c of window.APERIO_WORLD_PATHS) {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", c.d);
        p.classList.add("lm-country");
        if (c.a2 && COUNTRY_LANGS[c.a2]) p.classList.add("available");
        else if (c.a2 && PLANNED_BY_COUNTRY[c.a2]) p.classList.add("planned");
        p.dataset.a2 = c.a2 || "";
        p.dataset.name = c.name;
        gCountries.appendChild(p);
        if (c.a2) byA2[c.a2] = p;
      }

      gMicro = document.createElementNS(NS, "g");
      svg.appendChild(gMicro);
      for (const m of MICRO_CHIPS) {
        const target = byA2[m.a2];
        if (!target) continue;
        const b = target.getBBox();
        if (!b.width) continue;
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        const px = cx + m.dx, py = cy + m.dy;

        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", cx); line.setAttribute("y1", cy);
        line.setAttribute("x2", px); line.setAttribute("y2", py);
        line.classList.add("lm-chip-line");
        gMicro.appendChild(line);

        const g = document.createElementNS(NS, "g");
        g.classList.add("lm-chip");
        g.dataset.a2 = m.a2;
        g.dataset.name = target.dataset.name;
        const circle = document.createElementNS(NS, "circle");
        circle.setAttribute("cx", px); circle.setAttribute("cy", py); circle.setAttribute("r", 11);
        const label = document.createElementNS(NS, "text");
        label.setAttribute("x", px); label.setAttribute("y", py);
        label.setAttribute("font-size", "9");
        label.textContent = m.a2;
        g.append(circle, label);
        gMicro.appendChild(g);
      }

      setVB();
      scaleMicro();
    }

    // ── Tooltip / chooser / selection ─────────────────────────────────────
    const availLabel = (lang) => `${meta[lang].flag} ${meta[lang].name}`;

    svg.addEventListener("pointermove", (e) => {
      const el = e.target.closest(".lm-country, .lm-chip");
      if (!el || (drag && drag.moved)) { tip.style.display = "none"; return; }
      const a2 = el.dataset.a2;
      let html = `<div class="lm-tip-country"></div>`;
      tip.innerHTML = html;
      tip.firstChild.textContent = el.dataset.name || "";
      if (a2 && COUNTRY_LANGS[a2]) {
        const div = document.createElement("div");
        div.className = "lm-tip-lang";
        div.textContent = COUNTRY_LANGS[a2].map(availLabel).join(" · ");
        tip.appendChild(div);
      } else if (a2 && PLANNED_BY_COUNTRY[a2]) {
        const m = PLANNED[PLANNED_BY_COUNTRY[a2]];
        const div = document.createElement("div");
        div.className = "lm-tip-lang";
        div.textContent = `${m.flag} ${m.name}`;
        const soon = document.createElement("div");
        soon.className = "lm-tip-soon";
        soon.textContent = t("langmap_soon_hint");
        tip.append(div, soon);
      } else {
        const div = document.createElement("div");
        div.className = "lm-tip-soon";
        div.textContent = t("langmap_not_yet");
        tip.appendChild(div);
      }
      tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 260) + "px";
      tip.style.top = (e.clientY + 16) + "px";
    });
    svg.addEventListener("pointerleave", () => { tip.style.display = "none"; });

    svg.addEventListener("click", (e) => {
      if (drag && drag.moved) return;
      chooser.style.display = "none";
      const el = e.target.closest(".lm-country.available, .lm-chip");
      if (!el) return;
      const langs = COUNTRY_LANGS[el.dataset.a2] || [];
      if (langs.length === 1) return selectLang(langs[0]);
      if (langs.length > 1) {
        chooser.innerHTML = "";
        for (const l of langs) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = availLabel(l);
          b.addEventListener("click", () => { chooser.style.display = "none"; selectLang(l); });
          chooser.appendChild(b);
        }
        chooser.style.display = "flex";
        chooser.style.left = Math.min(e.clientX, window.innerWidth - 170) + "px";
        chooser.style.top = (e.clientY + 6) + "px";
      }
    });
    document.addEventListener("click", (e) => {
      if (!chooser.contains(e.target) && !svg.contains(e.target)) chooser.style.display = "none";
    });

    function selectLang(lang) {
      window.Aperio.setLang(lang);
      // Inform the agent so it switches language mid-session.
      if (typeof window.safeSend === "function") {
        try { window.safeSend(JSON.stringify({ type: "set_lang", lang })); } catch {}
      }
      toast.textContent = t("langmap_switched", { name: meta[lang].name });
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 2600);
      setTimeout(close, 650);
    }

    // ── Language list pane ────────────────────────────────────────────────
    function renderList() {
      const q = search.value.trim().toLowerCase();
      const active = window.Aperio.getCurrentLang();
      listEl.innerHTML = "";
      const matches = (lang, name, englishName = "") =>
        !q || lang.includes(q) || name.toLowerCase().includes(q) || englishName.toLowerCase().includes(q);

      const avail = window.Aperio.getSupportedLangs()
        .filter((lang) => matches(lang, meta[lang].name, meta[lang].englishName));
      if (avail.length) {
        const h = document.createElement("div");
        h.className = "lm-group";
        h.textContent = t("langmap_available");
        listEl.appendChild(h);
        for (const lang of avail) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "lm-row" + (lang === active ? " is-active" : "");
          b.innerHTML = `<span></span><span></span><span class="lm-code"></span>`;
          const [flag, name, code] = b.children;
          flag.textContent = meta[lang].flag;
          name.textContent = meta[lang].name;
          code.textContent = lang;
          b.addEventListener("click", () => selectLang(lang));
          listEl.appendChild(b);
        }
      }
      const soon = Object.entries(PLANNED).filter(([lang, m]) => matches(lang, m.name));
      if (soon.length) {
        const h = document.createElement("div");
        h.className = "lm-group";
        h.textContent = t("langmap_soon");
        listEl.appendChild(h);
        for (const [lang, m] of soon) {
          const d = document.createElement("button");
          d.type = "button";
          d.className = "lm-row soon";
          d.disabled = true;
          d.innerHTML = `<span></span><span></span><span class="lm-code"></span>`;
          const [flag, name, code] = d.children;
          flag.textContent = m.flag;
          name.textContent = m.name;
          code.textContent = lang;
          listEl.appendChild(d);
        }
      }
    }
    search.addEventListener("input", renderList);

    function renderCounts() {
      countEl.textContent = t("langmap_count", {
        n: window.Aperio.getSupportedLangs().length,
        m: Object.keys(PLANNED).length,
      });
    }

    document.addEventListener("aperio:lang-changed", () => { renderCounts(); renderList(); });

    // ── Open / close ──────────────────────────────────────────────────────
    function open() {
      overlay.classList.add("is-open");
      renderCounts();
      renderList();
      ensureData().then(buildMap).catch(() => {
        loading.textContent = "⚠"; // data failed to load; list pane still works
      });
    }
    function close() {
      overlay.classList.remove("is-open");
      tip.style.display = "none";
      chooser.style.display = "none";
    }
    openBtn.addEventListener("click", open);
    document.getElementById("langMapClose").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("is-open")) close();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
