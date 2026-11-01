// lib/docgraph/extract-docx.js
// DOCX extractor. Reuses mammoth (already in deps; same lib lib/handlers/
// attachments/docxHandler.js uses) to convert to HTML, then runs the HTML
// extractor — Word heading styles come through as <h1>…<h6>, giving clean
// section breaks. Returns the shared extractor shape { title, sections, refs }.

import mammoth from 'mammoth';
import { parseHtml } from './extract-html.js';

export async function extract(input, relPath) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const parsed = parseHtml(html || '', relPath);
  // mammoth HTML has no <title>; parseHtml already falls back to first heading
  // or filename, so nothing extra to do here.
  return parsed;
}
