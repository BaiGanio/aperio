// ── Streaming state ───────────────────────────────────────────
let reasoningBubble = null;
let reasoningText = "";
let streamingBubble = null;
let streamingText = "";
let streamStartTime = null;
// Request-scoped wall-clock: spans the WHOLE user turn (send → final answer),
// surviving the per-tool stream_end/stream_start cycles, so the live "#thinking"
// timer keeps counting through the "reading result…" gap between turns.
let requestStartTime = null;
let _liveTimerId = null;
let isReasoningActive = false;
let suggestionShown = false;
let accThinkingTokens = 0;
let accOutputTokens = 0;
let lastUserMsgWrap = null;
let lastReasoningWrapForTok = null;
let prevInputTokens = 0;
let startupBannerShown = false;
let pendingUserTokenEstimate = 0;
let _preloadToolCount = 0;
let _startupBreakdown = null;
// Whether the active model surfaces reasoning. Non-thinking models must not leave
// a "thinking…" breadcrumb behind — it reads as if the model were still working.
let _modelThinks = false;
// Round-table state. _nextBubbleAgent is set on stream_start and consumed by
// createStreamingBubble() so the bubble is styled with the right agent colour.
// _roundtableAgents is populated from the `provider` event for badge labels.
let _nextBubbleAgent = null;
let _roundtableAgents = [];
let _roundtablePhaseChip = null;
const _pendingGeneratedFiles = [];
// Live tool-activity cards, keyed by the backend `seq` so a tool_result can
// find the card its tool_start created.
const _toolCards = new Map();

// ── Persistent action feed ──────────────────────────────────────────────────
// The live "thinking…/typing…" dots bubble (#thinking) is a single moving
// cursor. To make the sequence of steps trackable, we leave a dim, persistent
// breadcrumb behind each completed reasoning phase and keep that live cursor
// pinned to the bottom of the feed (below any tool cards) instead of letting it
// strand above them with a self-replacing label.
let _lastPhase = null;
// True when the active "thinking" phase already produced a visible reasoning
// bubble — that bubble is the persistent record, so we skip the breadcrumb.
let _phaseHadReasoning = false;

function dropPhaseBreadcrumb(text) {
  const line = document.createElement("div");
  line.className = "action-phase done";
  line.innerHTML =
    `<span class="action-phase-mark"></span>` +
    `<span class="action-phase-label">${escapeHtml(text)}</span>`;
  const live = document.getElementById("thinking");
  if (live) messagesEl.insertBefore(line, live);
  else messagesEl.appendChild(line);
}

// Keep the live indicator as the last element so it reads as "what's happening
// now" beneath the completed steps.
function moveLiveIndicatorToBottom() {
  const live = document.getElementById("thinking");
  if (live && live !== messagesEl.lastElementChild) messagesEl.appendChild(live);
}

// Record a phase transition. Leaves a breadcrumb when a "thinking" phase gives
// way to tools or the answer, unless that thinking was already surfaced as a
// reasoning bubble.
function enterPhase(kind) {
  if (kind === "thinking") _phaseHadReasoning = false;
  if (_lastPhase === "thinking" && kind !== "thinking" && !_phaseHadReasoning && _modelThinks) {
    dropPhaseBreadcrumb(t("status_thinking"));
  }
  // "reading result…" is shown only on the live pill while the model digests a
  // tool result; it must NOT leave a breadcrumb — once the model is done reading
  // and moves on, the label disappears with the live pill rather than littering
  // the transcript with stale "reading result…" lines.
  _lastPhase = kind;
}

