// mcp/lib/preprocessPdf.js
// Extract text from a PDF buffer for inline injection into the agent context.
//
// Strategy:
//   1. Try text extraction via pdfjs-dist (no CLI tools needed)
//   2. Per-page: if extracted text is too sparse, flag as scanned
//   3. Return a structured result the attachment router acts on
//
// Requires: npm install pdfjs-dist

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire }                    from "module";

// pdfjs-dist v5 requires workerSrc to point at the actual worker file.
// Setting it to "" or false throws "Invalid workerSrc type".
// createRequire resolves the path relative to node_modules regardless of
// where this file lives in the project tree.
const _require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = _require.resolve(
  "pdfjs-dist/legacy/build/pdf.worker.mjs"
);

// A page is "scanned" (no real text) if its extracted text
// after whitespace normalisation is shorter than this.
const MIN_CHARS_PER_PAGE = 30;

// Hard cap: don't inline more than this into the context window.
const MAX_INLINE_CHARS = 80_000; // ~20K tokens

/**
 * Extract text from a PDF buffer.
 *
 * @param {Buffer} buffer
 * @returns {Promise<PdfResult>}
 *
 * @typedef {object} PdfResult
 * @property {"text"|"scanned"|"mixed"|"empty"} type
 * @property {string}   text         - Extracted and joined page text
 * @property {boolean}  truncated    - True if text exceeded MAX_INLINE_CHARS
 * @property {number}   pageCount
 * @property {number[]} scannedPages - 1-based page numbers with no extractable text
 * @property {string}   title        - PDF title metadata (may be empty string)
 */
export async function extractPdfText(buffer) {
  const data = new Uint8Array(buffer);

  let pdf;
  try {
    pdf = await getDocument({ data, verbosity: 0 }).promise;
  } catch (err) {
    throw new Error(`PDF could not be parsed: ${err.message}`);
  }

  const pageCount    = pdf.numPages;
  const meta         = await pdf.getMetadata().catch(() => ({}));
  const title        = meta?.info?.Title ?? "";
  const pageTexts    = [];
  const scannedPages = [];

  for (let i = 1; i <= pageCount; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();

    const raw = content.items
      .map(item => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (raw.length < MIN_CHARS_PER_PAGE) {
      scannedPages.push(i);
      pageTexts.push("");
    } else {
      pageTexts.push(raw);
    }
  }

  const fullText  = pageTexts.join("\n\n").trim();
  const truncated = fullText.length > MAX_INLINE_CHARS;
  const text      = truncated ? fullText.slice(0, MAX_INLINE_CHARS) : fullText;
  const textCount = pageTexts.filter(Boolean).length;

  let type;
  if (textCount === 0 && scannedPages.length > 0) type = "scanned";
  else if (textCount === 0)                        type = "empty";
  else if (scannedPages.length === 0)              type = "text";
  else                                             type = "mixed";

  return { type, text, truncated, pageCount, scannedPages, title };
}