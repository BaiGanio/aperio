// ── Type config ──────────────────────────────────────────────
const TYPE_CONFIG = {
  fact:       { icon: "◈", label: "Facts" },
  preference: { icon: "◎", label: "Preferences" },
  project:    { icon: "◱", label: "Projects" },
  decision:   { icon: "◇", label: "Decisions" },
  solution:   { icon: "◈", label: "Solutions" },
  source:     { icon: "◉", label: "Sources" },
  person:     { icon: "◯", label: "People" },
};

// ── State ────────────────────────────────────────────────────
let ws, pendingSuggestion = null, isThinking = false, hasInitialized = false;
let allMemories = []; // Global store for the current modal session
let currentPage = 1;
const recordsPerPage = 3;

// ── DOM refs ─────────────────────────────────────────────────
const messagesEl   = document.getElementById("messages");
const chatInput    = document.getElementById("chatInput");
const sendBtn      = document.getElementById("sendBtn");
const stopBtn      = document.getElementById("stopBtn");
const statusDot    = document.getElementById("statusDot");
const statusText   = document.getElementById("statusText");
const memoriesList = document.getElementById("memoriesList");
const searchInput  = document.getElementById("searchInput");

// ── WebSocket ────────────────────────────────────────────────
function toggleReasoning() {
  const cur = localStorage.getItem("aperio-reasoning") !== "false";
  localStorage.setItem("aperio-reasoning", cur ? "false" : "true");
  updateReasoningBtn();
}

function updateReasoningBtn() {
  const on = localStorage.getItem("aperio-reasoning") !== "false";
  const btn = document.getElementById("reasoningToggle");
  const lbl = document.getElementById("reasoningToggleLabel");
  if (!btn) return;
  btn.style.borderColor = on ? "var(--accent)" : "var(--border)";
  btn.style.color       = on ? "var(--accent)" : "var(--text-muted)";
  btn.style.opacity     = on ? "1" : "0.5";
  if (lbl) lbl.textContent = on ? "reasoning on" : "reasoning off";
  btn.title = on ? "Click to hide reasoning" : "Click to show reasoning";
}

window.addEventListener("DOMContentLoaded", updateReasoningBtn);

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    document.getElementById("startup-thinking")?.remove();
    if (!hasInitialized) {
      hasInitialized = true;
      setStatus("thinking", "loading…");
      addThinking();
      ws.send(JSON.stringify({ type: "init" }));
    } else {
      setStatus("connected", "reconnected");
      sendBtn.disabled = chatInput.value.trim() === "" || isThinking;
    }
  };

  ws.onclose = () => {
    setStatus("", "disconnected");
    sendBtn.disabled = true;
    setTimeout(connect, 3000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };
}

function setStatus(cls, text) {
  statusDot.className = "status-dot " + cls;
  statusText.textContent = text;
  if (cls === "thinking") {
    startTitleAnimation();
  } else {
    stopTitleAnimation();
  }
}

// Animated thinking title
let titleAnimFrame = null;
const titleDots = ["", ".", "..", "..."];
let titleDotIdx = 0;

function startTitleAnimation() {
  if (titleAnimFrame) return;
  titleDotIdx = 0;
  titleAnimFrame = setInterval(() => {
    document.title = "● Aperio is thinking" + titleDots[titleDotIdx % titleDots.length];
    titleDotIdx++;
  }, 400);
}

function stopTitleAnimation() {
  if (titleAnimFrame) { clearInterval(titleAnimFrame); titleAnimFrame = null; }
  document.title = "Aperio";
}

// ── Message handler ──────────────────────────────────────────
let reasoningBubble = null;
let reasoningText = "";
let streamingBubble = null;
let streamingText = "";
let isReasoningActive = false; // true while model is inside <think> / reasoning phase
let suggestionShown = false;

