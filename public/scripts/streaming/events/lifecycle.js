// public/scripts/streaming/events/lifecycle.js
// Provider/model/startup lifecycle: what the agent is, what it is loading, and
// the host-level state (allowed paths, background jobs) around it.

// Initial connection ack — nothing to render, but the type is claimed so the
// router's coverage check treats it as handled rather than unknown.
onStreamEvent("status", () => {});

onStreamEvent("startup_breakdown", (msg) => {
  _startupBreakdown = msg;
  // Show the banner at startup (not after the first message) — the breakdown
  // carries server-side estimates for every startup component, so we don't need
  // to wait for a real provider token count.
  _maybeShowStartupBanner();
  _syncStartupContextBar();
});

onStreamEvent("provider", (msg) => {
  document.getElementById("startup-thinking")?.remove();
  // Track provider for cost display.
  if (typeof setCostProvider === "function") setCostProvider(msg.name, msg.model, msg.costRates, msg.local, msg.subscription);
  // Round-table: cache agent list and toggle the Discuss button accordingly.
  // Sparse re-announces (llamacpp mid-turn ctx grow, model switch) omit the
  // roundtable fields entirely — absence means "no change", not "disable".
  if (Array.isArray(msg.agents)) _roundtableAgents = msg.agents;
  if ("roundtableAvailable" in msg && typeof window.applyRoundtableAvailability === "function") {
    window.applyRoundtableAvailability(Boolean(msg.roundtableAvailable), msg.roundtableReason);
  }
  const badge = document.getElementById("providerBadge");
  if (badge) {
    const isLlamaCpp = msg.name === "llamacpp";
    const isDeepSeek = msg.name === "deepseek";
    let label;
    if (isLlamaCpp) {
      label = `⬡ ${shortModelName(msg.model)}`;
    } else if (isDeepSeek) {
      label = `◈ ${msg.model}`;
    } else {
      const m = msg.model;
      label = `✦ ${m.includes("haiku") ? "haiku" : m.includes("sonnet") ? "sonnet" : m.includes("opus") ? "opus" : m}`;
    }
    badge.textContent = label;
    badge.className = "model-chip-name " +
      (isLlamaCpp ? "model-chip-name--llamacpp" :
       isDeepSeek ? "model-chip-name--deepseek" : "model-chip-name--cloud");
    badge.style.display = "";
    const chip = document.getElementById("modelChip");
    if (chip) {
      chip.classList.add("has-model");
      chip.title = `${msg.name} — ${msg.model}`;
      // From here on the label is the written state word (connected / busy /
      // disconnected), not the free-form boot text. Drop the boot-time
      // data-i18n hook so a late locale load can't stomp the live word back
      // to "connecting…".
      document.getElementById("statusText")?.removeAttribute("data-i18n");
      window.syncChipStateLabel?.();
    }
  }

  // Sync the model selector with the confirmed provider/model.
  if (typeof window.syncModelSelection === "function") {
    window.syncModelSelection(msg.name, msg.model);
  }

  _modelThinks = !!msg.thinks;
  const toggle = document.getElementById("reasoningToggle");
  if (toggle) toggle.style.display = msg.thinks ? "flex" : "none";

  if (msg.contextWindow) maxCtx = msg.contextWindow;
  // Sparse re-announces (llamacpp mid-turn ctx grow) omit this key entirely —
  // absence means "no change", not "unknown, clear it". A boot/switch_model
  // message always includes the key (possibly with value null for a genuinely
  // non-local provider), so presence still lets that case clear it correctly.
  if ("contextCapacityPct" in msg) {
    window.maxCtxCapacityPct = (typeof msg.contextCapacityPct === "number") ? msg.contextCapacityPct : null;
  }
  if (typeof msg.imageTokens === "number") _imageTokenCost = msg.imageTokens;
  // These two boot events may arrive in either order. Re-sync once capacity
  // is known so the navbar can render both sides of the estimate.
  _syncStartupContextBar();
});

onStreamEvent("model_status", (msg) => {
  // Staged label while llama.cpp downloads/loads a model inside the current
  // request (issue A/B): the whimsy rotator yields to any non-whimsy label,
  // so writing here pins the stage text until "ready" hands the label back.
  const short = shortModelName(msg.model);
  let text = null;
  if (msg.status === "downloading") {
    text = msg.totalGB
      ? t("status_model_downloading_of", { model: short, got: msg.gotGB, total: msg.totalGB, pct: Math.min(99, Math.round((msg.gotGB / msg.totalGB) * 100)) })
      : t("status_model_downloading", { model: short, got: msg.gotGB });
  } else if (msg.status === "loading") {
    text = t("status_model_loading", { model: short });
  } else if (msg.status === "ready") {
    text = t("chat_thinking_label"); // whimsy resumes from here
  }
  if (text) {
    const label = document.querySelector("#thinking .thinking-label");
    if (label) {
      // Mid-request load: pin the stage onto the live thinking indicator.
      // A boot-preload banner may still be up if the user sent a message
      // mid-download — the label now owns the stage, so drop the banner.
      dismissModelLoadingBanner();
      label.textContent = text;
      moveLiveIndicatorToBottom();
      if (msg.status !== "ready") setStatus("thinking", text);
    } else if (msg.status === "ready") {
      // Boot preload finished with no request in flight — clear the banner.
      dismissModelLoadingBanner();
    } else {
      // No request in flight (boot preload, helpers/modelPreload.js): the
      // chat looks idle/ready, so surface the wait as the standalone banner
      // rendering.js provides instead of a thinking label that isn't there.
      showModelLoadingBanner(msg.status, text);
    }
  }
});

onStreamEvent("paths_updated", (msg) => {
  if (typeof notifyPathsChanged === "function") notifyPathsChanged(msg.paths);
});

onStreamEvent("agent_job_done", (msg) => {
  if (typeof showAgentJobBanner === "function") showAgentJobBanner(msg);
  if (typeof window.refreshAgentsPanelIfOpen === "function") window.refreshAgentsPanelIfOpen();
});
