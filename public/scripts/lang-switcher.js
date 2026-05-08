/**
 * lang-switcher.js — populates the navbar language dropdown and wires it up.
 * Depends on i18n.js being loaded first.
 */
(function () {
  function init() {
    const switcher = document.getElementById("langSwitcher");
    const trigger  = document.getElementById("langTrigger");
    const popover  = document.getElementById("langPopover");
    const flagEl   = document.getElementById("langTriggerFlag");
    const codeEl   = document.getElementById("langTriggerCode");
    if (!switcher || !trigger || !popover) return;

    const meta = window.Aperio.LOCALE_META;
    const supported = window.Aperio.getSupportedLangs();

    function renderTrigger() {
      const lang = window.Aperio.getCurrentLang();
      const m = meta[lang] || meta.en;
      flagEl.textContent = m.flag;
      codeEl.textContent = lang.toUpperCase();
      trigger.title = `${m.name} (${lang.toUpperCase()})`;
    }

    function renderPopover() {
      const active = window.Aperio.getCurrentLang();
      popover.innerHTML = "";
      for (const lang of supported) {
        const m = meta[lang];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "lang-option" + (lang === active ? " is-active" : "");
        btn.dataset.lang = lang;
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", lang === active ? "true" : "false");
        btn.innerHTML =
          `<span class="lang-flag">${m.flag}</span>` +
          `<span class="lang-name"></span>` +
          `<span class="lang-code-mini">${lang}</span>`;
        btn.querySelector(".lang-name").textContent = m.name;
        btn.addEventListener("click", () => {
          window.Aperio.setLang(lang);
          renderTrigger();
          renderPopover();
          close();
          // Inform the agent so it switches language mid-session.
          if (typeof window.safeSend === "function") {
            try { window.safeSend(JSON.stringify({ type: "set_lang", lang })); } catch {}
          }
        });
        popover.appendChild(btn);
      }
    }

    function open() {
      switcher.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
    }
    function close() {
      switcher.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
    }
    function toggle() {
      switcher.classList.contains("is-open") ? close() : open();
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });

    document.addEventListener("click", (e) => {
      if (!switcher.contains(e.target)) close();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && switcher.classList.contains("is-open")) close();
    });

    document.addEventListener("aperio:lang-changed", () => {
      renderTrigger();
      renderPopover();
    });

    renderTrigger();
    renderPopover();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
