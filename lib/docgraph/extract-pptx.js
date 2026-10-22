// lib/docgraph/extract-pptx.js
// PPTX extractor. PPTX is a ZIP of XML; mirrors the proven approach in
// lib/handlers/attachments/pptxHandler.js (adm-zip + fast-xml-parser, collect
// <a:t> text runs). One section per slide (heading "Slide N"), with speaker
// notes appended. Returns { title, sections, refs }.

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false });
const baseName = (relPath) => relPath.split('/').pop().replace(/\.[^.]+$/, '');
const slideNum = (e) => parseInt(e.entryName.match(/\d+/)?.[0] ?? '0', 10);
const byNum = (a, b) => slideNum(a) - slideNum(b);
const clean = (s) => s.replace(/\s+/g, ' ').trim();

// Recursively collect all <a:t> (DrawingML text run) values from a parsed node.
function collectText(node) {
  if (typeof node === 'string') return node;
  if (typeof node !== 'object' || node === null) return '';
  const parts = [];
  for (const [key, val] of Object.entries(node)) {
    if (key === 'a:t') parts.push(...(Array.isArray(val) ? val.map(String) : [String(val)]));
    else parts.push(collectText(val));
  }
  return parts.filter(Boolean).join(' ');
}

export async function extract(input, relPath) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries = new AdmZip(buffer).getEntries();
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).sort(byNum);
  const notes = entries.filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.entryName)).sort(byNum);

  const sections = [];
  for (let i = 0; i < slides.length; i++) {
    const slideText = clean(collectText(parser.parse(slides[i].getData().toString('utf8'))));
    const noteText = notes[i] ? clean(collectText(parser.parse(notes[i].getData().toString('utf8')))) : '';
    const text = (slideText + (noteText ? `\n[Notes] ${noteText}` : '')).trim();
    if (!text) continue;
    sections.push({
      localId: sections.length + 1,
      parentLocalId: null,
      ord: sections.length,
      level: 1,
      heading: `Slide ${i + 1}`,
      text,
    });
  }

  const summary = sections.length ? null : 'No slide text found.';
  return { title: baseName(relPath), sections, refs: [], summary };
}
