// ── Theme ────────────────────────────────────────────────────
const THEMES = ["light", "dark", "aurora", "system"];
let currentTheme = localStorage.getItem("aperio-theme") || "system";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".theme-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
  currentTheme = theme;
  localStorage.setItem("aperio-theme", theme);
}

document.querySelectorAll(".theme-btn").forEach(btn => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
});

applyTheme(currentTheme);

// ── Update timestamps every 30s ────────────────────────────────
setInterval(() => {
  document.querySelectorAll(".msg-timestamp[data-ts]").forEach(el => {
    const diff = Math.floor((Date.now() - Number.parseInt(el.dataset.ts)) / 1000);
    if (diff < 60)        el.textContent = t("mem_just_now");
    else if (diff < 3600) el.textContent = t("mem_min_ago",  { n: Math.floor(diff/60) });
    else                  el.textContent = t("mem_hour_ago", { n: Math.floor(diff/3600) });
  });
}, 30_000);