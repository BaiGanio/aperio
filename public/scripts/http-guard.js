// public/scripts/http-guard.js — REBIND-01 (first-party side)
// Adds the X-Aperio-Client header to every same-origin fetch so the server can
// tell first-party UI calls apart from cross-site (CSRF/DNS-rebind) ones. Must
// load before any script that fetches /api. Cross-origin requests are left
// untouched so the header never leaks to third parties.
(function () {
  const orig = window.fetch.bind(window);

  // AUTH-01: if a ?token= is present in the URL, persist it; attach the stored
  // token as a Bearer header on same-origin calls. No-op unless the server
  // requires a token (APERIO_AUTH_TOKEN). Exposed for the WS connector too.
  try {
    const urlTok = new URLSearchParams(window.location.search).get("token");
    if (urlTok) localStorage.setItem("aperio_auth_token", urlTok);
  } catch { /* storage blocked */ }
  function authToken() {
    try { return localStorage.getItem("aperio_auth_token"); } catch { return null; }
  }
  window.__aperioAuthToken = authToken;

  function sameOrigin(url) {
    try {
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch {
      return true; // relative/blob URL — same-origin by construction
    }
  }

  window.fetch = function (input, init = {}) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!sameOrigin(url)) return orig(input, init);
    const headers = new Headers(
      init.headers || (typeof input !== "string" && input.headers) || {}
    );
    headers.set("X-Aperio-Client", "1");
    const tok = authToken();
    if (tok && !headers.has("Authorization")) headers.set("Authorization", "Bearer " + tok);
    return orig(input, { ...init, headers });
  };
})();
