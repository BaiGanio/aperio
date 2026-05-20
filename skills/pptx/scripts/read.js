#!/usr/bin/env node
/**
 * Extract text content from a PPTX file (replaces: python -m markitdown).
 * Usage: node scripts/read.js presentation.pptx
 */

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { resolve } from 'path';

const [,, inputFile] = process.argv;
if (!inputFile) {
  console.error('Usage: node scripts/read.js <presentation.pptx>');
  process.exit(1);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: false,
});

const zip = new AdmZip(resolve(inputFile));

// Map r:id → slide file path from presentation rels
const relsData = zip.getEntry('ppt/_rels/presentation.xml.rels')?.getData().toString('utf8') ?? '';
const relsXml = parser.parse(relsData);
const rels = [relsXml?.Relationships?.Relationship ?? []].flat();
const ridToPath = Object.fromEntries(
  rels
    .filter(r => r?.['@_Type']?.includes('/slide') && r?.['@_Target']?.startsWith('slides/'))
    .map(r => [r['@_Id'], `ppt/${r['@_Target']}`])
);

// Get ordered slide IDs from presentation.xml
const presData = zip.getEntry('ppt/presentation.xml')?.getData().toString('utf8') ?? '';
const presXml = parser.parse(presData);
const sldIds = [presXml?.['p:presentation']?.['p:sldIdLst']?.['p:sldId'] ?? []].flat();

sldIds.forEach((sldId, i) => {
  const slidePath = ridToPath[sldId?.['@_r:id']];
  if (!slidePath) return;
  const slideXml = zip.getEntry(slidePath)?.getData().toString('utf8') ?? '';
  const texts = [...slideXml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
    .map(m => m[1])
    .filter(t => t.trim());
  if (texts.length) console.log(`\n## Slide ${i + 1}\n\n${texts.join('\n')}`);
});
