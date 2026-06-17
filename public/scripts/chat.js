// ── Type config ──────────────────────────────────────────────
// Labels are looked up via t() at render time so they follow the active locale.
window.TYPE_CONFIG = {
  fact:       { icon: "◈", labelKey: "type_facts" },
  preference: { icon: "◎", labelKey: "type_preferences" },
  project:    { icon: "◱", labelKey: "type_projects" },
  decision:   { icon: "◇", labelKey: "type_decisions" },
  solution:   { icon: "◈", labelKey: "type_solutions" },
  source:     { icon: "◉", labelKey: "type_sources" },
  person:     { icon: "◯", labelKey: "type_people" },
  inference:  { icon: "◌", labelKey: "type_inferences" },
};

// ── State ────────────────────────────────────────────────────
window.ws = null;
window.pendingSuggestion = null;
window.isThinking = false;
window.hasInitialized = false;
window.allMemories = []; // Global store for the current modal session
window.filteredMemories = []; // Subset of allMemories matching the current search query in the modal
window.currentPage = 1;
window.recordsPerPage = 10;
// Set by the provider message on connection; updated if the model changes at runtime.
window.maxCtx = 0;

// ── DOM refs ─────────────────────────────────────────────────
window.messagesEl   = document.getElementById("messages");
window.chatInput    = document.getElementById("chatInput");
window.sendBtn      = document.getElementById("sendBtn");
window.stopBtn      = document.getElementById("stopBtn");
window.statusDot    = document.getElementById("statusDot");
window.statusText   = document.getElementById("statusText");
window.memoriesList = document.getElementById("memoriesList");
window.searchInput  = document.getElementById("searchInput");

// ── WebSocket ────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // AUTH-01: WebSocket handshakes can't set headers, so pass the opt-in token
  // (if any) as a query param. window.__aperioAuthToken is set by http-guard.js.
  const tok = window.__aperioAuthToken?.();
  const q = tok ? `?token=${encodeURIComponent(tok)}` : "";
  window.ws = new WebSocket(`${proto}//${location.host}${q}`);

  window.ws.onopen = () => {
    document.getElementById("startup-thinking")?.remove();
    if (!window.hasInitialized) {
      window.hasInitialized = true;
      setStatus("thinking", t("status_loading"));
      addThinking(false);
      window.ws.send(JSON.stringify({ type: "init", lang: window.Aperio.getCurrentLang() }));
    } else {
      setStatus("connected", t("status_reconnected"));
      window.sendBtn.disabled = window.chatInput.value.trim() === "";
      const lang = window.Aperio.getCurrentLang();
      if (lang !== "en") window.ws.send(JSON.stringify({ type: "set_lang", lang }));
    }
  };

  window.ws.onclose = () => {
    setStatus("", t("status_disconnected"));
    window.sendBtn.disabled = true;
    setTimeout(connect, 3000);
  };

  window.ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };
}
window.connect = connect;

function setStatus(cls, text) {
  window.statusDot.className = "status-dot " + cls;
  window.statusText.textContent = text;
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
    document.title = t("title_thinking") + titleDots[titleDotIdx % titleDots.length];
    titleDotIdx++;
  }, 400);
}

function stopTitleAnimation() {
  if (titleAnimFrame) { clearInterval(titleAnimFrame); titleAnimFrame = null; }
  document.title = t("page_title");
}


function parseSuggestionBlock(text) {
  const div = document.createElement("div");
  div.className = "memory-suggestion";

  const title = document.createElement("div");
  title.className = "memory-suggestion-title";
  title.textContent = t("sug_title");
  div.appendChild(title);

  const lines = text.split("\n").filter(l => /^\d+\./.test(l.trim()));
  window.pendingSuggestion = { lines, indices: [] };

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
  saveAll.textContent = t("sug_save_all");
  saveAll.onclick = () => sendSuggestionResponse("all", lines.map((_, i) => i+1));

  const none = document.createElement("button");
  none.className = "btn btn-ghost";
  none.textContent = t("sug_skip");
  none.onclick = () => sendSuggestionResponse("none", []);

  lines.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = t("sug_save_n", { n: i + 1 });
    btn.onclick = () => sendSuggestionResponse("pick", [i+1]);
    actions.appendChild(btn);
  });

  actions.prepend(none);
  actions.prepend(saveAll);
  div.appendChild(actions);

  return div;
}

