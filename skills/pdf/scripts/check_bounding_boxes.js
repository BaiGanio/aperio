#!/usr/bin/env node
// Usage: node check_bounding_boxes.js <fields.json>
// Validates that no bounding boxes in the fields JSON overlap each other.
import { readFileSync } from 'fs';

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('Usage: check_bounding_boxes.js <fields.json>');
  process.exit(1);
}

const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
const fields = data.form_fields;
console.log(`Read ${fields.length} fields`);

function intersects(r1, r2) {
  return !(r1[0] >= r2[2] || r1[2] <= r2[0] || r1[1] >= r2[3] || r1[3] <= r2[1]);
}

// Build flat list of {rect, rectType, field} entries
const entries = [];
for (const f of fields) {
  entries.push({ rect: f.label_bounding_box, rectType: 'label', field: f });
  entries.push({ rect: f.entry_bounding_box, rectType: 'entry', field: f });
}

let hasError = false;
const messages = [];

for (let i = 0; i < entries.length; i++) {
  const ei = entries[i];
  for (let j = i + 1; j < entries.length; j++) {
    const ej = entries[j];
    if (ei.field.page_number !== ej.field.page_number) continue;
    if (!intersects(ei.rect, ej.rect)) continue;

    hasError = true;
    if (ei.field === ej.field) {
      messages.push(
        `FAILURE: intersection between label and entry bounding boxes for \`${ei.field.description}\` (${JSON.stringify(ei.rect)}, ${JSON.stringify(ej.rect)})`
      );
    } else {
      messages.push(
        `FAILURE: intersection between ${ei.rectType} bounding box for \`${ei.field.description}\` (${JSON.stringify(ei.rect)}) and ${ej.rectType} bounding box for \`${ej.field.description}\` (${JSON.stringify(ej.rect)})`
      );
    }
    if (messages.length >= 20) {
      messages.push('Aborting further checks; fix bounding boxes and try again');
      break;
    }
  }
  if (messages.length >= 20) break;

  // Check entry box height vs font size
  if (ei.rectType === 'entry' && ei.field.entry_text) {
    const fontSize = ei.field.entry_text.font_size ?? 14;
    const entryHeight = ei.rect[3] - ei.rect[1];
    if (entryHeight < fontSize) {
      hasError = true;
      messages.push(
        `FAILURE: entry bounding box height (${entryHeight}) for \`${ei.field.description}\` is too short for the text content (font size: ${fontSize}). Increase the box height or decrease the font size.`
      );
      if (messages.length >= 20) {
        messages.push('Aborting further checks; fix bounding boxes and try again');
        break;
      }
    }
  }
}

for (const msg of messages) console.log(msg);
if (!hasError) console.log('SUCCESS: All bounding boxes are valid');