function estimateTokens(text) {
  if (!text || !text.trim()) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

// Per-image vision-token cost. Every upload is normalised to a fixed 896×896
// PNG before reaching the model, so the cost is constant per provider — the
// server reports the active provider's figure in the `provider` event (see
// lib/helpers/imageTokens.js). Falls back to the Anthropic-style estimate until
// that event arrives.
let _imageTokenCost = Math.round((896 * 896) / 750); // ≈ 1070

// A user message's attachments are not free: images cost vision tokens and
// files are injected as extracted text. Estimate that cost so the per-message
// token chip reflects the real upload, not just the typed prompt.
function estimateAttachmentTokens(att) {
  if (!att) return 0;
  if (att.type && att.type.startsWith("image/")) return _imageTokenCost;

  // Restored-session files carry a server-computed token figure (the client has
  // no file data to recompute from).
  if (typeof att.tokens === "number") return att.tokens;

  // Live upload: for text/code files the raw bytes ARE the model's text, so
  // decode and apply the same char/4 heuristic used for chat text.
  const dataUrl = att.dataUrl || (att.data ? `data:;base64,${att.data}` : null);
  if (!dataUrl) return 0;
  try {
    const base64 = dataUrl.split(",")[1] || "";
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return estimateTokens(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return 0;
  }
}

function setUserTokenEstimate(n) { pendingUserTokenEstimate = n; }

function handleMessage(msg) {
  if (msg.type === "status") {
    // initial connection ack
  }

  if (msg.type === "startup_breakdown") {
    _startupBreakdown = msg;
    // Show the banner at startup (not after the first message) — the breakdown
    // carries server-side estimates for every startup component, so we don't need
    // to wait for a real provider token count.
    _maybeShowStartupBanner();
  }

  if (msg.type === "tool_count") {
    _preloadToolCount = msg.count ?? 0;
    const badge = document.getElementById("toolCountBadge");
    if (badge) {
      if (_preloadToolCount > 0) {
        badge.textContent = `${_preloadToolCount}t`;
        badge.style.display = "inline";
        badge.title = `${_preloadToolCount} tool${_preloadToolCount === 1 ? "" : "s"} loaded`;
      } else {
        badge.style.display = "none";
      }
    }
  }

  if (msg.type === "provider") {
    document.getElementById("startup-thinking")?.remove();
    // Round-table: cache agent list and toggle the Discuss button accordingly.
    if (Array.isArray(msg.agents)) _roundtableAgents = msg.agents;
    if (typeof window.applyRoundtableAvailability === "function") {
      window.applyRoundtableAvailability(Boolean(msg.roundtableAvailable));
    }
    if (msg.toolCount !== undefined) {
      _preloadToolCount = msg.toolCount;
      const toolBadge = document.getElementById("toolCountBadge");
      if (toolBadge) {
        if (_preloadToolCount > 0) {
          toolBadge.textContent = `${_preloadToolCount}t`;
          toolBadge.style.display = "inline";
          toolBadge.title = `${_preloadToolCount} tool${_preloadToolCount === 1 ? "" : "s"} loaded`;
        } else {
          toolBadge.style.display = "none";
        }
      }
    }
    const badge = document.getElementById("providerBadge");
    if (badge) {
      const isOllama   = msg.name === "ollama";
      const isDeepSeek = msg.name === "deepseek";
      let label;
      if (isOllama) {
        label = `⬡ ${msg.model}`;
      } else if (isDeepSeek) {
        label = `◈ ${msg.model}`;
      } else {
        const m = msg.model;
        label = `✦ ${m.includes("haiku") ? "haiku" : m.includes("sonnet") ? "sonnet" : m.includes("opus") ? "opus" : m}`;
      }
      badge.textContent = label;
      badge.title = `${msg.name} — ${msg.model}`;
      badge.style.display = "inline";
      badge.style.background = isOllama   ? "rgba(34,197,94,.15)"  :
                               isDeepSeek ? "rgba(59,130,246,.15)"  : "var(--accent-soft)";
      badge.style.color      = isOllama   ? "#22c55e"               :
                               isDeepSeek ? "#3b82f6"               : "var(--accent)";
    }

    // Sync the model selector with the confirmed provider/model.
    if (typeof window.syncModelSelection === "function") {
      window.syncModelSelection(msg.name, msg.model);
    }

    _modelThinks = !!msg.thinks;
    const toggle = document.getElementById("reasoningToggle");
    if (toggle) toggle.style.display = msg.thinks ? "flex" : "none";

    if (msg.contextWindow) maxCtx = msg.contextWindow;
    if (typeof msg.imageTokens === "number") _imageTokenCost = msg.imageTokens;
  }

  if (msg.type === "paths_updated") {
    if (typeof notifyPathsChanged === "function") notifyPathsChanged(msg.paths);
  }

  if (msg.type === "agent_job_done") {
    if (typeof showAgentJobBanner === "function") showAgentJobBanner(msg);
    if (typeof window.refreshAgentsPanelIfOpen === "function") window.refreshAgentsPanelIfOpen();
  }

  if (msg.type === "thinking") {
    suggestionShown = false;
    enterPhase("thinking");
    setStatus("thinking", t("status_thinking"));
    sendBtn.disabled = true;
    if (!document.getElementById("thinking")) addThinking();
  }

  if (msg.type === "tool") {
    removeToolIndicator();
    // A tool call means the agent is actively working. The preceding
    // stream_end (sent before tool execution) flips the UI to an idle
    // "connected" state and re-enables the send button — so re-assert the
    // working state here, and recreate the thinking indicator if it was torn
    // down, otherwise the user sees an idle screen while scripts run.
    isThinking = true;
    sendBtn.disabled = true;
    sendBtn.style.display = "none";
    stopBtn.style.display = "flex";
    enterPhase("tool");
    if (!document.getElementById("thinking")) addThinking();
    const key = TOOL_LABEL_KEYS && TOOL_LABEL_KEYS[msg.name];
    const labelText = key ? t(key) : t("tool_generic", { name: msg.name });
    const label = document.querySelector("#thinking .thinking-label");
    if (label) label.textContent = labelText;
    moveLiveIndicatorToBottom();
    setStatus("thinking", labelText);
  }

  if (msg.type === "reasoning_start") {
    isReasoningActive = true;
    _phaseHadReasoning = true;
    document.getElementById("preparing-answer")?.remove();
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = t("msg_reasoning_done");
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
      reasoningText = "";
    }
    if (localStorage.getItem("aperio-reasoning") === "false") return;
    removeThinking();
    removeToolIndicator();
    reasoningText = "";
    const wrap = document.createElement("div");
    wrap.className = "reasoning-wrap";
    const details = document.createElement("details");
    details.setAttribute("open", "");
    const summary = document.createElement("summary");
    const statusSpan = document.createElement("span");
    statusSpan.style.cssText = "font-size:10px;opacity:0.5;animation:labelFade 1.8s ease infinite";
    statusSpan.textContent = t("chat_thinking_label");
    summary.appendChild(document.createTextNode(t("msg_reasoning_header") + " "));
    summary.appendChild(statusSpan);
    const pre = document.createElement("pre");
    details.appendChild(summary);
    details.appendChild(pre);
    const bubble = document.createElement("div");
    bubble.className = "reasoning-bubble";
    bubble.appendChild(details);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    reasoningBubble = { wrap, pre, details, statusSpan, bubble };
    return;
  }

  if (msg.type === "reasoning_token") {
    if (reasoningBubble && msg.text) {
      reasoningText += msg.text;
      reasoningBubble.pre.textContent = reasoningText;
      reasoningBubble.pre.scrollTop = reasoningBubble.pre.scrollHeight;
      scrollToBottom();
    }
    return;
  }

  if (msg.type === "reasoning_done") {
    isReasoningActive = false;
    const SHORT_THRESHOLD = 280;
    function reasoningTitle(text) {
      const first = text.split(/[.!?\n]/)[0].trim();
      return first.length > 58 ? first.slice(0, 55) + "…" : (first || t("msg_reasoning_header"));
    }
    if (reasoningBubble) {
      if (reasoningText.length <= SHORT_THRESHOLD) {
        const flat = document.createElement("div");
        flat.className = "reasoning-flat";
        const lbl = document.createElement("span");
        lbl.className = "reasoning-flat-label";
        lbl.textContent = t("msg_reasoning_flat");
        flat.appendChild(lbl);
        flat.appendChild(reasoningBubble.pre);
        reasoningBubble.bubble.replaceChild(flat, reasoningBubble.details);
      } else {
        const title = reasoningTitle(reasoningText);
        const summary = reasoningBubble.details.querySelector("summary");
        summary.firstChild.textContent = "🧠 " + title + " ";
        reasoningBubble.details.removeAttribute("open");
        reasoningBubble.statusSpan.textContent = t("msg_reasoning_done");
        reasoningBubble.statusSpan.style.animation = "none";
        reasoningBubble.statusSpan.style.opacity = "0.4";
      }
      lastReasoningWrapForTok = reasoningBubble.wrap;
      reasoningBubble = null;
    }
    const lastWrap = [...messagesEl.querySelectorAll(".reasoning-wrap")].at(-1);
    if (!lastReasoningWrapForTok) lastReasoningWrapForTok = lastWrap || null;
    if (lastWrap) {
      const details = lastWrap.querySelector("details");
      const span = lastWrap.querySelector(".reasoning-bubble summary span");
      if (details) details.removeAttribute("open");
      if (span) { span.textContent = t("msg_reasoning_done"); span.style.animation = "none"; span.style.opacity = "0.4"; }
    }
    reasoningText = "";
    removeThinking();
    document.getElementById("preparing-answer")?.remove();
    const prep = document.createElement("div");
    prep.id = "preparing-answer";
    prep.style.cssText = "padding:6px 0 0 38px;font-size:11px;font-family:var(--font-mono);color:var(--text-muted);opacity:0.6;animation:labelFade 1.8s ease infinite";
    prep.textContent = t("msg_preparing_answer");
    messagesEl.appendChild(prep);
    scrollToBottom();
    return;
  }

  if (msg.type === "stream_start") {
    streamStartTime = Date.now();
    isReasoningActive = false;
    isThinking = true;
    sendBtn.disabled = true;
    sendBtn.style.display = "none";
    stopBtn.style.display = "flex";
    if (streamingBubble) {
      if (streamingText.trim()) {
        finalizeStreamingBubble(streamingBubble, streamingText, null);
      } else {
        streamingBubble.wrap?.remove();
      }
      streamingBubble = null;
      streamingText = "";
    }
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = t("msg_reasoning_done");
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
    }
    // Don't promise "typing…" yet: the model has only *started* generating, and
    // this turn may yet be a tool call that prints nothing visible. The live
    // line stays "thinking…" until the first real token arrives (see `token`),
    // so the label never blinks "typing…" over an empty screen.
    // Round-table: tag the next streaming bubble with the agent that owns it.
    // Stored on a module-level var so the lazy `createStreamingBubble()` call
    // from the first `token` event picks up the right persona styling.
    _nextBubbleAgent = msg.agent_id ? { agentId: msg.agent_id, persona: msg.persona ?? msg.agent_id } : null;
  }

  if (msg.type === "token") {
    if (msg.text) {
      const reasoningOn = localStorage.getItem("aperio-reasoning") !== "false";
      if (isReasoningActive && reasoningOn) return;
      if (!streamingBubble) {
        // First visible token of the answer — now "typing" is true. Mark the
        // phase (drops the "thinking…" breadcrumb) and flip the header, then
        // tear down the live line; the streaming text itself is the indicator.
        enterPhase("typing");
        setStatus("thinking", t("status_typing"));
        removeThinking();
        removeToolIndicator();
        document.getElementById("preparing-answer")?.remove();
        streamingBubble = createStreamingBubble(_nextBubbleAgent);
      }
      streamingText += msg.text;
      _scheduleStreamRender();
    }
  }

  if (msg.type === "retract") {
    if (streamingBubble) {
      streamingBubble.wrap?.remove();
      streamingBubble = null;
      streamingText = "";
    }
    const lastAI = [...messagesEl.querySelectorAll('.message.ai')].at(-1);
    if (lastAI) {
      const bubble = lastAI.querySelector('.bubble');
      const text = bubble?.textContent || "";
      if (text.trim().startsWith("{") || text.includes('"name"')) lastAI.remove();
    }
    return;
  }

  if (msg.type === "stream_end") {
    const elapsedSec = streamStartTime ? (Date.now() - streamStartTime) / 1000 : null;
    streamStartTime = null;
    // NB: this stream_end may be the inter-tool one (sent before a tool runs),
    // not the end of the turn — so the live request timer is only stopped in the
    // terminal branches below (a real answer), not here.
    for (const c of _toolCards.values()) {
      if (c._timerId) { clearInterval(c._timerId); c._timerId = null; }
    }
    accThinkingTokens += msg.usage?.thinking_tokens ?? 0;
    accOutputTokens += msg.usage?.output_tokens ?? 0;
    const responseStats = (elapsedSec && msg.usage?.output_tokens)
      ? { outputTokens: accOutputTokens, thinkingTokens: accThinkingTokens, elapsedSec, inputTokens: msg.usage?.input_tokens ?? 0 }
      : null;
    if (streamingBubble && streamingText.trim()) {
      stopLiveTimer();
      finalizeStreamingBubble(streamingBubble, streamingText, responseStats);
      for (const f of _pendingGeneratedFiles) streamingBubble.bubble.appendChild(_buildGeneratedFileCard(f)); _pendingGeneratedFiles.length = 0;
      window.Aperio?.tts?.speak(streamingText);
      window.Aperio?.voice?.onStreamEnd?.();
      _refineStartupBanner(msg.usage?.input_tokens);
      _annotateTokenBadges(msg.usage?.input_tokens, accThinkingTokens);
      accThinkingTokens = 0; accOutputTokens = 0;
    } else if (streamingBubble) {
      streamingBubble.wrap?.remove();
    } else if (!streamingText && msg.text?.trim()) {
      stopLiveTimer();
      removeThinking();
      removeToolIndicator();
      addMessage("ai", msg.text);
      window.Aperio?.tts?.speak(msg.text);
      window.Aperio?.voice?.onStreamEnd?.();
      _refineStartupBanner(msg.usage?.input_tokens);
      _annotateTokenBadges(msg.usage?.input_tokens, accThinkingTokens);
      accThinkingTokens = 0; accOutputTokens = 0;
    }
    // Fallback: if the card is still pending (e.g. no streaming text), attach to last AI bubble
    if (_pendingGeneratedFiles.length) {
      const lastBubble = [...messagesEl.querySelectorAll(".message.ai .bubble")].at(-1);
      for (const f of _pendingGeneratedFiles) {
        if (lastBubble) lastBubble.appendChild(_buildGeneratedFileCard(f));
        else messagesEl.appendChild(_buildGeneratedFileCard(f));
      }
      _pendingGeneratedFiles.length = 0;
    }
    document.getElementById("preparing-answer")?.remove();
    streamingBubble = null;
    streamingText = "";
    isThinking = false;
    setStatus("connected", t("status_connected"));
    sendBtn.disabled = chatInput.value.trim() === "";
    sendBtn.style.display = "";
    stopBtn.style.display = "none";
    scrollToBottom();
    if (msg.usage) {
      updateContextBar(msg.usage.input_tokens ?? 0, maxCtx, msg.usage.output_tokens ?? 0);
    }
  }

  if (msg.type === "context_warning") {
    showContextBanner(msg.pct, "warning");
  }

  if (msg.type === "context_trimmed") {
    showContextBanner(msg.pct, "trimmed");
  }

  if (msg.type === "context_handoff_suggested") {
    // Auto-trigger by default so the dumb-zone rotation actually happens.
    // Banner is still shown for visibility and to let the user dismiss.
    showHandoffBanner(msg.pct, { autoTrigger: true });
  }

  if (msg.type === "handoff_written") {
    showHandoffResult(msg.ok, msg);
  }

  if (msg.type === "context_summarized") {
    dismissContextBanner();
    if (!msg.ok) {
      addMessage("ai", t("ctx_summarize_failed", { reason: msg.reason }));
    } else {
      const note = document.createElement("div");
      note.className = "ctx-banner ctx-banner--trimmed";
      note.style.cssText = "font-size:10px;opacity:0.75;";
      const text = msg.saved ? t("ctx_summarize_ok") : t("ctx_summarize_no_save");
      note.innerHTML = `<span class="ctx-banner-text">${text}</span>` +
        `<button class="ctx-banner-btn" onclick="this.parentElement.remove()">${t("ctx_dismiss")}</button>`;
      document.querySelector(".chat-area")?.prepend(note);
    }
  }

  if (msg.type === "suggestions_saved") {
    const note = document.createElement("div");
    note.className = "suggestions-saved-note";
    note.textContent = msg.saved === 1 ? t("ctx_suggestions_saved_one") : t("ctx_suggestions_saved_many", { n: msg.saved });
    document.querySelector(".chat-area")?.appendChild(note);
    setTimeout(() => note.remove(), 3000);
  }

  if (msg.type === "session_resumed") {
    handleSessionResumed(msg);
  }

  if (msg.type === "memories") {
    renderMemoriesFromMessage(msg.memories);
  }

  if (msg.type === "deleted") {
    allMemories = allMemories.filter(m => m.id !== msg.id);
    renderMemories(allMemories);
  }

  if (msg.type === "recall_result") {
    const items = _parseRecallText(msg.text);
    if (items.length) _renderRecallPill(items);
    return;
  }

  if (msg.type === "ttl_chip") {
    _renderTtlChip(msg);
    return;
  }

  if (msg.type === "skills_matched") {
    if (msg.skills?.length) _renderSkillsChip(msg.skills);
    return;
  }

  if (msg.type === "tool_start") {
    _renderToolCard(msg);
    return;
  }

  if (msg.type === "tool_result") {
    _resolveToolCard(msg);
    return;
  }

  if (msg.type === "delete_confirm_pending") {
    _renderDeleteConfirmButton(msg.token, msg.path);
    return;
  }

  if (msg.type === "action_confirm_pending") {
    _renderActionConfirmButton(msg.token, msg.label, msg.summary, msg.tool);
    return;
  }

  if (msg.type === "generated_file") {
    // The server emits these only after the final answer has streamed, so the
    // answer bubble already exists — attach the download card straight to it.
    // If a bubble is still streaming, keep it pending so stream_end attaches it.
    if (streamingBubble) { _pendingGeneratedFiles.push(msg); return; }
    // Otherwise the answer is already rendered: attach to it, or — if the answer
    // was empty so no bubble exists — stand the card up on its own.
    const lastBubble = [...messagesEl.querySelectorAll(".message.ai .bubble")].at(-1);
    if (lastBubble) lastBubble.appendChild(_buildGeneratedFileCard(msg));
    else messagesEl.appendChild(_buildGeneratedFileCard(msg));
    scrollToBottom();
    return;
  }

  if (msg.type === "no_tool_use_detected") {
    _renderNoToolWarning(msg.model);
    return;
  }

  if (msg.type === "error") {
    removeThinking();
    removeToolIndicator();
    stopLiveTimer();
    isThinking = false;
    setStatus("connected", "error");
    sendBtn.disabled = chatInput.value.trim() === "";
    sendBtn.style.display = "";
    stopBtn.style.display = "none";
    addMessage("ai", `⚠️ ${msg.text}`);
  }

  // ── Round-table events ────────────────────────────────────────────────────
  if (msg.type === "roundtable_phase") {
    _renderRoundtablePhaseChip(msg.phase, msg.agent_id);
    return;
  }

  if (msg.type === "roundtable_agreed") {
    _renderConsensusBubble(msg);
    return;
  }

  if (msg.type === "roundtable_no_agreement") {
    _renderNoAgreementCard(msg);
    return;
  }

  if (msg.type === "roundtable_error") {
    _renderRoundtableErrorCard(msg);
    return;
  }
}

