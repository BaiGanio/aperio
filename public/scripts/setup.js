if (location.protocol === "file:") {
  var t = window.t || function (k) { return null; };
  document.documentElement.innerHTML =
    '<body class="csp-style-17">' +
    '<h1 class="csp-style-18">' +
      (t("setup_file_guard_title") || "Please start Aperio with its launcher") + '</h1>' +
    '<p>' + (t("setup_file_guard_body") ||
      "This page needs Aperio's engine running. Opening the file directly won't work. " +
      "Close this tab and start Aperio from the Aperio folder: double-click <b>START.bat</b> " +
      "on Windows, or run <b>bash START.sh</b> on macOS / Linux. " +
      "Your browser will open the setup automatically.") + '</p>' +
    '<p class="csp-style-19">' + (t("setup_file_guard_url") ||
      "Already running? Open") + ' <a href="http://localhost:31337">http://localhost:31337</a>.</p>' +
    '</body>';
  throw new Error("setup.html opened over file:// — halting wizard.");
}

// ── Step definitions (must mirror bootstrap.js STEPS) ─────────────────────
const STEPS = [
  { id: "node",    labelKey: "setup_step_node",    icon: "bi-filetype-js" },
  { id: "deps",    labelKey: "setup_step_deps",    icon: "bi-box-seam"    },
  { id: "engine",  labelKey: "setup_step_engine",  icon: "bi-cpu"         },
  { id: "model",   labelKey: "setup_step_model",   icon: "bi-stars"       },
  { id: "sqlite",  labelKey: "setup_step_sqlite",  icon: "bi-database"    },
];

const _t = (k, p) => (window.t ? window.t(k, p) : k);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const state = Object.fromEntries(STEPS.map(s => [s.id, { status: "idle", detail: _t("setup_detail_waiting") }]));
let doneCount = 0;

// ── Build cards ───────────────────────────────────────────────────────────
const cardList = document.getElementById("cardList");

STEPS.forEach(s => {
  const card = document.createElement("div");
  card.className = "step-card";
  card.dataset.status = "idle";
  card.id = `card-${s.id}`;
  card.innerHTML = `
    <div class="step-icon-wrap">
      <i class="bi ${s.icon} step-bi-icon"></i>
    </div>
    <div class="step-text">
      <div class="step-label" data-i18n="${s.labelKey}">${_t(s.labelKey)}</div>
      <div class="step-detail" id="detail-${s.id}" data-i18n="setup_detail_waiting">${_t("setup_detail_waiting")}</div>
      ${s.id === "model" ? `<div class="model-download" id="modelDownload" aria-live="polite"><div class="model-download__row"><span id="modelDownloadStatus">Waiting for download…</span><span id="modelDownloadStats"></span></div><div class="model-download__bar"><div class="model-download__fill" id="modelDownloadFill"></div></div></div>` : ""}
    </div>
    <div class="step-spinner"></div>
    <span class="step-badge badge-idle" id="badge-${s.id}" data-i18n="setup_badge_idle">${_t("setup_badge_idle")}</span>
  `;
  cardList.appendChild(card);
});

// ── Helpers ───────────────────────────────────────────────────────────────
const BADGE_KEYS = { idle: "setup_badge_idle", running: "setup_badge_running", done: "setup_badge_done", skipped: "setup_badge_skipped", error: "setup_badge_error" };

function applyStep(id, status, detail) {
  const card  = document.getElementById(`card-${id}`);
  const badge = document.getElementById(`badge-${id}`);
  const det   = document.getElementById(`detail-${id}`);
  if (!card) return;

  card.dataset.status  = status;
  badge.className      = `step-badge badge-${status}`;
  if (status === "done" || status === "skipped") {
    // Finished steps show a single green checkmark instead of a text badge.
    delete badge.dataset.i18n;
    badge.innerHTML = '<i class="bi bi-check-lg"></i>';
  } else {
    badge.dataset.i18n = BADGE_KEYS[status] || "setup_badge_idle";
    badge.textContent  = _t(BADGE_KEYS[status] || "setup_badge_idle");
  }
  if (detail) {
    det.textContent = detail;
    delete det.dataset.i18n; // dynamic detail from server isn't translatable
  } else {
    // No live detail (hydrated from a snapshot). Keep the line consistent with
    // the badge instead of leaving a stale "Waiting…" next to a READY badge.
    if (status === "idle") {
      det.dataset.i18n = "setup_detail_waiting";
      det.textContent  = _t("setup_detail_waiting");
    } else if (status === "running") {
      det.dataset.i18n = "setup_badge_running";
      det.textContent  = _t("setup_badge_running");
    } else {
      delete det.dataset.i18n; // done / skipped / error → the badge carries the state
      det.textContent = "";
    }
  }
}

