window.attachedFiles = [];

const fileInput    = document.getElementById('fileInput');
const attachPreview = document.getElementById('attachPreview');

// ── Discuss toggle (round-table mode) ─────────────────────────────────────
// Disabled until the server announces `roundtableAvailable: true` via the
// `provider` event (see streaming.js → applyRoundtableAvailability).
const discussBtn = document.getElementById('discussBtn');
let _discussOn = false;
let _discussAvailable = false;

function _applyDiscussVisualState() {
  if (!discussBtn) return;
  discussBtn.classList.toggle("discuss-btn--on", _discussOn);
  discussBtn.setAttribute("aria-pressed", _discussOn ? "true" : "false");
  discussBtn.disabled = !_discussAvailable;
  discussBtn.style.opacity = _discussAvailable ? "" : "0.4";
  discussBtn.style.cursor = _discussAvailable ? "pointer" : "not-allowed";
}

// Remembers the localized default tooltip while a server-provided
// "why Discuss is disabled" reason temporarily replaces it.
let _discussTitleDefault = null;

window.applyRoundtableAvailability = function(available, reason) {
  _discussAvailable = Boolean(available);
  if (!available && _discussOn) _discussOn = false;
  if (discussBtn) {
    if (!available && reason) {
      if (_discussTitleDefault === null) _discussTitleDefault = discussBtn.title;
      discussBtn.title = reason;
    } else if (_discussTitleDefault !== null) {
      discussBtn.title = _discussTitleDefault;
      _discussTitleDefault = null;
    }
  }
  _applyDiscussVisualState();
};

window.isRoundtableRequested = function() {
  return _discussAvailable && _discussOn;
};

discussBtn?.addEventListener("click", () => {
  if (!_discussAvailable) return;
  _discussOn = !_discussOn;
  _applyDiscussVisualState();
  if (_discussOn) {
    // Arming Discuss: ask the main model to summarize the conversation so far and
    // offer it as the framing for the two agents. The server decides whether there
    // is enough history; the confirmation card (if any) is rendered by streaming.js
    // on the `discuss_summary` event.
    window.safeSend?.(JSON.stringify({ type: "discuss_start" }));
  } else {
    document.getElementById("discuss-summary-card")?.remove();
  }
});

_applyDiscussVisualState();