function _phaseAction(phase) {
  if (phase === "review")   return t("roundtable_phase_review");
  if (phase === "revise")   return t("roundtable_phase_revise");
  if (phase === "rereview") return t("roundtable_phase_rereview");
  if (phase === "answer")   return t("roundtable_phase_answer");
  return phase || "";
}

function _agentModelLabel(agentId) {
  const a = _roundtableAgents.find(x => x.id === agentId);
  if (!a) return agentId === "verifier" ? "β" : "α";
  if (a.model) return a.model;
  return a.name || agentId;
}

function _renderRoundtablePhaseChip(phase, agentId) {
  _roundtablePhaseChip?.remove();
  const chip = document.createElement("div");
  chip.className = "roundtable-phase-chip is-active";
  if (agentId) chip.classList.add(`roundtable-phase-${agentId}`);

  const badge = document.createElement("span");
  badge.className = `roundtable-agent-badge roundtable-agent-${agentId || "primary"}`;
  badge.textContent = agentId === "verifier" ? "β" : "α";

  const spinner = document.createElement("span");
  spinner.className = "roundtable-phase-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "roundtable-phase-text";
  text.textContent = t("roundtable_phase_status", {
    model:  _agentModelLabel(agentId),
    action: _phaseAction(phase),
  });

  chip.append(badge, spinner, text);
  messagesEl.appendChild(chip);
  _roundtablePhaseChip = chip;
  scrollToBottom();
}

function _clearRoundtablePhaseChip() {
  _roundtablePhaseChip?.remove();
  _roundtablePhaseChip = null;
}

function _renderConsensusBubble(msg) {
  _clearRoundtablePhaseChip();
  if (streamingBubble) {
    if (streamingText.trim()) finalizeStreamingBubble(streamingBubble, streamingText, null);
    else streamingBubble.wrap?.remove();
    streamingBubble = null;
    streamingText = "";
  }
  const wrap = document.createElement("div");
  wrap.className = "message ai roundtable-consensus";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  avatar.textContent = "✓";
  avatar.title = t("roundtable_consensus_label");

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

  const header = document.createElement("div");
  header.className = "roundtable-consensus-header";
  const pill = document.createElement("span");
  pill.className = "roundtable-consensus-pill";
  pill.textContent = t("roundtable_consensus_label");
  header.appendChild(pill);
  (msg.agents || _roundtableAgents).forEach(a => {
    const wrap = document.createElement("span");
    wrap.className = "roundtable-agent-chip";
    const badge = document.createElement("span");
    badge.className = `roundtable-agent-badge roundtable-agent-${a.id || a}`;
    badge.textContent = (a.id === "verifier" ? "β" : "α");
    const label = a.model ? `${a.name} · ${a.model}` : (a.name || a.id || a);
    badge.title = label;
    wrap.appendChild(badge);
    if (a.model || a.name) {
      const tag = document.createElement("span");
      tag.className = "roundtable-agent-chip-label";
      tag.textContent = label;
      wrap.appendChild(tag);
    }
    header.appendChild(wrap);
  });
  col.appendChild(header);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdown(msg.text || "");
  col.appendChild(bubble);

  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  highlightAll?.();
  scrollToBottom();
}