function handleMessage(msg) {

  if (msg.type === "status") {
    // initial connection ack
  }

  if (msg.type === "provider") {
    document.getElementById("startup-thinking")?.remove();
    const badge = document.getElementById("providerBadge");
    if (badge) {
      const isOllama = msg.name === "ollama";
      let label;
      if (isOllama) {
        label = `⬡ ${msg.model}`;
      } else {
        const m = msg.model;
        label = `✦ ${m.includes("haiku") ? "haiku" : m.includes("sonnet") ? "sonnet" : m.includes("opus") ? "opus" : m}`;
      }
      badge.textContent = label;
      badge.title = `${msg.name} — ${msg.model}`;
      badge.style.display = "inline";
      badge.style.background = isOllama ? "rgba(34,197,94,.15)" : "var(--accent-soft)";
      badge.style.color      = isOllama ? "#22c55e"             : "var(--accent)";
    }
  }

  if (msg.type === "thinking") {
    suggestionShown = false;
    setStatus("thinking", "thinking…");
    sendBtn.disabled = true;
    if (!document.getElementById("thinking")) addThinking();
  }

  if (msg.type === "tool") {
    removeToolIndicator();
    const label = document.querySelector("#thinking .thinking-label");
    if (label) label.textContent = TOOL_LABELS[msg.name] || "Working…";
  }

  if (msg.type === "reasoning_start") {
    isReasoningActive = true;
    document.getElementById("preparing-answer")?.remove();
    // Close any previous bubble cleanly before starting a new one
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = "done";
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
      reasoningText = "";
    }
    // Respect toggle — if off, don't create a bubble
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
    statusSpan.textContent = "thinking…";
    summary.appendChild(document.createTextNode("🧠 Reasoning "));
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
    reasoningBubble = { wrap, pre, details, statusSpan };
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
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = "done";
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
    }
    // Fallback: collapse any unclosed reasoning bubble still in DOM

    const lastWrap = [...messagesEl.querySelectorAll(".reasoning-wrap")].at(-1);
    if (lastWrap) {
      const details = lastWrap.querySelector("details");
      const span = lastWrap.querySelector(".reasoning-bubble summary span");
      if (details) details.removeAttribute("open");
      if (span) { span.textContent = "done"; span.style.animation = "none"; span.style.opacity = "0.4"; }
    }
    reasoningText = "";
    removeThinking();
    // Show "preparing answer" indicator
    document.getElementById("preparing-answer")?.remove();
    const prep = document.createElement("div");
    prep.id = "preparing-answer";
    prep.style.cssText = "padding:6px 0 0 38px;font-size:11px;font-family:var(--font-mono);color:var(--text-muted);opacity:0.6;animation:labelFade 1.8s ease infinite";
    prep.textContent = "✦ preparing answer…";
    messagesEl.appendChild(prep);
    scrollToBottom();
    return;
  }

  if (msg.type === "stream_start") {
    isReasoningActive = false; // reasoning phase is over, answer is coming
    // Safety net: collapse reasoning bubble if still open
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = "done";
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
    }
    const label = document.querySelector("#thinking .thinking-label");
    if (label) label.textContent = "typing…";
    setStatus("thinking", "typing…");
    // NOTE: do NOT null streamingBubble here — tokens may arrive after this
  }

  if (msg.type === "token") {
    if (msg.text) {
      const reasoningOn = localStorage.getItem("aperio-reasoning") !== "false";
      // If reasoning toggle is ON and model is still in reasoning phase, discard content tokens
      // (the answer will arrive via stream_end after reasoning completes)
      if (isReasoningActive && reasoningOn && reasoningBubble) return;
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
    // Remove any streaming bubble that showed tool call JSON
    if (streamingBubble) {
      streamingBubble.wrap?.remove();
      streamingBubble = null;
      streamingText = "";
    }
    // Also remove the last AI message bubble if it contains JSON
    const lastAI = [...messagesEl.querySelectorAll('.message.ai')].at(-1);
    if (lastAI) {
      const bubble = lastAI.querySelector('.bubble');
      const text = bubble?.textContent || "";
      if (text.trim().startsWith("{") || text.includes('"name"')) lastAI.remove();
    }
    return;
  }

  if (msg.type === "stream_end") {
    if (streamingBubble && streamingText.trim()) {
      // Tokens were streamed — finalize the existing bubble, ignore msg.text entirely
      finalizeStreamingBubble(streamingBubble, streamingText);
    } else if (streamingBubble) {
      streamingBubble.wrap?.remove();
    } else if (!streamingText && msg.text?.trim()) {
      // Truly buffered response: no tokens ever arrived, render msg.text directly
      removeThinking();
      removeToolIndicator();
      addMessage("ai", msg.text);
    }
    document.getElementById("preparing-answer")?.remove();
    streamingBubble = null;
    streamingText = "";
    isThinking = false;
    setStatus("connected", "connected");
    sendBtn.disabled = chatInput.value.trim() === "";
    sendBtn.style.display = "";
    stopBtn.style.display = "none";
    scrollToBottom();
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
    const label = lang || "code";
    const langClass = lang ? ` class="language-${lang}"` : "";
    const blockHtml =
      `<div class="code-block">` +
      `<div class="code-toolbar"><span class="code-lang">${label}</span>` +
      `<span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono)">streaming…</span></div>` +
      `<pre><code${langClass}>${escaped}</code></pre></div>`;

    ref.bubble.innerHTML = beforeHtml + blockHtml + '<span class="cursor">▋</span>';
  } else {
    ref.bubble.innerHTML = renderMarkdown(text) + '<span class="cursor">▋</span>';
    highlightAll();
  }
  scrollToBottom();
}

