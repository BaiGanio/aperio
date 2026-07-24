// lib/docgraph/extract-pdf.js
// PDF extractor via pdfjs-dist (already in deps). Mirrors the proven worker
// setup in lib/handlers/attachments/workers/preprocessPdf.js, but is
// indexing-shaped: one section per page (no truncation — a 100-page PDF must
// outline fully), no font-size heading heuristics in v1 (the brief endorses
// "page N" sections as the reliable fallback).
//
// Scanned pages (no extractable text) are skipped and reported in `summary`;
// the agent OCRs those on demand via the pdf / preprocess-image skills. Returns
// the shared shape plus an optional `summary`.

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'module';

// pdfjs-dist v5 needs workerSrc pointed at the real worker file (see
// preprocessPdf.js for why ""/false throws). createRequire resolves it from
// node_modules regardless of where this file sits.
const _require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = _require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

const MIN_CHARS_PER_PAGE = 30; // below this a page is treated as scanned/empty.
const baseName = (relPath) => relPath.split('/').pop().replace(/\.[^.]+$/, '');

export async function extract(input, relPath) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const data = new Uint8Array(buffer);

  let pdf;
  try {
    pdf = await getDocument({ data, verbosity: 0 }).promise;
  } catch (err) {
    throw new Error(`PDF could not be parsed: ${err.message}`);
  }

  const pageCount = pdf.numPages;
  const meta = await pdf.getMetadata().catch(() => ({}));
  const title = (meta?.info?.Title || '').trim() || baseName(relPath);

  const sections = [];
  const scannedPages = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const raw = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (raw.length < MIN_CHARS_PER_PAGE) {
      scannedPages.push(i);
      continue;
    }
    sections.push({
      localId: sections.length + 1,
      parentLocalId: null,
      ord: sections.length,
      level: 1,
      heading: `Page ${i}`,
      text: raw,
    });
  }

  const summary = scannedPages.length
    ? `${scannedPages.length}/${pageCount} page(s) have no extractable text (scanned/image-only: ${scannedPages.slice(0, 20).join(', ')}${scannedPages.length > 20 ? '…' : ''}). Open with the pdf / preprocess-image skill to OCR.`
    : null;

  return { title, sections, refs: [], summary };
}