function _renderNoAgreementCard(msg) {
  _clearRoundtablePhaseChip();
  if (streamingBubble) {
    if (streamingText.trim()) finalizeStreamingBubble(streamingBubble, streamingText, null);
    else streamingBubble.wrap?.remove();
    streamingBubble = null;
    streamingText = "";
  }
  const wrap = document.createElement("div");
  wrap.className = "message ai roundtable-no-consensus-wrap";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  avatar.textContent = "A";
  avatar.title = "Aperio";

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

  const card = document.createElement("div");
  card.className = "roundtable-no-consensus";

  const primary = _findAgent("primary");
  const attribution = document.createElement("div");
  attribution.className = "roundtable-no-consensus-attribution";
  const primaryLabel = primary
    ? (primary.model ? `${primary.name} · ${primary.model}` : (primary.name || "Aperio"))
    : "Aperio";
  attribution.textContent = t("roundtable_no_consensus_attribution", { model: primaryLabel });
  card.appendChild(attribution);

  const banner = document.createElement("div");
  banner.className = "roundtable-no-consensus-banner";
  banner.textContent = t("roundtable_no_consensus_banner", { n: msg.rounds ?? "" });
  card.appendChild(banner);

  const cols = document.createElement("div");
  cols.className = "roundtable-no-consensus-cols";
  (msg.positions || []).forEach(pos => {
    const colEl = document.createElement("div");
    colEl.className = `roundtable-no-consensus-col roundtable-no-consensus-${pos.agent_id}`;
    const title = document.createElement("div");
    title.className = "roundtable-no-consensus-title";
    title.textContent = pos.agent_id === "verifier" ? t("roundtable_position_b") : t("roundtable_position_a");
    colEl.appendChild(title);
    const body = document.createElement("div");
    body.className = "roundtable-no-consensus-body";
    body.innerHTML = renderMarkdown(pos.text || "");
    colEl.appendChild(body);
    cols.appendChild(colEl);
  });
  card.appendChild(cols);

  col.appendChild(card);
  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  highlightAll?.();
  scrollToBottom();
}