// ── Chat UI ──────────────────────────────────────────────────
function finalizeStreamingBubble(ref, fullText) {
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

  // Add timestamp below bubble
  const ts = document.createElement("div");
  ts.className = "msg-timestamp";
  ts.textContent = "just now";
  ts.dataset.ts = Date.now();
  ref.wrap.querySelector("div[style]")?.appendChild(ts) ||
    ref.wrap.appendChild(ts);

  highlightAll();
}

function getUserInitial() {
  const nameMem = allMemories.find(m =>
    m.type === "person" && (m.title.toLowerCase().includes("my name") || m.tags?.includes("self"))
  ) || allMemories.find(m => m.title.toLowerCase().startsWith("my name"));
  if (nameMem) {
    const name = nameMem.content?.trim() || nameMem.title;
    return name.charAt(0).toUpperCase();
  }
  return "U";
}

function addMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role === "user" ? "user" : "ai"}`;

  const avatar = document.createElement("div");
  avatar.className = `avatar ${role === "user" ? "user" : "ai"}`;
  avatar.textContent = role === "user" ? (getUserInitial()) : "A";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (text.includes("🧠 **Memory suggestions**") && !suggestionShown) {
    suggestionShown = true;
    const [before, after] = text.split("🧠 **Memory suggestions**");
    bubble.innerHTML = renderMarkdown(before.trim());
    bubble.appendChild(parseSuggestionBlock(after));
  } else {
    bubble.innerHTML = renderMarkdown(text);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function renderMarkdown(text) {
  const blocks = [];
  text = text.replace(/```(\w*)[ \t]*\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = "cb-" + Math.random().toString(36).slice(2, 8);
    const label = lang || "code";
    const langClass = lang ? ' class="language-' + lang + '"' : "";
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const idx = blocks.length;
    blocks.push(
      '<div class="code-block">' +
      '<div class="code-toolbar"><span class="code-lang">' + label + '</span>' +
      '<button class="copy-btn" onclick="copyCode(\'' + id + '\')">' +
      '<i class="bi bi-clipboard"></i> copy</button></div>' +
      '<pre><code id="' + id + '"' + langClass + '>' + escaped.trimEnd() + '</code></pre></div>'
    );
    return "\x00" + idx + "\x00";
  });
  text = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^\n*]+?)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, "<br>").replace(/<br>(<div)/g, "$1");
  text = text.replace(/\x00(\d+)\x00/g, (_, i) => blocks[parseInt(i)]);
  return text;
}

function highlightAll() {
  if (window.Prism) Prism.highlightAll();
}

function copyCode(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    const btn = el.closest(".code-block")?.querySelector(".copy-btn");
    if (!btn) return;
    btn.innerHTML = '<i class="bi bi-clipboard-check"></i> copied!';
    btn.classList.add("copied");
    setTimeout(() => {
      btn.innerHTML = '<i class="bi bi-clipboard"></i> copy';
      btn.classList.remove("copied");
    }, 2000);
  });
}