const formatBytes = bytes => {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
};
const formatDuration = seconds => {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
function applyDownloadProgress(download) {
  const box = document.getElementById("modelDownload");
  if (!box || !download) return;
  box.classList.add("show");
  box.dataset.status = download.status || "downloading";
  const status = document.getElementById("modelDownloadStatus");
  const stats = document.getElementById("modelDownloadStats");
  const fill = document.getElementById("modelDownloadFill");
  const labels = { downloading: "Downloading", completed: "Complete", failed: "Download failed", aborted: "Download aborted" };
  status.textContent = download.resumed ? "Resuming download" : (labels[download.status] || "Downloading");
  if (download.status === "completed") { status.textContent = "Download complete"; fill.style.width = "100%"; }
  else if (download.percent != null) fill.style.width = `${Math.min(100, download.percent)}%`;
  else fill.style.width = "35%";
  if (download.downloadedBytes != null && download.totalBytes != null) {
    stats.textContent = `${formatBytes(download.downloadedBytes)} / ${formatBytes(download.totalBytes)} · ${Math.round(download.percent ?? 0)}% · ${formatBytes(download.speedBytesPerSecond)}/s · ETA ${formatDuration(download.etaSeconds)}`;
  } else if (download.downloadedBytes != null) {
    stats.textContent = `${formatBytes(download.downloadedBytes)} downloaded · total unknown`;
  } else stats.textContent = "Waiting for transfer details…";
}

function updateProgress(done, total) {
  document.getElementById("progressFill").style.width  = `${Math.round(done / total * 100)}%`;
  document.getElementById("progressFrac").textContent  = `${done} / ${total}`;
  const labelEl = document.getElementById("progressLabel");
  if (done === total) {
    labelEl.dataset.i18n = "setup_all_done";
    labelEl.textContent = _t("setup_all_done");
  } else {
    delete labelEl.dataset.i18n;
    labelEl.textContent = _t("setup_step_of", { n: done + 1, total });
  }
}


function showDone() {
  document.getElementById("progressFill").style.width          = "100%";
  document.getElementById("progressFrac").textContent          = `${STEPS.length} / ${STEPS.length}`;
  document.getElementById("progressLabel").textContent         = _t("setup_all_done");
  document.getElementById("doneBanner").classList.add("show");
  document.getElementById("launchBtn").classList.add("show");
  document.getElementById("helpLink").classList.add("show");
  waitForAppReady();
}

// Bootstrap finishing only means the install steps are done — the server then
// warms up the app (embeddings → local engine → agent → WebSocket), which takes a
// while on first run. Navigating to "/" before that lands on a shell with no
// API/WebSocket to talk to, which looks frozen. So keep the launch button
// disabled and poll /api/bootstrap/state until `ready`, then open the app
// automatically. A timeout fallback re-enables the button so nobody is trapped.
function waitForAppReady() {
  const btn   = document.getElementById("launchBtn");
  const label = btn.querySelector("span");
  btn.disabled = true;
  label.dataset.i18n = "setup_starting_app";
  label.textContent  = _t("setup_starting_app");

  const POLL_MS = 1000;
  const MAX_MS  = 180000; // 3 min — well past a cold first-run warmup
  let elapsed = 0;

  const timer = setInterval(async () => {
    elapsed += POLL_MS;
    let ready = false;
    try { ready = (await fetch("/api/bootstrap/state").then(r => r.json())).ready; }
    catch (_e) { /* transient — the server may be busy warming up; keep polling */ }

    if (ready) {
      clearInterval(timer);
      window.location = "/";        // app is up — open it seamlessly
    } else if (elapsed >= MAX_MS) {
      clearInterval(timer);
      // Don't dead-end the user: re-enable the button so they can try anyway.
      btn.disabled = false;
      label.dataset.i18n = "setup_open_aperio";
      label.textContent  = _t("setup_open_aperio");
    }
  }, POLL_MS);
}

function showError(msg) {
  document.getElementById("errorText").textContent = _t("setup_error_prefix", { msg });
  document.getElementById("errorBanner").classList.add("show");
  const retry = document.getElementById("retrySetupBtn");
  if (retry) retry.disabled = false;
}

document.getElementById("retrySetupBtn")?.addEventListener("click", () => {
  esStarted = false;
  progressView.style.display = "none";
  wizardView.style.display = "";
  document.getElementById("errorBanner").classList.remove("show");
  document.querySelectorAll(".wiz-continue").forEach(b => b.disabled = false);
});

// ── Setup error modal — reuses the same .confirm-modal classes as the main app ──
function showSetupErrorModal(msg) {
  const modal = document.getElementById("confirmModal");
  if (!modal) return;
  modal.querySelector(".confirm-title").textContent = "Error";
  modal.querySelector(".confirm-message").textContent = msg;
  modal.querySelector(".confirm-btn--cancel").style.display = "none";
  const okBtn = document.getElementById("confirmOkBtn");
  if (okBtn) okBtn.textContent = "Close";
  modal.classList.add("active");
}
function closeSetupErrorModal() {
  const modal = document.getElementById("confirmModal");
  if (modal) modal.classList.remove("active");
  // Re-enable wizard buttons so the user can try again.
  document.querySelectorAll(".wiz-continue").forEach(b => b.disabled = false);
}

// Close modal when clicking the overlay background.
document.getElementById("confirmModal")?.addEventListener("click", (e) => {
  if (!e.target.closest(".confirm-content")) closeSetupErrorModal();
});

// Close modal on Escape key.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSetupErrorModal();
});

