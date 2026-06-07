// ── Streaming state ───────────────────────────────────────────
let reasoningBubble = null;
let reasoningText = "";
let streamingBubble = null;
let streamingText = "";
let streamStartTime = null;
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
let _preloadMemCount = 0;
let _startupBreakdown = null;
// Round-table state. _nextBubbleAgent is set on stream_start and consumed by
// createStreamingBubble() so the bubble is styled with the right agent colour.
// _roundtableAgents is populated from the `provider` event for badge labels.
let _nextBubbleAgent = null;
let _roundtableAgents = [];
let _roundtablePhaseChip = null;
let _pendingGeneratedFile = null;
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
  if (_lastPhase === "thinking" && kind !== "thinking" && !_phaseHadReasoning) {
    dropPhaseBreadcrumb(t("status_thinking"));
  }
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

  if (msg.type === "preload_mem_count") {
    _preloadMemCount = msg.count ?? 0;
  }

  if (msg.type === "startup_breakdown") {
    _startupBreakdown = msg;
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

    const toggle = document.getElementById("reasoningToggle");
    if (toggle) toggle.style.display = msg.thinks ? "flex" : "none";

    if (msg.contextWindow) maxCtx = msg.contextWindow;
    if (typeof msg.imageTokens === "number") _imageTokenCost = msg.imageTokens;
  }

  if (msg.type === "paths_updated") {
    if (typeof notifyPathsChanged === "function") notifyPathsChanged(msg.paths);
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
      updateStreamingBubble(streamingBubble, streamingText);
      requestAnimationFrame(() => scrollToBottom());
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
    accThinkingTokens += msg.usage?.thinking_tokens ?? 0;
    accOutputTokens += msg.usage?.output_tokens ?? 0;
    const responseStats = (elapsedSec && msg.usage?.output_tokens)
      ? { outputTokens: accOutputTokens, thinkingTokens: accThinkingTokens, elapsedSec, inputTokens: msg.usage?.input_tokens ?? 0 }
      : null;
    if (streamingBubble && streamingText.trim()) {
      finalizeStreamingBubble(streamingBubble, streamingText, responseStats);
      if (_pendingGeneratedFile) { streamingBubble.bubble.appendChild(_buildGeneratedFileCard(_pendingGeneratedFile)); _pendingGeneratedFile = null; }
      window.Aperio?.tts?.speak(streamingText);
      window.Aperio?.voice?.onStreamEnd?.();
      _maybeShowStartupBanner(msg.usage?.input_tokens);
      _annotateTokenBadges(msg.usage?.input_tokens, accThinkingTokens);
      accThinkingTokens = 0; accOutputTokens = 0;
    } else if (streamingBubble) {
      streamingBubble.wrap?.remove();
    } else if (!streamingText && msg.text?.trim()) {
      removeThinking();
      removeToolIndicator();
      addMessage("ai", msg.text);
      window.Aperio?.tts?.speak(msg.text);
      window.Aperio?.voice?.onStreamEnd?.();
      _maybeShowStartupBanner(msg.usage?.input_tokens);
      _annotateTokenBadges(msg.usage?.input_tokens, accThinkingTokens);
      accThinkingTokens = 0; accOutputTokens = 0;
    }
    // Fallback: if the card is still pending (e.g. no streaming text), attach to last AI bubble
    if (_pendingGeneratedFile) {
      const lastBubble = [...messagesEl.querySelectorAll(".message.ai .bubble")].at(-1);
      if (lastBubble) lastBubble.appendChild(_buildGeneratedFileCard(_pendingGeneratedFile));
      else messagesEl.appendChild(_buildGeneratedFileCard(_pendingGeneratedFile));
      _pendingGeneratedFile = null;
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

  if (msg.type === "generated_file") {
    // The server emits these only after the final answer has streamed, so the
    // answer bubble already exists — attach the download card straight to it.
    // If a bubble is still streaming, keep it pending so stream_end attaches it.
    if (streamingBubble) { _pendingGeneratedFile = msg; return; }
    // Otherwise the answer is already rendered: attach to it, or — if the answer
    // was empty so no bubble exists — stand the card up on its own.
    const lastBubble = [...messagesEl.querySelectorAll(".message.ai .bubble")].at(-1);
    if (lastBubble) lastBubble.appendChild(_buildGeneratedFileCard(msg));
    else messagesEl.appendChild(_buildGeneratedFileCard(msg));
    scrollToBottom();
    return;
  }

  if (msg.type === "error") {
    removeThinking();
    removeToolIndicator();
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

    const escaped = codeContent
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const beforeHtml = before ? renderMarkdown(before) : "";
    const rawLabel = lang || "code";
    const safeLabel = escapeHtml(rawLabel);
    const safeLangForClass = (lang && /^[a-zA-Z0-9_+-]+$/.test(lang)) ? lang : "";
    const langClass = safeLangForClass ? ` class="language-${safeLangForClass}"` : "";
    const blockHtml =
      `<div class="code-block">` +
      `<div class="code-toolbar"><span class="code-lang">${safeLabel}</span>` +
      `<span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono)">${t("msg_streaming")}</span></div>` +
      `<pre><code${langClass}>${escaped}</code></pre></div>`;

    ref.bubble.innerHTML = beforeHtml + blockHtml + '<span class="cursor">▋</span>';
  } else {
    ref.bubble.innerHTML = renderMarkdown(text) + '<span class="cursor">▋</span>';
    highlightAll();
  }
  scrollToBottom();
}

function finalizeStreamingBubble(ref, fullText, stats) {
  ref.bubble.classList.remove("streaming");

  ref.bubble.innerHTML = "";
  if (fullText.includes("🧠 **Memory suggestions**") && !suggestionShown) {
    suggestionShown = true;
    const [before, after] = fullText.split("🧠 **Memory suggestions**");
    ref.bubble.innerHTML = renderMarkdown(before.trim());
    ref.bubble.appendChild(parseSuggestionBlock(after));
  } else {
    ref.bubble.innerHTML = renderMarkdown(fullText);
  }
  if (fullText.trim()) _attachBubbleCopyBtn(ref.bubble, fullText);

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

function _maybeShowStartupBanner(inputTok) {
  if (startupBannerShown) return;
  // Wait for a real provider token count — the banner's job is to explain that
  // number, not to estimate one.
  if (!inputTok) return;
  startupBannerShown = true;

  // Memories shown reflect what's actually injected into the startup prompt.
  // Memories are no longer preloaded, so this is normally 0; we no longer fall
  // back to the sidebar count (those memories are NOT in the prompt).
  const memCount = _preloadMemCount;
  const parts = [t("startup_tokens_from", { n: inputTok.toLocaleString() })];
  if (memCount) parts.push(memCount === 1 ? t("startup_memory_one") : t("startup_memory_many", { n: memCount }));
  if (_preloadToolCount) parts.push(_preloadToolCount === 1 ? t("startup_tool_one") : t("startup_tool_many", { n: _preloadToolCount }));

  // Per-component breakdown of where the startup tokens go. Component figures
  // are server-side estimates; "scaffolding" reconciles them to the real total
  // so the rows always sum to the provider-reported number.
  const bd = _startupBreakdown;
  let bdHtml = "";
  if (bd) {
    const items = [[t("startup_bd_identity"), bd.identity || 0]];
    // One row per always-on skill, named — there may be more than one.
    for (const s of bd.skills || []) items.push([t("startup_bd_skill_named", { name: s.name }), s.tokens || 0]);
    if (memCount) items.push([t("startup_bd_memories", { n: memCount }), bd.memoryTokens || 0]);
    const accounted = items.reduce((n, [, v]) => n + v, 0);
    const other = Math.max(0, inputTok - accounted);
    if (other) items.push([t("startup_bd_other"), other]);
    const rows = items
      .map(([label, n]) => `<div class="ctx-bd-row"><span>${label}</span><span>~${n.toLocaleString()}</span></div>`)
      .join("");
    bdHtml =
      `<div class="ctx-bd" style="display:none">` +
        `<div class="ctx-bd-title">${t("startup_bd_title")}</div>` +
        rows +
        `<div class="ctx-bd-note">${t("startup_bd_note")}</div>` +
      `</div>`;
  }

  const banner = document.createElement("div");
  banner.className = "ctx-banner ctx-banner--memories";
  banner.innerHTML =
    `<div class="ctx-banner-row">` +
      `<span class="ctx-banner-text">${parts.join(' · ')}</span>` +
      (bd ? `<button class="ctx-banner-btn" onclick="const b=this.closest('.ctx-banner').querySelector('.ctx-bd'); b.style.display = b.style.display==='none' ? 'block' : 'none';">${t("startup_bd_toggle")}</button>` : "") +
      `<button class="ctx-banner-btn" onclick="this.closest('.ctx-banner').remove()">${t("ctx_dismiss")}</button>` +
    `</div>` +
    bdHtml;
  document.querySelector(".chat-area")?.prepend(banner);
  setTimeout(() => {
    if (!banner.isConnected) return;
    const bd = banner.querySelector(".ctx-bd");
    if (bd && bd.style.display !== "none") return;
    banner.remove();
  }, 10000);
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
    case "png": case "jpg": case "jpeg":
    case "gif": case "webp": case "svg": return { icon: "bi-file-earmark-image",       label: ext.toUpperCase() };
    default:                            return { icon: "bi-file-earmark",             label: (ext || "FILE").toUpperCase() };
  }
}

function _buildGeneratedFileCard({ filename, url, sizeKb }) {
  // Prefer the explicit filename; otherwise derive it from the URL so the name
  // and extension are always shown (no "spreadsheet.xlsx" placeholder).
  const name = filename || (url ? decodeURIComponent(url.split("/").pop()) : "file");
  const ext  = (name.split(".").pop() || "").toLowerCase();
  const { icon, label } = _fileKind(ext);

  const card = document.createElement("div");
  card.className = "generated-file-card";
  card.innerHTML =
    `<div class="gfc-icon"><i class="bi ${icon}"></i></div>` +
    `<div class="gfc-info">` +
      `<span class="gfc-name">${escapeHtml(name)}</span>` +
      `<span class="gfc-meta">${escapeHtml(label)}${sizeKb ? ` · ${sizeKb} KB` : ""}</span>` +
    `</div>` +
    `<a class="gfc-btn" href="${escapeHtml(url)}" download="${escapeHtml(name)}">` +
      `<i class="bi bi-download"></i> Download` +
    `</a>`;
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
            `<button class="fpm-close-btn" title="Close (Esc)"><i class="bi bi-x-lg"></i></button>` +
          `</div>` +
        `</div>` +
        `<div class="fpm-body bubble skill-doc-body"></div>` +
      `</div>`;
    const close = () => overlay.classList.remove("open");
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector(".fpm-close-btn").addEventListener("click", close);
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
  messagesEl.appendChild(card);
  moveLiveIndicatorToBottom();
  scrollToBottom();
}

function _resolveToolCard(msg) {
  const card = _toolCards.get(msg.seq);
  if (!card) return;
  _toolCards.delete(msg.seq);
  card.classList.remove("pending");
  card.classList.add(msg.ok ? "ok" : "error");
  const time = card.querySelector(".tool-card-time");
  if (time && typeof msg.ms === "number") time.textContent = `${msg.ms}ms`;
  const result = card.querySelector(".tool-card-result");
  if (result) result.textContent = `↳ ${msg.summary || (msg.ok ? "done" : "error")}`;
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