function parseSuggestionBlock(text) {
  const div = document.createElement("div");
  div.className = "memory-suggestion";

  const title = document.createElement("div");
  title.className = "memory-suggestion-title";
  title.textContent = "✦ Memory suggestions";
  div.appendChild(title);

  const lines = text.split("\n").filter(l => /^\d+\./.test(l.trim()));
  pendingSuggestion = { lines, indices: [] };

  lines.forEach((line, i) => {
    const item = document.createElement("div");
    item.className = "suggestion-item";
    item.innerHTML = `<div class="suggestion-num">${i+1}</div><span>${renderMarkdown(line.replace(/^\d+\.\s*/, ""))}</span>`;
    div.appendChild(item);
  });

  const actions = document.createElement("div");
  actions.className = "suggestion-actions";

  const saveAll = document.createElement("button");
  saveAll.className = "btn btn-primary";
  saveAll.textContent = "Save all";
  saveAll.onclick = () => sendSuggestionResponse("all", lines.map((_, i) => i+1));

  const none = document.createElement("button");
  none.className = "btn btn-ghost";
  none.textContent = "Skip";
  none.onclick = () => sendSuggestionResponse("none", []);

  lines.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = `Save ${i+1}`;
    btn.onclick = () => sendSuggestionResponse("pick", [i+1]);
    actions.appendChild(btn);
  });

  actions.prepend(none);
  actions.prepend(saveAll);
  div.appendChild(actions);

  return div;
}

function sendSuggestionResponse(mode, nums) {
  if (!ws) return;
  const text = mode === "none" ? "none" : nums.join(" ");
  addMessage("user", mode === "none" ? "Skip — don't save" : `Save suggestions: ${nums.join(", ")}`);
  ws.send(JSON.stringify({ type: "chat", text: `Please save memory suggestions: ${text}` }));
  pendingSuggestion = null;
}

function addThinking() {
  const el = document.createElement("div");
  el.className = "thinking";
  el.id = "thinking";
  el.innerHTML = `
    <div class="avatar ai">A</div>
    <div class="thinking-dots">
      <div class="thinking-dots-row">
        <div class="thinking-dot"></div>
        <div class="thinking-dot"></div>
        <div class="thinking-dot"></div>
      </div>
      <div class="thinking-label">thinking…</div>
    </div>`;
  messagesEl.appendChild(el);
  document.querySelector(".input-bar")?.classList.add("input-locked");
  document.getElementById("inputHint").textContent = "Aperio is thinking…";
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeThinking() {
  document.getElementById("thinking")?.remove();
  document.querySelector(".input-bar")?.classList.remove("input-locked");
  document.getElementById("preparing-answer")?.remove();
  const inputHint = document.getElementById("inputHint");
  if (inputHint) inputHint.innerHTML = `${cmdKey}↵ to send &nbsp;·&nbsp; Shift↵ for newline`;
}

let toolEl = null;
const TOOL_LABELS = {
  recall:             "Searching memories…",
  remember:           "Saving memory…",
  forget:             "Deleting memory…",
  update_memory:      "Updating memory…",
  backfill_embeddings:"Generating embeddings…",
  dedup_memories:     "Checking for duplicates…",
  read_file:          "Reading file…",
  scan_project:       "Scanning project…",
  fetch_url:          "Fetching URL…",
};

function addToolIndicator(name) {
  removeToolIndicator();
  toolEl = document.createElement("div");
  toolEl.className = "tool-indicator";
  const label = TOOL_LABELS[name] || `Using ${name}…`;
  toolEl.innerHTML = `<div class="tool-spinner"></div> ${label}`;
  messagesEl.appendChild(toolEl);
  scrollToBottom();
}

function removeToolIndicator() {
  toolEl?.remove();
  toolEl = null;
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ── WebSocket safe send ──────────────────────────────────────
function safeSend(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
}

// ── Send ─────────────────────────────────────────────────────
function send() {
  const text = chatInput.value.trim();
  if (!text || isThinking || !ws) return;
  addMessage("user", text);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  chatInput.value = "";
  autoResize();
  sendBtn.disabled = true;
  isThinking = true;
  sendBtn.style.display = "none";
  stopBtn.style.display = "flex";
  requestAnimationFrame(() => {
    removeThinking();
    setStatus("thinking", "thinking…");
    addThinking();
    safeSend(JSON.stringify({ type: "chat", text }));
  });
}

sendBtn.onclick = send;
stopBtn.onclick = () => {
  safeSend(JSON.stringify({ type: "stop" }));
  removeThinking();
  removeToolIndicator();
  document.getElementById("preparing-answer")?.remove();
  isThinking = false;
  sendBtn.style.display = "";
  stopBtn.style.display = "none";
  sendBtn.disabled = chatInput.value.trim() === "";
};

chatInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    send();
  }
});

