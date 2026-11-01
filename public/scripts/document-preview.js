// Generated DOCX preview. Conversion and sanitization happen server-side; the
// browser receives inert HTML and renders it in the existing sandboxed iframe.

function _documentPreviewPage(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 40px 24px; background: #eef0f3; color: #202124; font: 16px/1.55 Arial, sans-serif; }
    main { width: min(816px, 100%); min-height: 1056px; margin: 0 auto; padding: 72px 80px; background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,.12); }
    h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1.2em 0 .5em; }
    h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
    p { margin: 0 0 .85em; }
    table { width: 100%; border-collapse: collapse; margin: 1em 0; }
    th, td { padding: 7px 9px; border: 1px solid #b8bdc5; text-align: left; vertical-align: top; }
    th { background: #f2f4f7; }
    img { max-width: 100%; height: auto; }
    blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #c7ccd4; color: #555; }
    pre { overflow: auto; padding: 12px; background: #f5f6f8; }
    @media (max-width: 700px) { body { padding: 12px; } main { min-height: 0; padding: 32px 24px; } }
  </style></head><body><main>${html}</main></body></html>`;
}

async function openGeneratedDocumentModal(url, name) {
  ensureFileModal();
  const modal = document.getElementById("file-preview-modal");
  resetSpreadsheetModal(modal);
  modal.querySelector(".fpm-icon").innerHTML = '<i class="bi bi-file-earmark-word"></i>';
  modal.querySelector(".fpm-filename").textContent = (name || "document.docx").replace(/\.[^.]+$/, "");
  modal.querySelector(".fpm-ext-badge").textContent = "DOCX";

  const frameEl = modal.querySelector(".fpm-frame");
  frameEl.removeAttribute("src");
  frameEl.srcdoc = _documentPreviewPage("<p>Loading document…</p>");
  frameEl.style.display = "block";
  modal.querySelector(".fpm-pre").style.display = "none";
  modal.querySelector(".fpm-view-tabs").hidden = true;
  modal.querySelector(".fpm-copy-btn").hidden = true;
  modal.dataset.artifactUrl = url;

  const browserBtn = modal.querySelector(".fpm-browser-btn");
  browserBtn.hidden = false;
  browserBtn.innerHTML = '<i class="bi bi-download"></i> <span>Download</span>';
  browserBtn.title = "Download the original Word document";
  modal.querySelector(".fpm-folder-btn").hidden = false;
  modal.classList.add("open");

  try {
    const response = await fetch(`/api/artifact/preview?url=${encodeURIComponent(url)}`);
    const documentPreview = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(documentPreview.error || `HTTP ${response.status}`);
    frameEl.srcdoc = _documentPreviewPage(documentPreview.html || "<p>This document is empty.</p>");
    const pathbar = modal.querySelector(".fpm-pathbar");
    pathbar.hidden = false;
    modal.querySelector(".fpm-path-value").textContent = documentPreview.path;
  } catch (error) {
    frameEl.srcdoc = _documentPreviewPage(`<p>Could not preview document: ${escapeHtml(error.message)}</p>`);
    modal.querySelector(".fpm-folder-btn").hidden = true;
  }
}