// ── View switching ────────────────────────────────────────────────────────
const wizardView   = document.getElementById("wizardView");
const progressView = document.getElementById("progressView");

// ── SSE — only connected once bootstrap has actually started ───────────────
let esStarted = false;
function startProgress() {
  wizardView.style.display   = "none";
  progressView.style.display = "";
  if (esStarted) return;
  esStarted = true;

  const es = new EventSource("/api/bootstrap/stream");

  es.addEventListener("snapshot", e => {
    const { steps } = JSON.parse(e.data);
    let done = 0;
    steps.forEach(s => {
      applyStep(s.id, s.status, "");
      if (s.status === "done" || s.status === "skipped") done++;
    });
    doneCount = done;
    updateProgress(done, STEPS.length);
  });

  es.addEventListener("step", e => {
    const { id, status, detail } = JSON.parse(e.data);
    applyStep(id, status, detail);
    if (status === "done" || status === "skipped") {
      doneCount++;
      updateProgress(doneCount, STEPS.length);
    }
  });

  es.addEventListener("progress", e => {
    const data = JSON.parse(e.data);
    if (data.download) applyDownloadProgress(data.download);
  });

  es.addEventListener("complete", () => { es.close(); showDone(); });
  es.addEventListener("error", function(e) {
    try {
      es.close();
      esStarted = false;
      const data = JSON.parse(e.data);
      applyDownloadProgress({ status: /abort|cancel/i.test(data.message || "") ? "aborted" : "failed" });
      showError(data.message);
    }
    catch (_e) { /* SSE connection drop — browser will retry automatically */ }
  });
}

// ── Wizard navigation ──────────────────────────────────────────────────────
const wizChoice = document.getElementById("wizChoice");
const wizCloud  = document.getElementById("wizCloud");
const wizLocal  = document.getElementById("wizLocal");

function showScreen(el) {
  [wizChoice, wizCloud, wizLocal].forEach(s => s.style.display = "none");
  el.style.display = "";
}

document.querySelectorAll("[data-choice]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.choice === "cloud") showScreen(wizCloud);
    else { showScreen(wizLocal); loadSpecs(); }
  });
});
document.querySelectorAll("[data-back]").forEach(b =>
  b.addEventListener("click", () => showScreen(wizChoice)));

// ── Cloud screen ───────────────────────────────────────────────────────────
const KEY_HELP = {
  anthropic: "https://console.anthropic.com/settings/keys",
  deepseek:  "https://platform.deepseek.com/api_keys",
  codex:     "https://platform.openai.com/api-keys",
  // gemini:    "https://aistudio.google.com/app/apikey",
};
const providerSel = document.getElementById("wizProvider");
const keyHelp     = document.getElementById("wizKeyHelp");
const syncKeyHelp = () => {
  keyHelp.href = KEY_HELP[providerSel.value];
  const keyEl = document.getElementById("wizKey");
  keyEl.placeholder = providerSel.value === "codex"
    ? "Optional API key (leave blank after `codex login`)"
    : _t("wiz_key_placeholder");
};
providerSel.addEventListener("change", syncKeyHelp);
syncKeyHelp();

document.getElementById("wizCloudGo").addEventListener("click", () => {
  const keyEl   = document.getElementById("wizKey");
  const apiKey  = keyEl.value.trim();
  if (!apiKey && providerSel.value !== "codex") { keyEl.focus(); return; }
  submitConfig({ provider: providerSel.value, apiKey });
});

// ── Local screen ───────────────────────────────────────────────────────────
// llama.cpp is the only local engine. /api/setup/specs recommends a model
// sized to this machine's RAM.
const FALLBACK_MODEL_HF = "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M";
let recommendedModel = null;
let recommendedModelHf = null;
let shouldPullLocalModel = false;
let selectedLocalModel = null;

function modelFamily(repo) {
  return String(repo || "").replace(/-qat(?=-GGUF$)/i, "");
}