chatInput.addEventListener("input", () => {
  autoResize();
  sendBtn.disabled = chatInput.value.trim() === "" || isThinking;
});

function autoResize() {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + "px";
  const counter = document.getElementById("charCounter");
  if (counter) {
    const len = chatInput.value.length;
    if (len > 200) {
      counter.textContent = `${len.toLocaleString()} chars`;
      counter.className = "char-counter visible" + (len > 2000 ? " verylong" : len > 800 ? " long" : "");
    } else {
      counter.className = "char-counter";
    }
  }
}

// ── Memories sidebar ─────────────────────────────────────────
function renderMemoriesFromMessage(memories) {
  allMemories = Array.isArray(memories) ? memories : [];
  renderMemories(allMemories);
}

const PREVIEW_COUNT = 3;
const expandedGroups = new Set();
const collapsedGroups = new Set(Object.keys(TYPE_CONFIG));

function renderMemories(memories) {
  if (!memories.length) {
    memoriesList.innerHTML = `
      <div class="empty-state" style="padding:24px 16px; text-align:center; line-height:1.8;">
        <div style="font-size:22px; margin-bottom:8px; opacity:.4">◈</div>
        <div style="font-weight:500; margin-bottom:6px; color:var(--text)">No memories yet</div>
        <div style="font-size:12px; color:var(--text-muted)">
          Tell Aperio something worth keeping.<br>
          Try: <em>"Remember that I prefer TypeScript"</em>
        </div>
      </div>`;
    return;
  }

  const grouped = {};
  memories.forEach(m => {
    if (!grouped[m.type]) grouped[m.type] = [];
    grouped[m.type].push(m);
  });

  memoriesList.innerHTML = "";
  const countEl = document.getElementById("memoryCount");
  if (countEl) countEl.textContent = memories.length ? `(${memories.length})` : "";

  Object.entries(grouped).forEach(([type, items]) => {
    const cfg = TYPE_CONFIG[type] || { icon: '<i class="bi bi-circle"></i>', label: type };
    const isCollapsed = collapsedGroups.has(type);
    const isExpanded = expandedGroups.has(type);
    const visible = isExpanded ? items : items.slice(0, PREVIEW_COUNT);
    const hasMore = items.length > PREVIEW_COUNT;

    const group = document.createElement("div");
    group.className = "type-group";

    const header = document.createElement("div");
    header.className = "type-header";
    header.innerHTML = `
      <span class="type-icon">${cfg.icon}</span>
      <span>${cfg.label}</span>
      <span class="type-count">${items.length}</span>
      <i class="bi bi-chevron-right type-chevron ${isCollapsed ? "" : "open"}"></i>`;
    header.onclick = () => {
      if (collapsedGroups.has(type)) collapsedGroups.delete(type);
      else collapsedGroups.add(type);
      renderMemories(allMemories);
    };
    group.appendChild(header);

    const body = document.createElement("div");
    body.className = `type-group-body ${isCollapsed ? "collapsed" : ""}`;

    visible.forEach(m => body.appendChild(makeMemoryCard(m)));

    if (hasMore) {
      const btn = document.createElement("button");
      btn.className = "show-more-btn";
      if (isExpanded) {
        btn.textContent = "▴ show less";
        btn.onclick = (e) => { e.stopPropagation(); expandedGroups.delete(type); renderMemories(allMemories); };
      } else {
        btn.textContent = `▾ ${items.length - PREVIEW_COUNT} more`;
        btn.onclick = (e) => { e.stopPropagation(); expandedGroups.add(type); renderMemories(allMemories); };
      }
      body.appendChild(btn);
    }

    group.appendChild(body);
    memoriesList.appendChild(group);
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (isNaN(date)) return "";
  const diff = Math.floor((Date.now() - date) / 1000);
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

function makeMemoryCard(m) {
  const card = document.createElement("div");
  card.className = "memory-card";

  const pips = Array.from({ length: 5 }, (_, i) =>
    `<div class="importance-pip ${i < m.importance ? "filled" : ""}"></div>`
  ).join("");

  const ts = timeAgo(m.createdAt);
  const jsonStr = JSON.stringify(m);
  const base64Data = btoa(unescape(encodeURIComponent(jsonStr)));
  card.innerHTML = `
    <div class="memory-card-header">
      <div class="memory-title">${escapeHtml(m.title)}</div>
      <button class="delete-btn" title="Delete memory"><i class="bi bi-trash3"></i></button>
    </div>
    <div class="memory-preview" data-memory='${base64Data}'>${escapeHtml(m.content)}</div>
    ${m.tags.length ? `<div class="memory-tags">${m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    <div class="importance-bar">
      ${pips}
      ${ts ? `<span class="memory-ts">${ts}</span>` : ""}
    </div>`;

  card.querySelector(".delete-btn").onclick = (e) => {
    e.stopPropagation();
    if (!m.id) return;
    if (!confirm(`Delete "${m.title}"?`)) return;
    card.style.opacity = "0.4";
    card.style.pointerEvents = "none";
    safeSend(JSON.stringify({ type: "delete_memory", id: m.id }));
  };

  return card;
}

function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ── Search ───────────────────────────────────────────────────
searchInput.addEventListener("input", () => {
  const q = searchInput.value.toLowerCase().trim();
  if (!q) {
    Object.keys(TYPE_CONFIG).forEach(t => collapsedGroups.add(t));
    renderMemories(allMemories);
    return;
  }
  const filtered = allMemories.filter(m =>
    m.title.toLowerCase().includes(q) ||
    m.content.toLowerCase().includes(q) ||
    m.tags.some(t => t.toLowerCase().includes(q))
  );
  const matchedTypes = new Set(filtered.map(m => m.type));
  Object.keys(TYPE_CONFIG).forEach(t => {
    if (matchedTypes.has(t)) collapsedGroups.delete(t);
    else collapsedGroups.add(t);
  });
  renderMemories(filtered);
});

// ── Export brain ─────────────────────────────────────────────
document.getElementById("exportBtn").addEventListener("click", () => {
  if (!allMemories.length) return;
  if (!confirm(`Export ${allMemories.length} memories to JSON?`)) return;
  const data = JSON.stringify(allMemories, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aperio-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── OS-aware shortcut labels ─────────────────────────────────
const isMac = navigator.userAgentData
  ? navigator.userAgentData.platform.toUpperCase().includes("MAC")
  : navigator.userAgent.toUpperCase().includes("MAC");
const cmdKey = isMac ? "⌘" : "Ctrl";

const inputHint = document.getElementById("inputHint");
const sendBtnEl = document.getElementById("sendBtn");
if (inputHint) inputHint.innerHTML = `${cmdKey}↵ to send &nbsp;·&nbsp; Shift↵ for newline`;
if (sendBtnEl) sendBtnEl.title = `Send (${cmdKey}+Enter)`;

// ── Sidebar toggle ───────────────────────────────────────────
const appEl = document.querySelector(".app");
const sidebarToggleBtn = document.getElementById("sidebarToggle");
let sidebarOpen = localStorage.getItem("aperio-sidebar") !== "closed";

function applySidebar() {
  appEl.classList.toggle("sidebar-collapsed", !sidebarOpen);
  sidebarToggleBtn.title = sidebarOpen ? `Hide sidebar (${cmdKey}B)` : `Show sidebar (${cmdKey}B)`;
  sidebarToggleBtn.querySelector("i").className = sidebarOpen
    ? "bi bi-layout-sidebar"
    : "bi bi-layout-sidebar-reverse";
  localStorage.setItem("aperio-sidebar", sidebarOpen ? "open" : "closed");
}

sidebarToggleBtn.addEventListener("click", () => {
  sidebarOpen = !sidebarOpen;
  applySidebar();
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    sidebarOpen = !sidebarOpen;
    applySidebar();
  }
});

applySidebar();

// ── Reasoning toggle ─────────────────────────────────────────
function showPreview(memory) {
    try {
        const mem = JSON.parse(memory);
        // Fill Title & Content
        document.querySelector('.mtitle').textContent = mem.title;
        document.querySelector('.mcontent').textContent = mem.content;

        // Visual Importance (Stars)
        // Generate the stars as HTML icons
        let starHTML = '';
        for (let i = 1; i <= 5; i++) {
            if (i <= mem.importance) {
                // Filled star icon
                starHTML += '<i class="bi bi-star-fill"></i>'; 
            } else {
                // Empty star icon
                starHTML += '<i class="bi bi-star"></i>';
            }
        }
        document.querySelector('.importance-rating').innerHTML = `Importance: <span class="stars">${starHTML}</span>`;

        // Tags (Chips)
        const tagHTML = mem.tags.map(tag => `<span>#${tag}</span>`).join('');
        document.querySelector('.mtags').innerHTML = tagHTML;
        
        // Type Badge
        const badge = document.querySelector('.type-badge');
        badge.textContent = mem.type.toUpperCase();
        badge.className = `type-badge ${mem.type}`; // Color it via CSS

        document.querySelector('.preview-modal').classList.add('active');
    } catch (e) {
        console.error("Could not parse memory data. Value was:", memory);
        return;
    }
}


function closePreview() {
  document.querySelector('.preview-modal').classList.remove('active');
}

document.addEventListener('click', (e) => {
  const modal = document.querySelector('.preview-modal');
  
  // 1. Handle Closing
  if (modal.classList.contains('active') && !e.target.closest('.preview-content')) {
    closePreview();
  }

  // 2. Handle Opening
  const target = e.target.closest('.memory-preview');
  if (target) {
    const jsonStr = decodeURIComponent(escape(atob(target.dataset.memory)));
    showPreview(jsonStr);
  }
});


// Close modal when pressing ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelector('.preview-modal')?.classList.remove('active');
  }
});

