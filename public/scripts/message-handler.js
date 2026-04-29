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
    // Respect toggle — if off, track the state but don't create a bubble.
    // isReasoningActive must stay true so content tokens are held back while
    // the model is inside its thinking block (applies to all reasoning models).
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
      // If reasoning toggle is ON and model is still in reasoning phase, discard content tokens.
      // NOTE: do NOT also check reasoningBubble here — for inline-tag models like Gemma 4,
      // content tokens arrive while reasoningBubble is still open (the splitter interleaves them).
      // isReasoningActive is the only correct signal for "we are inside a thinking block".
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
    // ✅ ADD THIS — update context bar when response is complete
    if (msg.usage) {
      const used = (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0);
      updateContextBar(used, maxCtx);
    }
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    // ref.bubble.appendChild(parseSuggestionBlock(after));
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

function addMessage(role, text, attachments) {
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
    const textNode = document.createElement("div");
    textNode.innerHTML = renderMarkdown(before.trim());
    bubble.appendChild(textNode);
    bubble.appendChild(parseSuggestionBlock(after));
  } else if (text.trim()) {
    const textNode = document.createElement("div");
    textNode.innerHTML = renderMarkdown(text);
    bubble.appendChild(textNode);
  }

  // Render attachment cards below the text
  if (role === "user" && attachments && attachments.length > 0) {
    const attachRow = document.createElement("div");
    attachRow.className = "msg-attachments";
    attachments.forEach(att => {
      attachRow.appendChild(buildAttachmentCard(att));
    });
    bubble.appendChild(attachRow);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

/**
 * Build a single attachment card for the message bubble.
 * Clicking the pill toggles an inline preview panel below it.
 * @param {{ name: string, type: string, dataUrl?: string }} att
 */
function buildAttachmentCard(att) {
  const isImage = att.type && att.type.startsWith("image/");

  // Wrapper holds both the pill and the collapsible preview
  const wrapper = document.createElement("div");
  wrapper.className = "msg-attach-wrapper";

  const card = document.createElement("div");
  card.className = "msg-attach-card msg-attach-file";
  card.style.cursor = "pointer";
  card.title = "Click to preview";

  const chevron = document.createElement("span");
  chevron.className = "msg-attach-chevron";
  chevron.innerHTML = '<i class="bi bi-chevron-down"></i>';

  if (isImage && att.dataUrl) {
    const thumb = document.createElement("div");
    thumb.className = "msg-attach-thumb";
    const img = document.createElement("img");
    img.src = att.dataUrl;
    img.alt = att.name || "image";
    thumb.appendChild(img);

    const info = document.createElement("div");
    info.className = "msg-attach-info";

    const name = document.createElement("div");
    name.className = "msg-attach-name";
    name.textContent = (att.name || "image").replace(/\.[^.]+$/, "");

    const ext = (att.name || "").split(".").pop().toUpperCase() ||
                (att.type || "").replace("image/", "").toUpperCase() || "IMG";
    const badge = document.createElement("div");
    badge.className = "msg-attach-meta";
    badge.textContent = ext;

    info.appendChild(name);
    info.appendChild(badge);
    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(chevron);
  } else {
    const icon = document.createElement("div");
    icon.className = "msg-attach-icon";
    icon.innerHTML = getFileIcon(att.name, att.type);

    const info = document.createElement("div");
    info.className = "msg-attach-info";

    const name = document.createElement("div");
    name.className = "msg-attach-name";
    name.textContent = att.name || "file";

    const meta = document.createElement("div");
    meta.className = "msg-attach-meta";
    meta.textContent = getFileTypeLabelFromMime(att.type);

    info.appendChild(name);
    info.appendChild(meta);
    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(chevron);
  }

  // ── Inline preview panel (hidden until clicked) ───────────
  const preview = document.createElement("div");
  preview.className = "msg-attach-preview";

  if (isImage && att.dataUrl) {
    const img = document.createElement("img");
    img.src = att.dataUrl;
    img.alt = att.name || "image";
    img.className = "msg-attach-preview-img";
    preview.appendChild(img);
  } else if (att.dataUrl) {
    try {
      const base64Data = att.dataUrl.split(",")[1] || "";
      const decoded = atob(base64Data);
      const pre = document.createElement("pre");
      pre.className = "msg-attach-preview-code";
      const code = document.createElement("code");
      const ext = (att.name || "").split(".").pop().toLowerCase();
      const langMap = { js:"javascript", ts:"typescript", jsx:"javascript",
                        tsx:"typescript", py:"python", html:"html", css:"css",
                        json:"json", md:"markdown" };
      if (langMap[ext]) code.className = `language-${langMap[ext]}`;
      code.textContent = decoded.length > 6000
        ? decoded.slice(0, 6000) + "\n\n… (truncated)"
        : decoded;
      pre.appendChild(code);
      preview.appendChild(pre);
    } catch (_) {
      preview.textContent = "Preview unavailable.";
    }
  } else {
    preview.textContent = "No preview available.";
  }

  // ── Toggle on pill click ──────────────────────────────────
  card.addEventListener("click", () => {
    const open = preview.classList.toggle("open");
    const icon = card.querySelector(".msg-attach-chevron i");
    if (icon) icon.className = open ? "bi bi-chevron-up" : "bi bi-chevron-down";
    if (open && !isImage) requestAnimationFrame(() => highlightAll());
    requestAnimationFrame(() => scrollToBottom());
  });

  wrapper.appendChild(card);
  wrapper.appendChild(preview);
  return wrapper;
}

function getFileIcon(name, mime) {
  if (mime === "application/pdf") return '<i class="bi bi-file-earmark-pdf"></i>';
  if (mime && mime.startsWith("image/")) return '<i class="bi bi-image"></i>';
  if (mime === "application/json" || (name && name.endsWith(".json"))) return '<i class="bi bi-braces"></i>';
  if (name && /\.(js|ts|jsx|tsx)$/.test(name)) return '<i class="bi bi-filetype-js"></i>';
  if (name && /\.(py)$/.test(name)) return '<i class="bi bi-filetype-py"></i>';
  if (name && /\.(html|htm)$/.test(name)) return '<i class="bi bi-filetype-html"></i>';
  if (name && /\.(css|scss)$/.test(name)) return '<i class="bi bi-filetype-css"></i>';
  if (name && /\.(md)$/.test(name)) return '<i class="bi bi-file-earmark-text"></i>';
  return '<i class="bi bi-file-earmark"></i>';
}

function getFileTypeLabelFromMime(mime) {
  if (!mime) return "File";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("image/")) return mime.replace("image/", "").toUpperCase();
  if (mime === "application/json") return "JSON";
  if (mime.includes("javascript")) return "JavaScript";
  if (mime.includes("html")) return "HTML";
  if (mime.includes("css")) return "CSS";
  if (mime.includes("python")) return "Python";
  if (mime.includes("plain")) return "Text";
  if (mime.includes("markdown")) return "Markdown";
  return "File";
}

