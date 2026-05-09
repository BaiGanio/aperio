#!/usr/bin/env node
// Usage: node fill_pdf_form_with_annotations.js <input.pdf> <fields.json> <output.pdf>
// Fills a non-fillable PDF by drawing text at specified coordinates.
// fields.json format: { pages: [{page_number, pdf_width?, image_width?, image_height?}],
//                       form_fields: [{page_number, entry_bounding_box, label_bounding_box,
//                                      entry_text?: {text, font?, font_size?, font_color?}}] }
import { readFileSync, writeFileSync } from 'fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const FONT_MAP = {
  'Arial': StandardFonts.Helvetica,
  'Helvetica': StandardFonts.Helvetica,
  'Times New Roman': StandardFonts.TimesRoman,
  'Times': StandardFonts.TimesRoman,
  'Courier': StandardFonts.Courier,
  'Courier New': StandardFonts.Courier,
};

const [,, inputPdf, fieldsJson, outputPdf] = process.argv;
if (!inputPdf || !fieldsJson || !outputPdf) {
  console.error('Usage: fill_pdf_form_with_annotations.js <input.pdf> <fields.json> <output.pdf>');
  process.exit(1);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return rgb(
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  );
}

// Transform from image pixel coords to PDF coords (bottom-left origin)
function fromImageCoords(bbox, imgW, imgH, pdfW, pdfH) {
  const xScale = pdfW / imgW;
  const yScale = pdfH / imgH;
  return {
    x: bbox[0] * xScale,
    y: pdfH - bbox[3] * yScale,          // bottom edge in PDF coords
    width: (bbox[2] - bbox[0]) * xScale,
    height: (bbox[3] - bbox[1]) * yScale,
  };
}

// Transform from pdfplumber top-left coords to PDF coords (bottom-left origin)
function fromPdfCoords(bbox, pdfH) {
  return {
    x: bbox[0],
    y: pdfH - bbox[3],                   // bottom edge in PDF coords
    width: bbox[2] - bbox[0],
    height: bbox[3] - bbox[1],
  };
}

const fieldsData = JSON.parse(readFileSync(fieldsJson, 'utf8'));
const pdfDoc = await PDFDocument.load(readFileSync(inputPdf));
const pages = pdfDoc.getPages();

// Cache embedded fonts
const fontCache = {};
async function getFont(name) {
  const stdName = FONT_MAP[name] ?? StandardFonts.Helvetica;
  if (!fontCache[stdName]) fontCache[stdName] = await pdfDoc.embedFont(stdName);
  return fontCache[stdName];
}

let drawn = 0;
for (const field of fieldsData.form_fields) {
  const entryText = field.entry_text;
  if (!entryText?.text) continue;

  const pageIndex = field.page_number - 1;
  const page = pages[pageIndex];
  if (!page) continue;

  const { width: pdfW, height: pdfH } = page.getSize();
  const pageInfo = fieldsData.pages.find(p => p.page_number === field.page_number);

  let pos;
  if (pageInfo?.pdf_width) {
    pos = fromPdfCoords(field.entry_bounding_box, pdfH);
  } else {
    pos = fromImageCoords(
      field.entry_bounding_box,
      pageInfo.image_width, pageInfo.image_height,
      pdfW, pdfH,
    );
  }

  const fontSize = entryText.font_size ?? 14;
  const font = await getFont(entryText.font ?? 'Arial');
  const color = hexToRgb(entryText.font_color ?? '000000');

  page.drawText(entryText.text, {
    x: pos.x,
    y: pos.y,
    size: fontSize,
    font,
    color,
    maxWidth: pos.width,
  });
  drawn++;
}

writeFileSync(outputPdf, await pdfDoc.save());
console.log(`Successfully filled PDF form and saved to ${outputPdf}`);
console.log(`Drew ${drawn} text entries`);
