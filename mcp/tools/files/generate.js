// mcp/tools/files/generate.js — generate_xlsx, generate_docx.

import fs from "fs/promises";
import { join, basename, resolve as resolvePath } from "path";
import { v4 as uuidv4 } from "uuid";
import ExcelJS from "exceljs";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  TableRow, TableCell, Table, WidthType,
} from "docx";
import { getActiveScratchDir } from "../../../lib/routes/paths.js";

// Runtime var/ data anchors to process.cwd() — the same root as the path-guard
// floor (lib/routes/paths.js BASE_DIR) and the SQLite default. Module-relative
// anchoring let generated documents escape sandboxed runs into the install
// tree (#282). Identical in normal launches, where cwd == repo root.
const UPLOADS_DIR = resolvePath(process.cwd(), "var/uploads");

export async function generateXlsxHandler({ filename, sheets }) {
  try {
    // Write into the session scratch workspace when one is active (so the file
    // is pruned with the session); fall back to var/uploads outside a session
    // context (e.g. CLI). The matching static mount serves each location.
    const scratchDir = getActiveScratchDir();
    const outDir     = scratchDir ?? UPLOADS_DIR;
    const urlBase    = scratchDir ? `/scratch/${basename(scratchDir)}` : "/uploads";
    await fs.mkdir(outDir, { recursive: true });

    const safeName  = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const outName   = `${uuidv4().slice(0, 8)}-${safeName.endsWith(".xlsx") ? safeName : safeName + ".xlsx"}`;
    const outPath   = join(outDir, outName);
    const publicUrl = `${urlBase}/${outName}`;

    const wb = new ExcelJS.Workbook();

    for (const sheet of sheets) {
      const ws = wb.addWorksheet(sheet.name || "Sheet1");

      // Write headers with bold formatting
      if (sheet.headers?.length) {
        const headerRow = ws.addRow(sheet.headers);
        headerRow.eachCell(cell => {
          cell.font = { bold: true };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } };
        });
      }

      // Write data rows; strings starting with "=" become formulas
      for (const row of (sheet.rows ?? [])) {
        const rowValues = row.map(v => {
          if (typeof v === "string" && v.startsWith("=")) return { formula: v.slice(1) };
          return v ?? null;
        });
        ws.addRow(rowValues);
      }

      // Auto-width columns (cap at 40)
      ws.columns.forEach(col => {
        let max = 10;
        col.eachCell?.({ includeEmpty: false }, cell => {
          const len = String(cell.value?.formula ?? cell.value ?? "").length;
          if (len > max) max = len;
        });
        col.width = Math.min(max + 2, 40);
      });
    }

    await wb.xlsx.writeFile(outPath);
    const stat   = await fs.stat(outPath);
    const sizeKb = (stat.size / 1024).toFixed(1);

    return {
      content: [{
        type: "text",
        text: `APERIO_FILE:${JSON.stringify({ filename: safeName.endsWith(".xlsx") ? safeName : safeName + ".xlsx", url: publicUrl, sizeKb, path: outPath })}`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ generate_xlsx failed: ${err.message}` }] };
  }
}

export async function generateDocxHandler({ filename, sections }) {
  try {
    const scratchDir = getActiveScratchDir();
    const outDir     = scratchDir ?? UPLOADS_DIR;
    const urlBase    = scratchDir ? `/scratch/${basename(scratchDir)}` : "/uploads";
    await fs.mkdir(outDir, { recursive: true });

    const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const outName  = `${uuidv4().slice(0, 8)}-${safeName.endsWith(".docx") ? safeName : safeName + ".docx"}`;
    const outPath  = join(outDir, outName);
    const publicUrl = `${urlBase}/${outName}`;

    const children = [];

    for (const section of sections) {
      if (section.heading) {
        children.push(new Paragraph({
          text:    section.heading,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
        }));
      }
      for (const para of (section.paragraphs ?? [])) {
        if (typeof para === "string") {
          children.push(new Paragraph({ children: [new TextRun(para)], spacing: { after: 120 } }));
        } else if (para.type === "table" && Array.isArray(para.rows)) {
          const tableRows = para.rows.map(row =>
            new TableRow({
              children: row.map(cell =>
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun(String(cell ?? ""))] })],
                  width: { size: Math.floor(9360 / row.length), type: WidthType.DXA },
                })
              ),
            })
          );
          children.push(new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        }
      }
    }

    const doc  = new Document({ sections: [{ children }] });
    const buf  = await Packer.toBuffer(doc);
    await fs.writeFile(outPath, buf);
    const stat   = await fs.stat(outPath);
    const sizeKb = (stat.size / 1024).toFixed(1);

    return {
      content: [{
        type: "text",
        text: `APERIO_FILE:${JSON.stringify({ filename: safeName.endsWith(".docx") ? safeName : safeName + ".docx", url: publicUrl, sizeKb, path: outPath })}`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ generate_docx failed: ${err.message}` }] };
  }
}