function sendSuggestionResponse(mode, nums) {
  const lines = window.pendingSuggestion?.lines ?? [];
  window.pendingSuggestion = null;
  document.querySelector(".memory-suggestion")?.remove();
  if (mode === "none") return;
  const items = nums
    .map(n => lines[n - 1])
    .filter(Boolean)
    .map(l => ({ text: l.replace(/^\d+\.\s*/, "").trim() }));
  if (!items.length) return;
  safeSend(JSON.stringify({ type: "save_suggestions", items }));
}

function addThinking(lockInput = true) {
  // The live activity cursor is a flat line, consistent with the persistent
  // phase breadcrumbs and tool cards (one terminal-style column). Keeps id
  // "thinking" and the .thinking-label hook so the streaming handlers can swap
  // its label (thinking… → typing…) unchanged.
  const el = document.createElement("div");
  el.className = "action-phase active";
  el.id = "thinking";
  el.innerHTML =
    `<span class="action-phase-mark live"></span>` +
    `<span class="thinking-label action-phase-label" data-i18n="chat_thinking_label">${t("chat_thinking_label")}</span>` +
    `<span class="thinking-time"></span>`;
  window.messagesEl.appendChild(el);
  if (lockInput) document.querySelector(".input-bar")?.classList.add("input-locked");
  document.getElementById("inputHint").textContent = t("chat_input_thinking");
  window.messagesEl.scrollTop = window.messagesEl.scrollHeight;
}

function removeThinking() {
  document.getElementById("thinking")?.remove();
  document.querySelector(".input-bar")?.classList.remove("input-locked");
  document.getElementById("preparing-answer")?.remove();
  const inputHint = document.getElementById("inputHint");
  if (inputHint) inputHint.innerHTML = t("chat_input_hint_html", { key: cmdKey });
}

let toolEl = null;
// Tool labels — maps MCP tool name → translation key. Looked up via t() at render
// time so the indicator follows the active language.
const TOOL_LABEL_KEYS = {
  recall:               "tool_recall",
  remember:             "tool_remember",
  forget:               "tool_forget",
  update_memory:        "tool_update_memory",
  backfill_embeddings:  "tool_backfill_embeddings",
  deduplicate_memories: "tool_deduplicate_memories",
  read_file:            "tool_read_file",
  scan_project:         "tool_scan_project",
  fetch_url:            "tool_fetch_url",
  write_file:           "tool_write_file",
  edit_file:            "tool_edit_file",
  append_file:          "tool_append_file",
  syntax_check:         "tool_syntax_check",
  run_node_script:      "tool_run_node_script",
  generate_xlsx:        "tool_generate_xlsx",
  wiki_write:           "tool_wiki_write",
  wiki_get:             "tool_wiki_get",
  wiki_search:          "tool_wiki_search",
  wiki_list:            "tool_wiki_list",
};

function addToolIndicator(name) {
  removeToolIndicator();
  toolEl = document.createElement("div");
  toolEl.className = "tool-indicator";
  const key = TOOL_LABEL_KEYS[name];
  const label = key ? t(key) : t("tool_generic", { name });
  toolEl.innerHTML = `<div class="tool-spinner"></div> ${label}`;
  window.messagesEl.appendChild(toolEl);
  scrollToBottom();
}

function removeToolIndicator() {
  toolEl?.remove();
  toolEl = null;
}

function isNearBottom() {
  return window.messagesEl.scrollHeight - window.messagesEl.scrollTop - window.messagesEl.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    window.messagesEl.scrollTop = window.messagesEl.scrollHeight;
  }
}
window.scrollToBottom = scrollToBottom;

// ── WebSocket safe send ──────────────────────────────────────
function safeSend(data) {
  if (window.ws?.readyState === WebSocket.OPEN) window.ws.send(data);
}
window.safeSend = safeSend;

