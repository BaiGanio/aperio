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

function estimateTokens(text) {
  if (!text || !text.trim()) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

function setUserTokenEstimate(n) { pendingUserTokenEstimate = n; }

function handleMessage(msg) {
  if (msg.type === "status") {
    // initial connection ack
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
  }

  if (msg.type === "token") {
    if (msg.text) {
      const reasoningOn = localStorage.getItem("aperio-reasoning") !== "false";
      if (isReasoningActive && reasoningOn) return;
      if (!streamingBubble) {
        removeThinking();
        removeToolIndicator();
        streamingBubble = createStreamingBubble();
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
      _maybeShowStartupBanner(msg.usage?.input_tokens);
      _annotateTokenBadges(msg.usage?.input_tokens, accThinkingTokens);
      accThinkingTokens = 0; accOutputTokens = 0;
    } else if (streamingBubble) {
      streamingBubble.wrap?.remove();
    } else if (!streamingText && msg.text?.trim()) {
      removeThinking();
      removeToolIndicator();
      addMessage("ai", msg.text);
      _maybeShowStartupBanner(msg.usage?.input_tokens);
      _annotateTokenBadges(msg.usage?.input_tokens, accThinkingTokens);
      accThinkingTokens = 0; accOutputTokens = 0;
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

  if (msg.type === "context_summarized") {
    dismissContextBanner();
    if (!msg.ok) {
      addMessage("ai", t("ctx_summarize_failed", { reason: msg.reason }));
    } else if (!msg.saved) {
      const note = document.createElement("div");
      note.className = "ctx-banner ctx-banner--trimmed";
      note.style.cssText = "font-size:10px;opacity:0.75;";
      note.innerHTML = `<span class="ctx-banner-text">${t("ctx_summarize_no_save")}</span>` +
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
}

function createStreamingBubble() {
  const wrap = document.createElement("div");
  wrap.className = "message ai";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  avatar.textContent = "A";

  const bubble = document.createElement("div");
  bubble.className = "bubble streaming";
  bubble.innerHTML = '<span class="cursor">▋</span>';

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";
  col.appendChild(bubble);

  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return { wrap, bubble, col };
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
  const memCount = Array.isArray(allMemories) ? allMemories.length : 0;
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
