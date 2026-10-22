// Non-plaintext writers: PNG "scans", PDF, DOCX, XLSX, EML and HTML.
//
// Format coverage is not decoration. docgraph indexes txt/md/html/pdf/docx/xlsx/
// pptx/eml but NOT png, so the PNG scans are reachable only through the vision
// path — the oracle records that asymmetry per document, because "the model never
// saw it" and "the model could not have seen it through retrieval" are different
// failures.

import { createRequire } from "node:module";
import { money } from "./money.mjs";

const require = createRequire(import.meta.url);

// The generator runs from the repo root so it can borrow Aperio's own
// dependencies rather than installing its own.
const sharp = require("sharp");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const ExcelJS = require("exceljs");

// ---------------------------------------------------------------------------
// PNG "scan": the document text rendered onto off-white paper. Crisper than a
// real scan, which is deliberate — it isolates "can the model read an image at
// all" from "can the model cope with scan noise".
// ---------------------------------------------------------------------------

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escapeXml(text) {
  return text.replace(/[&<>"']/g, char => XML_ESCAPES[char]);
}

export async function writePng(text, { fontSize = 15, padding = 28 } = {}) {
  const lines = text.replace(/\t/g, "    ").split("\n");
  const charWidth = fontSize * 0.6;
  const lineHeight = Math.round(fontSize * 1.35);
  const longest = lines.reduce((max, current) => Math.max(max, current.length), 0);
  const width = Math.ceil(longest * charWidth) + padding * 2;
  const height = lines.length * lineHeight + padding * 2;
  const body = lines
    .map((content, index) => {
      if (!content.trim()) return "";
      const y = padding + lineHeight * (index + 1);
      return `<text x="${padding}" y="${y}" xml:space="preserve">${escapeXml(content)}</text>`;
    })
    .filter(Boolean)
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#f8f6f1"/>
  <g font-family="Menlo, DejaVu Sans Mono, PingFang SC, Hiragino Sans, monospace"
     font-size="${fontSize}" fill="#1d1c1a">
${body}
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

// ---------------------------------------------------------------------------
// PDF. pdf-lib's standard fonts are WinAnsi-encoded: Latin scripts only. Callers
// must not send Cyrillic or CJK text here — build.mjs routes those to txt/png —
// and the sanitizer below folds the typographic characters that Latin documents
// legitimately contain (arrows, dashes, curly quotes) down to WinAnsi.
// ---------------------------------------------------------------------------

const WINANSI_FOLD = new Map(Object.entries({
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>",
  "–": "-", "—": "-", "―": "-", "‒": "-",
  "’": "'", "‘": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "•": "*", "·": "-", "…": "...", " ": " ",
  "≈": "~", "≤": "<=", "≥": ">=", "×": "x",
  "═": "=", "─": "-", "━": "-",
}));

// Windows-1252 additions above Latin-1 that pdf-lib can encode.
const WIN1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""));

export function toWinAnsi(text) {
  let folded = "";
  for (const char of text) {
    const replacement = WINANSI_FOLD.get(char);
    if (replacement !== undefined) { folded += replacement; continue; }
    const code = char.codePointAt(0);
    if (code === 10 || code === 13 || (code >= 32 && code <= 255) || WIN1252_EXTRA.has(char)) {
      folded += char;
    } else {
      folded += "?";
    }
  }
  return folded;
}

export async function writePdf(text, { title, fontSize = 9, margin = 40 } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);
  if (title) pdf.setTitle(title);
  pdf.setProducer("household corpus generator (fictional sample data)");
  const lineHeight = fontSize * 1.22;
  const lines = toWinAnsi(text).replace(/\t/g, "    ").split("\n");
  const pageWidth = 595.28; // A4 portrait
  const pageHeight = 841.89;
  const perPage = Math.floor((pageHeight - margin * 2) / lineHeight);
  for (let offset = 0; offset < lines.length; offset += perPage) {
    const page = pdf.addPage([pageWidth, pageHeight]);
    const slice = lines.slice(offset, offset + perPage);
    slice.forEach((content, index) => {
      if (!content.trim()) return;
      page.drawText(content, {
        x: margin,
        y: pageHeight - margin - lineHeight * (index + 1),
        size: fontSize,
        font,
      });
    });
  }
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------
// DOCX — a completed payment form, monospaced so its column layout survives.
// ---------------------------------------------------------------------------

export async function writeDocx(text, { title } = {}) {
  const document = new Document({
    title,
    description: "Fictional sample document for demonstration purposes.",
    sections: [{
      properties: {},
      children: text.split("\n").map(content => new Paragraph({
        children: [new TextRun({ text: content, font: "Courier New", size: 18 })],
      })),
    }],
  });
  return Packer.toBuffer(document);
}

// ---------------------------------------------------------------------------
// XLSX — a PLANNED budget, never actuals. A sheet of real totals would hand the
// model the answer key, which is exactly the shortcut this corpus exists to
// prevent, so the planned figures deliberately differ from what was spent.
// ---------------------------------------------------------------------------

export async function writeXlsx({ period, titleBg, rows, noteBg }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Ivan Petrov (fictional)";
  workbook.created = new Date("2026-07-26T00:00:00Z");
  const sheet = workbook.addWorksheet(`Бюджет ${period}`);
  sheet.columns = [
    { header: "Категория", key: "category", width: 24 },
    { header: "Планирано (лв)", key: "planned", width: 16 },
    { header: "Забележка", key: "note", width: 44 },
  ];
  sheet.addRow([]);
  sheet.spliceRows(1, 0, [titleBg]);
  sheet.getRow(1).font = { bold: true, size: 13 };
  for (const row of rows) {
    sheet.addRow({ category: row.category, planned: row.planned / 100, note: row.note ?? "" });
  }
  const total = rows.reduce((sum, row) => sum + row.planned, 0);
  sheet.addRow({});
  sheet.addRow({ category: "ОБЩО ПЛАНИРАНО", planned: total / 100, note: noteBg });
  sheet.lastRow.font = { bold: true };
  sheet.getColumn("planned").numFmt = "#,##0.00";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// EML — provider billing notification. Cyrillic subjects go out as RFC 2047
// base64 encoded-words and the body as base64 UTF-8, which is both realistic and
// a genuine exercise of extract-eml.js's decoders.
// ---------------------------------------------------------------------------

function encodeWord(text) {
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function wrapBase64(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
}

export function writeEml({ from, fromName, to, toName, subject, date, body, messageId }) {
  const headers = [
    `From: ${encodeWord(fromName)} <${from}>`,
    `To: ${encodeWord(toName)} <${to}>`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${wrapBase64(body)}\r\n`, "utf8");
}

// ---------------------------------------------------------------------------
// HTML — the provider's web copy of an invoice. A duplicate representation of a
// bill that already exists as .txt, so it belongs to the same economic event.
// ---------------------------------------------------------------------------

export function writeHtml({ titleBg, providerBg, invoiceNo, issue, servicePeriodBg, dueDate, rows, total, footerBg }) {
  const cells = rows
    .map(row => `      <tr><td>${row.label}</td><td class="amount">${money(row.amount)} лв</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="bg">
<head>
  <meta charset="utf-8">
  <title>${titleBg}</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; color: #222; margin: 2rem; }
    table { border-collapse: collapse; margin-top: 1rem; }
    td, th { border: 1px solid #bbb; padding: 6px 12px; }
    .amount { text-align: right; font-variant-numeric: tabular-nums; }
    .total td { font-weight: bold; background: #f2f2f2; }
    .fiction { color: #666; font-size: 0.85rem; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <h1>${providerBg}</h1>
  <h2>${titleBg}</h2>
  <p>
    Фактура №: <strong>${invoiceNo}</strong><br>
    Дата на издаване: ${issue}<br>
    Период на отчитане: ${servicePeriodBg}<br>
    Краен срок за плащане: ${dueDate}
  </p>
  <table>
    <thead><tr><th>Описание</th><th>Сума</th></tr></thead>
    <tbody>
${cells}
      <tr class="total"><td>ЗА ПЛАЩАНЕ (с ДДС)</td><td class="amount">${money(total)} лв</td></tr>
    </tbody>
  </table>
  <p class="fiction">${footerBg}</p>
</body>
</html>
`;
}
