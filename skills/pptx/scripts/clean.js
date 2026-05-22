#!/usr/bin/env node
/**
 * Remove unreferenced files from an unpacked PPTX directory.
 * Usage: node scripts/clean.js unpacked/
 */

import { readFileSync, writeFileSync, unlinkSync, rmdirSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, join, relative } from 'path';
import { runScript, requireArg, assertExists } from './_lib.js';

runScript('clean', () => {
  const unpackedDir = requireArg(process.argv[2], 'Usage: node scripts/clean.js <unpacked_dir>');
  const dir = assertExists(unpackedDir, 'unpacked dir');
  if (!statSync(dir).isDirectory()) {
    throw Object.assign(new Error(`Not a directory: ${dir}`), { code: 'NOT_DIR' });
  }

  function getReferencedSlides() {
    const presPath = join(dir, 'ppt', 'presentation.xml');
    const relsPath = join(dir, 'ppt', '_rels', 'presentation.xml.rels');
    if (!existsSync(presPath) || !existsSync(relsPath)) {
      process.stderr.write(`⚠️ presentation.xml or its rels missing — skipping orphan-slide removal\n`);
      return new Set();
    }

    const relsContent = readFileSync(relsPath, 'utf8');
    const ridToSlide = {};
    for (const [, rid, target] of relsContent.matchAll(/Id="([^"]+)"[^>]*Type="[^"]*\/slide"[^>]*Target="slides\/([^"]+)"/g)) {
      ridToSlide[rid] = target;
    }
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
      try {
        unlinkSync(join(slidesDir, file));
        removed.push(relative(dir, join(slidesDir, file)));
        const relsFile = join(relsDir, `${file}.rels`);
        if (existsSync(relsFile)) {
          unlinkSync(relsFile);
          removed.push(relative(dir, relsFile));
        }
      } catch (err) {
        process.stderr.write(`⚠️ failed to remove orphan ${file}: ${err.message}\n`);
      }
    }

    if (removed.length) {
      const relsPath = join(dir, 'ppt', '_rels', 'presentation.xml.rels');
      if (existsSync(relsPath)) {
        try {
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
        } catch (err) {
          process.stderr.write(`⚠️ failed to update presentation.xml.rels: ${err.message}\n`);
        }
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
        try {
          const content = readFileSync(full, 'utf8');
          const base = full.replace(/\/_rels\/[^/]+$/, '');
          for (const [, target] of content.matchAll(/Target="([^"]+)"/g)) {
            if (target.startsWith('http')) continue;
            try {
              const abs = new URL(target, `file://${base}/`).pathname;
              referenced.add(relative(dir, abs).replace(/\\/g, '/'));
            } catch (urlErr) {
              process.stderr.write(`⚠️ malformed target in ${full}: ${target} (${urlErr.message})\n`);
            }
          }
        } catch (err) {
          process.stderr.write(`⚠️ failed to scan rels ${full}: ${err.message}\n`);
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
        if (!referenced.has(rel)) {
          try {
            unlinkSync(full);
            removed.push(rel);
          } catch (err) {
            process.stderr.write(`⚠️ failed to remove orphan ${rel}: ${err.message}\n`);
          }
        }
      }
    }
    return removed;
  }

  function updateContentTypes(removedFiles) {
    const ctPath = join(dir, '[Content_Types].xml');
    if (!existsSync(ctPath)) return;
    try {
      let content = readFileSync(ctPath, 'utf8');
      let changed = false;
      for (const file of removedFiles) {
        const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const before = content;
        content = content.replace(new RegExp(`\\s*<Override PartName="/${escaped}"[^/]*/>`), '');
        if (content !== before) changed = true;
      }
      if (changed) writeFileSync(ctPath, content, 'utf8');
    } catch (err) {
      process.stderr.write(`⚠️ failed to update [Content_Types].xml: ${err.message}\n`);
    }
  }

  const allRemoved = [];
  allRemoved.push(...removeOrphanedSlides());

  const trashDir = join(dir, '[trash]');
  if (existsSync(trashDir)) {
    for (const file of readdirSync(trashDir)) {
      const full = join(trashDir, file);
      try {
        if (statSync(full).isFile()) { unlinkSync(full); allRemoved.push(relative(dir, full)); }
      } catch (err) {
        process.stderr.write(`⚠️ failed to clean ${full}: ${err.message}\n`);
      }
    }
    try { rmdirSync(trashDir); } catch (err) {
      process.stderr.write(`⚠️ failed to rmdir [trash]: ${err.message}\n`);
    }
  }

  const referenced = getAllReferencedFiles();
  allRemoved.push(...removeOrphanedFiles(referenced));

  if (allRemoved.length) {
    updateContentTypes(allRemoved);
    console.log(`✅ clean: removed ${allRemoved.length} unreferenced files from ${dir}:`);
    allRemoved.forEach(f => console.log(`  ${f}`));
  } else {
    console.log(`✅ clean: no unreferenced files found in ${dir}`);
  }
});