async function toggleMemoryView() {
    const modal = document.getElementById('memoryModal');
    if (!modal) {
        console.error("❌ memoryModal not found in this page's HTML.");
        return; 
    }
    modal.style.display = 'block'; // Show Modal
    await refreshMemories();
}

function closeModal() {
    document.getElementById('memoryModal').style.display = 'none';
}

async function refreshMemories() {
    try {
        const res = await fetch('/api/memories');
        const data = await res.json();
        
        // Save to both arrays initially
        allMemories = Array.isArray(data.raw) ? data.raw : [];
        filteredMemories = [...allMemories]; 
        
        // Reset search input
        const searchInput = document.getElementById('memory-search');
        if (searchInput) searchInput.value = '';
        currentPage = 1;
        renderTablePage();
    } catch (err) {
        document.getElementById('table-wrapper').innerHTML = `<p style="color:red;">${err.message}</p>`;
    }
}

function handleSearch() {
    const searchInput = document.getElementById('memory-search');
    if (!searchInput) return;
    
    const term = searchInput.value.toLowerCase();
    
    filteredMemories = allMemories.filter(m => {
        const meta = m.metadata || m;
        
        // --- SAFE TAG CONVERSION ---
        let tagsString = "";
        if (Array.isArray(meta.tags)) {
            tagsString = meta.tags.join(' ');
        } else if (typeof meta.tags === 'string') {
            tagsString = meta.tags;
        }

        // Combine all searchable text
        const searchBlob = `${meta.title || ''} ${meta.content || ''} ${tagsString}`.toLowerCase();
        
        return searchBlob.includes(term);
    });

    currentPage = 1;
    renderTablePage();
}


