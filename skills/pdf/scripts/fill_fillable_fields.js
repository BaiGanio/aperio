#!/usr/bin/env node
// Usage: node fill_fillable_fields.js <input.pdf> <field_values.json> <output.pdf>
// field_values.json: output of extract_form_field_info.js with "value" added to each field entry.
import { readFileSync, writeFileSync } from 'fs';
import { PDFDocument } from 'pdf-lib';

const [,, inputPdf, fieldsJson, outputPdf] = process.argv;
if (!inputPdf || !fieldsJson || !outputPdf) {
  console.error('Usage: fill_fillable_fields.js <input.pdf> <field_values.json> <output.pdf>');
  process.exit(1);
}

const fields = JSON.parse(readFileSync(fieldsJson, 'utf8'));
const pdfDoc = await PDFDocument.load(readFileSync(inputPdf));
const form = pdfDoc.getForm();

// Build a lookup of actual field names in the PDF
const pdfFieldNames = new Set(form.getFields().map(f => f.getName()));

let hasError = false;

// Validate all entries first
for (const field of fields) {
  if (!('value' in field)) continue;
  if (!pdfFieldNames.has(field.field_id)) {
    console.error(`ERROR: \`${field.field_id}\` is not a valid field ID`);
    hasError = true;
    continue;
  }
  const err = validationError(field, field.value);
  if (err) { console.error(err); hasError = true; }
}
if (hasError) process.exit(1);

// Fill fields
for (const field of fields) {
  if (!('value' in field)) continue;

  const { field_id: id, type, value } = field;

  if (type === 'text') {
    form.getTextField(id).setText(String(value));

  } else if (type === 'checkbox') {
    const cb = form.getCheckBox(id);
    value === field.checked_value ? cb.check() : cb.uncheck();

  } else if (type === 'radio_group') {
    // pdf-lib expects option names without leading slash
    const normalized = value.startsWith('/') ? value.slice(1) : value;
    form.getRadioGroup(id).select(normalized);

  } else if (type === 'choice') {
    const normalized = value.startsWith('/') ? value.slice(1) : value;
    try {
      form.getDropdown(id).select(normalized);
    } catch {
      form.getOptionList(id).select(normalized);
    }
  }
}

form.flatten();
writeFileSync(outputPdf, await pdfDoc.save());
console.log(`Filled PDF saved to ${outputPdf}`);

function validationError(field, value) {
  const { field_id: id, type } = field;
  if (type === 'checkbox') {
    if (value !== field.checked_value && value !== field.unchecked_value) {
      return `ERROR: Invalid value "${value}" for checkbox field "${id}". The checked value is "${field.checked_value}" and the unchecked value is "${field.unchecked_value}"`;
    }
  } else if (type === 'radio_group') {
    const opts = (field.radio_options || []).map(o => o.value);
    if (!opts.includes(value)) {
      return `ERROR: Invalid value "${value}" for radio group field "${id}". Valid values are: ${JSON.stringify(opts)}`;
    }
  } else if (type === 'choice') {
    const opts = (field.choice_options || []).map(o => o.value);
    if (!opts.includes(value)) {
      return `ERROR: Invalid value "${value}" for choice field "${id}". Valid values are: ${JSON.stringify(opts)}`;
    }
  }
  return null;
}
