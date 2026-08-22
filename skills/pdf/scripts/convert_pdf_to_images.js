#!/usr/bin/env node
// Usage: node convert_pdf_to_images.js <input.pdf> <output_dir>
// Converts each PDF page to a PNG image using pdftoppm (poppler).
// Requires: brew install poppler
import { existsSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, join } from 'path';

const execFileAsync = promisify(execFile);

const [,, pdfPath, outputDir] = process.argv;
if (!pdfPath || !outputDir) {
  console.error('Usage: convert_pdf_to_images.js <input.pdf> <output_dir>');
  process.exit(1);
}

// Check for pdftoppm
async function findTool() {
  for (const tool of ['pdftoppm', '/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm']) {
    try {
      await execFileAsync(tool, ['-v']);
      return tool;
    } catch { /* not found or version flag printed to stderr — both are ok if exit code ok */ }
    // pdftoppm -v exits non-zero but that's fine, check existence differently
    try {
      await execFileAsync('which', [tool]);
      return tool;
    } catch { /* continue */ }
  }
  return null;
}

let tool = await findTool();
if (!tool) {
  // Last-ditch: try running directly and catch
  try { await execFileAsync('pdftoppm', ['-h']); tool = 'pdftoppm'; } catch {
    console.error('pdftoppm not found. Install poppler with: brew install poppler');
    process.exit(1);
  }
}

const absOutput = resolve(outputDir);
if (!existsSync(absOutput)) mkdirSync(absOutput, { recursive: true });

const prefix = join(absOutput, 'page');

// -png: output PNG, -r 200: 200 DPI, -scale-to 1000: cap longest dimension at 1000px
await execFileAsync('pdftoppm', ['-png', '-r', '200', '-scale-to', '1000', resolve(pdfPath), prefix]);

// pdftoppm names files as <prefix>-1.png, <prefix>-01.png, etc.
const { readdirSync } = await import('fs');
const pages = readdirSync(absOutput)
  .filter(f => f.startsWith('page') && f.endsWith('.png'))
  .sort();

for (const f of pages) {
  console.log(`Saved ${join(absOutput, f)}`);
}
console.log(`Converted ${pages.length} pages to PNG images`);
