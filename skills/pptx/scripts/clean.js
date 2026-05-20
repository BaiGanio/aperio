#!/usr/bin/env node
/**
 * Remove unreferenced files from an unpacked PPTX directory.
 * Usage: node scripts/clean.js unpacked/
 *
 * Removes: orphaned slides, [trash] dir, unreferenced media/charts/diagrams/drawings.
 */

import { readFileSync, writeFileSync, unlinkSync, rmdirSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, join, relative } from 'path';

const [,, unpackedDir] = process.argv;
if (!unpackedDir) {
  console.error('Usage: node scripts/clean.js <unpacked_dir>');
  process.exit(1);
}

const dir = resolve(unpackedDir);

function getReferencedSlides() {
  const presPath = join(dir, 'ppt', 'presentation.xml');
  const relsPath = join(dir, 'ppt', '_rels', 'presentation.xml.rels');
  if (!existsSync(presPath) || !existsSync(relsPath)) return new Set();

  const relsContent = readFileSync(relsPath, 'utf8');
  const ridToSlide = {};
  for (const [, rid, target] of relsContent.matchAll(/Id="([^"]+)"[^>]*Type="[^"]*\/slide"[^>]*Target="slides\/([^"]+)"/g)) {
    ridToSlide[rid] = target;
  }
  // Also handle reversed attribute order
  for (const [, target, rid] of relsContent.matchAll(/Target="slides\/([^"]+)"[^>]*Id="([^"]+)"/g)) {
    ridToSlide[rid] = target;
  }

  const presContent = readFileSync(presPath, 'utf8');
  const rids = [...presContent.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)].map(m => m[1]);
  return new Set(rids.map(rid => ridToSlide[rid]).filter(Boolean));
}

function removeOrphanedSlides() {
  const slidesDir = join(dir, 'ppt', 'slides');
  const relsDir = join(slidesDir, '_rels');
  if (!existsSync(slidesDir)) return [];

  const referenced = getReferencedSlides();
  const removed = [];

  for (const file of readdirSync(slidesDir)) {
    if (!/^slide\d+\.xml$/.test(file) || referenced.has(file)) continue;
    unlinkSync(join(slidesDir, file));
    removed.push(relative(dir, join(slidesDir, file)));
    const relsFile = join(relsDir, `${file}.rels`);
    if (existsSync(relsFile)) {
      unlinkSync(relsFile);
      removed.push(relative(dir, relsFile));
    }
  }

  if (removed.length) {
    const relsPath = join(dir, 'ppt', '_rels', 'presentation.xml.rels');
    if (existsSync(relsPath)) {
      let content = readFileSync(relsPath, 'utf8');
      content = content.replace(
        /<Relationship[^>]*Type="[^"]*\/slide"[^>]*Target="slides\/([^"]+)"[^>]*\/>/g,
        (match, slide) => referenced.has(slide) ? match : ''
      );
      content = content.replace(
        /<Relationship[^>]*Target="slides\/([^"]+)"[^>]*Type="[^"]*\/slide"[^>]*\/>/g,
        (match, slide) => referenced.has(slide) ? match : ''
      );
      writeFileSync(relsPath, content, 'utf8');
    }
  }
  return removed;
}

function getAllReferencedFiles() {
  const referenced = new Set();
  function collectRels(startDir) {
    if (!existsSync(startDir)) return;
    for (const entry of readdirSync(startDir, { withFileTypes: true })) {
      const full = join(startDir, entry.name);
      if (entry.isDirectory()) { collectRels(full); continue; }
      if (!entry.name.endsWith('.rels')) continue;
      const content = readFileSync(full, 'utf8');
      const base = full.replace(/\/_rels\/[^/]+$/, '');
      for (const [, target] of content.matchAll(/Target="([^"]+)"/g)) {
        if (target.startsWith('http')) continue;
        try {
          const abs = new URL(target, `file://${base}/`).pathname;
          referenced.add(relative(dir, abs).replace(/\\/g, '/'));
        } catch { /* ignore malformed */ }
      }
    }
  }
  collectRels(dir);
  return referenced;
}

function removeOrphanedFiles(referenced) {
  const resourceDirs = ['media', 'embeddings', 'charts', 'diagrams', 'tags', 'drawings', 'ink'];
  const removed = [];
  for (const dirName of resourceDirs) {
    const resDir = join(dir, 'ppt', dirName);
    if (!existsSync(resDir)) continue;
    for (const file of readdirSync(resDir)) {
      const full = join(resDir, file);
      if (!statSync(full).isFile()) continue;
      const rel = relative(dir, full).replace(/\\/g, '/');
      if (!referenced.has(rel)) { unlinkSync(full); removed.push(rel); }
    }
  }
  return removed;
}

function updateContentTypes(removedFiles) {
  const ctPath = join(dir, '[Content_Types].xml');
  if (!existsSync(ctPath)) return;
  let content = readFileSync(ctPath, 'utf8');
  let changed = false;
  for (const file of removedFiles) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = content;
    content = content.replace(new RegExp(`\\s*<Override PartName="/${escaped}"[^/]*/>`), '');
    if (content !== before) changed = true;
  }
  if (changed) writeFileSync(ctPath, content, 'utf8');
}

const allRemoved = [];
allRemoved.push(...removeOrphanedSlides());

const trashDir = join(dir, '[trash]');
if (existsSync(trashDir)) {
  for (const file of readdirSync(trashDir)) {
    const full = join(trashDir, file);
    if (statSync(full).isFile()) { unlinkSync(full); allRemoved.push(relative(dir, full)); }
  }
  try { rmdirSync(trashDir); } catch { /* ignore */ }
}

const referenced = getAllReferencedFiles();
allRemoved.push(...removeOrphanedFiles(referenced));

if (allRemoved.length) {
  updateContentTypes(allRemoved);
  console.log(`Removed ${allRemoved.length} unreferenced files:`);
  allRemoved.forEach(f => console.log(`  ${f}`));
} else {
  console.log('No unreferenced files found');
}
