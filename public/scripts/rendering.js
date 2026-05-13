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
    if (text.trim()) {
      const est = estimateTokens(text);
      const chip = document.createElement("div");
      chip.className = "msg-stats msg-stats--user";
      chip.textContent = `↑ ~${est.toLocaleString()} tokens`;
      wrap.after(chip);
    }
  }
  scrollToBottom();
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

  const wrapper = document.createElement("div");
  wrapper.className = "msg-attach-wrapper";

  const card = document.createElement("div");
  card.className = "msg-attach-card msg-attach-file";
  card.style.cursor = "pointer";

  if (isImage && imageDataUrl) {
    card.title = "Click to expand";
    const thumb = document.createElement("div");
    thumb.className = "msg-attach-thumb";
    const img = document.createElement("img");
    img.src = thumbDataUrl || fullImageUrl;
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

    const chevron = document.createElement("span");
    chevron.className = "msg-attach-chevron";
    chevron.innerHTML = '<i class="bi bi-chevron-down"></i>';

    info.appendChild(name);
    info.appendChild(badge);
    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(chevron);
  } else {
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
  }

  if (isImage && imageDataUrl) {
    const preview = document.createElement("div");
    preview.className = "msg-attach-preview";

    const img = document.createElement("img");
    img.src = fullImageUrl || thumbDataUrl;
    img.alt = att.name || "image";
    img.className = "msg-attach-preview-img";
    preview.appendChild(img);

    card.addEventListener("click", () => {
      const open = preview.classList.toggle("open");
      const chevIcon = card.querySelector(".msg-attach-chevron i");
      if (chevIcon) chevIcon.className = open ? "bi bi-chevron-up" : "bi bi-chevron-down";
      requestAnimationFrame(() => scrollToBottom());
    });

    wrapper.appendChild(card);
    wrapper.appendChild(preview);
  } else {
    card.addEventListener("click", () => openFileModal(att));
    wrapper.appendChild(card);
  }

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
          <button class="fpm-copy-btn" title="Copy content">
            <i class="bi bi-clipboard"></i> Copy
          </button>
          <button class="fpm-close-btn" title="Close (Esc)">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
      <div class="fpm-body">
        <pre class="fpm-pre"><code class="fpm-code"></code></pre>
      </div>
    </div>`;

  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeFileModal();
  });
  overlay.querySelector(".fpm-close-btn").addEventListener("click", closeFileModal);
  overlay.querySelector(".fpm-copy-btn").addEventListener("click", () => {
    const text = overlay.querySelector(".fpm-code").textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = overlay.querySelector(".fpm-copy-btn");
      btn.innerHTML = '<i class="bi bi-clipboard-check"></i> Copied!';
      setTimeout(() => btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy', 2000);
    });
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeFileModal();
  });

  document.body.appendChild(overlay);
}

function openFileModal(att) {
  ensureFileModal();
  const modal = document.getElementById("file-preview-modal");

  modal.querySelector(".fpm-icon").innerHTML = getFileIcon(att.name, att.type);
  modal.querySelector(".fpm-filename").textContent =
    (att.name || "file").replace(/\.[^.]+$/, "");
  const ext = (att.name || "").split(".").pop().toUpperCase() || "FILE";
  modal.querySelector(".fpm-ext-badge").textContent = ext;

  const codeEl = modal.querySelector(".fpm-code");
  codeEl.className = "fpm-code";
  try {
    const base64 = (att.dataUrl || "").split(",")[1] || "";
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    codeEl.textContent = new TextDecoder("utf-8").decode(bytes) || "Empty file.";
  } catch (_) {
    codeEl.textContent = "Could not decode file content.";
  }

  const fileExt = (att.name || "").split(".").pop().toLowerCase();
  const langMap = { js:"javascript", ts:"typescript", jsx:"javascript", tsx:"typescript",
                    py:"python", html:"html", css:"css", json:"json", md:"markdown" };
  if (langMap[fileExt]) codeEl.className = `fpm-code language-${langMap[fileExt]}`;

  modal.classList.add("open");
  requestAnimationFrame(() => {
    if (window.Prism) Prism.highlightElement(codeEl);
    modal.querySelector(".fpm-body").scrollTop = 0;
  });
}

function closeFileModal() {
  document.getElementById("file-preview-modal")?.classList.remove("open");
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
