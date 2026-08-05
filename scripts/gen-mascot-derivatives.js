#!/usr/bin/env node
/**
 * Regenerates the derived mascot assets from the masters in docs/assets/mascot/
 * and mirrors the app-needed subset into public/assets/mascot/.
 *
 * Masters (hand-produced, see memory `project-mascot`):
 *   robot-aurora-512.png  full body, transparent
 *   icon-512.png          square head mark (headphones + antenna)
 *
 * Derivatives (this script):
 *   avatar-124.png / avatar-248.webp  chat AI avatar (@1x / @2x), full body
 *   body-256.webp                   full body for page headers and the 404
 *   mono.png                        quiet desaturated body for empty/offline states
 *   head-64.webp                    inline terminal-demo icon — the one slot where
 *                                   the body is too small to read, so the head stays
 *
 * Usage: npm run gen:mascot   (add --check to verify without writing)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs', 'assets', 'mascot');
const PUBLIC = path.join(ROOT, 'public', 'assets', 'mascot');

/** Every derivative must stay under this, per the plan's asset budget. */
const MAX_BYTES = 30 * 1024;

const check = process.argv.includes('--check');

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * The whole robot, trimmed to its own edges and centred in a square canvas —
 * the mascot has a body, and at avatar sizes the silhouette still reads.
 */
function body() {
  return sharp(path.join(DOCS, 'robot-aurora-512.png')).trim({ threshold: 1 });
}

async function avatar(size) {
  return body()
    .resize(size, size, { fit: 'contain', background: TRANSPARENT })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function avatarWebp(size) {
  return body()
    .resize(size, size, { fit: 'contain', background: TRANSPARENT })
    .webp({ quality: 90, alphaQuality: 100, effort: 6 })
    .toBuffer();
}

/** Crisp body for page headers and the 404 — WebP to keep the page budget. */
async function bodyWebp(size = 256) {
  return body()
    .resize(size, size, { fit: 'contain', background: TRANSPARENT })
    .webp({ quality: 90, alphaQuality: 100, effort: 6 })
    .toBuffer();
}

/**
 * Desaturated body at 50% alpha: present but quiet, so an empty list or an
 * offline banner feels attended rather than shouted at. Readable on both the
 * dark (#0d0d14) and light (#f4f4f8) surfaces.
 */
async function mono(size = 256, opacity = 0.5) {
  const grey = await body()
    .resize(size, size, { fit: 'contain', background: TRANSPARENT })
    .greyscale()
    .toColourspace('srgb')
    .ensureAlpha()
    .png()
    .toBuffer();

  const veil = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: opacity },
    },
  })
    .png()
    .toBuffer();

  // `dest-in` multiplies the body's alpha by the veil's uniform alpha.
  return sharp(grey)
    .composite([{ input: veil, blend: 'dest-in' }])
    // Greyscale quantizes losslessly enough to halve the file (palette + tRNS
    // keeps the alpha), which matters at 256px.
    .png({ compressionLevel: 9, palette: true, quality: 100, effort: 10 })
    .toBuffer();
}

/**
 * Footer thumbnail for a wallpaper. The full JPEGs are 120–320 KB each; the
 * landing page shows them at 132×74, so it downloads a thumb and links the
 * original.
 */
async function wallpaperThumb(master, width = 264, height = 148) {
  return sharp(path.join(DOCS, master))
    .resize(width, height, { fit: 'cover' })
    .webp({ quality: 78, effort: 6 })
    .toBuffer();
}

async function headWebp(size = 64) {
  return sharp(path.join(DOCS, 'icon-512.png'))
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 88, alphaQuality: 100, effort: 6 })
    .toBuffer();
}

/**
 * Masters copied verbatim into public/ — the app's own pages need the PNG
 * favicon set that docs/ already links, and nothing derives them.
 */
const mirrors = ['favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png'];

/** Derivatives the landing page uses and the app has no need for. */
const docsOnly = new Set([
  'wallpaper-1920x1080-thumb.webp',
  'wallpaper-2560x1440-thumb.webp',
  'wallpaper-3840x2160-thumb.webp',
  'wallpaper-phone-1170x2532-thumb.webp',
]);

const derivatives = {
  'avatar-56.png': () => avatar(56),
  'avatar-112.png': () => avatar(112),
  'avatar-124.png': () => avatar(124),
  'avatar-248.webp': () => avatarWebp(248),
  'body-256.webp': () => bodyWebp(),
  'mono.png': () => mono(),
  'head-64.webp': () => headWebp(),
  'wallpaper-1920x1080-thumb.webp': () => wallpaperThumb('wallpaper-1920x1080.jpg'),
  'wallpaper-2560x1440-thumb.webp': () => wallpaperThumb('wallpaper-2560x1440.jpg'),
  'wallpaper-3840x2160-thumb.webp': () => wallpaperThumb('wallpaper-3840x2160.jpg'),
  'wallpaper-phone-1170x2532-thumb.webp': () => wallpaperThumb('wallpaper-phone-1170x2532.jpg'),
};

async function main() {
  if (!check) {
    await mkdir(DOCS, { recursive: true });
    await mkdir(PUBLIC, { recursive: true });
  }

  let failed = false;
  for (const name of mirrors) {
    const master = await readFile(path.join(DOCS, name));
    const target = path.join(PUBLIC, name);
    if (check) {
      const current = await readFile(target).catch(() => null);
      if (!current || !current.equals(master)) {
        console.error(`✗ ${path.relative(ROOT, target)} differs from the master — re-run npm run gen:mascot`);
        failed = true;
      }
      continue;
    }
    await writeFile(target, master);
    console.log(`✓ ${name} — mirrored to public/`);
  }

  for (const [name, build] of Object.entries(derivatives)) {
    const buf = await build();
    const kb = (buf.length / 1024).toFixed(1);
    if (buf.length > MAX_BYTES) {
      console.error(`✗ ${name} is ${kb} KB — over the ${MAX_BYTES / 1024} KB budget`);
      failed = true;
      continue;
    }

    const targets = docsOnly.has(name) ? [DOCS] : [DOCS, PUBLIC];

    if (check) {
      for (const dir of targets) {
        const target = path.join(dir, name);
        const current = await readFile(target).catch(() => null);
        if (!current) {
          console.error(`✗ missing ${path.relative(ROOT, target)}`);
          failed = true;
        } else if (current.length !== buf.length) {
          console.error(`✗ stale ${path.relative(ROOT, target)} — re-run npm run gen:mascot`);
          failed = true;
        }
      }
      continue;
    }

    for (const dir of targets) await writeFile(path.join(dir, name), buf);
    console.log(`✓ ${name} — ${kb} KB`);
  }

  if (failed) process.exit(1);
  if (check) console.log('✓ mascot derivatives are up to date');
}

await main();
