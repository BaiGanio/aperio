// ── Context banner ───────────────────────────────────────────
let ctxBannerEl = null;

function showContextBanner(pct, mode) {
  if (ctxBannerEl) return;
  const banner = document.createElement("div");
  banner.className = "ctx-banner" + (mode === "trimmed" ? " ctx-banner--trimmed" : "");
  const msg = mode === "trimmed" ? t("ctx_trimmed", { pct }) : t("ctx_warn", { pct });
  banner.innerHTML =
    `<span class="ctx-banner-text">${msg}</span>` +
    `<button class="ctx-banner-btn ctx-banner-btn--primary" onclick="sendSummarize()">${t("ctx_summarize")}</button>` +
    `<button class="ctx-banner-btn" onclick="dismissContextBanner()">${t("ctx_dismiss")}</button>`;
  document.querySelector(".chat-area")?.prepend(banner);
  ctxBannerEl = banner;
}

function dismissContextBanner() {
  ctxBannerEl?.remove();
  ctxBannerEl = null;
}

function sendSummarize() {
  dismissContextBanner();
  safeSend(JSON.stringify({ type: "summarize" }));
}

function sendHandoff(focus) {
  dismissContextBanner();
  safeSend(JSON.stringify({ type: "handoff", focus: focus || null }));
}

// Handoff banner — shown when the server emits context_handoff_suggested.
// Distinct from the summarize banner so both can coexist while a session
// crosses both thresholds.
let handoffBannerEl = null;
let handoffAutoFired = false;

function showHandoffBanner(pct, { autoTrigger = false } = {}) {
  if (handoffBannerEl) return;
  const banner = document.createElement("div");
  banner.className = "ctx-banner ctx-banner--trimmed";
  const label = (typeof t === "function" && t("ctx_handoff")) || `Context at ${pct}% — handoff suggested.`;
  banner.innerHTML =
    `<span class="ctx-banner-text">${label}</span>` +
    `<button class="ctx-banner-btn ctx-banner-btn--primary" onclick="sendHandoff()">Run handoff</button>` +
    `<button class="ctx-banner-btn" onclick="dismissHandoffBanner()">Dismiss</button>`;
  document.querySelector(".chat-area")?.prepend(banner);
  handoffBannerEl = banner;

  if (autoTrigger && !handoffAutoFired) {
    handoffAutoFired = true;
    setTimeout(() => sendHandoff(), 250);
  }
}

function dismissHandoffBanner() {
  handoffBannerEl?.remove();
  handoffBannerEl = null;
}

function showHandoffResult(ok, payload) {
  dismissHandoffBanner();
  const note = document.createElement("div");
  note.className = "ctx-banner ctx-banner--trimmed";
  note.style.cssText = "font-size:10px;opacity:0.85;";
  const text = ok
    ? `📦 Handoff written: <code>${payload.path}</code>${payload.rotated ? " — context rotated, fresh start." : ""}`
    : `Handoff failed: ${payload.reason || "unknown"}`;
  note.innerHTML =
    `<span class="ctx-banner-text">${text}</span>` +
    `<button class="ctx-banner-btn" onclick="this.parentElement.remove()">Dismiss</button>`;
  document.querySelector(".chat-area")?.prepend(note);
}

// ── Message rendering ─────────────────────────────────────────
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

  // AI messages route through _renderWithDeliverables so a build's HTML shows as
  // a card, not source. User messages render verbatim (they may legitimately
  // paste HTML they want to see).
  const renderInto = (node, src) => {
    if (role !== "user" && typeof _renderWithDeliverables === "function") {
      _renderWithDeliverables(node, src, false);
    } else {
      node.innerHTML = renderMarkdown(src);
    }
  };

  if (text.includes("🧠 **Memory suggestions**") && !suggestionShown) {
    suggestionShown = true;
    const [before, after] = text.split("🧠 **Memory suggestions**");
    const textNode = document.createElement("div");
    renderInto(textNode, before.trim());
    bubble.appendChild(textNode);
    bubble.appendChild(parseSuggestionBlock(after));
  } else if (text.trim()) {
    const textNode = document.createElement("div");
    renderInto(textNode, text);
    bubble.appendChild(textNode);
  }
  if (role !== "user" && text.trim()) {
    _attachBubbleCopyBtn(bubble, text);
    _enhanceAiBubble(bubble, text);
  }

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
  if (role === "user") {
    lastUserMsgWrap = wrap;
    const chip = buildUserTokenChip(text, attachments);
    if (chip) wrap.after(chip);
  }
  scrollToBottom();
}