// ── Send ─────────────────────────────────────────────────────
async function send() {
  const text = window.chatInput.value.trim();
  const files = window.attachedFiles || []; // Access the global array
  if ((!text && files.length === 0) || !window.ws) return;

  // Sending while a response is still streaming interrupts it. Tear down the
  // in-flight generation's UI locally (the server aborts the model call) and
  // flag the message so the agent is told it was cut off.
  const interrupting = window.isThinking;
  if (interrupting) {
    if (streamingBubble) { streamingBubble.wrap?.remove(); streamingBubble = null; streamingText = ""; }
    if (reasoningBubble) {
      if (reasoningBubble.statusSpan) reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble = null;
    }
    removeThinking();
    removeToolIndicator();
    document.getElementById("preparing-answer")?.remove();
  }

  // Prepare attachments payload
  const attachments = [];

  // Process each file
  for (const file of files) {
    const base64 = await fileToBase64(file);
    attachments.push({
      name: file.name,
      type: file.type,
      data: base64
    });
  }

  // AFTER
  const attachmentCards = getAttachmentsSnapshot();
  addUserMessage(text || (files.length > 0 ? t("chat_uploaded_files", { n: files.length }) : ""), attachmentCards); // ← new
  window.attachedFiles = [];   // must stay AFTER snapshot
  renderPreviews(); // Clear the file preview chips

  window.messagesEl.scrollTop = window.messagesEl.scrollHeight;
  window.chatInput.value = "";
  window.clearInputSuggestion?.();
  autoResize();
  window.sendBtn.disabled = true;
  window.isThinking = true;
  window.sendBtn.style.display = "none";
  window.stopBtn.style.display = "flex";
  requestAnimationFrame(() => {
    removeThinking();
    setStatus("thinking", t("status_thinking"));
    addThinking();
    startLiveTimer();
    const roundtable = typeof window.isRoundtableRequested === "function" && window.isRoundtableRequested();
    safeSend(JSON.stringify({ type: "chat", text, attachments, roundtable, interrupted: interrupting }));
  });
}

// ── Inline next-step suggestion ───────────────────────────────────────────
// The lead choice from the model's last turn is offered as ghost text in the
// (empty) input. Accept it with Tab or → just like an editor autocomplete; the
// choice pills below the message remain the full, clickable list.
window.setInputSuggestion = function(acceptValue, label) {
  const el = window.chatInput;
  if (!el || el.value.trim() !== "") return;   // never clobber what the user is typing
  el.dataset.suggestion = acceptValue;
  el.placeholder = label;
  el.title = t("chat_suggest_hint");
};

window.clearInputSuggestion = function() {
  const el = window.chatInput;
  if (!el || !el.dataset.suggestion) return;
  delete el.dataset.suggestion;
  el.placeholder = t("chat_placeholder");
  el.removeAttribute("title");
};

function acceptInputSuggestion() {
  const el = window.chatInput;
  if (!el?.dataset.suggestion || el.value.trim() !== "") return false;
  el.value = el.dataset.suggestion;
  window.clearInputSuggestion();
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  autoResize();
  window.sendBtn.disabled = el.value.trim() === "";
  return true;
}

window.send       = send;
window.autoResize = autoResize;
window.wsSafeSend = (data) => safeSend(typeof data === "string" ? data : JSON.stringify(data));
window.sendBtn.onclick = send;
window.stopBtn.onclick = () => {
  safeSend(JSON.stringify({ type: "stop" }));
  stopLiveTimer();
  removeThinking();
  removeToolIndicator();
  document.getElementById("preparing-answer")?.remove();
  window.isThinking = false;
  window.sendBtn.style.display = "";
  window.stopBtn.style.display = "none";
  window.sendBtn.disabled = window.chatInput.value.trim() === "";
};

window.chatInput.addEventListener("keydown", (e) => {
  // Autocomplete keyboard navigation (takes priority when dropdown is open)
  if (handleAutocompleteKeydown(e)) return;

  // Accept the inline next-step suggestion (only when the input is empty).
  if ((e.key === "Tab" || e.key === "ArrowRight") && window.chatInput.dataset.suggestion) {
    if (acceptInputSuggestion()) { e.preventDefault(); return; }
  }

  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    send();
  }
});

window.chatInput.addEventListener("input", () => {
  autoResize();
  // Stay enabled even while a response streams — sending interrupts it.
  window.sendBtn.disabled = window.chatInput.value.trim() === "";
  checkAutocompleteTrigger();
});

function autoResize() {
  const el = window.chatInput;
  
  // 1. Reset height to allow it to shrink if text was deleted
  el.style.height = "auto";
  // 2. Get the new scrollHeight
  const newHeight = el.scrollHeight;
  // 3. Apply the height with a cap, 
  // but we use 'border-box' logic so it stays within 140px total
  el.style.height = Math.min(newHeight, 140) + "px";
  const counter = document.getElementById("charCounter");
  if (counter) {
    const len = window.chatInput.value.length;
    if (len > 200) {
      counter.textContent = `${len.toLocaleString()} chars`;
      counter.className = "char-counter visible" + (len > 2000 ? " verylong" : len > 800 ? " long" : "");
    } else {
      counter.className = "char-counter";
    }
  }
}

// Helper function to read files as Base64
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',')[1]); // Remove the data:image/png;base64, prefix
    reader.onerror = error => reject(error);
  });
}
