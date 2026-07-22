// ── Theme ────────────────────────────────────────────────────
const THEMES = ["light", "dark", "aurora", "system"];
let currentTheme = (() => {
  try { return localStorage.getItem("aperio-theme") || "system"; }
  catch { return "system"; }
})();

// DOM-only — does not persist, so it's safe to call at boot and from the
// settings boot-sync. Persistence happens in the click handler below.
function applyTheme(theme) {
  // Guard: reject invalid/undefined themes so a misclick or stray caller never
  // sets data-theme="" or data-theme="undefined", breaking all CSS.
  if (!THEMES.includes(theme)) theme = "system";
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".theme-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
  currentTheme = theme;
}

function bootTheme() {
  // data-theme excludes ambient-buttons which share the theme-btn class
  document.querySelectorAll(".theme-btn[data-theme]").forEach(btn => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.theme);
      window.Aperio?.settings?.set("aperio-theme", btn.dataset.theme);
    });
  });
  applyTheme(currentTheme);
  window.Aperio?.settings?.register("aperio-theme", applyTheme);
}

// If the DOM is already ready (unlikely for a synchronous script at the bottom
// of <body>, but possible with streaming HTML or preload scanners), wire now.
// Otherwise wait for DOMContentLoaded so the theme buttons exist.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootTheme);
} else {
  bootTheme();
}

// ── Update timestamps every 30s ────────────────────────────────
setInterval(() => {
  document.querySelectorAll(".msg-timestamp[data-ts]").forEach(el => {
    const diff = Math.floor((Date.now() - Number.parseInt(el.dataset.ts)) / 1000);
    if (diff < 60)        el.textContent = t("mem_just_now");
    else if (diff < 3600) el.textContent = t("mem_min_ago",  { n: Math.floor(diff/60) });
    else                  el.textContent = t("mem_hour_ago", { n: Math.floor(diff/3600) });
  });
}, 30_000);