// Per-message "↑ ~N tokens" chip for a user turn, counting the typed text plus
// every attachment (images cost vision tokens, files their extracted text).
// Returns null when the estimate is zero. Shared by live and restored messages.
function buildUserTokenChip(text, attachments) {
  let est = estimateTokens(text);
  (attachments || []).forEach(att => { est += estimateAttachmentTokens(att); });
  const chip = document.createElement("div");
  chip.className = "msg-stats msg-stats--user";
  if (text.trim()) {
    const copyBtn = document.createElement("button");
    copyBtn.className = "msg-user-copy-btn";
    copyBtn.title = "Copy";
    copyBtn.dataset.raw = text;
    copyBtn.innerHTML = '<i class="bi bi-copy"></i>';
    copyBtn.onclick = () => copyBubble(copyBtn);
    chip.appendChild(copyBtn);

    const retryBtn = document.createElement("button");
    retryBtn.className = "msg-user-copy-btn msg-user-retry-btn";
    retryBtn.title = "Retry";
    retryBtn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i>';
    retryBtn.onclick = () => {
      const input = document.getElementById("chatInput");
      if (input && window.send) { input.value = text; window.send(); }
    };
    chip.appendChild(retryBtn);
  }
  if (est > 0) {
    const label = document.createElement("span");
    label.textContent = `↑ ~${est.toLocaleString()} tokens`;
    chip.appendChild(label);
  }
  if (!est && !text.trim()) return null;
  return chip;
}

function buildAttachmentCard(att) {
  const isImage = att.type && att.type.startsWith("image/");

  // Resolve the best available image source:
  // - dataUrl: from a live upload (browser File → base64)
  // - url:     from a restored session (server-side static file)
  // - thumbnail: base64 JPEG thumbnail stored in session JSON
  const thumbDataUrl = att.dataUrl
    || (att.thumbnail ? `data:image/jpeg;base64,${att.thumbnail}` : null);
  const fullImageUrl = att.url || att.dataUrl;
  const imageDataUrl = thumbDataUrl || fullImageUrl;

  // ── Images: render inline as a clickable thumbnail that opens a full-screen
  //    lightbox — no filename pill, matching how chat UIs present images. ──
  if (isImage && imageDataUrl) {
    const figure = document.createElement("div");
    figure.className = "msg-attach-image";
    figure.title = "Click to expand";

    const img = document.createElement("img");
    img.src = thumbDataUrl || fullImageUrl;
    img.alt = att.name || "image";
    img.loading = "lazy";
    figure.appendChild(img);

    figure.addEventListener("click", () => openImageLightbox(fullImageUrl || thumbDataUrl, att.name));
    return figure;
  }

  // ── Non-image files: pill card that opens a content-preview modal. ──
  const wrapper = document.createElement("div");
  wrapper.className = "msg-attach-wrapper";

  const card = document.createElement("div");
  card.className = "msg-attach-card msg-attach-file";
  card.style.cursor = "pointer";
  card.title = "Click to view file";

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

  const openIcon = document.createElement("span");
  openIcon.className = "msg-attach-chevron";
  openIcon.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';

  info.appendChild(name);
  info.appendChild(meta);
  card.appendChild(icon);
  card.appendChild(info);
  card.appendChild(openIcon);

  card.addEventListener("click", () => openFileModal(att));
  wrapper.appendChild(card);
  return wrapper;
}

