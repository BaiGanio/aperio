#!/usr/bin/env node
/**
 * Create a thumbnail grid from a PPTX file using soffice + pdftoppm + sharp.
 * Usage: node scripts/thumbnail.js input.pptx [output_prefix] [--cols N]
 *
 * Creates: thumbnails.jpg (or <output_prefix>.jpg)
 */

import { spawnSync } from 'child_process';
import { mkdirSync, readdirSync, unlinkSync, existsSync, rmSync } from 'fs';
import { resolve, join, basename } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';

const THUMBNAIL_WIDTH = 300;
const GRID_PADDING = 20;
const MAX_COLS = 6;

const args = process.argv.slice(2);
let inputFile = null;
let outputPrefix = 'thumbnails';
let cols = 3;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cols') { cols = parseInt(args[++i], 10); continue; }
  if (!inputFile) inputFile = args[i];
  else outputPrefix = args[i];
}

if (!inputFile) {
  console.error('Usage: node scripts/thumbnail.js <input.pptx> [output_prefix] [--cols N]');
  process.exit(1);
}

cols = Math.min(cols, MAX_COLS);
const absInput = resolve(inputFile);
const tempDir = join(tmpdir(), `pptx-thumb-${Date.now()}`);
mkdirSync(tempDir, { recursive: true });

async function run() {
  // Convert PPTX → PDF
  const pdfBase = basename(absInput, '.pptx');
  const r1 = spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, absInput], {
    env: { ...process.env, SAL_USE_VCLPLUGIN: 'svp' },
    stdio: 'pipe',
  });
  const pdfPath = join(tempDir, `${pdfBase}.pdf`);
  if (r1.status !== 0 || !existsSync(pdfPath)) {
    console.error('PDF conversion failed'); process.exit(1);
  }

  // Convert PDF pages → JPEG images
  const slidePrefix = join(tempDir, 'slide');
  const r2 = spawnSync('pdftoppm', ['-jpeg', '-r', '100', pdfPath, slidePrefix], { stdio: 'pipe' });
  if (r2.status !== 0) { console.error('Image conversion failed'); process.exit(1); }

  const slideImages = readdirSync(tempDir)
    .filter(f => /^slide-\d+\.jpg$/.test(f))
    .sort()
    .map(f => join(tempDir, f));

  if (!slideImages.length) { console.error('No slides found'); process.exit(1); }

  // Calculate grid dimensions from first image aspect ratio
  const meta = await sharp(slideImages[0]).metadata();
  const aspect = meta.height / meta.width;
  const thumbH = Math.round(THUMBNAIL_WIDTH * aspect);
  const rows = Math.ceil(slideImages.length / cols);
  const gridW = cols * THUMBNAIL_WIDTH + (cols + 1) * GRID_PADDING;
  const gridH = rows * thumbH + (rows + 1) * GRID_PADDING;

  // Build composite operations
  const composites = await Promise.all(
    slideImages.map(async (imgPath, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const input = await sharp(imgPath).resize(THUMBNAIL_WIDTH, thumbH, { fit: 'inside' }).toBuffer();
      return { input, left: col * THUMBNAIL_WIDTH + (col + 1) * GRID_PADDING, top: row * thumbH + (row + 1) * GRID_PADDING };
    })
  );

  const outputFile = `${outputPrefix}.jpg`;
  await sharp({ create: { width: gridW, height: gridH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(composites)
    .jpeg({ quality: 95 })
    .toFile(outputFile);

  rmSync(tempDir, { recursive: true, force: true });
  console.log(`Created ${outputFile}`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
