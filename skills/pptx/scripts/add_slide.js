#!/usr/bin/env node
/**
 * Add a slide to an unpacked PPTX directory.
 *   Duplicate a slide:       node scripts/add_slide.js unpacked/ slide2.xml
 *   Create from layout:      node scripts/add_slide.js unpacked/ slideLayout2.xml
 *
 * Prints the <p:sldId> element to manually insert into presentation.xml.
 */

import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const [,, unpackedDir, source] = process.argv;
if (!unpackedDir || !source) {
  console.error('Usage: node scripts/add_slide.js <unpacked_dir> <source>');
  console.error('  source: slide2.xml (duplicate) or slideLayout2.xml (create from layout)');
  process.exit(1);
}

const dir = resolve(unpackedDir);
const slidesDir = join(dir, 'ppt', 'slides');
const relsDir = join(slidesDir, '_rels');

function getNextSlideNum() {
  if (!existsSync(slidesDir)) return 1;
  const nums = readdirSync(slidesDir)
    .map(f => f.match(/^slide(\d+)\.xml$/)?.[1])
    .filter(Boolean)
    .map(Number);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function getNextSlideId() {
  const presPath = join(dir, 'ppt', 'presentation.xml');
  const content = readFileSync(presPath, 'utf8');
  const ids = [...content.matchAll(/<p:sldId[^>]*id="(\d+)"/g)].map(m => Number(m[1]));
  return ids.length ? Math.max(...ids) + 1 : 256;
}

function addToContentTypes(dest) {
  const ctPath = join(dir, '[Content_Types].xml');
  let ct = readFileSync(ctPath, 'utf8');
  if (ct.includes(`/ppt/slides/${dest}`)) return;
  const override = `<Override PartName="/ppt/slides/${dest}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  ct = ct.replace('</Types>', `  ${override}\n</Types>`);
  writeFileSync(ctPath, ct, 'utf8');
}

function addToPresentationRels(dest) {
  const relsPath = join(dir, 'ppt', '_rels', 'presentation.xml.rels');
  let rels = readFileSync(relsPath, 'utf8');
  if (rels.includes(`slides/${dest}`)) {
    const existing = rels.match(new RegExp(`Id="(rId\\d+)"[^>]*Target="slides/${dest}"`));
    return existing?.[1] ?? 'rId?';
  }
  const rids = [...rels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]));
  const rid = `rId${rids.length ? Math.max(...rids) + 1 : 1}`;
  const rel = `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${dest}"/>`;
  rels = rels.replace('</Relationships>', `  ${rel}\n</Relationships>`);
  writeFileSync(relsPath, rels, 'utf8');
  return rid;
}

const nextNum = getNextSlideNum();
const dest = `slide${nextNum}.xml`;
mkdirSync(relsDir, { recursive: true });

if (source.startsWith('slideLayout') && source.endsWith('.xml')) {
  const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>`;

  writeFileSync(join(slidesDir, dest), slideXml, 'utf8');
  writeFileSync(join(relsDir, `${dest}.rels`), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/${source}"/>
</Relationships>`, 'utf8');
} else {
  const srcSlide = join(slidesDir, source);
  if (!existsSync(srcSlide)) {
    console.error(`Error: ${srcSlide} not found`);
    process.exit(1);
  }
  copyFileSync(srcSlide, join(slidesDir, dest));
  const srcRels = join(relsDir, `${source}.rels`);
  if (existsSync(srcRels)) {
    const relsContent = readFileSync(srcRels, 'utf8')
      .replace(/<Relationship[^>]*notesSlide[^>]*\/>\s*/g, '');
    writeFileSync(join(relsDir, `${dest}.rels`), relsContent, 'utf8');
  }
}

addToContentTypes(dest);
const rid = addToPresentationRels(dest);
const nextId = getNextSlideId();
console.log(`Created ${dest} from ${source}`);
console.log(`Add to presentation.xml <p:sldIdLst>: <p:sldId id="${nextId}" r:id="${rid}"/>`);