// ── File preview modal ────────────────────────────────────────
function ensureFileModal() {
  if (document.getElementById("file-preview-modal")) return;

  const overlay = document.createElement("div");
  overlay.id = "file-preview-modal";
  overlay.className = "fpm-overlay";
  overlay.innerHTML = `
    <div class="fpm-dialog">
      <div class="fpm-header">
        <div class="fpm-title-group">
          <span class="fpm-icon"></span>
          <span class="fpm-filename"></span>
          <span class="fpm-ext-badge"></span>
        </div>
        <div class="fpm-actions">
          <button class="fpm-source-btn" title="Toggle source" style="display:none">
            <i class="bi bi-code-slash"></i> Source
          </button>
          <button class="fpm-copy-btn" title="Copy content">
            <i class="bi bi-copy"></i> Copy
          </button>
          <button class="fpm-close-btn" title="Close (Esc)">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
      <div class="fpm-body">
        <iframe class="fpm-frame" sandbox="allow-scripts" title="Rendered preview" style="display:none"></iframe>
        <pre class="fpm-pre"><code class="fpm-code"></code></pre>
      </div>
    </div>`;

  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeFileModal();
  });
  overlay.querySelector(".fpm-close-btn").addEventListener("click", closeFileModal);
  // HTML previews open rendered; this toggles to the raw source and back.
  overlay.querySelector(".fpm-source-btn").addEventListener("click", () => {
    const frameEl = overlay.querySelector(".fpm-frame");
    const preEl   = overlay.querySelector(".fpm-pre");
    const btn     = overlay.querySelector(".fpm-source-btn");
    if (btn.dataset.showing === "source") {
      frameEl.style.display = ""; preEl.style.display = "none";
      btn.dataset.showing = "preview";
      btn.innerHTML = '<i class="bi bi-code-slash"></i> Source';
    } else {
      preEl.style.display = ""; frameEl.style.display = "none";
      btn.dataset.showing = "source";
      btn.innerHTML = '<i class="bi bi-eye"></i> Preview';
      if (window.Prism) Prism.highlightElement(preEl.querySelector(".fpm-code"));
    }
  });
  overlay.querySelector(".fpm-copy-btn").addEventListener("click", () => {
    const text = overlay.dataset.source ?? overlay.querySelector(".fpm-code").textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = overlay.querySelector(".fpm-copy-btn");
      btn.innerHTML = '<i class="bi bi-copy-check"></i> Copied!';
      setTimeout(() => btn.innerHTML = '<i class="bi bi-copy"></i> Copy', 2000);
    });
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeFileModal();
  });

  document.body.appendChild(overlay);
}

// Shared renderer for the file-preview modal. HTML files open as a rendered
// page in a sandboxed iframe with a Source toggle; everything else shows
// syntax-highlighted source. `text` is the file's full content.
function renderFileModal(name, text) {
  const modal = document.getElementById("file-preview-modal");
  modal.querySelector(".fpm-icon").innerHTML = getFileIcon(name, null);
  modal.querySelector(".fpm-filename").textContent = (name || "file").replace(/\.[^.]+$/, "");
  modal.querySelector(".fpm-ext-badge").textContent = (name || "").split(".").pop().toUpperCase() || "FILE";

  const codeEl  = modal.querySelector(".fpm-code");
  const preEl   = modal.querySelector(".fpm-pre");
  const frameEl = modal.querySelector(".fpm-frame");
  const srcBtn  = modal.querySelector(".fpm-source-btn");

  modal.dataset.source = text;          // raw text for the Copy button
  codeEl.className = "fpm-code";
  codeEl.textContent = text;

  const ext = (name || "").split(".").pop().toLowerCase();
  const langMap = { js:"javascript", ts:"typescript", jsx:"javascript", tsx:"typescript",
                    py:"python", html:"html", css:"css", json:"json", md:"markdown",
                    cs:"csharp", rs:"rust", go:"go", java:"java", cpp:"cpp", c:"c",
                    sh:"bash", yaml:"yaml", yml:"yaml", toml:"toml", xml:"xml", sql:"sql" };
  if (langMap[ext]) codeEl.className = `fpm-code language-${langMap[ext]}`;

  const isHtml = ext === "html" || ext === "htm";
  if (isHtml) {
    frameEl.srcdoc = text;
    frameEl.style.display = "";
    preEl.style.display = "none";
    srcBtn.style.display = "";
    srcBtn.dataset.showing = "preview";
    srcBtn.innerHTML = '<i class="bi bi-code-slash"></i> Source';
  } else {
    frameEl.removeAttribute("srcdoc");
    frameEl.style.display = "none";
    preEl.style.display = "";
    srcBtn.style.display = "none";
  }

  modal.classList.add("open");
  requestAnimationFrame(() => {
    if (!isHtml && window.Prism) Prism.highlightElement(codeEl);
    modal.querySelector(".fpm-body").scrollTop = 0;
  });
}

