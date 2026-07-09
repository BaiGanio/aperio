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

function updateSendBtn() {
  const hasText  = chatInput.value.trim().length > 0;
  const hasFiles = attachedFiles.length > 0;
  sendBtn.disabled = !(hasText || hasFiles);  // enable if either is true
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

document.getElementById('attachBtn').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const incoming = Array.from(e.target.files);
  fileInput.value = ''; // reset so same file can be re-added

  // Read each file into a data URL so the message bubble can render thumbnails
  // without a second async read at send time.
  incoming.forEach(file => {
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