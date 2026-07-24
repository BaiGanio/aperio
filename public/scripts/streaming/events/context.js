// public/scripts/streaming/events/context.js
// Context-window pressure (warn / trim / summarize / handoff) and session
// lifecycle (resume, branch).

onStreamEvent("context_warning", (msg) => {
  showContextBanner(msg.pct, "warning");
});

onStreamEvent("context_trimmed", (msg) => {
  showContextBanner(msg.pct, "trimmed");
});

onStreamEvent("context_handoff_suggested", (msg) => {
  // Auto-trigger by default so the dumb-zone rotation actually happens.
  // Banner is still shown for visibility and to let the user dismiss.
  showHandoffBanner(msg.pct, { autoTrigger: true });
});

onStreamEvent("handoff_written", (msg) => {
  showHandoffResult(msg.ok, msg);
});

onStreamEvent("context_summarized", (msg) => {
  dismissContextBanner();
  if (!msg.ok) {
    addMessage("ai", t("ctx_summarize_failed", { reason: msg.reason }));
  } else {
    window.resetContextBar?.(maxCtx);
    const note = document.createElement("div");
    note.className = "ctx-banner ctx-banner--trimmed";
    note.style.cssText = "font-size:10px;opacity:0.75;";
    const text = msg.saved ? t("ctx_summarize_ok") : t("ctx_summarize_no_save");
    note.innerHTML = `<span class="ctx-banner-text">${text}</span>` +
      `<button class="ctx-banner-btn" data-action="removeParent">${t("ctx_dismiss")}</button>`;
    document.querySelector(".chat-area")?.prepend(note);
  }
});

onStreamEvent("suggestions_saved", (msg) => {
  const note = document.createElement("div");
  note.className = "suggestions-saved-note";
  note.textContent = msg.saved === 1 ? t("ctx_suggestions_saved_one") : t("ctx_suggestions_saved_many", { n: msg.saved });
  document.querySelector(".chat-area")?.appendChild(note);
  setTimeout(() => note.remove(), 3000);
});

onStreamEvent("session_resumed", (msg) => {
  handleSessionResumed(msg);
});

onStreamEvent("session_branched", (msg) => {
  if (!msg.ok) { addMessage("ai", "Couldn't branch — not enough conversation yet."); return; }
  const banner = document.createElement("div");
  banner.className = "ctx-banner";
  banner.innerHTML =
    `<span class="ctx-banner-text">${t("branch_created") || "↳ Branched:"} ${msg.title || ""}</span>` +
      `<button class="ctx-banner-btn" data-action="removeParent">${t("ctx_dismiss")}</button>`;
  document.querySelector(".chat-area")?.prepend(banner);
  document.getElementById("messages").innerHTML = "";
});
