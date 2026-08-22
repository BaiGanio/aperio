// ── Self-memory table modal ───────────────────
// Oversight view of the agent's own walled-off notes: read + delete only,
// backed by the dedicated GET/DELETE /api/self-memories endpoints (not the
// generic DB browser). Reuses parseTags/fmtDate/impDots/escapeHtml/t from
// memory-table.js and its neighbors, loaded earlier in index.html.
function openSelfMemoryTable() {
  const modal = document.getElementById('selfMemoryModal');
  if (!modal) return;
  modal.style.display = 'flex';
  refreshSelfMemories();
}

// Opened from the DB panel's "Self-memories" row (see scripts/db-panel.js).
window.openSelfMemoryTable = openSelfMemoryTable;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('selfMemoryModal');
    if (modal && modal.style.display === 'flex') closeSelfMemoryModal();
  }
});

document.getElementById('selfMemoryModal').addEventListener('click', (e) => {
  if (!e.target.closest('.mem-table-content')) closeSelfMemoryModal();
});

function closeSelfMemoryModal() {
  const modal = document.getElementById('selfMemoryModal');
  if (modal) modal.style.display = 'none';
}
window.closeSelfMemoryModal = closeSelfMemoryModal;

window.selfCurrentPage = 1;

async function refreshSelfMemories() {
  try {
    const res = await fetch('/api/self-memories');
    const data = await res.json();
    window.allSelfMemories = Array.isArray(data.raw) ? data.raw : [];
    window.filteredSelfMemories = [...window.allSelfMemories];
    const searchInput = document.getElementById('self-memory-search');
    if (searchInput) searchInput.value = '';
    window.selfCurrentPage = 1;
    updateSelfModalCount();
    renderSelfTablePage();
  } catch (err) {
    const wrapper = document.getElementById('self-table-wrapper');
    if (wrapper) wrapper.innerHTML = `<div class="mem-empty csp-style-24">${window.escapeHtml(err.message)}</div>`;
  }
}
window.refreshSelfMemories = refreshSelfMemories;

function updateSelfModalCount() {
  const el = document.getElementById('selfMemTableCount');
  if (el) el.textContent = window.allSelfMemories.length ? `(${window.allSelfMemories.length})` : '';
  const info = document.getElementById('self-mem-filter-info');
  if (info) info.textContent = '';
}

function handleSelfSearch() {
  const searchInput = document.getElementById('self-memory-search');
  if (!searchInput) return;
  const term = searchInput.value.toLowerCase();
  window.filteredSelfMemories = window.allSelfMemories.filter(m => {
    const tagsStr = parseTags(m.tags);
    const blob = `${m.title || ''} ${m.content || ''} ${tagsStr}`.toLowerCase();
    return blob.includes(term);
  });
  window.selfCurrentPage = 1;
  const info = document.getElementById('self-mem-filter-info');
  if (info) {
    info.textContent = term
      ? `${window.filteredSelfMemories.length} of ${window.allSelfMemories.length} rows`
      : '';
  }
  renderSelfTablePage();
}
window.handleSelfSearch = handleSelfSearch;

function renderSelfTablePage() {
  const wrapper = document.getElementById('self-table-wrapper');
  const pageInfo = document.getElementById('self-page-info');
  const controls = document.getElementById('self-pagination-controls');
  if (!wrapper || !controls) return;

  if (window.filteredSelfMemories.length === 0) {
    wrapper.innerHTML = '<div class="mem-empty">No self-memories found.</div>';
    controls.style.display = 'none';
    return;
  }

  const start = (window.selfCurrentPage - 1) * window.recordsPerPage;
  const end = start + window.recordsPerPage;
  const pageItems = window.filteredSelfMemories.slice(start, end);
  const totalPages = Math.ceil(window.filteredSelfMemories.length / window.recordsPerPage) || 1;

  controls.style.display = 'flex';
  if (pageInfo) {
    pageInfo.textContent = `${window.selfCurrentPage} / ${totalPages}  ·  ${window.filteredSelfMemories.length} rows`;
  }

  let html = `<table class="mem-tbl">
    <thead>
      <tr>
        <th class="mem-col-num">#</th>
        <th>Memory</th>
        <th class="mem-col-imp">Imp.</th>
        <th class="mem-col-del"></th>
      </tr>
    </thead>
    <tbody>`;

  html += pageItems.map((row, i) => {
    const rowNum = start + i + 1;

    const title      = row.title   || 'Untitled';
    const content    = row.content || '';
    const tagsStr    = parseTags(row.tags);
    const importance = row.importance != null ? Number(row.importance) : 1;

    const id        = row.id || '';
    const createdAt = fmtDate(row.created_at || row.createdAt);
    const source    = row.source || '';

    const safeTitle   = window.escapeHtml(title);
    const safeContent = window.escapeHtml(content);
    const safeTags    = window.escapeHtml(tagsStr);

    const metaParts = [];
    if (id)        metaParts.push(`<span class="mem-meta-label">id</span> ${window.escapeHtml(id)}`);
    if (createdAt) metaParts.push(`<span class="mem-meta-label">created</span> ${window.escapeHtml(createdAt)}`);
    if (source)    metaParts.push(`<span class="mem-meta-label">source</span> ${window.escapeHtml(source)}`);
    const metaHtml = metaParts.length
      ? `<div class="mem-meta-row">${metaParts.map(p => `<span>${p}</span>`).join('')}</div>`
      : '';

    return `<tr>
      <td class="mem-col-num mem-row-num">${rowNum}</td>
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
        <button class="mem-del-btn" data-id="${window.escapeHtml(id)}" data-title="${safeTitle}" title="Delete self-memory">
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
      try {
        const res = await fetch(`/api/self-memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Delete failed');
        window.allSelfMemories = window.allSelfMemories.filter(m => m.id !== id);
        window.filteredSelfMemories = window.filteredSelfMemories.filter(m => m.id !== id);
        updateSelfModalCount();
        renderSelfTablePage();
      } catch (err) {
        showErrorModal(err.message);
      }
    });
  });

  document.getElementById('self-prev-page').disabled = window.selfCurrentPage === 1;
  document.getElementById('self-next-page').disabled = window.selfCurrentPage === totalPages;
}

function changeSelfPage(step) {
  window.selfCurrentPage += step;
  renderSelfTablePage();
  const body = document.querySelector('#selfMemoryModal .mem-table-body');
  if (body) body.scrollTop = 0;
}
window.changeSelfPage = changeSelfPage;