function openFileModal(att) {
  ensureFileModal();
  let text;
  try {
    const base64 = (att.dataUrl || "").split(",")[1] || "";
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    text = new TextDecoder("utf-8").decode(bytes) || "Empty file.";
  } catch (_) {
    text = "Could not decode file content.";
  }
  renderFileModal(att.name, text);
}

function closeFileModal() {
  document.getElementById("file-preview-modal")?.classList.remove("open");
}

async function openGeneratedFileModal(url, name) {
  ensureFileModal();
  const modal = document.getElementById("file-preview-modal");
  modal.querySelector(".fpm-icon").innerHTML = getFileIcon(name, null);
  modal.querySelector(".fpm-filename").textContent = (name || "file").replace(/\.[^.]+$/, "");
  modal.querySelector(".fpm-ext-badge").textContent = (name || "").split(".").pop().toUpperCase() || "FILE";
  modal.querySelector(".fpm-frame").style.display = "none";
  modal.querySelector(".fpm-pre").style.display = "";
  modal.querySelector(".fpm-source-btn").style.display = "none";
  modal.querySelector(".fpm-code").textContent = "Loading…";
  modal.classList.add("open");

  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    modal.querySelector(".fpm-code").textContent = `Could not load file: ${e.message}`;
    return;
  }
  renderFileModal(name, text);
}

// Open an HTML string directly in the rendered preview modal (used for code
// blocks the model dumped inline rather than writing to a file).
function previewHtmlString(html, name) {
  ensureFileModal();
  renderFileModal(name || "preview.html", html);
}

// ── Image lightbox ────────────────────────────────────────────
function ensureImageLightbox() {
  if (document.getElementById("image-lightbox")) return;

  const overlay = document.createElement("div");
  overlay.id = "image-lightbox";
  overlay.className = "img-lightbox";
  overlay.innerHTML = `
    <button class="img-lightbox-close" title="Close (Esc)"><i class="bi bi-x-lg"></i></button>
    <img class="img-lightbox-img" alt="">`;

  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeImageLightbox();
  });
  overlay.querySelector(".img-lightbox-close").addEventListener("click", closeImageLightbox);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeImageLightbox();
  });

  document.body.appendChild(overlay);
}

function openImageLightbox(src, alt) {
  if (!src) return;
  ensureImageLightbox();
  const overlay = document.getElementById("image-lightbox");
  const img = overlay.querySelector(".img-lightbox-img");
  img.src = src;
  img.alt = alt || "image";
  overlay.classList.add("open");
}

function closeImageLightbox() {
  document.getElementById("image-lightbox")?.classList.remove("open");
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

function addUserMessage(text, attachments) {
  addMessage("user", text, attachments);
}


function renderBlock(container, block) {
  if (block.type === 'text') {
    const textSpan = document.createElement('span');
    textSpan.innerHTML = renderMarkdown(block.text || "");
    container.appendChild(textSpan);
  } else if (block.type === 'image') {
    const img = document.createElement('img');
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
