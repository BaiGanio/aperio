// ── Context banner ───────────────────────────────────────────
let ctxBannerEl = null;

function showContextBanner(pct, mode) {
  if (ctxBannerEl) return;
  const banner = document.createElement("div");
  banner.className = "ctx-banner" + (mode === "trimmed" ? " ctx-banner--trimmed" : "");
  const msg = mode === "trimmed" ? t("ctx_trimmed", { pct }) : t("ctx_warn", { pct });
  banner.innerHTML =
    `<span class="ctx-banner-text">${msg}</span>` +
    `<button class="ctx-banner-btn ctx-banner-btn--primary" data-action="sendSummarize">${t("ctx_summarize")}</button>` +
    `<button class="ctx-banner-btn" data-action="dismissContextBanner">${t("ctx_dismiss")}</button>`;
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
  const label = (typeof t === "function" && t("ctx_handoff", { pct })) || `Context at ${pct}% — handoff suggested.`;
  banner.innerHTML =
    `<span class="ctx-banner-text">${label}</span>` +
    `<button class="ctx-banner-btn ctx-banner-btn--primary" data-action="sendHandoff">${t("ctx_handoff_run")}</button>` +
    `<button class="ctx-banner-btn" data-action="dismissHandoffBanner">${t("ctx_dismiss")}</button>`;
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
    `<button class="ctx-banner-btn" data-action="removeParent">Dismiss</button>`;
  document.querySelector(".chat-area")?.prepend(note);
}

// ── Background-agent "job finished" banner ────────────────────
// Pushed from the server when a scheduled (interval/watcher) job completes —
// there's no chat turn for these, so this is the only signal the user gets.
// Reuses the startup banner styling. Unlike that banner, this one auto-dismisses
// (success after 8s; errors stay until dismissed so failures aren't missed).
function dismissAgentJobBanner(el) {
  if (!el || !el.isConnected) return;
  el.style.transition = "opacity 0.4s ease";
  el.style.opacity = "0";
  setTimeout(() => el.remove(), 400);
}

function showAgentJobBanner({ jobId, verdict, durationMs, trigger, model, error }) {
  const ok = verdict === "ok";
  const banner = document.createElement("div");
  banner.className = "ctx-banner" + (ok ? " ctx-banner--memories" : " ctx-banner--trimmed");
  const id   = `<code>${jobId ?? "?"}</code>`;
  const by   = model ? ` by <code>${model}</code>` : "";
  const secs = durationMs ? ` in ${(durationMs / 1000).toFixed(1)}s` : "";
  const via  = trigger ? ` (${trigger})` : "";
  const text = ok
    ? `✅ Job ${id} finished${by}${secs}${via}.`
    : `⚠️ Job ${id} failed${by}${via}: ${error || "unknown error"}`;
  banner.innerHTML =
    `<span class="ctx-banner-text">${text}</span>` +
    `<button class="ctx-banner-btn" data-action="dismissAgentJobBanner">Dismiss</button>`;
  document.querySelector(".chat-area")?.prepend(banner);
  if (ok) setTimeout(() => dismissAgentJobBanner(banner), 8000);
}

// ── Model download/load banner ────────────────────────────────
// llama.cpp lazily downloads/loads GGUF weights inside the first request that
// names a model — otherwise minutes of unexplained silence (issues A/B). While
// that runs the server streams `model_status` events; this single banner makes
// the wait legible in the main window and dismisses itself 5 s after the model
// is ready. A single element is reused and updated in place across stages.
let modelBannerEl = null;
let modelBannerTimer = null;

function showModelLoadingBanner(status, text) {
  if (modelBannerTimer) { clearTimeout(modelBannerTimer); modelBannerTimer = null; }
  if (!modelBannerEl || !modelBannerEl.isConnected) {
    modelBannerEl = document.createElement("div");
    modelBannerEl.className = "ctx-banner ctx-banner--model";
    modelBannerEl.innerHTML =
      `<span class="model-banner-spinner" aria-hidden="true"></span>` +
      `<span class="ctx-banner-text"></span>`;
    document.querySelector(".chat-area")?.prepend(modelBannerEl);
  }
  modelBannerEl.classList.toggle("ctx-banner--model-ready", status === "ready");
  modelBannerEl.querySelector(".ctx-banner-text").textContent = text;
  if (status === "ready") {
    modelBannerTimer = setTimeout(dismissModelLoadingBanner, 5000);
  }
}

