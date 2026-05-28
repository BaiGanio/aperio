// ── Paths panel ────────────────────────────────────────────────
let _pathsReadList    = [];
let _pathsWriteList   = [];
let _currentSessionId = null;

// Snapshot of the lists as loaded, so Apply can stay disabled until the user
// actually adds or removes a path.
let _pathsSnapshot    = "";

// Last-known per-connection paths, updated by paths_updated / paths_restored.
// null means no WS update has arrived yet — fall back to GET /api/paths.
let _liveReadPaths  = null;
let _liveWritePaths = null;

function setCurrentSessionId(id) { _currentSessionId = id; }

// Called from streaming.js when the server confirms a path change.
function notifyPathsChanged(readPaths, writePaths) {
  _liveReadPaths  = readPaths;
  _liveWritePaths = writePaths;
}

async function openPathsPanel() {
  if (_liveReadPaths !== null) {
    _pathsReadList  = [..._liveReadPaths];
    _pathsWriteList = [..._liveWritePaths];
  } else {
    try {
      const data = await fetch("/api/paths").then(r => r.json());
      _pathsReadList  = [...(data.readPaths  || [])];
      _pathsWriteList = [...(data.writePaths || [])];
    } catch {
      _pathsReadList  = [];
      _pathsWriteList = [];
    }
  }
  _pathsSnapshot = JSON.stringify([_pathsReadList, _pathsWriteList]);
  _renderPathChips("read");
  _renderPathChips("write");
  _updateApplyState();
  document.getElementById("paths-modal").style.display = "flex";
}

function closePathsPanel() {
  document.getElementById("paths-modal").style.display = "none";
}

// Apply is enabled only when the current lists differ from what was loaded.
function _updateApplyState() {
  const btn = document.querySelector(".paths-apply-btn");
  if (!btn) return;
  btn.disabled = JSON.stringify([_pathsReadList, _pathsWriteList]) === _pathsSnapshot;
}

function _renderPathChips(type) {
  const list = type === "read" ? _pathsReadList : _pathsWriteList;
  const el   = document.getElementById(`${type}-paths-chips`);
  if (!el) return;
  if (list.length === 0) {
    el.innerHTML = `<span class="paths-empty-hint">${t("paths_empty")}</span>`;
    return;
  }
  el.innerHTML = "";
  // Rebuild with current indices so closures are fresh after every render
  list.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "path-chip";
    chip.innerHTML = `<span class="path-chip-text" title="${p}">${p}</span>
      <button class="path-chip-del" title="${t("paths_remove_title")}">×</button>`;
    chip.querySelector(".path-chip-del").onclick = () => {
      list.splice(i, 1);
      _renderPathChips(type);
      _updateApplyState();
    };
    el.appendChild(chip);
  });
}

function addPathChip(type) {
  const input = document.getElementById(`${type}-path-input`);
  const val   = input.value.trim();
  if (!val) return;
  const list  = type === "read" ? _pathsReadList : _pathsWriteList;
  if (!list.includes(val)) {
    list.push(val);
    _renderPathChips(type);
    _updateApplyState();
  }
  input.value = "";
  input.focus();
}

// Open a native folder picker via the server (osascript/zenity/kdialog/PowerShell),
// falling back to browser <input webkitdirectory> if the server has no picker available.
async function _pickFolder(type) {
  try {
    const res  = await fetch("/api/pick-folder");
    const data = await res.json();
    if (data.path) {
      const input = document.getElementById(`${type}-path-input`);
      if (input) { input.value = data.path; input.focus(); }
      return;
    }
    if (data.cancelled) return;
    // Non-macOS — fall through to browser picker
  } catch {}

  // Browser fallback: webkitdirectory input (gives folder name, not full path)
  const fileInput = document.getElementById(`${type}-folder-input`);
  if (!fileInput) return;
  fileInput.onchange = (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const rel  = files[0].webkitRelativePath || "";
    const name = rel.split("/")[0] || files[0].name || "";
    const input = document.getElementById(`${type}-path-input`);
    if (input && name) {
      input.value = name;
      input.focus();
      input.select();
    }
    fileInput.value = "";
  };
  fileInput.click();
}

function applyPaths() {
  const applyBtn = document.querySelector(".paths-apply-btn");
  const origHTML = applyBtn.innerHTML;
  applyBtn.disabled = true;
  applyBtn.textContent = t("paths_applying");

  // Send per-connection path update via WebSocket so paths are scoped to this
  // tab's connection and don't bleed into other open tabs.
  safeSend(JSON.stringify({
    type:       "set_paths",
    readPaths:  _pathsReadList,
    writePaths: _pathsWriteList,
    sessionId:  _currentSessionId,
  }));

  // Optimistically close — paths_updated from the server confirms the change.
  applyBtn.innerHTML = `<i class="bi bi-check-lg"></i> ${t("paths_applied")}`;
  setTimeout(closePathsPanel, 700);
}

document.addEventListener("DOMContentLoaded", () => {
  // Enter key submits in add-path inputs
  ["read", "write"].forEach(type => {
    const inp = document.getElementById(`${type}-path-input`);
    if (inp) inp.addEventListener("keydown", e => {
      if (e.key === "Enter") addPathChip(type);
    });
  });

  // Escape closes the panel
  document.addEventListener("keydown", e => {
    const modal = document.getElementById("paths-modal");
    if (e.key === "Escape" && modal && modal.style.display !== "none") closePathsPanel();
  });

  // Clicking the dim backdrop (outside the drawer) closes the panel.
  const modal = document.getElementById("paths-modal");
  if (modal) modal.addEventListener("click", e => {
    if (e.target === modal) closePathsPanel();
  });
});
