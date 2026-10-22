// public/scripts/github-triage-panel.js
// Settings → GitHub triage section. Reads/writes three server-side settings:
//   • triage.repos          — array of "owner/repo" / project names (plain)
//   • github.token          — secret, write-only (GET returns {configured})
//   • github.webhook_secret — secret, write-only
// Secrets are never sent back to the browser: on load we only learn whether one
// is set and show a "configured ✓" badge; leaving a secret field blank on save
// keeps the existing value (so editing the repo list never wipes the token).
(() => {
  const $ = (id) => document.getElementById(id);

  async function getSetting(key) {
    try {
      const r = await fetch(`/api/settings/${encodeURIComponent(key)}`);
      if (!r.ok) return null;
      return (await r.json()).value;
    } catch { return null; }
  }

  async function putSetting(key, value) {
    const r = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!r.ok) throw new Error(`PUT ${key} → ${r.status}`);
  }

  function badge(el, configured) {
    if (!el) return;
    el.textContent = configured ? "✓ configured" : "not set";
    el.style.color = configured ? "var(--accent, #4caf50)" : "var(--text-muted, #888)";
  }

  // Settings → array of trimmed lines. Accepts the array we stored or, for
  // resilience, a comma/newline string.
  function reposToText(value) {
    const arr = Array.isArray(value) ? value : (value ? String(value).split(/[\n,]/) : []);
    return arr.map((s) => String(s).trim()).filter(Boolean).join("\n");
  }
  function textToRepos(text) {
    return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }

  window.loadGithubTriageSettings = async function () {
    const [repos, token, secret] = await Promise.all([
      getSetting("triage.repos"),
      getSetting("github.token"),
      getSetting("github.webhook_secret"),
    ]);
    const ta = $("triageReposInput");
    if (ta) ta.value = reposToText(repos);
    badge($("githubTokenState"), !!token?.configured);
    badge($("githubWebhookSecretState"), !!secret?.configured);
    // Clear secret inputs (we never have the value to prefill).
    if ($("githubTokenInput"))         $("githubTokenInput").value = "";
    if ($("githubWebhookSecretInput")) $("githubWebhookSecretInput").value = "";

    const summary = $("githubTriageSummary");
    if (summary) {
      const n = textToRepos(ta?.value || "").length;
      summary.textContent = n ? `${n} repo${n > 1 ? "s" : ""}` : "";
    }
  };

  window.saveGithubTriageSettings = async function () {
    const status = $("githubTriageStatus");
    const setStatus = (msg, ok) => {
      if (!status) return;
      status.textContent = msg;
      status.className = "model-select-status " + (ok ? "is-ok" : "is-err");
    };
    try {
      await putSetting("triage.repos", textToRepos($("triageReposInput")?.value || ""));
      // Only write a secret when the user actually typed one (blank = keep).
      const tok = $("githubTokenInput")?.value.trim();
      if (tok) await putSetting("github.token", tok);
      const sec = $("githubWebhookSecretInput")?.value.trim();
      if (sec) await putSetting("github.webhook_secret", sec);

      setStatus("Saved", true);
      window.loadGithubTriageSettings();
    } catch (err) {
      setStatus(`Save failed: ${err.message}`, false);
    }
  };
})();
