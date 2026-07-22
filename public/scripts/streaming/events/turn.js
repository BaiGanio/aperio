// public/scripts/streaming/events/turn.js
// The chat turn itself: thinking/tool phases, the reasoning bubble, token
// streaming, and the terminal stream_end / error settlement. These handlers own
// the mutable streaming state declared in state.js — no other domain writes it.

onStreamEvent("thinking", (msg) => {
  suggestionShown = false;
  enterPhase("thinking");
  setStatus("thinking", t("status_thinking"));
  setAmbientLevel(0.5);
  sendBtn.disabled = true;
  // Round-table turns carry an agent_id — their working cue is the per-agent
  // phase breadcrumb, so we don't also raise the global "thinking…" line
  // (which previously stranded above the first agent's bubble).
  if (!msg.agent_id && !document.getElementById("thinking")) addThinking();
});

onStreamEvent("tool", (msg) => {
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
  if (!msg.agent_id && !document.getElementById("thinking")) addThinking();
  const key = TOOL_LABEL_KEYS && TOOL_LABEL_KEYS[msg.name];
  const labelText = key ? t(key) : t("tool_generic", { name: msg.name });
  const label = document.querySelector("#thinking .thinking-label");
  if (label) label.textContent = labelText;
  moveLiveIndicatorToBottom();
  setStatus("thinking", labelText);
  setAmbientLevel(0.75);
});

onStreamEvent("reasoning_start", () => {
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
});

onStreamEvent("reasoning_token", (msg) => {
  if (reasoningBubble && msg.text) {
    reasoningText += msg.text;
    reasoningBubble.pre.textContent = reasoningText;
    reasoningBubble.pre.scrollTop = reasoningBubble.pre.scrollHeight;
    scrollToBottom();
  }
});

onStreamEvent("reasoning_done", () => {
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
});

onStreamEvent("stream_start", (msg) => {
  streamStartTime = Date.now();
  _answerArtifacts = [];   // belongs to the turn that just ended, not this one
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
  } else if (streamingText) {
    // Defensive reset for a held prefix if a provider starts a replacement
    // stream without first sending the expected retract/stream_end pair.
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
});

onStreamEvent("token", (msg) => {
  if (msg.text) {
    const reasoningOn = localStorage.getItem("aperio-reasoning") !== "false";
    if (isReasoningActive && reasoningOn) return;
    streamingText += msg.text;
    if (!streamingBubble) {
      // Probe a short prefix before showing it. Suspicious tool-call-shaped
      // content remains buffered until stream_end, giving a late server-side
      // retract a chance to erase it without flashing raw syntax to the user.
      if (globalThis.AperioStreamPrefixGuard?.shouldHoldLeadingContent(streamingText)) return;
      // First visible token of the answer — now "typing" is true. Mark the
      // phase (drops the "thinking…" breadcrumb) and flip the header, then
      // tear down the live line; the streaming text itself is the indicator.
      enterPhase("typing");
      setStatus("thinking", t("status_typing"));
      setAmbientLevel(0.6);
      removeThinking();
      removeToolIndicator();
      document.getElementById("preparing-answer")?.remove();
      streamingBubble = createStreamingBubble(_nextBubbleAgent);
    }
    _scheduleStreamRender();
  }
});

onStreamEvent("retract", () => {
  if (streamingBubble) {
    streamingBubble.wrap?.remove();
    streamingBubble = null;
  }
  // A suspicious prefix may still be held without a bubble. Always clear the
  // buffer so it cannot bleed into the retry's stream_start.
  streamingText = "";
  const lastAI = [...messagesEl.querySelectorAll('.message.ai')].at(-1);
  if (lastAI) {
    const bubble = lastAI.querySelector('.bubble');
    const text = bubble?.textContent || "";
    if (text.trim().startsWith("{") || text.includes('"name"')) lastAI.remove();
  }
});

