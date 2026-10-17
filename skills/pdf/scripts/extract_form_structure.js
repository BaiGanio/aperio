#!/usr/bin/env node
// Usage: node extract_form_structure.js <input.pdf> <output.json>
// Extracts text labels, horizontal lines, and checkbox rectangles from a non-fillable PDF.
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const _require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = _require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

const [,, pdfPath, outputPath] = process.argv;
if (!pdfPath || !outputPath) {
  console.error('Usage: extract_form_structure.js <input.pdf> <output.json>');
  process.exit(1);
}

// Apply 2D affine transform [a,b,c,d,e,f] to point (x, y)
function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Multiply two 2D affine matrices
function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const PAINT_OPS = new Set([
  OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill,
  OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
]);

const data = new Uint8Array(readFileSync(pdfPath));
const pdf = await getDocument({ data, verbosity: 0 }).promise;

const structure = { pages: [], labels: [], lines: [], checkboxes: [], row_boundaries: [] };

for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
  const page = await pdf.getPage(pageNum);
  const { width: pageWidth, height: pageHeight } = page.getViewport({ scale: 1 });

  structure.pages.push({ page_number: pageNum, width: pageWidth, height: pageHeight });

  // ── Text labels ──────────────────────────────────────────────────────────
  const textContent = await page.getTextContent();
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const [, , , , tx, ty] = item.transform;
    const h = item.height || Math.abs(item.transform[0]);

    // Split item text into words and distribute x proportionally
    const words = item.str.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const totalChars = words.reduce((s, w) => s + w.length, 0);
    let xCursor = tx;
    for (const word of words) {
      const wordWidth = item.width * (word.length / totalChars);
      structure.labels.push({
        page: pageNum,
        text: word,
        x0: Math.round(xCursor * 10) / 10,
        top: Math.round((pageHeight - ty - h) * 10) / 10,
        x1: Math.round((xCursor + wordWidth) * 10) / 10,
        bottom: Math.round((pageHeight - ty) * 10) / 10,
      });
      xCursor += wordWidth;
    }
  }

  // ── Graphics: lines and checkbox rects ───────────────────────────────────
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;

  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  let pathPoints = [];       // accumulated moveto/lineto points
  const pendingRects = [];   // rectangles added via 're' operator, awaiting paint

  const recordRect = (x0, y0, w, h) => {
    // Convert bottom-left PDF coords to top-left coords (pdfplumber style)
    const x1 = x0 + w;
    const y1 = y0 + h;
    const top = Math.round((pageHeight - y1) * 10) / 10;
    const bottom = Math.round((pageHeight - y0) * 10) / 10;
    const rx0 = Math.round(x0 * 10) / 10;
    const rx1 = Math.round(x1 * 10) / 10;

    const rw = Math.abs(rx1 - rx0);
    const rh = Math.abs(bottom - top);

    // Thin horizontal line (height < 2pt, spans > 50% of page width)
    if (rh < 2 && rw > pageWidth * 0.5) {
      structure.lines.push({ page: pageNum, y: top, x0: rx0, x1: rx1 });
    }

    // Small near-square checkbox rectangle (5–15pt each side, within 2pt of square)
    if (rw >= 5 && rw <= 15 && rh >= 5 && rh <= 15 && Math.abs(rw - rh) < 2) {
      structure.checkboxes.push({
        page: pageNum,
        x0: rx0, top, x1: rx1, bottom,
        center_x: Math.round(((rx0 + rx1) / 2) * 10) / 10,
        center_y: Math.round(((top + bottom) / 2) * 10) / 10,
      });
    }
  };

  const flushPath = () => {
    // Check if the accumulated path points form a horizontal line segment
    if (pathPoints.length === 2) {
      const [p0, p1] = pathPoints;
      if (Math.abs(p0[1] - p1[1]) < 1) {
        const x0 = Math.min(p0[0], p1[0]);
        const x1 = Math.max(p0[0], p1[0]);
        const y = (p0[1] + p1[1]) / 2;
        const w = x1 - x0;
        if (w > pageWidth * 0.5) {
          const top = Math.round((pageHeight - y) * 10) / 10;
          structure.lines.push({ page: pageNum, y: top, x0: Math.round(x0 * 10) / 10, x1: Math.round(x1 * 10) / 10 });
        }
      }
    }
    pathPoints = [];
  };

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    if (op === OPS.save) {
      ctmStack.push([...ctm]);
    } else if (op === OPS.restore) {
      ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (op === OPS.transform) {
      ctm = multiplyMatrix(ctm, args);
    } else if (op === OPS.moveTo) {
      pathPoints = [applyMatrix(ctm, args[0], args[1])];
    } else if (op === OPS.lineTo) {
      pathPoints.push(applyMatrix(ctm, args[0], args[1]));
    } else if (op === OPS.rectangle) {
      const [px, py, pw, ph] = args.map(Number);
      const [rx, ry] = applyMatrix(ctm, px, py);
      // Scale dimensions by the CTM scale factor (ignoring rotation for simplicity)
      const scaleX = Math.sqrt(ctm[0] ** 2 + ctm[1] ** 2);
      const scaleY = Math.sqrt(ctm[2] ** 2 + ctm[3] ** 2);
      pendingRects.push([rx, ry, pw * scaleX, ph * scaleY]);
    } else if (op === OPS.endPath) {
      pathPoints = [];
      pendingRects.length = 0;
    } else if (PAINT_OPS.has(op)) {
      flushPath();
      for (const r of pendingRects) recordRect(...r);
      pendingRects.length = 0;
    }
  }

  page.cleanup();
}

// Derive row_boundaries from sorted unique line y-values per page
const linesByPage = {};
for (const line of structure.lines) {
  (linesByPage[line.page] ??= []).push(line.y);
}
for (const [page, ys] of Object.entries(linesByPage)) {
  const sorted = [...new Set(ys)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length - 1; i++) {
    structure.row_boundaries.push({
      page: Number(page),
      row_top: sorted[i],
      row_bottom: sorted[i + 1],
      row_height: Math.round((sorted[i + 1] - sorted[i]) * 10) / 10,
    });
  }
}

writeFileSync(outputPath, JSON.stringify(structure, null, 2));

console.log(`Found:`);
console.log(`  - ${structure.pages.length} pages`);
console.log(`  - ${structure.labels.length} text labels`);
console.log(`  - ${structure.lines.length} horizontal lines`);
console.log(`  - ${structure.checkboxes.length} checkboxes`);
console.log(`  - ${structure.row_boundaries.length} row boundaries`);
console.log(`Saved to ${outputPath}`);
