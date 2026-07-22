import { statSync } from "node:fs";
import { extname } from "node:path";
import ExcelJS from "exceljs";

import { ArtifactActionError, resolveGeneratedArtifactUrl } from "./artifactActions.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SHEETS = 20;
const MAX_ROWS = 1000;
const MAX_COLUMNS = 100;

function displayValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (typeof value.formula === "string") {
      return value.result == null ? `=${value.formula}` : String(value.result);
    }
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("");
    if (value.text != null) return String(value.text);
    if (value.error != null) return String(value.error);
    return "";
  }
  return String(value);
}

function previewCell(cell) {
  const value = cell.value;
  const out = { display: displayValue(value) };
  if (value && typeof value === "object" && typeof value.formula === "string") out.formula = value.formula;
  if (cell.font?.bold) out.bold = true;
  return out;
}

/** Parse a generated .xlsx into a bounded, display-only JSON grid. */
export async function previewSpreadsheetArtifact(url, {
  root = process.cwd(),
  resolveArtifact = resolveGeneratedArtifactUrl,
} = {}) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(String(url || ""), "http://aperio.local").pathname); }
  catch { throw new ArtifactActionError("Invalid spreadsheet artifact URL."); }
  if (extname(pathname).toLowerCase() !== ".xlsx") {
    throw new ArtifactActionError("Only .xlsx artifacts can be previewed.", 415);
  }

  const path = resolveArtifact(url, root);
  const stats = statSync(path);
  if (stats.size > MAX_FILE_BYTES) {
    throw new ArtifactActionError("Spreadsheet is too large to preview (10 MB maximum).", 413);
  }

  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.readFile(path); }
  catch { throw new ArtifactActionError("Spreadsheet could not be parsed.", 422); }

  const sheets = workbook.worksheets.slice(0, MAX_SHEETS).map(sheet => {
    const previewRowCount = Math.min(sheet.rowCount, MAX_ROWS);
    const previewColumnCount = Math.min(sheet.columnCount, MAX_COLUMNS);
    const rows = [];
    for (let rowNumber = 1; rowNumber <= previewRowCount; rowNumber++) {
      const row = [];
      for (let columnNumber = 1; columnNumber <= previewColumnCount; columnNumber++) {
        row.push(previewCell(sheet.getCell(rowNumber, columnNumber)));
      }
      rows.push(row);
    }
    return {
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      previewRowCount,
      previewColumnCount,
      truncated: sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS,
      rows,
    };
  });

  return {
    path,
    sheets,
    truncatedSheets: workbook.worksheets.length > MAX_SHEETS,
  };
}
