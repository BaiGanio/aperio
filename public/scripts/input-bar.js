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

// ── "+" actions menu (attach / branch) ────────────────────────
// The attach button doubles as a small menu so Branch has a discoverable home
// next to the file affordance it's often reached for. Clicking the button
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

// ── Branch button + friendly confirm card ─────────────────────
// Branching saves the current conversation as-is and opens a fresh thread
// seeded with a summary of it — the original stays in Sessions. A friendly
// inline card explains that (replacing the bare browser confirm()).
function askBranchConfirm() {
  closePlusMenu();
  if (document.getElementById("branchConfirmCard")) return; // already asking
  const card = document.createElement("div");
  card.className = "branch-confirm-card";
  card.id = "branchConfirmCard";
  card.innerHTML =
    `<b>${t("branch_card_title")}</b>` +
    `<span>${t("branch_card_body")}</span>` +
    `<div class="branch-confirm-row">` +
      `<button type="button" class="branch-confirm-btn branch-confirm-btn--primary" id="branchGo">${t("branch_card_go")}</button>` +
      `<button type="button" class="branch-confirm-btn" id="branchStay">${t("branch_card_stay")}</button>` +
    `</div>`;
  const wrap = document.querySelector(".input-bar .input-wrap");
  wrap?.insertAdjacentElement("afterend", card);
  card.querySelector("#branchStay").addEventListener("click", () => card.remove());
  card.querySelector("#branchGo").addEventListener("click", () => {
    card.remove();
    window.safeSend?.(JSON.stringify({ type: "branch_conversation" }));
  });
}

document.getElementById("branchBtn")?.addEventListener("click", askBranchConfirm);
document.getElementById("pmBranch")?.addEventListener("click", askBranchConfirm);

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