// public/scripts/lite.js — lite-profile UI gating (issue #186, Phase 5).
//
// When the server runs with APERIO_LITE=on, developer surfaces are hidden so
// non-technical users see only chat, memories, documents, wiki and the basic
// settings. Hiding is pure CSS driven by two attributes on <html>:
//
//   data-lite="on"           → elements with .lite-hide disappear
//   data-lite-advanced="on"  → the Settings "Advanced mode" switch; reveals
//                              everything again without leaving lite
//
// The flag comes from GET /api/config/client, but that's async — to avoid the
// hidden buttons flashing visible on load, the last known value is cached in
// localStorage and applied synchronously here (this script loads in <head>).
// First-ever load in lite mode may briefly show the full UI; every load after
// that is flash-free.
(() => {
  const LITE_KEY = "aperio-lite";
  const ADV_KEY  = "aperio-lite-advanced";
  const root = document.documentElement;

  function apply() {
    if (localStorage.getItem(LITE_KEY) === "on") root.dataset.lite = "on";
    else delete root.dataset.lite;
    if (localStorage.getItem(ADV_KEY) === "on") root.dataset.liteAdvanced = "on";
    else delete root.dataset.liteAdvanced;
  }
  apply();

  // Reconcile with the server (the .env/launcher flag may have changed).
  fetch("/api/config/client")
    .then((r) => r.json())
    .then(({ lite }) => {
      localStorage.setItem(LITE_KEY, lite ? "on" : "off");
      apply();
    })
    .catch(() => {}); // offline/starting — keep the cached state

  window.Aperio = window.Aperio || {};
  window.Aperio.lite = {
    on:       () => root.dataset.lite === "on",
    advanced: () => root.dataset.liteAdvanced === "on",
    // "basic" = lite with Advanced off — the state that hides surfaces.
    basic:    () => root.dataset.lite === "on" && root.dataset.liteAdvanced !== "on",
    setAdvanced(v) {
      localStorage.setItem(ADV_KEY, v ? "on" : "off");
      apply();
    },
  };
})();