function _renderRoundtableErrorCard(msg) {
  _clearRoundtablePhaseChip();
  if (streamingBubble) {
    if (streamingText.trim()) finalizeStreamingBubble(streamingBubble, streamingText, null);
    else streamingBubble.wrap?.remove();
    streamingBubble = null;
    streamingText = "";
  }
  const wrap = document.createElement("div");
  wrap.className = "message ai roundtable-no-consensus-wrap";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  avatar.textContent = "A";
  avatar.title = "Aperio";

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

  const card = document.createElement("div");
  card.className = "roundtable-error-card";

  const agentLabel = msg.agent_id === "verifier" ? "β" : "α";
  const agent = _findAgent(msg.agent_id);
  const modelLabel = agent
    ? (agent.model ? `${agent.name} · ${agent.model}` : (agent.name || agentLabel))
    : agentLabel;

  const title = document.createElement("div");
  title.className = "roundtable-error-title";
  title.textContent = t("roundtable_error_title", { agent: agentLabel, model: modelLabel, phase: _phaseAction(msg.phase) });
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "roundtable-error-body";
  body.textContent = msg.message || "";
  card.appendChild(body);

  col.appendChild(card);
  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function createStreamingBubble(agentMeta = null) {
  const wrap = document.createElement("div");
  wrap.className = "message ai";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  // Round-table avatars: "α" for primary, "β" for verifier. Single-agent path
  // keeps the default "A" Aperio mark.
  let avatarLetter = "A";
  if (agentMeta?.agentId === "primary" || agentMeta?.persona === "primary") avatarLetter = "α";
  if (agentMeta?.persona === "verifier" || agentMeta?.agentId === "verifier") avatarLetter = "β";
  avatar.textContent = avatarLetter;

  if (agentMeta?.agentId) {
    wrap.classList.add(`message-agent-${agentMeta.agentId}`);
    avatar.classList.add(`avatar-agent-${agentMeta.agentId}`);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble streaming";
  bubble.innerHTML = '<span class="cursor">▋</span>';

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

  // Round-table only: small inline header above the bubble showing the agent's
  // provider and model so users can tell A and B apart without hovering the
  // avatar. Falls back silently if the provider event hasn't populated
  // `_roundtableAgents` yet (single-agent chats render no tag).
  const tag = _buildRoundtableAgentTag(agentMeta);
  if (tag) col.appendChild(tag);

  col.appendChild(bubble);

  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return { wrap, bubble, col, agentMeta };
}

function _findAgent(agentId) {
  if (!agentId) return null;
  return _roundtableAgents.find(a => a?.id === agentId) || null;
}

function _buildRoundtableAgentTag(agentMeta) {
  if (!agentMeta?.agentId) return null;
  const agent = _findAgent(agentMeta.agentId);
  if (!agent) return null;
  const tag = document.createElement("div");
  tag.className = `roundtable-agent-tag roundtable-agent-tag-${agentMeta.agentId}`;
  const letter = agentMeta.agentId === "verifier" ? "β" : "α";
  const label = agent.model ? `${agent.name} · ${agent.model}` : (agent.name || letter);
  tag.textContent = label;
  tag.title = label;
  return tag;
}

// Tokens can arrive faster than the browser can paint. Re-rendering the whole
// growing message on every token is O(n²) and freezes the tab on long outputs
// (e.g. a streamed HTML page). Coalesce into at most one render per frame.
let _streamRenderScheduled = false;
function _scheduleStreamRender() {
  if (_streamRenderScheduled) return;
  _streamRenderScheduled = true;
  requestAnimationFrame(() => {
    _streamRenderScheduled = false;
    if (!streamingBubble) return;   // finalized/torn down before this frame ran
    updateStreamingBubble(streamingBubble, streamingText);
    scrollToBottom();
  });
}

function updateStreamingBubble(ref, text) {
  const fenceCount = (text.match(/```/g) || []).length;
  const hasOpenFence = fenceCount % 2 !== 0;

  if (hasOpenFence) {
    const lastFence = text.lastIndexOf("```");
    const before = text.slice(0, lastFence);
    const inProgress = text.slice(lastFence + 3);

    const firstNewline = inProgress.indexOf("\n");
    const lang = firstNewline > 0 ? inProgress.slice(0, firstNewline).trim() : "";
    const codeContent = firstNewline > 0 ? inProgress.slice(firstNewline + 1) : inProgress;

    // Render everything before the open fence (any completed deliverables there
    // stripped to cards), then handle the in-progress block.
    const { text: cleanBefore, files } = _stripDeliverables(before);
    ref.bubble.innerHTML = renderMarkdown(cleanBefore);
    files.forEach(f => ref.bubble.appendChild(_buildDeliverableCard(f, true)));

    if (_isDeliverable(lang, codeContent)) {
      // A build deliverable streaming in shows a "Building …" placeholder, never
      // raw source — the file is saved and surfaced as a card on completion.
      ref.bubble.appendChild(_buildDeliverableCard({ name: _deliverableName(lang, codeContent), content: codeContent }, true));
    } else {
      const escaped = codeContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const safeLabel = escapeHtml(lang || "code");
      const safeLangForClass = (lang && /^[a-zA-Z0-9_+-]+$/.test(lang)) ? lang : "";
      const langClass = safeLangForClass ? ` class="language-${safeLangForClass}"` : "";
      const holder = document.createElement("div");
      holder.innerHTML =
        `<div class="code-block">` +
        `<div class="code-toolbar"><span class="code-lang">${safeLabel}</span>` +
        `<span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono)">${t("msg_streaming")}</span></div>` +
        `<pre><code${langClass}>${escaped}</code></pre></div>`;
      ref.bubble.appendChild(holder.firstChild);
    }
    ref.bubble.insertAdjacentHTML("beforeend", '<span class="cursor">▋</span>');
  } else {
    _renderWithDeliverables(ref.bubble, text, true);
    highlightAll();
  }
  scrollToBottom();
}

// ── AI bubble enhancements ───────────────────────────────────────────────────
// A "build" request shouldn't dump 10k lines of code into the chat. When the
// model writes the file to disk it surfaces as a generated-file card; but weak
// models often paste the code inline anyway. So collapse any large inline code
// block behind a compact toolbar (Expand / Copy / Download / — for HTML —
// Preview) instead of letting it flood the transcript.
const _CODE_EXT = { html: "html", htm: "html", css: "css", javascript: "js", js: "js",
                    jsx: "jsx", tsx: "tsx", typescript: "ts", ts: "ts", python: "py",
                    py: "py", json: "json", sh: "sh", bash: "sh", xml: "xml", svg: "svg",
                    markdown: "md", md: "md" };

function _makeCodeBtn(iconClass, label) {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.innerHTML = `<i class="bi ${iconClass}"></i> ${label}`;
  return btn;
}

// ── Build deliverables ───────────────────────────────────────────────────────
// A build request ("make me a page") shouldn't dump the file's source into the
// chat at all. The server persists such blocks to the workspace (see
// persistAnswerArtifacts) and emits a download/preview card; the chat just shows
// a "Building …" placeholder where the code would be. Criteria mirror the server
// so the client hides exactly what the server saved.
// Classify a fenced block as a deliverable, sniffing CONTENT (not just the fence
// label) because weak models routinely emit a bare ``` fence — the exact case
// where the code leaked into the bubble and no card appeared. Mirrors the
// server's classifyDeliverable so the client hides exactly what the server saves.
function _classifyDeliverable(lang, code) {
  const l = (lang || "").toLowerCase();
  if (l === "html" || l === "htm") return "html";
  if (l === "svg") return "svg";
  if (l === "md" || l === "markdown") return "md";
  if (l && l !== "code") return null;        // tagged js/css/python/… → not a deliverable
  if (/<!doctype html/i.test(code) || /<html[\s>]/i.test(code)) return "html";
  if (/^\s*<svg[\s>]/i.test(code)) return "svg";
  return null;
}
function _isDeliverable(lang, text) {
  if (!_classifyDeliverable(lang, text)) return false;
  return text.length >= 1000 || text.split("\n").length >= 20;
}
function _deliverableName(lang, text) {
  const kind = _classifyDeliverable(lang, text);
  if (kind === "html") {
    const m = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const slug = m && m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return slug ? `${slug}.html` : "index.html";
  }
  if (kind === "svg") return "image.svg";
  return "document.md";
}
// Remove build deliverables from the message text BEFORE rendering, so the
// source never reaches the bubble in ANY form: fenced (```html / bare ```),
// or raw `<!DOCTYPE html>…`/`<svg>…` with no fence (optionally wrapped in a
// literal <pre><code>). Returns the cleaned text plus the extracted files.
function _stripDeliverables(text) {
  const files = [];
  let out = text;

  // Fenced blocks whose content classifies as a deliverable.
  out = out.replace(/```(\w*)[ \t]*\r?\n?([\s\S]*?)```/g, (full, lang, code) => {
    const body = code.replace(/\s+$/, "");
    if (!_isDeliverable(lang, body)) return full;
    files.push({ name: _deliverableName(lang, body), content: body });
    return "";
  });

  // Raw, unfenced HTML/SVG document — closed, or (while streaming) running to
  // the end of the text. A leading literal <pre><code> wrapper is absorbed.
  out = out.replace(
    /(?:<pre>\s*<code>\s*)?(<!doctype html\b[\s\S]*?(?:<\/html\s*>|$)|<html\b[\s\S]*?(?:<\/html\s*>|$)|<svg\b[\s\S]*?(?:<\/svg\s*>|$))(?:\s*<\/code>\s*<\/pre>)?/i,
    (full, doc) => {
      const body = doc.replace(/\s+$/, "");
      if (body.length < 400) return full;   // small inline example — leave it
      const kind = /^\s*<svg/i.test(body) ? "svg" : "html";
      files.push({ name: _deliverableName(kind, body), content: body });
      return "";
    }
  );

  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), files };
}

// The placeholder shown in place of a deliverable: "Building…" while streaming,
// or a card with Preview/Download (built from the captured content) once done.
function _buildDeliverableCard(file, building) {
  const card = document.createElement("div");
  card.className = "build-card";
  card.innerHTML =
    `<span class="build-card-icon">${building ? "⏳" : "📄"}</span>` +
    `<span class="build-card-name">${escapeHtml(file.name)}</span>` +
    `<span class="build-card-sub">${building ? "building, saving to your workspace…" : "saved to your workspace"}</span>`;
  if (!building) {
    const actions = document.createElement("span");
    actions.className = "build-card-actions";
    if (/\.html?$/i.test(file.name)) {
      const pv = _makeCodeBtn("bi-eye", "preview");
      pv.addEventListener("click", () => previewHtmlString(file.content, file.name));
      actions.appendChild(pv);
    }
    const dl = _makeCodeBtn("bi-download", "download");
    dl.addEventListener("click", () => {
      const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    actions.appendChild(dl);
    card.appendChild(actions);
  }
  return card;
}

// Render answer text with deliverables stripped out and shown as cards instead.
function _renderWithDeliverables(bubble, text, streaming) {
  const { text: clean, files } = _stripDeliverables(text);
  bubble.innerHTML = renderMarkdown(clean) + (streaming ? '<span class="cursor">▋</span>' : "");
  files.forEach(f => bubble.appendChild(_buildDeliverableCard(f, streaming)));
  return files.length;
}

function _collapseLargeCodeBlocks(bubble) {
  bubble.querySelectorAll(".code-block").forEach(block => {
    if (block.dataset.enhanced) return;
    const code = block.querySelector("code");
    const toolbar = block.querySelector(".code-toolbar");
    if (!code || !toolbar) return;
    const text = code.textContent;
    const lineCount = text.split("\n").length;
    const isLarge = lineCount > 12 || text.length > 800;
    if (!isLarge) return;
    block.dataset.enhanced = "1";

    const langLabel = (block.querySelector(".code-lang")?.textContent || "code").toLowerCase();
    const ext = _CODE_EXT[langLabel] || "txt";
    const filename = `generated.${ext}`;

    block.classList.add("code-block--collapsed");

    if (ext === "html" || ext === "htm") {
      const previewBtn = _makeCodeBtn("bi-eye", "preview");
      previewBtn.addEventListener("click", () => previewHtmlString(text, filename));
      toolbar.appendChild(previewBtn);
    }

    const dlBtn = _makeCodeBtn("bi-download", "download");
    dlBtn.title = `Save as ${filename}`;
    dlBtn.addEventListener("click", () => {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    toolbar.appendChild(dlBtn);

    const expandBtn = _makeCodeBtn("bi-arrows-expand", `expand (${lineCount} lines)`);
    expandBtn.addEventListener("click", () => {
      const collapsed = block.classList.toggle("code-block--collapsed");
      expandBtn.innerHTML = collapsed
        ? `<i class="bi bi-arrows-expand"></i> expand (${lineCount} lines)`
        : `<i class="bi bi-arrows-collapse"></i> collapse`;
    });
    toolbar.appendChild(expandBtn);
  });
}

// Render trailing "pick an option" prompts as clickable pills. The user can
// still type a free-form answer — the pills are a shortcut, not a constraint.
// Heuristic: the message asks a question and lists 2–6 short **bold** items.
//
// Two shapes of prompt, handled differently:
//   • Answer  — the bold item IS the answer ("**A skill**", "**An MCP server**").
//               Clicking it sends that text straight back.
//   • Topic   — the bold item is a category that poses its own follow-up after a
//               dash ("**Email provider** — Gmail, Outlook, or IMAP?"). Sending
//               the bare label answers nothing, so clicking instead seeds the
//               input with "Email provider: " and focuses it for the user to fill.
function _extractChoices(text) {
  if (text.includes("```")) return null;            // a build result, not a prompt
  if (!text.includes("?")) return null;             // not a question at all
  const items = [];
  const re = /^\s*(?:\d+\.|[-*+])\s+\*\*([^*\n]+?)\*\*\s*(.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const label = m[1].replace(/[:：]\s*$/, "").trim();
    if (!label || label.length > 40 || items.some(it => it.label === label)) continue;
    const rest = (m[2] || "").trim();
    // A "topic" item trails a dash and asks its own sub-question — its label
    // names what to answer rather than being the answer.
    const needsInput = /[—–-]/.test(rest) && rest.includes("?");
    items.push({ label, needsInput });
  }
  return items.length >= 2 && items.length <= 6 ? items : null;
}

function _renderChoicePills(bubble, text) {
  const items = _extractChoices(text);
  if (!items) return;
  // If most items pose their own follow-up, the whole prompt needs the user's
  // own answers — seed the input instead of auto-sending bare labels.
  const clarify = items.filter(it => it.needsInput).length > items.length / 2;

  const wrap = document.createElement("div");
  wrap.className = "choice-pills-wrap";

  const cap = document.createElement("div");
  cap.className = "choice-pills-caption";
  cap.textContent = clarify ? t("choice_caption_clarify") : t("choice_caption_pick");
  wrap.appendChild(cap);

  const row = document.createElement("div");
  row.className = "choice-pills";
  items.forEach(({ label }) => {
    const pill = document.createElement("button");
    pill.className = "choice-pill" + (clarify ? " choice-pill--topic" : "");
    pill.textContent = label;
    pill.addEventListener("click", () => {
      const input = document.getElementById("chatInput");
      if (!input) return;
      if (clarify) {
        // Seed "Topic: " (append on a new line if the user is mid-answer),
        // focus the caret at the end, and let the textarea grow.
        const prefix = input.value.trim() ? input.value.replace(/\s+$/, "") + "\n" : "";
        input.value = prefix + label + ": ";
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        if (window.autoResize) window.autoResize();
      } else if (window.send) {
        input.value = label;
        window.send();
      }
    });
    row.appendChild(pill);
  });
  wrap.appendChild(row);
  bubble.appendChild(wrap);

  // Mirror the lead choice into the input as an inline next-step suggestion
  // (Claude-Code style): ghost text in the empty prompt, accepted with Tab / →.
  // Topic items seed "Label: " for the user to finish; answer items seed the
  // label itself. The pills above stay as the full, clickable list.
  const lead = items[0];
  const acceptValue = clarify ? lead.label + ": " : lead.label;
  window.setInputSuggestion?.(acceptValue, lead.label);
}

function _enhanceAiBubble(bubble, rawText) {
  _collapseLargeCodeBlocks(bubble);     // large non-deliverable snippets → collapsed
  _renderChoicePills(bubble, rawText);
}

function finalizeStreamingBubble(ref, fullText, stats) {
  ref.bubble.classList.remove("streaming");

  ref.bubble.innerHTML = "";
  if (fullText.includes("🧠 **Memory suggestions**") && !suggestionShown) {
    suggestionShown = true;
    const [before, after] = fullText.split("🧠 **Memory suggestions**");
    _renderWithDeliverables(ref.bubble, before.trim(), false);
    ref.bubble.appendChild(parseSuggestionBlock(after));
  } else {
    _renderWithDeliverables(ref.bubble, fullText, false);
  }
  if (fullText.trim()) _attachBubbleCopyBtn(ref.bubble, fullText);
  _enhanceAiBubble(ref.bubble, fullText);

  const col = ref.wrap.querySelector("div[style]") || ref.wrap;

  const ts = document.createElement("div");
  ts.className = "msg-timestamp";
  ts.textContent = t("mem_just_now");
  ts.dataset.ts = Date.now();
  col.appendChild(ts);

  if (stats) {
    const answerTok = stats.outputTokens - (stats.thinkingTokens || 0);
    const tokPerSec = (answerTok / stats.elapsedSec).toFixed(1);
    const secLabel = stats.elapsedSec.toFixed(1) + "s";
    const badge = document.createElement("div");
    badge.className = "msg-stats";
    let label;
    if (stats.thinkingTokens > 0) {
      label = t("stats_with_thinking", { total: stats.outputTokens, answer: answerTok, thinking: stats.thinkingTokens, speed: tokPerSec, sec: secLabel });
    } else {
      label = t("stats_plain", { answer: answerTok, speed: tokPerSec, sec: secLabel });
    }
    // The response token count above only covers what the model *generated*.
    // The far larger input — full history + injected skills + recalled memories
    // + tool schemas — is what the user was missing. Surface it so the footer
    // number isn't mistaken for the whole turn's cost. This is the same
    // provider-reported figure the navbar context bar uses.
    if (stats.inputTokens > 0) {
      label += " · " + t("stats_context_in", { n: stats.inputTokens.toLocaleString() });
    }
    badge.textContent = label;
    col.appendChild(badge);
  }

  highlightAll();
}

// Sum of the known startup components (server-side estimates). The static
// greeting means there's no startup inference, so this is the best number we
// have until the first real turn reports a true provider count.
function _startupComponentsTotal(bd) {
  return (bd.identity || 0)
    + (bd.skills || []).reduce((n, s) => n + (s.tokens || 0), 0)
    + (bd.memoryTokens || 0)
    + (bd.toolSchemas || 0);
}

// Build the banner's inner HTML. When `realTotal` is given (after turn 1) the
// headline shows the true provider count and a "scaffolding" row reconciles the
// estimates to it; otherwise it's a labelled estimate.
function _startupBannerInner(bd, realTotal) {
  const est = _startupComponentsTotal(bd);
  const total = realTotal || est;

  const items = [[t("startup_bd_identity"), bd.identity || 0]];
  for (const s of (bd.skills || [])) items.push([t("startup_bd_skill_named", { name: s.name }), s.tokens || 0]);
  if (bd.toolSchemas)  items.push([t("startup_bd_tools"), bd.toolSchemas]);
  if (bd.memoryTokens) items.push([t("startup_bd_memory_pointer"), bd.memoryTokens]);
  if (realTotal) {
    const other = Math.max(0, realTotal - est);
    if (other) items.push([t("startup_bd_other"), other]);
  }
  const rows = items
    .map(([label, n]) => `<div class="ctx-bd-row"><span>${label}</span><span>~${n.toLocaleString()}</span></div>`)
    .join("");

  const headline = realTotal
    ? t("startup_tokens_from", { n: total.toLocaleString() })
    : t("startup_tokens_est", { n: total.toLocaleString() });

  return (
    `<div class="ctx-banner-row">` +
      `<span class="ctx-banner-text">${headline}</span>` +
      `<button class="ctx-banner-btn" onclick="const b=this.closest('.ctx-banner').querySelector('.ctx-bd'); b.style.display = b.style.display==='none' ? 'block' : 'none';">${t("startup_bd_toggle")}</button>` +
      `<button class="ctx-banner-btn" onclick="this.closest('.ctx-banner').remove()">${t("ctx_dismiss")}</button>` +
    `</div>` +
    `<div class="ctx-bd" style="display:none">` +
      `<div class="ctx-bd-title">${t("startup_bd_title")}</div>` +
      rows +
      `<div class="ctx-bd-note">${t("startup_bd_note")}</div>` +
    `</div>`
  );
}

let _startupBannerEl = null;
let _startupBannerRefined = false;

function _maybeShowStartupBanner() {
  if (startupBannerShown) return;
  const bd = _startupBreakdown;
  if (!bd || !_startupComponentsTotal(bd)) return;
  startupBannerShown = true;

  const banner = document.createElement("div");
  banner.className = "ctx-banner ctx-banner--memories";
  banner.innerHTML = _startupBannerInner(bd, null);
  document.querySelector(".chat-area")?.prepend(banner);
  _startupBannerEl = banner;
}

// Replace the startup estimate with the real provider input-token count once the
// first turn returns. Keeps the banner visible (no auto-dismiss) so the figure
// the user actually paid stays on screen until they dismiss it.
function _refineStartupBanner(inputTok) {
  if (!inputTok || _startupBannerRefined || !_startupBreakdown) return;
  if (!_startupBannerEl || !_startupBannerEl.isConnected) return;
  _startupBannerRefined = true;
  // Preserve whether the user had expanded the breakdown.
  const wasOpen = _startupBannerEl.querySelector(".ctx-bd")?.style.display === "block";
  _startupBannerEl.innerHTML = _startupBannerInner(_startupBreakdown, inputTok);
  if (wasOpen) {
    const bd = _startupBannerEl.querySelector(".ctx-bd");
    if (bd) bd.style.display = "block";
  }
}

function _annotateTokenBadges(inputTok, thinkTok) {
  lastUserMsgWrap = null;
  if (inputTok) prevInputTokens = inputTok;
  if (lastReasoningWrapForTok && thinkTok > 0) {
    const tok = document.createElement("span");
    tok.className = "reasoning-tok";
    tok.textContent = `🧠 +${thinkTok.toLocaleString()}`;
    const flatLabel = lastReasoningWrapForTok.querySelector(".reasoning-flat-label");
    const summary   = lastReasoningWrapForTok.querySelector("summary");
    (flatLabel || summary)?.appendChild(tok);
    lastReasoningWrapForTok = null;
  }
}

function toggleReasoning() {
  const cur = localStorage.getItem("aperio-reasoning") !== "false";
  window.Aperio?.settings?.set("aperio-reasoning", cur ? "false" : "true");
  updateReasoningBtn();
}

function updateReasoningBtn() {
  const on  = localStorage.getItem("aperio-reasoning") !== "false";
  const btn = document.getElementById("reasoningToggle");
  if (!btn) return;
  btn.classList.toggle("is-on", on);
  btn.title = on ? "Disable reasoning" : "Enable reasoning";
}

// Adopt a server value picked up at boot (localStorage already synced).
window.Aperio?.settings?.register("aperio-reasoning", updateReasoningBtn);

window.addEventListener("DOMContentLoaded", updateReasoningBtn);

function _humanExpiry(isoStr) {
  const days = Math.round((new Date(isoStr) - Date.now()) / 86400000);
  if (days <= 0) return t("ttl_chip_expired");
  if (days === 1) return t("ttl_chip_tomorrow");
  return t("ttl_chip_in_days", { n: days });
}

function _renderTtlChip({ id, memType, title, expires_at }) {
  const chip = document.createElement("div");
  chip.className = "ttl-chip";
  chip.innerHTML =
    `<span class="ttl-chip-icon">⏳</span>` +
    `<div class="ttl-chip-info">` +
      `<span class="ttl-chip-type">${escapeHtml(memType)}</span>` +
      `<span class="ttl-chip-title">${escapeHtml(title)}</span>` +
      `<span class="ttl-chip-expiry">${_humanExpiry(expires_at)}</span>` +
    `</div>` +
    `<div class="ttl-chip-actions">` +
      `<button class="ttl-btn ttl-btn--confirm">${t("ttl_chip_keep")}</button>` +
      `<button class="ttl-btn ttl-btn--remove">${t("ttl_chip_permanent")}</button>` +
    `</div>`;

  chip.querySelector(".ttl-btn--confirm").onclick = () => chip.remove();

  chip.querySelector(".ttl-btn--remove").onclick = async () => {
    const btn = chip.querySelector(".ttl-btn--remove");
    btn.disabled = true;
    btn.textContent = t("ttl_chip_removing");
    try {
      await fetch(`/api/memories/${id}/expiry`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expires_at: null }),
      });
    } catch { /* silent — chip still dismisses */ }
    chip.remove();
  };

  messagesEl.appendChild(chip);
  scrollToBottom();
}

// Map a file extension to its display icon + type label. Falls back to a
// generic file icon with the uppercased extension so any generated artifact
// is labelled correctly (never mislabelled as "Excel").
function _fileKind(ext) {
  switch (ext) {
    case "pptx": case "ppt":            return { icon: "bi-file-earmark-slides",      label: "PowerPoint" };
    case "xlsx": case "xls":            return { icon: "bi-file-earmark-spreadsheet", label: "Excel" };
    case "csv": case "tsv":             return { icon: "bi-file-earmark-spreadsheet", label: ext.toUpperCase() };
    case "pdf":                         return { icon: "bi-file-earmark-pdf",         label: "PDF" };
    case "docx": case "doc":            return { icon: "bi-file-earmark-word",        label: "Word" };
    case "html": case "htm":            return { icon: "bi-filetype-html",            label: "HTML page" };
    case "md":                          return { icon: "bi-file-earmark-text",        label: "Markdown" };
    case "png": case "jpg": case "jpeg":
    case "gif": case "webp": case "svg": return { icon: "bi-file-earmark-image",       label: ext.toUpperCase() };
    default:                            return { icon: "bi-file-earmark",             label: (ext || "FILE").toUpperCase() };
  }
}

const _BINARY_EXT = new Set(["xlsx", "xls", "docx", "doc", "pdf", "pptx", "ppt",
                              "png", "jpg", "jpeg", "gif", "webp", "svg",
                              "zip", "tar", "gz", "exe", "wasm"]);

function _buildGeneratedFileCard({ filename, url, sizeKb }) {
  const name = filename || (url ? decodeURIComponent(url.split("/").pop()) : "file");
  const ext  = (name.split(".").pop() || "").toLowerCase();
  const { icon, label } = _fileKind(ext);
  const canPreview = !_BINARY_EXT.has(ext);

  const card = document.createElement("div");
  card.className = "generated-file-card";

  const previewBtn = canPreview
    ? `<button class="gfc-btn gfc-preview-btn" data-url="${escapeHtml(url)}" data-name="${escapeHtml(name)}">` +
        `<i class="bi bi-eye"></i> Preview` +
      `</button>`
    : "";

  card.innerHTML =
    `<div class="gfc-icon"><i class="bi ${icon}"></i></div>` +
    `<div class="gfc-info">` +
      `<span class="gfc-name">${escapeHtml(name)}</span>` +
      `<span class="gfc-meta">${escapeHtml(label)}${sizeKb ? ` · ${sizeKb} KB` : ""}</span>` +
    `</div>` +
    previewBtn +
    `<a class="gfc-btn" href="${escapeHtml(url)}" download="${escapeHtml(name)}">` +
      `<i class="bi bi-download"></i> Download` +
    `</a>`;

  if (canPreview) {
    card.querySelector(".gfc-preview-btn").addEventListener("click", () => {
      openGeneratedFileModal(url, name);
    });
  }

  return card;
}

function _parseRecallText(text) {
  return text.split("---").filter(b => b.trim()).map(block => {
    const lines     = block.trim().split("\n");
    const firstLine = lines[0];
    const titleMatch = firstLine.match(/^\[\w+\]\s+(.+?)(?:\s+\[(?:similarity|confidence):|\s+\(importance:)/);
    const simMatch   = firstLine.match(/\[similarity:\s*([\d.]+)%\]/);
    const tagsLine   = lines.find(l => l.startsWith("Tags:")) || "";
    const tags       = tagsLine.replace("Tags:", "").trim();
    const content    = lines[1]?.trim() || "";
    return {
      title:      titleMatch?.[1]?.trim() || "",
      similarity: simMatch ? parseFloat(simMatch[1]) : null,
      content,
      tags:       tags && tags !== "none" ? tags : "",
      // The whole block (header + content + tags + id/date) is what recall
      // injects into the model's context, so estimate the cost from the raw
      // block rather than just the visible content line.
      tokens:     estimateTokens(block),
    };
  }).filter(m => m.title);
}

function _renderRecallPill(items) {
  const pill = document.createElement("div");
  pill.className = "recall-pill";

  const n = items.length;
  const label = n === 1 ? t("recall_pill_one") : t("recall_pill_many", { n });
  const topScores = items
    .filter(m => m.similarity !== null)
    .slice(0, 3)
    .map(m => `${m.similarity}%`)
    .join(" · ");

  // Total cost the recalled memories add to this turn's input — the figure the
  // user was missing under "Recalled N memories".
  const totalTok = items.reduce((sum, m) => sum + (m.tokens || 0), 0);
  const tokSuffix = totalTok
    ? `<span class="recall-pill-tok">${t("chip_tokens", { n: totalTok.toLocaleString() })}</span>`
    : "";

  const toggle = document.createElement("button");
  toggle.className = "recall-pill-toggle";
  toggle.innerHTML =
    `<span class="recall-asterisk">✦</span>` +
    `<span class="recall-pill-label">${label}</span>` +
    (topScores ? `<span class="recall-pill-scores">${topScores}</span>` : "") +
    tokSuffix +
    `<span class="recall-pill-chevron">▾</span>`;
  pill.appendChild(toggle);

  const details = document.createElement("div");
  details.className = "recall-pill-details";
  items.forEach(m => {
    const item = document.createElement("details");
    item.className = "recall-memory";
    item.innerHTML =
      `<summary>` +
        `<span class="recall-memory-title">${escapeHtml(m.title)}</span>` +
        (m.tokens ? `<span class="recall-score recall-score--tok">${t("chip_tokens", { n: m.tokens.toLocaleString() })}</span>` : "") +
        (m.similarity !== null ? `<span class="recall-score">${m.similarity}%</span>` : "") +
      `</summary>` +
      `<div class="recall-memory-body">` +
        (m.content ? `<div class="recall-memory-content">${escapeHtml(m.content)}</div>` : "") +
        (m.tags ? `<div class="recall-memory-tags">${escapeHtml(m.tags)}</div>` : "") +
      `</div>`;
    details.appendChild(item);
  });
  pill.appendChild(details);

  toggle.onclick = () => {
    const open = details.classList.toggle("open");
    toggle.querySelector(".recall-pill-chevron").textContent = open ? "▴" : "▾";
  };

  messagesEl.appendChild(pill);
  scrollToBottom();
}

// ── Skills chip ─────────────────────────────────────────────────────────────
// Skills are injected into the system prompt (not executed), so this chip is
// the only signal the user gets about which ones steered the turn.
function _renderSkillsChip(skills) {
  const chip = document.createElement("div");
  chip.className = "recall-pill skills-chip";

  // Header is a plain label — no toggle. The combined per-turn token cost of all
  // injected skills, so "skills" isn't an invisible token sink.
  const totalTok = skills.reduce((n, s) => n + (s.tokens || 0), 0);
  const tokTxt = totalTok ? ` <span class="skills-total-tok">(${t("chip_tokens", { n: totalTok.toLocaleString() }).trim()})</span>` : "";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "recall-pill-toggle skills-label";
  header.innerHTML =
    `<span class="recall-asterisk">✦</span>` +
    `<span class="recall-pill-label">${t("skills_chip_label")}${tokTxt}:</span>` +
    `<span class="recall-pill-chevron">▾</span>`;
  chip.appendChild(header);

  // The list collapses to keep things tidy when several skills load. Once open,
  // each row is itself expandable: clicking it reveals a brief description + a
  // "more…" that opens the full SKILL.md (fetched on demand, not streamed).
  const details = document.createElement("div");
  details.className = "recall-pill-details skills-details";
  skills.forEach(s => {
    const kb  = s.bytes  ? `${(s.bytes / 1024).toFixed(1)} KB` : "";
    const tok = s.tokens ? t("chip_tokens", { n: s.tokens.toLocaleString() }).trim() : "";
    const meta = [kb, tok].filter(Boolean).join(" · ");
    const item = document.createElement("details");
    item.className = "skill-row";
    item.innerHTML =
      `<summary class="skill-row-head">` +
        `<span class="skill-row-arrow">↳</span>` +
        `<span class="skill-row-name">${escapeHtml(s.name)}</span>` +
        (s.always ? `<span class="skill-always-badge">${t("skills_always_badge")}</span>` : "") +
        (meta ? `<span class="skill-row-meta">${escapeHtml(meta)}</span>` : "") +
        `<span class="skill-row-chevron">▾</span>` +
      `</summary>` +
      `<div class="skill-row-body">` +
        (s.description ? `<span class="skill-brief">${escapeHtml(s.description)}</span> ` : "") +
        `<button type="button" class="skill-more">${t("skills_more")}</button>` +
      `</div>`;
    item.querySelector(".skill-more").onclick = e => { e.preventDefault(); _openSkillDoc(s.name); };
    details.appendChild(item);
  });
  chip.appendChild(details);

  header.onclick = () => {
    const open = details.classList.toggle("open");
    header.querySelector(".recall-pill-chevron").textContent = open ? "▴" : "▾";
  };

  messagesEl.appendChild(chip);
  scrollToBottom();
}

// Open a skill's SKILL.md rendered as markdown in a modal — so the user can see
// *what* is in the system prompt and *why* it steered the turn. Content is
// fetched on demand (not streamed every turn). Reuses the file-preview modal
// shell (.fpm-*); the body carries `.bubble` for markdown styling.
function _openSkillDoc(name) {
  let overlay = document.getElementById("skill-doc-modal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "skill-doc-modal";
    overlay.className = "fpm-overlay";
    overlay.innerHTML =
      `<div class="fpm-dialog">` +
        `<div class="fpm-header">` +
          `<div class="fpm-title-group">` +
            `<span class="fpm-icon">✦</span>` +
            `<span class="fpm-filename skill-doc-name"></span>` +
            `<span class="fpm-ext-badge">SKILL.md</span>` +
          `</div>` +
          `<div class="fpm-actions">` +
            `<button class="fpm-edit-btn sk-btn sk-btn--ghost" title="Edit this skill">Edit</button>` +
            `<button class="fpm-close-btn" title="Close (Esc)"><i class="bi bi-x-lg"></i></button>` +
          `</div>` +
        `</div>` +
        `<div class="fpm-body bubble skill-doc-body"></div>` +
      `</div>`;
    const close = () => overlay.classList.remove("open");
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector(".fpm-close-btn").addEventListener("click", close);
    overlay.querySelector(".fpm-edit-btn").addEventListener("click", () => {
      const name = overlay.querySelector(".skill-doc-name").textContent;
      close();
      window.openSkillEditor?.(name);
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && overlay.classList.contains("open")) close();
    });
    document.body.appendChild(overlay);
  }
  overlay.querySelector(".skill-doc-name").textContent = name;
  const body = overlay.querySelector(".skill-doc-body");
  body.textContent = "…";
  overlay.classList.add("open");
  fetch(`/api/skill?name=${encodeURIComponent(name)}`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
    .then(doc => {
      body.innerHTML = renderMarkdown(doc.content || "");
      if (window.Prism) Prism.highlightAll();
      body.scrollTop = 0;
    })
    .catch(() => { body.textContent = t("skills_load_error"); });
}

// ── Tool activity cards ─────────────────────────────────────────────────────
function _renderToolCard(msg) {
  const card = document.createElement("div");
  card.className = "tool-card pending";
  // Short args sit inline beside the tool name; long ones (e.g. a full shell
  // command) drop to their own wrapping line below the head so the whole
  // command stays readable instead of being clipped to one line.
  const arg = msg.arg || "";
  const inlineArg = arg && arg.length <= 48
    ? `<span class="tool-card-arg">${escapeHtml(arg)}</span>` : "";
  const blockArg = arg && arg.length > 48
    ? `<div class="tool-card-arg-block">${escapeHtml(arg)}</div>` : "";
  card.innerHTML =
    `<div class="tool-card-head">` +
      `<span class="tool-card-dot"></span>` +
      `<span class="tool-card-name">${escapeHtml(msg.name)}</span>` +
      inlineArg +
      `<span class="tool-card-time"></span>` +
    `</div>` +
    blockArg +
    `<div class="tool-card-result">${t("tool_card_running")}</div>`;
  _toolCards.set(msg.seq, card);
  // Live stopwatch: tick the elapsed time in real time so a slow tool (e.g. a
  // long test run) never looks frozen. The interval is cleared on resolve, or
  // defensively on stream_end if the tool never reports back.
  const timeEl = card.querySelector(".tool-card-time");
  const startedAt = Date.now();
  timeEl.textContent = formatLiveDuration(0);
  card._timerId = setInterval(() => {
    timeEl.textContent = formatLiveDuration(Date.now() - startedAt);
  }, 100);
  messagesEl.appendChild(card);
  // The card now owns the tool's identity (name + args + result). The live
  // "thinking" pill stays the generic "Using {name}…" so it complements the
  // card instead of cloning its `name · arg` head right below it.
  moveLiveIndicatorToBottom();
  scrollToBottom();
}

// Human-readable tool duration: raw ms is meaningless to a user ("12013ms").
// Sub-second stays in ms; seconds get one decimal; a minute or more reads "1m 5s".
function formatToolDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// Live-counter format: unlike the resolved duration it never shows raw ms, so
// the ticking stopwatch reads as clean tenths of a second ("0.0s" → "12.3s")
// instead of a flickering "734ms". Rolls to "1m 5s" past a minute.
function formatLiveDuration(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// Drive the live timer on whichever "#thinking" pill currently exists. Started
// once per user turn (in send) and kept running across the inter-tool
// stream_end/start cycles so the "reading result…" digest gap is timed too;
// stopped only when the turn truly ends (final answer / error / stop).
function startLiveTimer() {
  stopLiveTimer();
  requestStartTime = Date.now();
  _liveTimerId = setInterval(() => {
    const el = document.querySelector("#thinking .thinking-time");
    if (el && requestStartTime) el.textContent = formatLiveDuration(Date.now() - requestStartTime);
  }, 100);
}
function stopLiveTimer() {
  clearInterval(_liveTimerId);
  _liveTimerId = null;
}

function _resolveToolCard(msg) {
  const card = _toolCards.get(msg.seq);
  if (!card) return;
  _toolCards.delete(msg.seq);
  if (card._timerId) { clearInterval(card._timerId); card._timerId = null; }
  card.classList.remove("pending");
  card.classList.add(msg.ok ? "ok" : "error");
  const time = card.querySelector(".tool-card-time");
  if (time && typeof msg.ms === "number") time.textContent = formatToolDuration(msg.ms);
  const result = card.querySelector(".tool-card-result");
  if (result) {
    const summaryText = `↳ ${msg.summary || (msg.ok ? "done" : "error")}`;
    // web_search ships its hits as `details` — render them as an expandable list
    // (titles link out) so "N results" is inspectable instead of an opaque count.
    if (Array.isArray(msg.details) && msg.details.length) {
      result.textContent = "";
      const det = document.createElement("details");
      det.className = "tool-card-results";
      const sum = document.createElement("summary");
      sum.textContent = summaryText;
      det.appendChild(sum);
      for (const r of msg.details) {
        const item = document.createElement("div");
        item.className = "tool-card-result-item";
        const a = document.createElement("a");
        a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = r.title || r.url;
        item.appendChild(a);
        const link = document.createElement("div");
        link.className = "tool-card-result-url";
        link.textContent = r.url;
        item.appendChild(link);
        if (r.snippet) {
          const sn = document.createElement("div");
          sn.className = "tool-card-result-snippet";
          sn.textContent = r.snippet;
          item.appendChild(sn);
        }
        det.appendChild(item);
      }
      result.appendChild(det);
    } else {
      result.textContent = summaryText;
    }
  }
  // The tool is done — don't leave the live pill stuck on the present-tense
  // "Using {name}…" sitting below a finished card (reads as if the tool is
  // still running, and went silent for minutes on slow models). Flip it to the
  // model's next phase: digesting the result before it answers.
  const label = document.querySelector("#thinking .thinking-label");
  if (label) label.textContent = t("tool_reading_result");
  // Mark the reading phase so enterPhase() leaves a persistent breadcrumb when
  // the answer (or next step) takes over, rather than the line just disappearing.
  _lastPhase = "reading";
  moveLiveIndicatorToBottom();
  scrollToBottom();
}

function _renderDeleteConfirmButton(token, filePath) {
  const filename = filePath ? filePath.split("/").pop() : "file";
  const wrap = document.createElement("div");
  wrap.className = "delete-confirm-wrap";
  wrap.innerHTML = `
    <div class="delete-confirm-header">Delete <code>${filename}</code>?</div>
    <div class="delete-confirm-meta">
      Confirmation token: <code class="delete-confirm-token">${token}</code>
      <span class="delete-confirm-hint">— click the button to confirm this deletion</span>
    </div>
  `;

  const btn = document.createElement("button");
  btn.className = "delete-confirm-btn";
  btn.innerHTML = '<i class="bi bi-trash"></i> Confirm deletion';
  btn.onclick = () => {
    wrap.remove();
    chatInput.value = token;
    send();
  };

  wrap.appendChild(btn);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

// Generic confirm-before-write button (GitHub issue create/update, etc.). The
// action is already resolved and stashed server-side under the token, so the
// click sends a `confirm_action` message and the SERVER executes it directly —
// no model round-trip. The result streams back as a normal assistant message.
function _renderActionConfirmButton(token, label, summary, tool) {
  const wrap = document.createElement("div");
  wrap.className = "action-confirm-wrap";

  const head = document.createElement("div");
  head.className = "action-confirm-header";
  head.textContent = label || "Confirm action";
  wrap.appendChild(head);

  if (summary) {
    const meta = document.createElement("div");
    meta.className = "action-confirm-summary";
    meta.textContent = summary;
    wrap.appendChild(meta);
  }

  const btn = document.createElement("button");
  btn.className = "action-confirm-btn";
  btn.innerHTML = '<i class="bi bi-check2-circle"></i> Confirm';
  btn.onclick = () => {
    btn.disabled = true;
    wrap.remove();
    safeSend(JSON.stringify({ type: "confirm_action", token, tool }));
  };

  // Let the user back out without performing the action.
  const cancel = document.createElement("button");
  cancel.className = "action-confirm-btn action-confirm-cancel";
  cancel.textContent = "Cancel";
  cancel.onclick = () => wrap.remove();

  const row = document.createElement("div");
  row.className = "action-confirm-row";
  row.appendChild(btn);
  row.appendChild(cancel);
  wrap.appendChild(row);

  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function _renderNoToolWarning(model) {
  const chip = document.createElement("div");
  chip.className = "no-tool-warning";
  chip.innerHTML =
    `<span class="no-tool-warning-icon">⚠</span>` +
    `<span class="no-tool-warning-text">` +
      `<strong>${escapeHtml(model)}</strong> answered with code instead of writing files. ` +
      `Small local models sometimes describe code rather than calling tools, especially when the target is vague. ` +
      `Try naming the file to create/edit, or switch to a larger model for reliable file operations.` +
    `</span>` +
    `<button class="no-tool-warning-dismiss" title="Dismiss">✕</button>`;
  chip.querySelector(".no-tool-warning-dismiss").onclick = () => chip.remove();
  messagesEl.appendChild(chip);
  scrollToBottom();
}
