// ── Memory table modal ───────────────────────────────────────
function openMemoryTable() {
  const modal = document.getElementById('memoryModal');
  if (!modal) return;
  modal.style.display = 'flex';
  refreshMemories();
}

// Opened from the DB panel's "Memories" row (see scripts/db-panel.js).
window.openMemoryTable = openMemoryTable;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('memoryModal');
    if (modal && modal.style.display === 'flex') closeModal();
  }
});

document.getElementById('memoryModal').addEventListener('click', (e) => {
  if (!e.target.closest('.mem-table-content')) closeModal();
});

function closeModal() {
  const modal = document.getElementById('memoryModal');
  if (modal) modal.style.display = 'none';
}

async function refreshMemories() {
  try {
    const res = await fetch('/api/memories');
    const data = await res.json();
    window.allMemories = Array.isArray(data.raw) ? data.raw : [];
    window.filteredMemories = [...window.allMemories];
    const searchInput = document.getElementById('memory-search');
    if (searchInput) searchInput.value = '';
    window.currentPage = 1;
    updateModalCount();
    renderTablePage();
  } catch (err) {
    const wrapper = document.getElementById('table-wrapper');
    if (wrapper) wrapper.innerHTML = `<div class="mem-empty csp-style-24">${window.escapeHtml(err.message)}</div>`;
  }
}
window.refreshMemories = refreshMemories;

function updateModalCount() {
  const el = document.getElementById('memTableCount');
  if (el) el.textContent = window.allMemories.length ? `(${window.allMemories.length})` : '';
  const info = document.getElementById('mem-filter-info');
  if (info) info.textContent = '';
}

function handleSearch() {
  const searchInput = document.getElementById('memory-search');
  if (!searchInput) return;
  const term = searchInput.value.toLowerCase();
  window.filteredMemories = window.allMemories.filter(m => {
    const meta = m.metadata || m;
    const tagsStr = parseTags(meta.tags);
    const blob = `${meta.title || ''} ${meta.content || ''} ${tagsStr}`.toLowerCase();
    return blob.includes(term);
  });
  window.currentPage = 1;
  const info = document.getElementById('mem-filter-info');
  if (info) {
    info.textContent = term
      ? `${window.filteredMemories.length} of ${window.allMemories.length} rows`
      : '';
  }
  renderTablePage();
}


function parseTags(tags) {
  if (!tags) return '';
  if (Array.isArray(tags)) return tags.join(', ');
  if (typeof tags !== 'string') return '';
  const s = tags.trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1);
    const items = [];
    let cur = '', inQ = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { if (cur.trim()) items.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
    if (cur.trim()) items.push(cur.trim());
    return items.join(', ');
  }
  try { const p = JSON.parse(s); return Array.isArray(p) ? p.join(', ') : s; }
  catch { return s; }
}

function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toISOString().slice(0, 16).replace('T', ' ');
}

function impDots(importance) {
  const n = Math.min(Math.max(Number(importance) || 0, 0), 5);
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="mem-imp-dot${i < n ? ' on' : ''}"></span>`
  ).join('');
}

function renderTablePage() {
  const wrapper = document.getElementById('table-wrapper');
  const pageInfo = document.getElementById('page-info');
  const controls = document.getElementById('pagination-controls');
  if (!wrapper || !controls) return;

  if (window.filteredMemories.length === 0) {
    wrapper.innerHTML = '<div class="mem-empty">No memories found.</div>';
    controls.style.display = 'none';
    return;
  }

  const start = (window.currentPage - 1) * window.recordsPerPage;
  const end = start + window.recordsPerPage;
  const pageItems = window.filteredMemories.slice(start, end);
  const totalPages = Math.ceil(window.filteredMemories.length / window.recordsPerPage) || 1;

  controls.style.display = 'flex';
  if (pageInfo) {
    pageInfo.textContent = `${window.currentPage} / ${totalPages}  ·  ${window.filteredMemories.length} rows`;
  }

  let html = `<table class="mem-tbl">
    <thead>
      <tr>
        <th class="mem-col-num">#</th>
        <th class="mem-col-type">Type</th>
        <th>Memory</th>
        <th class="mem-col-imp">Imp.</th>
        <th class="mem-col-del"></th>
      </tr>
    </thead>
    <tbody>`;

  html += pageItems.map((m, i) => {
    const row = m.metadata || m;
    const rowNum = start + i + 1;

    const type       = row.type    || 'unknown';
    const title      = row.title   || 'Untitled';
    const content    = row.content || '';
    const tagsStr    = parseTags(row.tags);
    const importance = row.importance != null ? Number(row.importance) : 1;

    const id        = row.id || '';
    const createdAt = fmtDate(row.created_at || row.createdAt);
    const source    = row.source || '';
    const expiresAt = (row.expires_at || row.expiresAt) ? fmtDate(row.expires_at || row.expiresAt) : null;

    const safeType    = window.escapeHtml(type);
    const safeTitle   = window.escapeHtml(title);
    const safeContent = window.escapeHtml(content);
    const safeTags    = window.escapeHtml(tagsStr);

    const metaParts = [];
    if (id)        metaParts.push(`<span class="mem-meta-label">id</span> ${window.escapeHtml(id)}`);
    if (createdAt) metaParts.push(`<span class="mem-meta-label">created</span> ${window.escapeHtml(createdAt)}`);
    if (source)    metaParts.push(`<span class="mem-meta-label">source</span> ${window.escapeHtml(source)}`);
    if (expiresAt) metaParts.push(`<span class="mem-meta-label">expires</span> ${window.escapeHtml(expiresAt)}`);
    const metaHtml = metaParts.length
      ? `<div class="mem-meta-row">${metaParts.map(p => `<span>${p}</span>`).join('')}</div>`
      : '';

    return `<tr>
      <td class="mem-col-num mem-row-num">${rowNum}</td>
      <td class="mem-col-type"><span class="mem-type-badge">${safeType}</span></td>
      <td>
        <div class="mem-content-title">${safeTitle}</div>
        <div class="mem-content-body">${safeContent}</div>
        ${safeTags ? `<div class="mem-tags-row">🏷️ ${safeTags}</div>` : ''}
        ${metaHtml}
      </td>
      <td class="mem-col-imp mem-imp-cell" title="Importance: ${importance}/5">
        <span class="mem-imp-dots">${impDots(importance)}</span>
      </td>
      <td class="mem-col-del">
        <button class="mem-del-btn" data-id="${window.escapeHtml(id)}" data-title="${safeTitle}" title="Delete memory">
          <i class="bi bi-trash3"></i>
        </button>
      </td>
    </tr>`;
  }).join('');

  html += '</tbody></table>';
  wrapper.innerHTML = html;

  wrapper.querySelectorAll('.mem-del-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const title = btn.dataset.title;
      if (!id) return;
      if (!await askConfirmModal(t('mem_delete_title'), t('mem_delete_confirm', { title }), 'Delete')) return;
      window.allMemories = window.allMemories.filter(m => (m.metadata || m).id !== id);
      window.filteredMemories = window.filteredMemories.filter(m => (m.metadata || m).id !== id);
      window.safeSend(JSON.stringify({ type: 'delete_memory', id }));
      updateModalCount();
      window.renderMemories(window.allMemories);
      renderTablePage();
    });
  });

  document.getElementById('prev-page').disabled = window.currentPage === 1;
  document.getElementById('next-page').disabled = window.currentPage === totalPages;
}


function changePage(step) {
  window.currentPage += step;
  renderTablePage();
  const body = document.querySelector('.mem-table-body');
  if (body) body.scrollTop = 0;
}
window.changePage = changePage;