function renderTablePage() {
    // 1. Re-define the elements so this function can see them
    const wrapper = document.getElementById('table-wrapper');
    const pageInfo = document.getElementById('page-info');
    const controls = document.getElementById('pagination-controls'); // THIS WAS MISSING
    
    // Safety check: if we aren't on a page with a modal, stop
    if (!wrapper || !controls) return;

    if (filteredMemories.length === 0) {
        wrapper.innerHTML = '<p style="text-align:center; padding:20px; opacity:0.6;">no_results_found</p>';
        controls.style.display = 'none';
        return;
    }

    const start = (currentPage - 1) * recordsPerPage;
    const end = start + recordsPerPage;
    const pageItems = filteredMemories.slice(start, end);
    const totalPages = Math.ceil(filteredMemories.length / recordsPerPage) || 1;

    // 2. Now 'controls' is defined and won't crash
    controls.style.display = 'flex';
    if (pageInfo) {
        pageInfo.innerText = `page ${currentPage}/${totalPages} (${filteredMemories.length} results)`;
    }

    let html = `<table style="width:100%; border-collapse:collapse; font-size:14px;">
        <thead style="background:#f4f4f4;">
            <tr>
                <th style="padding:10px; text-align:left; width:80px;">Type</th>
                <th style="padding:10px; text-align:left;">Memory</th>
                <th style="padding:10px; text-align:center; width:40px;">Importance</th>
            </tr>
        </thead>
        <tbody>`;

    html += pageItems.map(m => {
        const meta = m.metadata || m;
        // Convert importance (1-5) into star symbols
        // We use Math.min/max to ensure it stays between 1 and 5 stars
        const importance = Math.min(Math.max(parseInt(meta.importance) || 1, 1), 5);
        const stars = "⭐".repeat(importance);
        // --- BULLETPROOF TAGS ---
        let tagsArray = [];
        if (Array.isArray(meta.tags)) {
            tagsArray = meta.tags;
        } else if (typeof meta.tags === 'string') {
            // If it's a string, try to parse it or just split it
            try {
                const parsed = JSON.parse(meta.tags);
                tagsArray = Array.isArray(parsed) ? parsed : [meta.tags];
            } catch {
                tagsArray = meta.tags.split(',').map(t => t.trim());
            }
        }

        return `<tr style="border-bottom:1px solid #eee;">
            <td style="padding:8px; vertical-align:top;"><code>${meta.type || 'fact'}</code></td>
            <td style="padding:8px;">
                <div style="font-weight:bold; margin-bottom:4px;">${meta.title || 'Untitled'}</div>
                <div style="color:#555;">${meta.content || ''}</div>
                <div style="margin-top:5px;"><small style="color:#888;">🏷️ ${tagsArray.join(', ')}</small></div>
            </td>
            <!-- ⭐ Updated Importance Column -->
            <td style="padding: 10px; text-align: center; vertical-align: top; white-space: nowrap; font-size: 14px;">
                <span title="Importance: ${importance}/5">${stars}</span>
            </td>
        </tr>`;
    }).join('');

    html += '</tbody></table>';
    wrapper.innerHTML = html;

    document.getElementById('prev-page').disabled = currentPage === 1;
    document.getElementById('next-page').disabled = currentPage === totalPages;
}