// ── "+" actions menu (attach) ────────────────────────
// The attach button doubles as a small menu. Clicking the button
// toggles the menu; a click anywhere else closes it.
const plusMenu = document.getElementById("plusMenu");
function closePlusMenu() {
  plusMenu?.classList.remove("open");
  attachBtn?.setAttribute("aria-expanded", "false");
}
const attachBtn = document.getElementById("attachBtn");
attachBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = plusMenu.classList.toggle("open");
  attachBtn.setAttribute("aria-expanded", open ? "true" : "false");
});
document.addEventListener("click", (e) => {
  if (plusMenu && !plusMenu.contains(e.target) && e.target !== attachBtn && !attachBtn?.contains(e.target)) {
    closePlusMenu();
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePlusMenu(); });

document.getElementById("pmAttach")?.addEventListener("click", () => {
  closePlusMenu();
  fileInput.click();
});

function updateSendBtn() {
  const hasText  = chatInput.value.trim().length > 0;
  const hasFiles = attachedFiles.length > 0;
  sendBtn.disabled = !(hasText || hasFiles);  // enable if either is true
}

// ── Attachment budget (S2.10) ─────────────────────────────────────────────
// The browser used to read ANY file with readAsDataURL and no size or count
// check at all, keeping the data URL on the File object. The budget below is
// the server's, fetched once from /api/config/client, so there is exactly one
// limit rather than a second one invented here. The server enforces it again
// in processAttachments — this check is the courtesy that saves a pointless
// read and tells the user why.
let _attachLimits = null;

const _ATTACH_FALLBACK = { attachmentMaxBytes: 10 * 1024 * 1024, attachmentMaxCount: 5 };

function _formatMb(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

// Fetched eagerly, but every caller falls back to the shipped defaults, so a
// failed or still-pending fetch bounds the file rather than waving it through.
fetch('/api/config/client')
  .then(r => r.json())
  .then(cfg => {
    _attachLimits = {
      attachmentMaxBytes: Number(cfg.attachmentMaxBytes) || _ATTACH_FALLBACK.attachmentMaxBytes,
      attachmentMaxCount: Number(cfg.attachmentMaxCount) || _ATTACH_FALLBACK.attachmentMaxCount,
    };
  })
  .catch(() => { _attachLimits = _ATTACH_FALLBACK; });

function _attachBudget() {
  return _attachLimits || _ATTACH_FALLBACK;
}

function _showAttachError(message) {
  const line = document.createElement('div');
  line.className = 'attach-error';
  line.setAttribute('role', 'status');
  line.textContent = `⚠ ${message}`;
  attachPreview.appendChild(line);
  setTimeout(() => line.remove(), 6000);
}

/**
 * The single gate every attachment entry point passes through: the file picker,
 * paste, and anything added later. Returns true when the file may be read.
 */
function acceptAttachment(file) {
  const { attachmentMaxBytes, attachmentMaxCount } = _attachBudget();

  if (attachedFiles.length >= attachmentMaxCount) {
    _showAttachError(`Only ${attachmentMaxCount} attachments per message.`);
    return false;
  }
  // Checked BEFORE readAsDataURL, so an oversized file is never read or
  // expanded into a ~1.33x base64 data URL.
  if (file.size > attachmentMaxBytes) {
    _showAttachError(
      `${file.name} is ${_formatMb(file.size)} — over the ${_formatMb(attachmentMaxBytes)} limit.`,
    );
    return false;
  }
  return true;
}

function renderPreviews() {
  attachPreview.innerHTML = '';
  attachedFiles.forEach((file, i) => {
    const chip = document.createElement('div');
    const isImage = file.type.startsWith('image/');
    chip.className = 'attach-chip' + (isImage ? ' is-image' : '');

    if (isImage) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      chip.appendChild(img);
    }

    const name = document.createElement('span');
    name.textContent = file.name;
    chip.appendChild(name);

    const rm = document.createElement('button');
    rm.className = 'remove-file';
    rm.textContent = '×';
    rm.title = (typeof t === "function") ? t('chat_attach_remove') : 'Remove';
    rm.addEventListener('click', () => {
      attachedFiles.splice(i, 1);
      renderPreviews();
      updateSendBtn();
    });
    chip.appendChild(rm);

    attachPreview.appendChild(chip);
  });
}

fileInput.addEventListener('change', (e) => {
  const incoming = Array.from(e.target.files);
  fileInput.value = ''; // reset so same file can be re-added

  // Read each file into a data URL so the message bubble can render thumbnails
  // without a second async read at send time.
  incoming.forEach(file => {
    if (!acceptAttachment(file)) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      file._dataUrl = ev.target.result; // attach dataUrl directly on the File object
      attachedFiles.push(file);
      renderPreviews();
      updateSendBtn();
    };
    reader.readAsDataURL(file);
  });
});

// hook into your existing input listener — just add updateSendBtn() there
chatInput.addEventListener('input', updateSendBtn);

// Paste images/files directly into the chat input with Cmd+V / Ctrl+V
document.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const fileItems = items.filter(it => it.kind === 'file');
  if (!fileItems.length) return;

  e.preventDefault();
  fileItems.forEach(item => {
    const file = item.getAsFile();
    if (!file) return;
    if (!acceptAttachment(file)) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      file._dataUrl = ev.target.result;
      attachedFiles.push(file);
      renderPreviews();
      updateSendBtn();
    };
    reader.readAsDataURL(file);
  });
});

/**
 * Call this at the start of your send handler (before clearing attachedFiles)
 * to get a plain snapshot for addUserMessage().
 * @returns {{ name: string, type: string, dataUrl: string }[]}
 */
window.getAttachmentsSnapshot = function() {
  return attachedFiles.map(f => ({
    name: f.name,
    type: f.type,
    dataUrl: f._dataUrl || null,
  }));
};
