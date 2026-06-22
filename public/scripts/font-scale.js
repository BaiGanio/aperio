// ── Font scale ───────────────────────────────────────────────
// Global text-size multiplier. Every CSS font-size is calc(Npx * var(--font-scale)),
// so setting --font-scale on :root proportionally resizes all text.
//
// Mirrors the theme module: applyFontScale is DOM-only (safe at boot and from the
// settings boot-sync); the click handler persists via window.Aperio.settings.
const FONT_SCALE_KEY = "aperio-font-scale";

function applyFontScale(scale) {
  const s = String(scale);
  document.documentElement.style.setProperty("--font-scale", s);
  document.querySelectorAll(".fontscale-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.scale === s);
  });
}

document.querySelectorAll(".fontscale-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    applyFontScale(btn.dataset.scale);
    window.Aperio?.settings?.set(FONT_SCALE_KEY, btn.dataset.scale);
  });
});

applyFontScale(localStorage.getItem(FONT_SCALE_KEY) || "1");
window.Aperio?.settings?.register(FONT_SCALE_KEY, applyFontScale);
