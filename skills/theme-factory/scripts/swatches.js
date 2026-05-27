#!/usr/bin/env node
/**
 * Generate a PNG swatch sheet for all themes.
 * Usage: node skills/theme-factory/scripts/swatches.js [output.png]
 * Prints the absolute output path to stdout.
 */

import { readFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const themesDir = join(__dirname, '..', 'themes');

function parseTheme(content) {
  const name = content.match(/^# (.+)/m)?.[1] ?? 'Unknown';
  const colors = [];
  const re = /- \*\*(.+?)\*\*: `(#[0-9a-fA-F]{6})`/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    colors.push({ name: m[1], hex: m[2] });
  }
  return { name, colors };
}

const themes = readdirSync(themesDir)
  .filter(f => f.endsWith('.md'))
  .sort()
  .map(f => parseTheme(readFileSync(join(themesDir, f), 'utf8')));

const W = 1100;
const PAD = 24;
const NAME_W = 210;
const SWATCH_W = 190;
const SWATCH_GAP = 8;
const ROW_H = 100;
const ROW_GAP = 12;
const HEADER_H = 56;
const TOTAL_H = HEADER_H + themes.length * (ROW_H + ROW_GAP) + PAD;

function lum(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function tc(hex) { return lum(hex) > 145 ? '#1a1a1a' : '#ffffff'; }

function x(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TOTAL_H}" font-family="ui-sans-serif,Helvetica,Arial,sans-serif">
<rect width="${W}" height="${TOTAL_H}" fill="#f5f5f5"/>
<text x="${PAD}" y="38" font-size="20" font-weight="bold" fill="#111">Theme Factory — Color Palettes</text>
`;

for (const [i, theme] of themes.entries()) {
  const ry = HEADER_H + i * (ROW_H + ROW_GAP);
  svg += `<rect x="${PAD}" y="${ry}" width="${W - PAD * 2}" height="${ROW_H}" rx="8" fill="white" stroke="#ddd" stroke-width="1"/>`;
  svg += `<text x="${PAD + 14}" y="${ry + ROW_H / 2 + 6}" font-size="14" font-weight="600" fill="#222">${x(theme.name)}</text>`;

  for (const [j, color] of theme.colors.entries()) {
    const sx = PAD + NAME_W + j * (SWATCH_W + SWATCH_GAP);
    const sy = ry + 14;
    const sh = ROW_H - 28;
    const fg = tc(color.hex);
    svg += `<rect x="${sx}" y="${sy}" width="${SWATCH_W}" height="${sh}" rx="5" fill="${color.hex}"/>`;
    svg += `<text x="${sx + SWATCH_W / 2}" y="${sy + sh / 2 - 5}" text-anchor="middle" font-size="11" font-weight="600" fill="${fg}">${x(color.name)}</text>`;
    svg += `<text x="${sx + SWATCH_W / 2}" y="${sy + sh / 2 + 12}" text-anchor="middle" font-size="11" fill="${fg}" opacity="0.8">${color.hex}</text>`;
  }
}

svg += '</svg>';

const out = resolve(process.argv[2] ?? 'swatches.png');
mkdirSync(dirname(out), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(out);
