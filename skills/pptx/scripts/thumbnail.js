#!/usr/bin/env node
/**
 * Create a thumbnail grid from a PPTX file using soffice + pdftoppm + sharp.
 * Usage: node scripts/thumbnail.js input.pptx [output_prefix] [--cols N]
 */

import { spawnSync } from 'child_process';
import { mkdirSync, readdirSync, existsSync, rmSync } from 'fs';
import { resolve, join, basename } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { runScript, requireArg, assertExists, emitResult, emitSkip, isMissingBinary, installHint } from './_lib.js';

const THUMBNAIL_WIDTH = 300;
const GRID_PADDING = 20;
const MAX_COLS = 6;

runScript('thumbnail', async () => {
  const args = process.argv.slice(2);
  let inputFile = null;
  let outputPrefix = 'thumbnails';
  let cols = 3;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cols') { cols = parseInt(args[++i], 10); continue; }
    if (!inputFile) inputFile = args[i];
    else outputPrefix = args[i];
  }

  requireArg(inputFile, 'Usage: node scripts/thumbnail.js <input.pptx> [output_prefix] [--cols N]');
  const absInput = assertExists(inputFile, 'pptx');

  cols = Math.min(cols, MAX_COLS);
  const tempDir = join(tmpdir(), `pptx-thumb-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    const pdfBase = basename(absInput, '.pptx');
    const r1 = spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, absInput], {
      env: { ...process.env, SAL_USE_VCLPLUGIN: 'svp' },
      stdio: 'pipe',
    });
    if (isMissingBinary(r1)) {
      return emitSkip('thumbnail', installHint('soffice'), { source: absInput, missing: 'soffice' });
    }
    const pdfPath = join(tempDir, `${pdfBase}.pdf`);
    if (r1.status !== 0 || !existsSync(pdfPath)) {
      const stderr = r1.stderr?.toString() || '';
      const err = new Error(`soffice PDF conversion failed (exit ${r1.status}). stderr: ${stderr.slice(0, 500)}`);
      err.code = 'SOFFICE_FAILED';
      throw err;
    }

    const slidePrefix = join(tempDir, 'slide');
    const r2 = spawnSync('pdftoppm', ['-jpeg', '-r', '100', pdfPath, slidePrefix], { stdio: 'pipe' });
    if (isMissingBinary(r2)) {
      return emitSkip('thumbnail', installHint('pdftoppm'), { source: absInput, missing: 'pdftoppm' });
    }
    if (r2.status !== 0) {
      const stderr = r2.stderr?.toString() || '';
      const err = new Error(`pdftoppm failed (exit ${r2.status}). stderr: ${stderr.slice(0, 500)}`);
      err.code = 'PDFTOPPM_FAILED';
      throw err;
    }

    const slideImages = readdirSync(tempDir)
      .filter(f => /^slide-\d+\.jpg$/.test(f))
      .sort()
      .map(f => join(tempDir, f));

    if (!slideImages.length) {
      const err = new Error('No slide images produced (empty deck?)');
      err.code = 'NO_SLIDES';
      throw err;
    }

    const meta = await sharp(slideImages[0]).metadata();
    const aspect = meta.height / meta.width;
    const thumbH = Math.round(THUMBNAIL_WIDTH * aspect);
    const rows = Math.ceil(slideImages.length / cols);
    const gridW = cols * THUMBNAIL_WIDTH + (cols + 1) * GRID_PADDING;
    const gridH = rows * thumbH + (rows + 1) * GRID_PADDING;

    const composites = await Promise.all(
      slideImages.map(async (imgPath, i) => {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const input = await sharp(imgPath).resize(THUMBNAIL_WIDTH, thumbH, { fit: 'inside' }).toBuffer();
        return { input, left: col * THUMBNAIL_WIDTH + (col + 1) * GRID_PADDING, top: row * thumbH + (row + 1) * GRID_PADDING };
      })
    );

    const outputFile = resolve(`${outputPrefix}.jpg`);
    await sharp({ create: { width: gridW, height: gridH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite(composites)
      .jpeg({ quality: 95 })
      .toFile(outputFile);

    emitResult('thumbnail', outputFile, { slides: slideImages.length, source: absInput });
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch (cleanupErr) {
      process.stderr.write(`⚠️ tempDir cleanup failed: ${cleanupErr.message}\n`);
    }
  }
});
