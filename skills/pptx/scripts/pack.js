#!/usr/bin/env node
/**
 * Pack an unpacked PPTX directory back into a .pptx file.
 * Usage: node scripts/pack.js unpacked/ output.pptx
 */

import AdmZip from 'adm-zip';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, join, relative } from 'path';
import { runScript, requireArg, assertExists, emitResult } from './_lib.js';

const SMART_QUOTE_ENTITIES = {
  '&#x201C;': '“',
  '&#x201D;': '”',
  '&#x2018;': '‘',
  '&#x2019;': '’',
};

function condenseXml(content) {
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

runScript('pack', () => {
  const inputDir = requireArg(process.argv[2], 'Usage: node scripts/pack.js <unpacked_dir> <output.pptx>');
  const outputFile = requireArg(process.argv[3], 'Usage: node scripts/pack.js <unpacked_dir> <output.pptx>');
  const absInputDir = assertExists(inputDir, 'unpacked dir');
  if (!statSync(absInputDir).isDirectory()) {
    throw Object.assign(new Error(`Not a directory: ${absInputDir}`), { code: 'NOT_DIR' });
  }

  // Sanity check: a real unpacked pptx must have [Content_Types].xml at the root.
  if (!existsSync(join(absInputDir, '[Content_Types].xml'))) {
    throw Object.assign(
      new Error(`${absInputDir} does not look like an unpacked pptx ([Content_Types].xml missing)`),
      { code: 'BAD_INPUT_DIR' }
    );
  }

  const zip = new AdmZip();
  let added = 0;
  let failures = 0;
  for (const { full, rel } of getAllFiles(absInputDir)) {
    try {
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
      added++;
    } catch (err) {
      failures++;
      process.stderr.write(`⚠️ skipped ${rel}: ${err.message}\n`);
    }
  }

  if (failures > 0) {
    process.stderr.write(`⚠️ ${failures} file(s) skipped during pack — output may be incomplete\n`);
  }

  const absOutput = resolve(outputFile);
  zip.writeZip(absOutput);
  emitResult('pack', absOutput, { entries: added, skipped: failures, source: absInputDir });
});
