// ── Paths panel ────────────────────────────────────────────────
let _pathsReadList    = [];
let _pathsWriteList   = [];
let _currentSessionId = null;

function setCurrentSessionId(id) { _currentSessionId = id; }

async function openPathsPanel() {
  try {
    const data = await fetch("/api/paths").then(r => r.json());
    _pathsReadList  = [...(data.readPaths  || [])];
    _pathsWriteList = [...(data.writePaths || [])];
  } catch {
    _pathsReadList  = [];
    _pathsWriteList = [];
  }
  _renderPathChips("read");
  _renderPathChips("write");
  document.getElementById("paths-modal").style.display = "flex";
}

function closePathsPanel() {
  document.getElementById("paths-modal").style.display = "none";
}

function _renderPathChips(type) {
  const list = type === "read" ? _pathsReadList : _pathsWriteList;
  const el   = document.getElementById(`${type}-paths-chips`);
  if (!el) return;
  if (list.length === 0) {
    el.innerHTML = `<span class="paths-empty-hint">No paths configured</span>`;
    return;
  }
  el.innerHTML = "";
  // Rebuild with current indices so closures are fresh after every render
  list.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "path-chip";
    chip.innerHTML = `<span class="path-chip-text" title="${p}">${p}</span>
      <button class="path-chip-del" title="Remove">×</button>`;
    chip.querySelector(".path-chip-del").onclick = () => {
      list.splice(i, 1);
      _renderPathChips(type);
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
  }
  input.value = "";
  input.focus();
}

// Open native Finder folder picker (macOS) via server-side osascript,
// falling back to browser <input webkitdirectory> on other platforms.
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

async function applyPaths() {
  const applyBtn = document.querySelector(".paths-apply-btn");
  const origHTML = applyBtn.innerHTML;
  applyBtn.disabled = true;
  applyBtn.textContent = "Applying…";
  try {
    const res = await fetch("/api/paths", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ readPaths: _pathsReadList, writePaths: _pathsWriteList, sessionId: _currentSessionId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unknown error");
    applyBtn.innerHTML = '<i class="bi bi-check-lg"></i> Applied!';
    setTimeout(closePathsPanel, 700);
  } catch (err) {
    alert("Failed to apply paths: " + err.message);
    applyBtn.disabled = false;
    applyBtn.innerHTML = origHTML;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Enter key submits in add-path inputs
  ["read", "write"].forEach(type => {
    const inp = document.getElementById(`${type}-path-input`);
    if (inp) inp.addEventListener("keydown", e => {
      if (e.key === "Enter") addPathChip(type);
    });
  });

  // Escape closes the modal
  document.addEventListener("keydown", e => {
    const modal = document.getElementById("paths-modal");
    if (e.key === "Escape" && modal && modal.style.display !== "none") closePathsPanel();
  });
});
