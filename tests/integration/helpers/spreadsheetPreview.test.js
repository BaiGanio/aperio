import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";

import { previewSpreadsheetArtifact } from "../../../lib/helpers/spreadsheetPreview.js";

async function workbookFixture() {
  const root = mkdtempSync(join(tmpdir(), "aperio-sheet-preview-"));
  const uploads = join(root, "var", "scratch", "session-123");
  mkdirSync(uploads, { recursive: true });
  const path = join(uploads, "93722e91-expenses.xlsx");
  const workbook = new ExcelJS.Workbook();
  const expenses = workbook.addWorksheet("Expenses");
  expenses.addRow(["Date", "Description", "Amount"]);
  expenses.getRow(1).font = { bold: true };
  expenses.addRow(["2026-07-22", "Groceries", 42.5]);
  expenses.addRow(["Total", null, { formula: "SUM(C2:C2)" }]);
  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["Source", "Sample"]);
  await workbook.xlsx.writeFile(path);
  return { root, path: realpathSync(path) };
}

describe("previewSpreadsheetArtifact", () => {
  test("returns sheet tabs, bounded cells, styles, and formulas", async () => {
    const { root, path } = await workbookFixture();
    const preview = await previewSpreadsheetArtifact("/scratch/session-123/93722e91-expenses.xlsx", { root });

    assert.equal(preview.path, path);
    assert.equal(preview.sheets.length, 2);
    assert.deepEqual(preview.sheets.map(sheet => sheet.name), ["Expenses", "Notes"]);
    assert.equal(preview.sheets[0].rowCount, 3);
    assert.equal(preview.sheets[0].columnCount, 3);
    assert.deepEqual(preview.sheets[0].rows[0][0], { display: "Date", bold: true });
    assert.equal(preview.sheets[0].rows[1][2].display, "42.5");
    assert.equal(preview.sheets[0].rows[2][2].formula, "SUM(C2:C2)");
    assert.equal(preview.sheets[0].rows[2][2].display, "=SUM(C2:C2)");
  });

  test("rejects non-XLSX artifacts before parsing", async () => {
    await assert.rejects(
      previewSpreadsheetArtifact("/uploads/report.pdf", { root: process.cwd() }),
      error => error.status === 415 && /xlsx/i.test(error.message),
    );
  });
});
