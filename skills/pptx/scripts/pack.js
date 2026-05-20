#!/usr/bin/env node
/**
 * Pack an unpacked PPTX directory back into a .pptx file.
 * Condenses XML and restores smart-quote entities before zipping.
 * Usage: node scripts/pack.js unpacked/ output.pptx
 */

import AdmZip from 'adm-zip';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';

const SMART_QUOTE_ENTITIES = {
  '&#x201C;': '“',
  '&#x201D;': '”',
  '&#x2018;': '‘',
  '&#x2019;': '’',
};

function condenseXml(content) {
  // Remove pretty-print indentation: trim each line and join without newlines.
  // <a:t> text content sits on one line after pretty-printing, so this is safe.
  return content.split('\n').map(l => l.trim()).filter(Boolean).join('');
}

function restoreSmartQuotes(content) {
  let out = content;
  for (const [entity, char] of Object.entries(SMART_QUOTE_ENTITIES)) {
    out = out.replaceAll(entity, char);
  }
  return out;
}

function getAllFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(full, base));
    } else {
      files.push({ full, rel: relative(base, full).replace(/\\/g, '/') });
    }
  }
  return files;
}

const [,, inputDir, outputFile] = process.argv;
if (!inputDir || !outputFile) {
  console.error('Usage: node scripts/pack.js <unpacked_dir> <output.pptx>');
  process.exit(1);
}

const zip = new AdmZip();
for (const { full, rel } of getAllFiles(resolve(inputDir))) {
  const isXml = rel.endsWith('.xml') || rel.endsWith('.rels');
  let buf;
  if (isXml) {
    let content = readFileSync(full, 'utf8');
    content = condenseXml(content);
    content = restoreSmartQuotes(content);
    buf = Buffer.from(content, 'utf8');
  } else {
    buf = readFileSync(full);
  }
  zip.addFile(rel, buf);
}

zip.writeZip(resolve(outputFile));
console.log(`Packed to ${outputFile}`);