onStreamEvent("stream_end", (msg) => {
  const perStreamMs = streamStartTime ? (Date.now() - streamStartTime) : 0;
  streamStartTime = null;
  // A provider can emit text, then a tool event, then more text into the same
  // bubble. The tool event recreates the live indicator, so always clear it
  // here rather than only when stream_end has no streaming bubble.
  removeThinking();
  removeToolIndicator();
  // Round-table: once this agent's bubble has streamed in, freeze its phase
  // breadcrumb to "done" so it never reads as still-working (incl. manifestos).
  const _rtAgentDone = streamingBubble?.agentMeta?.agentId;
  // NB: this stream_end may be the inter-tool one (sent before a tool runs),
  // not the end of the turn — so the live request timer is only stopped in the
  // terminal branches below (a real answer), not here.
  for (const c of _toolCards.values()) {
    if (c._timerId) { clearInterval(c._timerId); c._timerId = null; }
  }
  accThinkingTokens += msg.usage?.thinking_tokens ?? 0;
  accOutputTokens += msg.usage?.output_tokens ?? 0;
  const totalElapsedSec = requestStartTime
    ? (Date.now() - requestStartTime) / 1000
    : (perStreamMs / 1000);
  const responseStats = (totalElapsedSec > 0 && msg.usage?.output_tokens)
    ? {
        outputTokens: accOutputTokens,
        thinkingTokens: accThinkingTokens,
        elapsedSec: totalElapsedSec,
        inputTokens: msg.usage?.input_tokens ?? 0,
        inputTokensKind: msg.usage?.input_tokens_kind ?? "context",
        timings: msg.usage?.timings ?? null,
      }
    : null;
  if (streamingBubble && streamingText.trim()) {
    settleTurnTimer();
    finalizeStreamingBubble(streamingBubble, streamingText, responseStats);
    for (const f of _pendingGeneratedFiles) streamingBubble.bubble.appendChild(_buildGeneratedFileCard(f)); _pendingGeneratedFiles.length = 0;
    window.Aperio?.tts?.speak(streamingText);
    window.Aperio?.voice?.onStreamEnd?.();
    _refineStartupBanner(msg.usage?.input_tokens, msg.usage?.input_tokens_kind);
    _annotateTokenBadges(msg.usage?.input_tokens, accThinkingTokens);
    accThinkingTokens = 0; accOutputTokens = 0;
  } else if (streamingBubble) {
    streamingBubble.wrap?.remove();
  } else if (!streamingBubble && (streamingText || msg.text || "").trim()) {
    // Content deliberately held by the prefix guard is still a valid answer
    // when the server accepts it. Render it once, at stream_end.
    const finalText = streamingText || msg.text;
    removeThinking();
    removeToolIndicator();
    addMessage("ai", finalText);
    settleTurnTimer();
    window.Aperio?.tts?.speak(finalText);
    window.Aperio?.voice?.onStreamEnd?.();
    _refineStartupBanner(msg.usage?.input_tokens, msg.usage?.input_tokens_kind);
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
  if (_rtAgentDone) _settleRoundtablePhaseChip();
  streamingBubble = null;
  streamingText = "";
  isThinking = false;
  setStatus("connected", t("status_connected"));
  // Calm back down. If voice responses are on, tts.js takes over from here
  // (its utterance onstart/onboundary handlers re-raise the level per word).
  setAmbientLevel(0);
  sendBtn.disabled = chatInput.value.trim() === "";
  sendBtn.style.display = "";
  stopBtn.style.display = "none";
  scrollToBottom();
  if (msg.usage) {
    // Codex CLI reports aggregate work across the agent's internal model/tool
    // steps. That is useful usage data, but it is not live context occupancy.
    if (msg.usage.input_tokens_kind !== "aggregate") {
      updateContextBar(msg.usage.input_tokens ?? 0, maxCtx, msg.usage.output_tokens ?? 0);
    }
  }
});

onStreamEvent("error", (msg) => {
  removeThinking();
  removeToolIndicator();
  isThinking = false;
  setStatus("connected", "error");
  setAmbientLevel(0);
  sendBtn.disabled = chatInput.value.trim() === "";
  sendBtn.style.display = "";
  stopBtn.style.display = "none";
  addMessage("ai", `⚠️ ${msg.text}`);
  settleTurnTimer();
});
