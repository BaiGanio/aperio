// lib/docgraph/extract-xlsx.js
// XLSX extractor via exceljs (already in deps; same lib mcp/tools/files.js uses).
// One section per worksheet; section text is the sheet's non-empty rows, each
// row's cells joined by " | " so a label and its value stay together (better
// for "what does my budget say about marketing" than dropping numbers). Rows
// are capped to avoid pathological sheets. Returns { title, sections, refs }.

import ExcelJS from 'exceljs';

const MAX_ROWS_PER_SHEET = Number(process.env.DOCGRAPH_XLSX_MAX_ROWS || 2000);
const baseName = (relPath) => relPath.split('/').pop().replace(/\.[^.]+$/, '');

// exceljs cell values come in several shapes (rich text, formula, hyperlink,
// date, plain). Flatten each to a display string; empty → ''.
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text);            // hyperlink
    if (v.result != null) return String(v.result);        // formula → cached result
    if (v.formula != null) return '';                     // formula with no cached result
    return '';
  }
  return String(v);
}

export async function extract(input, relPath) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sections = [];
  for (const sheet of wb.worksheets) {
    const rows = [];
    let count = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (count >= MAX_ROWS_PER_SHEET) return;
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const t = cellText(cell.value).trim();
        if (t) cells.push(t);
      });
      if (cells.length) { rows.push(cells.join(' | ')); count++; }
    });
    const text = rows.join('\n').trim();
    if (!text) continue;
    sections.push({
      localId: sections.length + 1,
      parentLocalId: null,
      ord: sections.length,
      level: 1,
      heading: sheet.name,
      text,
    });
  }

  const summary = sections.length ? null : 'No text content found in any sheet.';
  return { title: baseName(relPath), sections, refs: [], summary };
}
