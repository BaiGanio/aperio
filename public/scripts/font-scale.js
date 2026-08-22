// ── Font scale ───────────────────────────────────────────────
// Global text-size multiplier. Every CSS font-size is calc(Npx * var(--font-scale)),
// so setting --font-scale on :root proportionally resizes all text.
//
// Continuous slider (0.85–1.4): drags apply live for instant preview, but persist
// only on release (change) so a drag doesn't spam settings.set / the server.
// applyFontScale is DOM-only (safe at boot and from the settings boot-sync).
const FONT_SCALE_KEY = "aperio-font-scale";
const slider = document.getElementById("fontScaleSlider");
const valueOut = document.getElementById("fontScaleValue");

function applyFontScale(scale) {
  const s = String(scale);
  document.documentElement.style.setProperty("--font-scale", s);
  if (slider) slider.value = s;
  if (valueOut) valueOut.textContent = Math.round(parseFloat(s) * 100) + "%";
}

slider?.addEventListener("input", () => applyFontScale(slider.value));
slider?.addEventListener("change", () => {
  window.Aperio?.settings?.set(FONT_SCALE_KEY, slider.value);
});

applyFontScale(localStorage.getItem(FONT_SCALE_KEY) || "1");
window.Aperio?.settings?.register(FONT_SCALE_KEY, applyFontScale);
