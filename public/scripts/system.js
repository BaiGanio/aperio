// ── System panel ────────────────────────────────────────────────
let systemPanelOpen = false;
let systemPanelTimer = null;

function toggleSystemPanel() {
  systemPanelOpen = !systemPanelOpen;
  const panel    = document.getElementById("system-panel");
  const backdrop = document.getElementById("system-backdrop");
  const btn      = document.getElementById("systemBtn");

  panel.style.display    = systemPanelOpen ? "flex" : "none";
  backdrop.style.display = systemPanelOpen ? "block" : "none";
  if (btn) {
    btn.style.borderColor = systemPanelOpen ? "var(--accent)" : "var(--border)";
    btn.style.color       = systemPanelOpen ? "var(--accent)" : "var(--text-muted)";
  }

  if (systemPanelOpen) {
    document.getElementById("system-metrics-body").innerHTML =
      '<div class="system-loading">Loading metrics…</div>';
    refreshSystemPanel();
    systemPanelTimer = setInterval(refreshSystemPanel, 2000);
  } else {
    clearInterval(systemPanelTimer);
    systemPanelTimer = null;
  }
}

// ── Formatters ──────────────────────────────────────────────────
function fmtMemSystem(mb) {
  return mb >= 1024 ? (mb / 1024).toFixed(1).replace(/\.0$/, '') + ' GB' : mb + ' MB';
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtLoadBar(load, cores) {
  const pct = Math.min(100, Math.round((load / cores) * 100));
  let cls = "";
  if (pct >= 80) cls = "high";
  else if (pct >= 60) cls = "warn";
  return `<div class="system-load-bar-wrap">
    <div class="system-load-bar"><div class="system-load-bar-fill ${cls}" style="width:${pct}%"></div></div>
  </div>`;
}

// ── Render ──────────────────────────────────────────────────────
function refreshSystemPanel() {
  const body = document.getElementById("system-metrics-body");

  fetch('/api/system')
    .then(res => res.json())
    .then(m => {
      const usedMem   = m.systemUsedMem ?? (m.systemTotalMem - m.systemFreeMem);
      const memPct    = m.systemTotalMem > 0 ? Math.round((usedMem / m.systemTotalMem) * 100) : 0;
      const loadPct   = Math.min(100, Math.round((m.loadAvg1 / m.cores) * 100));
      const memColor  = memPct >= 80 ? '#e05555' : memPct >= 60 ? '#f0a040' : 'var(--accent)';
      const loadColor = loadPct >= 80 ? '#e05555' : loadPct >= 60 ? '#f0a040' : 'var(--accent)';

      body.innerHTML = `
        <div class="system-section-title">Process</div>
        <div class="system-cards">
          <div class="system-card">
            <div class="system-card-value">${fmtMemSystem(m.rss)}</div>
            <div class="system-card-label">RSS</div>
            <div class="system-card-desc">RAM this process is using right now — mostly the local embedding model and native libraries, not JavaScript.</div>
          </div>
          <div class="system-card">
            <div class="system-card-value">${fmtMemSystem(m.heap)}</div>
            <div class="system-card-label">Heap</div>
            <div class="system-card-desc">JavaScript heap — memory used by objects and variables.</div>
          </div>
          <div class="system-card">
            <div class="system-card-value">${m.cpu}%</div>
            <div class="system-card-label">CPU</div>
            <div class="system-card-desc">Process CPU usage — how hard this server is working.</div>
          </div>
          <div class="system-card">
            <div class="system-card-value">${m.memories_total}</div>
            <div class="system-card-label">Memories</div>
            <div class="system-card-desc">Total memories stored in this brain.</div>
          </div>
        </div>

        <div class="system-section-title">Machine</div>
        <div class="system-cards">
          <div class="system-card system-card-full">
            <div class="system-card-value csp-style-27">
              ${fmtMemSystem(usedMem)} / ${fmtMemSystem(m.systemTotalMem)}
              <span style="color:${memColor};margin-left:8px;font-size:calc(12px*var(--font-scale));">${memPct}% used</span>
            </div>
            <div class="system-card-label">System Memory</div>
            ${fmtLoadBar(memPct, 100)}
            <div class="system-card-desc csp-style-28">RAM used by the whole machine vs. total installed.${m.platform === 'darwin'
              ? ' Counted like Activity Monitor — file cache excluded.' : ''}</div>
          </div>
          <div class="system-card system-card-full">
            <div class="system-card-value csp-style-27">
              ${m.loadAvg1} · ${m.loadAvg5} · ${m.loadAvg15}
              <span style="color:${loadColor};margin-left:8px;font-size:calc(12px*var(--font-scale));">${m.cores} CPU cores${m.perfCores
                ? ` (${m.perfCores} performance + ${m.effCores} efficiency)` : ''}</span>
            </div>
            <div class="system-card-label">Load Average</div>
            ${fmtLoadBar(m.loadAvg1, m.cores)}
            <div class="system-card-desc csp-style-28">Machine-wide demand for CPU, averaged over the last 1 · 5 · 15 minutes.</div>
          </div>
          <div class="system-card">
            <div class="system-card-value csp-style-27">${fmtUptime(m.uptime)}</div>
            <div class="system-card-label">Uptime</div>
            <div class="system-card-desc">How long since this machine was booted.</div>
          </div>
          <div class="system-card">
            <div class="system-card-value csp-style-27">${m.platform} · ${m.arch}</div>
            <div class="system-card-label">Platform</div>
            <div class="system-card-desc">Operating system and CPU architecture.</div>
          </div>
        </div>

        <div class="system-info-row">
          <span>Node ${m.nodeVersion}</span>
          <span>refreshes every 2 s</span>
        </div>`;
    })
    .catch(() => {
      body.innerHTML = '<div class="system-loading csp-style-29">Failed to load metrics.</div>';
    });
}