function dismissModelLoadingBanner() {
  if (modelBannerTimer) { clearTimeout(modelBannerTimer); modelBannerTimer = null; }
  const el = modelBannerEl;
  modelBannerEl = null;
  if (!el || !el.isConnected) return;
  el.style.transition = "opacity 0.4s ease";
  el.style.opacity = "0";
  setTimeout(() => el.remove(), 400);
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
          <button class="fpm-browser-btn" title="Open this file in the browser" hidden>
            <i class="bi bi-box-arrow-up-right"></i> <span>Open in browser</span>
          </button>
          <button class="fpm-folder-btn" title="Show this file in Finder or Explorer" hidden>
            <i class="bi bi-folder2-open"></i> <span>Show in folder</span>
          </button>
          <button class="fpm-copy-btn" title="Copy content">
            <i class="bi bi-copy"></i> Copy
          </button>
          <button class="fpm-close-btn" title="Close (Esc)">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
      <div class="fpm-view-tabs" hidden>
        <button class="fpm-preview-btn is-active"><i class="bi bi-eye"></i> Preview</button>
        <button class="fpm-code-btn"><i class="bi bi-code-slash"></i> Code</button>
      </div>
      <div class="fpm-body">
        <iframe class="fpm-frame" sandbox="allow-scripts" title="Rendered preview"></iframe>
        <pre class="fpm-pre"><code class="fpm-code"></code></pre>
      </div>
    </div>`;

  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeFileModal();
  });
  overlay.querySelector(".fpm-close-btn").addEventListener("click", closeFileModal);
  overlay.querySelector(".fpm-preview-btn").addEventListener("click", () => setFileModalView(overlay, "preview"));
  overlay.querySelector(".fpm-code-btn").addEventListener("click", () => setFileModalView(overlay, "code"));
  overlay.querySelector(".fpm-browser-btn").addEventListener("click", () => {
    const url = overlay.dataset.artifactUrl;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  });
  overlay.querySelector(".fpm-folder-btn").addEventListener("click", async () => {
    const url = overlay.dataset.artifactUrl;
    if (!url) return;
    const btn = overlay.querySelector(".fpm-folder-btn");
    btn.disabled = true;
    try {
      const res = await fetch("/api/artifact/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      btn.innerHTML = '<i class="bi bi-check-lg"></i> <span>Opened</span>';
      setTimeout(() => btn.innerHTML = '<i class="bi bi-folder2-open"></i> <span>Show in folder</span>', 1600);
    } catch (err) {
      btn.title = `Could not show file: ${err.message}`;
      btn.innerHTML = '<i class="bi bi-exclamation-triangle"></i> <span>Could not open</span>';
      setTimeout(() => btn.innerHTML = '<i class="bi bi-folder2-open"></i> <span>Show in folder</span>', 2000);
    } finally {
      btn.disabled = false;
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

function setFileModalView(modal, view) {
  const preview = view === "preview";
  const frameEl = modal.querySelector(".fpm-frame");
  const preEl = modal.querySelector(".fpm-pre");
  frameEl.style.display = preview ? "block" : "none";
  preEl.style.display = preview ? "none" : "block";
  modal.querySelector(".fpm-preview-btn").classList.toggle("is-active", preview);
  modal.querySelector(".fpm-code-btn").classList.toggle("is-active", !preview);
  if (!preview && window.Prism) Prism.highlightElement(preEl.querySelector(".fpm-code"));
}

// Shared renderer for the file-preview modal. HTML files open as a rendered
// page in a sandboxed iframe with Preview/Code tabs; everything else shows
// syntax-highlighted source. `text` is the file's full content.
function renderFileModal(name, text, { artifactUrl = null } = {}) {
  const modal = document.getElementById("file-preview-modal");
  modal.querySelector(".fpm-icon").innerHTML = getFileIcon(name, null);
  modal.querySelector(".fpm-filename").textContent = (name || "file").replace(/\.[^.]+$/, "");
  modal.querySelector(".fpm-ext-badge").textContent = (name || "").split(".").pop().toUpperCase() || "FILE";

  const codeEl  = modal.querySelector(".fpm-code");
  const preEl   = modal.querySelector(".fpm-pre");
  const frameEl = modal.querySelector(".fpm-frame");
  const viewTabs = modal.querySelector(".fpm-view-tabs");
  const browserBtn = modal.querySelector(".fpm-browser-btn");
  const folderBtn = modal.querySelector(".fpm-folder-btn");

  modal.dataset.source = text;          // raw text for the Copy button
  modal.dataset.artifactUrl = artifactUrl || "";
  browserBtn.hidden = !artifactUrl;
  folderBtn.hidden = !artifactUrl;
  codeEl.className = "fpm-code";
  codeEl.textContent = text;

  const ext = (name || "").split(".").pop().toLowerCase();
  const langMap = { js:"javascript", cjs:"javascript", mjs:"javascript",
                    ts:"typescript", jsx:"javascript", tsx:"typescript",
                    py:"python", rb:"ruby", php:"php", go:"go", java:"java",
                    cs:"csharp", rs:"rust", kt:"kotlin", swift:"swift", scala:"scala",
                    cpp:"cpp", cc:"cpp", hpp:"cpp", c:"c", h:"c",
                    html:"html", css:"css", scss:"scss", less:"less",
                    json:"json", md:"markdown", sh:"bash", bash:"bash",
                    yaml:"yaml", yml:"yaml", toml:"toml", xml:"xml", sql:"sql" };
  if (langMap[ext]) codeEl.className = `fpm-code language-${langMap[ext]}`;

  const isHtml = ext === "html" || ext === "htm";
  if (isHtml) {
    frameEl.srcdoc = text;
    viewTabs.hidden = false;
    setFileModalView(modal, "preview");
  } else {
    frameEl.removeAttribute("srcdoc");
    frameEl.style.display = "none";
    preEl.style.display = "block";
    viewTabs.hidden = true;
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
  modal.querySelector(".fpm-pre").style.display = "block";
  modal.querySelector(".fpm-view-tabs").hidden = true;
  modal.dataset.artifactUrl = url;
  modal.querySelector(".fpm-browser-btn").hidden = false;
  modal.querySelector(".fpm-folder-btn").hidden = false;
  modal.querySelector(".fpm-code").textContent = "Loading…";
  modal.classList.add("open");

  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    modal.querySelector(".fpm-code").textContent = `Could not load file: ${e.message}`;
    modal.querySelector(".fpm-browser-btn").hidden = true;
    modal.querySelector(".fpm-folder-btn").hidden = true;
    return;
  }
  renderFileModal(name, text, { artifactUrl: url });
}

// Open an HTML string directly in the rendered preview modal (used for code
// blocks the model dumped inline rather than writing to a file). When the server
// has persisted that block to the workspace it passes the artifact URL too, which
// is what unlocks "open in browser" / "show in folder" — those need a real file,
// not the in-memory string.
function previewHtmlString(html, name, artifactUrl = null) {
  ensureFileModal();
  renderFileModal(name || "preview.html", html, { artifactUrl });
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
