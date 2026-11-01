#!/usr/bin/env node
// Usage: node extract_form_field_info.js <input.pdf> <output.json>
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

const _require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = _require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

const [,, pdfPath, jsonOutputPath] = process.argv;
if (!pdfPath || !jsonOutputPath) {
  console.error('Usage: extract_form_field_info.js <input.pdf> <output.json>');
  process.exit(1);
}

const data = new Uint8Array(readFileSync(pdfPath));
const pdf = await getDocument({ data, verbosity: 0 }).promise;

const simpleFields = {};
const radioGroups = {};

for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
  const page = await pdf.getPage(pageNum);
  const anns = await page.getAnnotations();

  for (const ann of anns) {
    if (ann.subtype !== 'Widget' || !ann.fieldType) continue;
    const fieldId = ann.fieldName;
    if (!fieldId) continue;

    if (ann.radioButton) {
      if (!radioGroups[fieldId]) {
        radioGroups[fieldId] = { field_id: fieldId, type: 'radio_group', page: pageNum, radio_options: [] };
      }
      const val = ann.buttonValue;
      if (val && val !== '/Off') {
        radioGroups[fieldId].radio_options.push({ value: val, rect: ann.rect });
      }
    } else if (ann.checkBox) {
      const onValue = ann.exportValue || '/Yes';
      simpleFields[fieldId] = {
        field_id: fieldId, type: 'checkbox',
        checked_value: onValue, unchecked_value: '/Off',
        page: pageNum, rect: ann.rect,
      };
    } else if (ann.fieldType === 'Tx') {
      simpleFields[fieldId] = { field_id: fieldId, type: 'text', page: pageNum, rect: ann.rect };
    } else if (ann.fieldType === 'Ch') {
      simpleFields[fieldId] = {
        field_id: fieldId, type: 'choice',
        choice_options: (ann.options || []).map(o => ({ value: o.exportValue, text: o.displayValue })),
        page: pageNum, rect: ann.rect,
      };
    } else {
      simpleFields[fieldId] = {
        field_id: fieldId, type: `unknown (${ann.fieldType})`, page: pageNum, rect: ann.rect,
      };
    }
  }
}

const fields = [...Object.values(simpleFields), ...Object.values(radioGroups)];

fields.sort((a, b) => {
  if (a.page !== b.page) return a.page - b.page;
  const ra = a.radio_options ? a.radio_options[0]?.rect : a.rect;
  const rb = b.radio_options ? b.radio_options[0]?.rect : b.rect;
  // Sort top-to-bottom (descending PDF y), then left-to-right
  const yDiff = (rb ? rb[1] : 0) - (ra ? ra[1] : 0);
  if (yDiff !== 0) return yDiff;
  return (ra ? ra[0] : 0) - (rb ? rb[0] : 0);
});

writeFileSync(jsonOutputPath, JSON.stringify(fields, null, 2));
console.log(`Wrote ${fields.length} fields to ${jsonOutputPath}`);