function populateCachedModels(specs) {
  const select = document.getElementById("wizModelSelect");
  const cached = Array.isArray(specs.cachedModels) ? specs.cachedModels : [];
  select.replaceChildren();
  const recommendedRepo = String(specs.recommendedModelHf || "").split(":")[0];
  const family = modelFamily(recommendedRepo);
  const choices = cached
    .filter(item => item?.repo && Array.isArray(item.files) && item.files.length)
    .map(item => ({ ...item, installedFamily: modelFamily(item.repo) }))
    .sort((a, b) => (a.installedFamily === family ? -1 : 0) - (b.installedFamily === family ? -1 : 0));
  if (!choices.length) {
    select.style.display = "none";
    selectedLocalModel = null;
    return;
  }
  const prompt = document.createElement("option");
  prompt.value = "";
  prompt.textContent = "Download the recommended model";
  select.appendChild(prompt);
  for (const item of choices) {
    const option = document.createElement("option");
    option.value = item.repo;
    const size = Math.max(...item.files.map(file => file.sizeGB || 0));
    option.textContent = `${item.installedFamily === family ? "✓ Recommended family — " : "✓ Installed — "}${item.repo} (${size.toFixed(1)} GB)`;
    select.appendChild(option);
  }
  select.style.display = "";
  const familyChoice = choices.find(item => item.installedFamily === family);
  if (familyChoice && familyChoice.repo !== recommendedRepo) {
    select.value = familyChoice.repo;
    selectedLocalModel = familyChoice.repo;
    shouldPullLocalModel = false;
  }
  select.onchange = () => {
    selectedLocalModel = select.value || null;
    shouldPullLocalModel = !selectedLocalModel;
  };
}

async function loadSpecs() {
  const box = document.getElementById("wizSpecs");
  const go  = document.getElementById("wizLocalGo");
  const select = document.getElementById("wizModelSelect");
  box.textContent = _t("wiz_checking");
  select.style.display = "none";
  select.replaceChildren();
  go.disabled = true;
  try {
    const s = await fetch("/api/setup/specs").then(r => r.json());
    recommendedModel = s.recommendedModel;
    recommendedModelHf = s.recommendedModelHf;
    shouldPullLocalModel = true;
    selectedLocalModel = null;
    populateCachedModels(s);
    const disk = s.diskGB == null ? _t("wiz_specs_unknown") : `${s.diskGB} GB`;
    const size = s.modelSizeGB ? ` ${_t("wiz_download", { n: s.modelSizeGB })}` : "";
    let html = `<b>${s.ramGB} GB</b> ${_t("wiz_ram")} &middot; <b>${disk}</b> ${_t("wiz_disk")}<br>`
             + `${_t("wiz_recommended")} <b>${escapeHtml(s.recommendedModel)}</b>${size}`
             + `<br><small>Model ID: <code>${escapeHtml(s.recommendedModelHf)}</code></small>`;
    if (!s.enoughDisk) html += `<br><span class="wiz-warn">${_t("wiz_disk_warn")}</span>`;
    box.innerHTML = html;
    go.disabled = false;
  } catch (_e) {
    // Couldn't reach the specs endpoint (e.g. opened as a file, or the request
    // failed). Don't dead-end the user — fall back to the safe small model that
    // runs almost anywhere, name it so they know what's coming, and let them go.
    recommendedModelHf = FALLBACK_MODEL_HF;
    shouldPullLocalModel = true;
    box.textContent = _t("wiz_specs_failed", { model: FALLBACK_MODEL_HF });
    go.disabled = false;
  }
}
document.getElementById("wizLocalGo").addEventListener("click", () => {
  const selected = selectedLocalModel || document.getElementById("wizModelSelect").value;
  const fallback = recommendedModelHf || FALLBACK_MODEL_HF;
  submitConfig({
    provider: "llamacpp",
    model: selected || fallback,
    pullModel: selected ? false : shouldPullLocalModel,
  });
});

// ── Submit config → kick off bootstrap → show progress ─────────────────────
async function submitConfig(payload) {
  const buttons = document.querySelectorAll(".wiz-continue");
  buttons.forEach(b => b.disabled = true);
  try {
    const r = await fetch("/api/setup/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      showSetupErrorModal(e.error || _t("wiz_submit_failed"));
      return;
    }
    startProgress();
  } catch (_e) {
    showSetupErrorModal(_t("wiz_network_failed"));
  }
}

// ── Router: wizard vs. progress on load (handles mid-bootstrap refresh) ────
fetch("/api/bootstrap/state")
  .then(r => r.json())
  .then(data => {
    if (data.bootstrapped) { window.location = "/"; return; }
    if (data.started) {
      let done = 0;
      (data.steps ?? []).forEach(s => {
        applyStep(s.id, s.status, "");
        if (s.status === "done" || s.status === "skipped") done++;
      });
      doneCount = done;
      updateProgress(done, STEPS.length);
      startProgress();
    }
    // else: bootstrap not started yet → leave the wizard visible (default)
  });
