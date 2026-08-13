import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const exec = promisify(execFile);

export async function verifyPdf(file, paper, { pseudo = false, expectedPages } = {}) {
  const bytes = await fs.readFile(file);
  const pdf = await PDFDocument.load(bytes);
  const catalog = pdf.catalog;
  const requiredCatalog = ['StructTreeRoot', 'MarkInfo', 'Lang', 'Outlines'];
  for (const key of requiredCatalog) if (!catalog.get(PDFName.of(key))) throw new Error(`${paper}: missing PDF catalog ${key}`);
  const lang = catalog.lookup(PDFName.of('Lang'))?.decodeText?.();
  if (lang !== (pseudo ? 'en-x-pseudo' : 'en')) throw new Error(`${paper}: wrong PDF language ${lang}`);
  if (!catalog.lookup(PDFName.of('MarkInfo'))?.toString().includes('/Marked true')) throw new Error(`${paper}: PDF is not marked tagged`);
  if (!pdf.getTitle()?.includes('NON-RELEASE')) throw new Error(`${paper}: preview PDF title lacks NON-RELEASE`);
  const objects = pdf.context.enumerateIndirectObjects().map(([, object]) => object.toString()).join('\n');
  for (const role of ['/Document', '/H1', '/P', '/L', '/Table', '/TR', '/TH', '/Figure']) {
    if (!objects.includes(`/S ${role}`)) throw new Error(`${paper}: missing structure role ${role}`);
  }
  if (objects.includes('/S /Strong')) throw new Error(`${paper}: Chromium /Strong regression detected`);
  if (!objects.includes('/Alt')) throw new Error(`${paper}: tagged figure lacks alternative text`);
  const outlineEntries = (objects.match(/\/Title /g) || []).length;
  if (outlineEntries < 26) throw new Error(`${paper}: incomplete document outline (${outlineEntries})`);
  const expected = paper === 'a4' ? [595.28, 841.89] : [612, 792];
  for (const [index, page] of pdf.getPages().entries()) {
    const { width, height } = page.getSize();
    if (Math.abs(width - expected[0]) > 1 || Math.abs(height - expected[1]) > 1) throw new Error(`${paper}: page ${index + 1} geometry ${width}x${height}`);
  }
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const document = await loading.promise;
  if (expectedPages && document.numPages !== expectedPages) throw new Error(`${paper}: expected ${expectedPages} pages, rendered ${document.numPages}`);
  let text = '';
  let links = 0;
  let internalLinks = 0;
  let externalLinks = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n';
    for (const annotation of (await page.getAnnotations()).filter((item) => item.subtype === 'Link')) {
      links += 1;
      if (annotation.url) externalLinks += 1;
      if (annotation.dest) internalLinks += 1;
    }
  }
  const markers = pseudo ? ['NON-RELEASE', 'Aperio', '65d45c', 'Ж', 'λ'] : ['NON-RELEASE', 'First recall', 'How Aperio carries a signal', 'apricot', 'review checklist'];
  for (const marker of markers) {
    if (!text.toLowerCase().includes(marker.toLowerCase())) throw new Error(`${paper}: searchable text missing ${marker}`);
  }
  if (links < 20) throw new Error(`${paper}: too few PDF links (${links})`);
  if (!pseudo && (!internalLinks || !externalLinks)) throw new Error(`${paper}: both internal and external links must survive PDF rendering`);
  if (!pseudo && !(text.indexOf('First recall') < text.indexOf('How Aperio carries a signal') && text.indexOf('How Aperio carries a signal') < text.indexOf('review checklist'))) {
    throw new Error(`${paper}: extracted reading order is invalid`);
  }
  const { stdout: fonts } = await exec('pdffonts', [file], { maxBuffer: 4 * 1024 * 1024 });
  const fontLines = fonts.trim().split('\n').slice(2).filter(Boolean);
  if (!fontLines.length || fontLines.some((line) => !/\syes\s/.test(line))) throw new Error(`${paper}: font embedding check failed`);
  return { paper, pseudo, pages: document.numPages, links, internalLinks, externalLinks, outlineEntries, searchableCharacters: text.length, cjkCopySearch: pseudo ? (text.includes('界') ? 'pass' : 'fail') : 'not-applicable', scriptFontCoverage: pseudo ? 'blocked-by-unlocked-preview-font-profile' : 'not-applicable', strongRegression: false, roles: ['Document', 'H1', 'P', 'L', 'Table', 'TR', 'TH', 'Figure'], embeddedFonts: fontLines.length };
}
