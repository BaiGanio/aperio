#!/usr/bin/env node
/**
 * Extract text content from a PPTX file.
 * Usage: node scripts/read.js presentation.pptx
 */

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { runScript, requireArg, assertExists } from './_lib.js';

runScript('read', () => {
  const inputFile = requireArg(process.argv[2], 'Usage: node scripts/read.js <presentation.pptx>');
  const abs = assertExists(inputFile, 'pptx');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    trimValues: false,
  });

  let zip;
  try {
    zip = new AdmZip(abs);
  } catch (err) {
    const wrapped = new Error(`Failed to open pptx (not a valid zip?): ${err.message}`);
    wrapped.code = 'BAD_PPTX';
    throw wrapped;
  }

  const relsEntry = zip.getEntry('ppt/_rels/presentation.xml.rels');
  if (!relsEntry) throw Object.assign(new Error('ppt/_rels/presentation.xml.rels missing — not a valid pptx'), { code: 'BAD_PPTX' });
  const relsData = relsEntry.getData().toString('utf8');
  const relsXml = parser.parse(relsData);
  const rels = [relsXml?.Relationships?.Relationship ?? []].flat();
  const ridToPath = Object.fromEntries(
    rels
      .filter(r => r?.['@_Type']?.includes('/slide') && r?.['@_Target']?.startsWith('slides/'))
      .map(r => [r['@_Id'], `ppt/${r['@_Target']}`])
  );

  const presEntry = zip.getEntry('ppt/presentation.xml');
  if (!presEntry) throw Object.assign(new Error('ppt/presentation.xml missing — not a valid pptx'), { code: 'BAD_PPTX' });
  const presData = presEntry.getData().toString('utf8');
  const presXml = parser.parse(presData);
  const sldIds = [presXml?.['p:presentation']?.['p:sldIdLst']?.['p:sldId'] ?? []].flat();

  let printed = 0;
  sldIds.forEach((sldId, i) => {
    const slidePath = ridToPath[sldId?.['@_r:id']];
    if (!slidePath) return;
    const slideEntry = zip.getEntry(slidePath);
    if (!slideEntry) {
      process.stderr.write(`⚠️ slide ${i + 1} referenced but missing in zip: ${slidePath}\n`);
      return;
    }
    const slideXml = slideEntry.getData().toString('utf8');
    const texts = [...slideXml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
      .map(m => m[1])
      .filter(t => t.trim());
    if (texts.length) {
      console.log(`\n## Slide ${i + 1}\n\n${texts.join('\n')}`);
      printed++;
    }
  });

  if (printed === 0) process.stderr.write(`⚠️ No slides with text found in ${abs}\n`);
  console.log(`\n--- read ${printed}/${sldIds.length} slides from ${abs} ---`);
});
