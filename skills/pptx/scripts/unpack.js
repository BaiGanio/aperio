#!/usr/bin/env node
/**
 * Unpack a PPTX file for editing — extracts ZIP, pretty-prints XML, escapes smart quotes.
 * Usage: node scripts/unpack.js input.pptx unpacked/
 */

import AdmZip from 'adm-zip';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { runScript, requireArg, assertExists } from './_lib.js';

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

runScript('unpack', () => {
  const inputFile = requireArg(process.argv[2], 'Usage: node scripts/unpack.js <input.pptx> <output_dir>');
  const outputDir = requireArg(process.argv[3], 'Usage: node scripts/unpack.js <input.pptx> <output_dir>');
  const absInput = assertExists(inputFile, 'pptx');

  let zip;
  try {
    zip = new AdmZip(absInput);
  } catch (err) {
    const wrapped = new Error(`Failed to open pptx as zip: ${err.message}`);
    wrapped.code = 'BAD_PPTX';
    throw wrapped;
  }

  const outPath = resolve(outputDir);
  zip.extractAllTo(outPath, true);

  if (!existsSync(outPath) || !statSync(outPath).isDirectory()) {
    const err = new Error(`extractAllTo did not produce directory: ${outPath}`);
    err.code = 'EXTRACT_FAILED';
    throw err;
  }

  let count = 0;
  let errors = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const filePath = join(outPath, name);
    try {
      let content = readFileSync(filePath, 'utf8');
      try { content = prettyPrintXml(content); } catch (prettyErr) {
        process.stderr.write(`⚠️ pretty-print failed for ${name}: ${prettyErr.message} (kept raw)\n`);
      }
      content = escapeSmartQuotes(content);
      writeFileSync(filePath, content, 'utf8');
      count++;
    } catch (err) {
      errors++;
      process.stderr.write(`⚠️ post-process failed for ${name}: ${err.message}\n`);
    }
  }

  console.log(`✅ unpack: ${absInput} → ${outPath} (${count} XML files processed, ${errors} errors)`);
  // unpack produces a directory, not a single file, so no APERIO_PPTX marker.
});