function changePage(step) {
    currentPage += step;
    renderTablePage();
    // Scroll modal to top when changing page
    document.querySelector('#memoryModal > div').scrollTop = 0;
}

async function checkDatabaseBackend() {
  const btn = document.getElementById('view-memories-btn');
  if (!btn) return;

  try {
    const res = await fetch('/api/config');
    const config = await res.json();

    // ONLY show if it's LanceDB. Hide if it's Postgres or anything else.
    if (config.backend === 'lancedb') {
        btn.style.display = 'inline-block';
    } else {
        btn.style.display = 'none';
    }
  } catch (err) {
    // Fallback: Hide if we can't determine the backend
    btn.style.display = 'none';
  }
}

// Run the check when the page loads
document.addEventListener('DOMContentLoaded', checkDatabaseBackend);





// ── Theme ────────────────────────────────────────────────────
const THEMES = ["light", "dark", "aurora", "system"];
let currentTheme = localStorage.getItem("aperio-theme") || "system";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".theme-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
  currentTheme = theme;
  localStorage.setItem("aperio-theme", theme);
}

document.querySelectorAll(".theme-btn").forEach(btn => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
});

applyTheme(currentTheme);

// ── Version ─────────────────────────────────────────────────────
fetch('/api/version')
  .then(res => res.json())
  .then(data => {
    document.getElementById('version-display').innerText = 'v' + data.version;
  })
  .catch(() => {});

// ── Boot ─────────────────────────────────────────────────────
connect();

// Update timestamps every 30s
setInterval(() => {
  document.querySelectorAll(".msg-timestamp[data-ts]").forEach(el => {
    const diff = Math.floor((Date.now() - parseInt(el.dataset.ts)) / 1000);
    if (diff < 60)        el.textContent = "just now";
    else if (diff < 3600) el.textContent = Math.floor(diff/60) + "m ago";
    else                  el.textContent = Math.floor(diff/3600) + "h ago";
  });
}, 30_000);