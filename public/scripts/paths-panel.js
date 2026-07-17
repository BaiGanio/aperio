// ── Allowed folders (Settings → expandable section) ─────────────
// A single, app-wide list of folders the AI can read and edit. Persisted in the
// DB via the WebSocket set_paths message; survives across sessions and restarts.
let _pathsList = [];

let _indexedRoots = null;
async function getIndexedRoots() {
  if (_indexedRoots !== null) return _indexedRoots;
  try {
    const d = await fetch("/api/codegraph/repos").then(r => r.json());
    _indexedRoots = (d.repos || []).map(r => r.root_path);
  } catch { _indexedRoots = []; }
  return _indexedRoots;
}

// Snapshot of the list as loaded, so Save stays disabled until the user actually
// adds or removes a path.
let _pathsSnapshot = "";

// Last-known list, updated by the paths_updated WS message. null means no WS
// update has arrived yet — fall back to GET /api/paths.
let _livePaths = null;

// Called from streaming.js when the server confirms a path change.
function notifyPathsChanged(paths) {
  _livePaths = paths;
}

// Load the current list into the editor. Called when the section is expanded.
async function loadPaths() {
  if (_livePaths !== null) {
    _pathsList = [..._livePaths];
  } else {
    try {
      const data = await fetch("/api/paths").then(r => r.json());
      _pathsList = [...(data.paths || [])];
    } catch {
      _pathsList = [];
    }
  }
  _pathsSnapshot = JSON.stringify(_pathsList);
  _renderPathChips();
  _updateApplyState();
}

// Save is enabled only when the current list differs from what was loaded.
function _updateApplyState() {
  const btn = document.querySelector(".paths-apply-btn");
  if (!btn) return;
  btn.disabled = JSON.stringify(_pathsList) === _pathsSnapshot;
}

function _renderPathChips() {
  const el = document.getElementById("paths-chips");
  if (!el) return;
  if (_pathsList.length === 0) {
    el.innerHTML = `<span class="paths-empty-hint">${t("paths_empty")}</span>`;
    return;
  }
  el.innerHTML = "";
  // Rebuild with current indices so closures are fresh after every render
  _pathsList.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "path-chip";
    const span = document.createElement("span");
    span.className = "path-chip-text";
    span.title = p;
    span.textContent = p;
    const btn = document.createElement("button");
    btn.className = "path-chip-del";
    btn.title = t("paths_remove_title");
    btn.textContent = "×";
    chip.append(span, btn);
    chip.querySelector(".path-chip-del").onclick = async () => {
      const roots = await getIndexedRoots();
      if (roots.includes(p)) {
        if (!await askConfirmModal("Remove allowed path", `Remove "${p}" from allowed paths?\n\nThis path has an indexed code graph repo. To fully remove it, delete the repo from the Code Graph panel instead.`, "Remove")) return;
      }
      _pathsList.splice(i, 1);
      _indexedRoots = null; // invalidate cache after mutation
      _renderPathChips();
      _updateApplyState();
    };
    el.appendChild(chip);
  });
}

function addPathChip() {
  const input = document.getElementById("path-input");
  const val   = input.value.trim();
  if (!val) return;
  if (!_pathsList.includes(val)) {
    _pathsList.push(val);
    _renderPathChips();
    _updateApplyState();
  }
  input.value = "";
  input.focus();
}

// Open a native folder picker via the server (osascript/zenity/kdialog/PowerShell),
// falling back to browser <input webkitdirectory> if the server has no picker available.
async function _pickFolder() {
  try {
    const res  = await fetch("/api/pick-folder");
    const data = await res.json();
    if (data.path) {
      const input = document.getElementById("path-input");
      if (input) { input.value = data.path; input.focus(); }
      return;
    }
    if (data.cancelled) return;
    // Non-macOS — fall through to browser picker
  } catch {}

  // Browser fallback: webkitdirectory input (gives folder name, not full path)
  const fileInput = document.getElementById("path-folder-input");
  if (!fileInput) return;
  fileInput.onchange = (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const rel  = files[0].webkitRelativePath || "";
    const name = rel.split("/")[0] || files[0].name || "";
    const input = document.getElementById("path-input");
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
  applyBtn.disabled = true;
  applyBtn.textContent = t("paths_applying");

  // Persist the app-wide allowlist via WebSocket; paths_updated confirms it.
  safeSend(JSON.stringify({ type: "set_paths", paths: _pathsList }));

  applyBtn.innerHTML = `<i class="bi bi-check-lg"></i> ${t("paths_applied")}`;
  _pathsSnapshot = JSON.stringify(_pathsList);
  setTimeout(() => {
    applyBtn.innerHTML = `<i class="bi bi-check-lg"></i> <span>${t("paths_apply")}</span>`;
    _updateApplyState();
  }, 1200);
}

document.addEventListener("DOMContentLoaded", () => {
  // Enter key submits in the overlay's add-path input.
  const inp = document.getElementById("path-input");
  if (inp) inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addPathChip(); }
  });
});
