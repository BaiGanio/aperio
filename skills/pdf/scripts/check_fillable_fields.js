#!/usr/bin/env node
// Usage: node check_fillable_fields.js <input.pdf>
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

const _require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = _require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('Usage: check_fillable_fields.js <input.pdf>');
  process.exit(1);
}

const data = new Uint8Array(readFileSync(pdfPath));
const pdf = await getDocument({ data, verbosity: 0 }).promise;

let hasFields = false;
for (let i = 1; i <= pdf.numPages && !hasFields; i++) {
  const page = await pdf.getPage(i);
  const anns = await page.getAnnotations();
  hasFields = anns.some(a => a.subtype === 'Widget' && a.fieldType);
}

console.log(hasFields
  ? 'This PDF has fillable form fields'
  : 'This PDF does not have fillable form fields; you will need to visually determine where to enter data'
);
