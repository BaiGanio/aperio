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
// Round-table state. _nextBubbleAgent is set on stream_start and consumed by
// createStreamingBubble() so the bubble is styled with the right agent colour.
// _roundtableAgents is populated from the `provider` event for badge labels.
let _nextBubbleAgent = null;
let _roundtableAgents = [];
let _roundtablePhaseChip = null;
let _pendingGeneratedFile = null;

function estimateTokens(text) {
  if (!text || !text.trim()) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

function setUserTokenEstimate(n) { pendingUserTokenEstimate = n; }

function handleMessage(msg) {
  if (msg.type === "status") {
    // initial connection ack
  }

  if (msg.type === "preload_mem_count") {
    _preloadMemCount = msg.count ?? 0;
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

    const toggle = document.getElementById("reasoningToggle");
    if (toggle) toggle.style.display = msg.thinks ? "flex" : "none";

    if (msg.contextWindow) maxCtx = msg.contextWindow;
  }

  if (msg.type === "session_created") {
    if (typeof setCurrentSessionId === "function") setCurrentSessionId(msg.id);
  }

  if (msg.type === "paths_restored") {
    if (typeof notifyPathsChanged === "function") notifyPathsChanged(msg.readPaths, msg.writePaths);
    const note = document.createElement("div");
    note.className = "suggestions-saved-note";
    note.innerHTML = t("sessions_paths_restored");
    document.getElementById("messages")?.appendChild(note);
    setTimeout(() => note.remove(), 4000);
  }

  if (msg.type === "paths_updated") {
    if (typeof notifyPathsChanged === "function") notifyPathsChanged(msg.readPaths, msg.writePaths);
  }

  if (msg.type === "thinking") {
    suggestionShown = false;
    setStatus("thinking", t("status_thinking"));
    sendBtn.disabled = true;
    if (!document.getElementById("thinking")) addThinking();
  }

  if (msg.type === "tool") {
    removeToolIndicator();
    const label = document.querySelector("#thinking .thinking-label");
    if (label) {
      const key = TOOL_LABEL_KEYS && TOOL_LABEL_KEYS[msg.name];
      label.textContent = key ? t(key) : t("tool_generic", { name: msg.name });
    }
  }

  if (msg.type === "reasoning_start") {
    isReasoningActive = true;
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
    const label = document.querySelector("#thinking .thinking-label");
    if (label) label.textContent = t("status_typing");
    setStatus("thinking", t("status_typing"));
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
        removeThinking();
        removeToolIndicator();
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
      ? { outputTokens: accOutputTokens, thinkingTokens: accThinkingTokens, elapsedSec }
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

  if (msg.type === "generated_file") {
    _pendingGeneratedFile = msg;
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
}

function _phaseLabel(phase) {
  if (phase === "review")   return t("roundtable_phase_review");
  if (phase === "revise")   return t("roundtable_phase_revise");
  if (phase === "rereview") return t("roundtable_phase_rereview");
  if (phase === "answer")   return t("roundtable_phase_answer");
  return phase || "";
}

function _renderRoundtablePhaseChip(phase, agentId) {
  // Replace the prior chip (one in flight at a time — round-table is sequential).
  _roundtablePhaseChip?.remove();
  const chip = document.createElement("div");
  chip.className = "roundtable-phase-chip";
  if (agentId) chip.classList.add(`roundtable-phase-${agentId}`);
  chip.textContent = _phaseLabel(phase);
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
    badge.textContent = (a.id === "verifier" ? "B" : "A");
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
  const card = document.createElement("div");
  card.className = "roundtable-no-consensus";

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

  messagesEl.appendChild(card);
  highlightAll?.();
  scrollToBottom();
}

function createStreamingBubble(agentMeta = null) {
  const wrap = document.createElement("div");
  wrap.className = "message ai";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  // Round-table avatars: "A" for primary, "B" for verifier. Falls back to "A"
  // for the single-agent path so existing chats look identical to before.
  let avatarLetter = "A";
  if (agentMeta?.persona === "verifier" || agentMeta?.agentId === "verifier") avatarLetter = "B";
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
  const letter = agentMeta.agentId === "verifier" ? "B" : "A";
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
    badge.textContent = label;
    col.appendChild(badge);
  }

  highlightAll();
}

function _maybeShowStartupBanner(inputTok) {
  if (startupBannerShown) return;
  startupBannerShown = true;
  const memCount = _preloadMemCount > 0 ? _preloadMemCount : (Array.isArray(allMemories) ? allMemories.length : 0);
  if (memCount === 0 && !_preloadToolCount) return;
  const parts = [];
  if (inputTok) parts.push(t("startup_tokens_from", { n: inputTok.toLocaleString() }));
  if (memCount) parts.push(memCount === 1 ? t("startup_memory_one") : t("startup_memory_many", { n: memCount }));
  if (_preloadToolCount) parts.push(_preloadToolCount === 1 ? t("startup_tool_one") : t("startup_tool_many", { n: _preloadToolCount }));
  const banner = document.createElement("div");
  banner.className = "ctx-banner ctx-banner--memories";
  banner.innerHTML =
    `<span class="ctx-banner-text">${parts.join(' · ')}</span>` +
    `<button class="ctx-banner-btn" onclick="this.parentElement.remove()">${t("ctx_dismiss")}</button>`;
  document.querySelector(".chat-area")?.prepend(banner);
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
  localStorage.setItem("aperio-reasoning", cur ? "false" : "true");
  updateReasoningBtn();
}

function updateReasoningBtn() {
  const on  = localStorage.getItem("aperio-reasoning") !== "false";
  const btn = document.getElementById("reasoningToggle");
  const lbl = document.getElementById("reasoningToggleLabel");
  if (!btn) return;
  btn.style.color   = on ? "var(--text)"       : "var(--text-muted)";
  btn.style.opacity = on ? "1"                 : "0.45";
  if (lbl) lbl.textContent = on ? "on" : "off";
  btn.title = on ? "Disable reasoning" : "Enable reasoning";
}

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

function _buildGeneratedFileCard({ filename, url, sizeKb }) {
  const card = document.createElement("div");
  card.className = "generated-file-card";
  card.innerHTML =
    `<div class="gfc-icon"><i class="bi bi-file-earmark-spreadsheet"></i></div>` +
    `<div class="gfc-info">` +
      `<span class="gfc-name">${escapeHtml(filename || "spreadsheet.xlsx")}</span>` +
      `<span class="gfc-meta">Excel${sizeKb ? ` · ${sizeKb} KB` : ""}</span>` +
    `</div>` +
    `<a class="gfc-btn" href="${escapeHtml(url)}" download="${escapeHtml(filename || "spreadsheet.xlsx")}">` +
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

  const toggle = document.createElement("button");
  toggle.className = "recall-pill-toggle";
  toggle.innerHTML =
    `<span class="recall-asterisk">✦</span>` +
    `<span class="recall-pill-label">${label}</span>` +
    (topScores ? `<span class="recall-pill-scores">${topScores}</span>` : "") +
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
