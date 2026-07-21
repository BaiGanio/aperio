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

// "unsloth/Qwen3.6-27B-GGUF:Q4_K_M" → "Qwen3.6-27B" — a status-label-sized
// model name (org, quant tag, and -GGUF suffix carry no meaning for the user).
function shortModelName(id) {
  const repo = String(id || "").split(":")[0];
  return (repo.includes("/") ? repo.slice(repo.indexOf("/") + 1) : repo).replace(/-GGUF$/i, "");
}

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

// Ambient coupling (issue #185 §A): drive the starfield's energy off the agent
// lifecycle so the background visibly works when the agent does — thinking
// stirs it, tool runs push harder, streaming settles it, idle calms it down.
// ambient.js eases toward the target, so step changes render as smooth swells.
function setAmbientLevel(level) {
  window.Aperio?.ambient?.setLevel?.(level);
}

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
    _syncStartupContextBar();
  }

  if (msg.type === "provider") {
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
    setAmbientLevel(0.5);
    sendBtn.disabled = true;
    // Round-table turns carry an agent_id — their working cue is the per-agent
    // phase breadcrumb, so we don't also raise the global "thinking…" line
    // (which previously stranded above the first agent's bubble).
    if (!msg.agent_id && !document.getElementById("thinking")) addThinking();
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
    if (!msg.agent_id && !document.getElementById("thinking")) addThinking();
    const key = TOOL_LABEL_KEYS && TOOL_LABEL_KEYS[msg.name];
    const labelText = key ? t(key) : t("tool_generic", { name: msg.name });
    const label = document.querySelector("#thinking .thinking-label");
    if (label) label.textContent = labelText;
    moveLiveIndicatorToBottom();
    setStatus("thinking", labelText);
    setAmbientLevel(0.75);
  }

  if (msg.type === "model_status") {
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
  }

  if (msg.type === "token") {
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
  }

  if (msg.type === "retract") {
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
    return;
  }

  if (msg.type === "stream_end") {
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
      window.resetContextBar?.(maxCtx);
      const note = document.createElement("div");
      note.className = "ctx-banner ctx-banner--trimmed";
      note.style.cssText = "font-size:10px;opacity:0.75;";
      const text = msg.saved ? t("ctx_summarize_ok") : t("ctx_summarize_no_save");
      note.innerHTML = `<span class="ctx-banner-text">${text}</span>` +
        `<button class="ctx-banner-btn" data-action="removeParent">${t("ctx_dismiss")}</button>`;
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

  if (msg.type === "session_branched") {
    if (!msg.ok) { addMessage("ai", "Couldn't branch — not enough conversation yet."); return; }
    const banner = document.createElement("div");
    banner.className = "ctx-banner";
    banner.innerHTML =
      `<span class="ctx-banner-text">${t("branch_created") || "↳ Branched:"} ${msg.title || ""}</span>` +
        `<button class="ctx-banner-btn" data-action="removeParent">${t("ctx_dismiss")}</button>`;
    document.querySelector(".chat-area")?.prepend(banner);
    document.getElementById("messages").innerHTML = "";
  }

  if (msg.type === "memories") {
    renderMemoriesFromMessage(msg.memories);
  }

  if (msg.type === "deleted") {
    allMemories = allMemories.filter(m => m.id !== msg.id);
    renderMemories(allMemories);
  }

  if (msg.type === "ttl_chip") {
    _renderTtlChip(msg);
    return;
  }

  if (msg.type === "skills_matched") {
    if (msg.skills?.length) _renderSkillsChip(msg.skills);
    return;
  }

  if (msg.type === "capability_notice") {
    if (msg.kind === "images_dropped") _renderCapabilityNotice(t("images_dropped_notice", { provider: msg.provider }));
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

  if (msg.type === "interrupts") {
    _renderPendingInterrupts(msg.interrupts || []);
    return;
  }

  if (msg.type === "interrupt_decided") {
    document.querySelector(`.action-confirm-wrap[data-interrupt-id="${CSS.escape(msg.interrupt?.id || "")}"]`)?.remove();
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

  if (msg.type === "slow_local_turn_detected") {
    _renderSlowTurnWarning(msg.model, msg.genTps, msg.hint);
    return;
  }

  if (msg.type === "error") {
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

  // ── Discuss entry flow (summarize → confirm) ──────────────────────────────
  if (msg.type === "discuss_summary") {
    removeThinking();
    if (msg.ok && msg.text) _renderDiscussSummaryCard(msg.text);
    // ok:false → nothing to summarize; the toggle is already armed silently.
    return;
  }

  if (msg.type === "discuss_staged") {
    _renderDiscussStagedNotes();
    return;
  }

  if (msg.type === "discuss_declined") {
    _renderDiscussNote("primary", t("discuss_declined_note"));
    return;
  }
}
