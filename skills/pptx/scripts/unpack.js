#!/usr/bin/env node
/**
 * Unpack a PPTX file for editing — extracts ZIP, pretty-prints XML, escapes smart quotes.
 * Usage: node scripts/unpack.js input.pptx unpacked/
 */

import AdmZip from 'adm-zip';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

const SMART_QUOTES = {
  '“': '&#x201C;',
  '”': '&#x201D;',
  '‘': '&#x2018;',
  '’': '&#x2019;',
};

function prettyPrintXml(xml) {
  const text = xml.replace(/\r\n/g, '\n').replace(/>\s*</g, '>\n<').trim();
  let indent = 0;
  return text.split('\n').map(raw => {
    const line = raw.trim();
    if (!line) return null;
    const isClose = line.startsWith('</');
    const isSelfClose = line.endsWith('/>');
    const isDecl = line.startsWith('<?') || line.startsWith('<!');
    const isOpen = line.startsWith('<') && !isClose && !isSelfClose && !isDecl;
    if (isClose) indent = Math.max(0, indent - 1);
    const out = '  '.repeat(indent) + line;
    if (isOpen && !line.includes('</')) indent++;
    return out;
  }).filter(l => l !== null).join('\n') + '\n';
}

function escapeSmartQuotes(content) {
  let out = content;
  for (const [char, entity] of Object.entries(SMART_QUOTES)) {
    out = out.replaceAll(char, entity);
  }
  return out;
}

const [,, inputFile, outputDir] = process.argv;
if (!inputFile || !outputDir) {
  console.error('Usage: node scripts/unpack.js <input.pptx> <output_dir>');
  process.exit(1);
}

const zip = new AdmZip(resolve(inputFile));
const outPath = resolve(outputDir);
zip.extractAllTo(outPath, true);

let count = 0;
for (const entry of zip.getEntries()) {
  if (entry.isDirectory) continue;
  const name = entry.entryName;
  if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
  const filePath = join(outPath, name);
  let content = readFileSync(filePath, 'utf8');
  try { content = prettyPrintXml(content); } catch { /* leave as-is */ }
  content = escapeSmartQuotes(content);
  writeFileSync(filePath, content, 'utf8');
  count++;
}

console.log(`Unpacked ${inputFile} (${count} XML files processed)`);