/**
 * Public helper — call this from input-bar.js / index.js when sending a message.
 * Captures the attachment list and renders it in the bubble before clearing.
 *
 * @param {string} text          — the message text
 * @param {Array}  attachments   — array of { name, type, dataUrl } built from File objects
 */
function addUserMessage(text, attachments) {
  addMessage("user", text, attachments);
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
  text = text.replace(/\x00(\d+)\x00/g, (_, i) => blocks[Number.parseInt(i)]);
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

function toggleReasoning() {
  // It only becomes true if the storage specifically says "true".
  const cur = localStorage.getItem("aperio-reasoning") === "true";
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

/**
* New helper to render a single content block.
* @param {HTMLElement} container - The bubble element to append to.
* @param {Object} block - The block object { type: 'text'|'image', text?: string, source?: { data?: string } }
*/
function renderBlock(container, block) {
  if (block.type === 'text') {
    const textSpan = document.createElement('span');
    textSpan.innerHTML = renderMarkdown(block.text || "");
    container.appendChild(textSpan);
  } else if (block.type === 'image') {
    const img = document.createElement('img');
    // If the server sent base64, we use it directly.
    // If it's a URL, we use that.
    if (block.source?.type === 'base64') {
      img.src = `data:${block.source.media_type};base64,${block.source.data}`;
    } else {
      img.src = block.source.url;
    }
    img.className = 'attachment-preview-image';
    img.alt = "Uploaded attachment";
    container.appendChild(img);
  }
}