#!/usr/bin/env node
/**
 * Verify a created PPTX is real and looks sane.
 *   - file exists on disk
 *   - opens as a valid zip
 *   - has the required parts ([Content_Types].xml, ppt/presentation.xml)
 *   - has at least one slide with non-placeholder text
 *
 * Emits an APERIO_PPTX:{...} marker so the agent layer can verify the same
 * file independently and surface it to the UI as a real, downloadable artifact.
 *
 * Usage: node scripts/verify.js output.pptx
 */

import AdmZip from 'adm-zip';
import { runScript, requireArg, assertExists, emitResult } from './_lib.js';

const PLACEHOLDER_PATTERNS = [
  /xxxx+/i,
  /lorem\s+ipsum/i,
  /\bthis\s+(page|slide)\s+layout\b/i,
  /click to add (title|text|subtitle)/i,
];

runScript('verify', () => {
  const inputFile = requireArg(process.argv[2], 'Usage: node scripts/verify.js <presentation.pptx>');
  const abs = assertExists(inputFile, 'pptx');

  let zip;
  try {
    zip = new AdmZip(abs);
  } catch (err) {
    throw Object.assign(new Error(`not a valid zip / pptx: ${err.message}`), { code: 'BAD_PPTX' });
  }

  const need = ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'];
  const missing = need.filter(n => !zip.getEntry(n));
  if (missing.length) {
    throw Object.assign(new Error(`pptx missing required parts: ${missing.join(', ')}`), { code: 'BAD_PPTX' });
  }

  const slideEntries = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName));
  if (!slideEntries.length) {
    throw Object.assign(new Error('pptx has zero slides'), { code: 'EMPTY_DECK' });
  }

  let textChars = 0;
  const placeholders = [];
  for (const entry of slideEntries) {
    const xml = entry.getData().toString('utf8');
    const texts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map(m => m[1]);
    const joined = texts.join(' ');
    textChars += joined.replace(/\s+/g, '').length;
    for (const pat of PLACEHOLDER_PATTERNS) {
      if (pat.test(joined)) placeholders.push({ slide: entry.entryName, match: pat.source });
    }
  }

  if (textChars === 0) {
    process.stderr.write('⚠️ verify: pptx opens but contains no text on any slide\n');
  }

  if (placeholders.length) {
    process.stderr.write(`⚠️ verify: ${placeholders.length} placeholder occurrence(s) detected:\n`);
    for (const p of placeholders) process.stderr.write(`   - ${p.slide}: /${p.match}/\n`);
  }

  emitResult('verify', abs, {
    slides: slideEntries.length,
    textChars,
    placeholders: placeholders.length,
  });
});
