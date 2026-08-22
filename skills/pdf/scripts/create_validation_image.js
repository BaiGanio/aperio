#!/usr/bin/env node
// Usage: node create_validation_image.js <page_number> <fields.json> <input_image> <output_image>
// Draws red (entry) and blue (label) bounding boxes on a page image for visual validation.
import { readFileSync } from 'fs';
import sharp from 'sharp';

const [,, pageArg, fieldsJson, inputImage, outputImage] = process.argv;
if (!pageArg || !fieldsJson || !inputImage || !outputImage) {
  console.error('Usage: create_validation_image.js <page_number> <fields.json> <input_image> <output_image>');
  process.exit(1);
}

const pageNumber = parseInt(pageArg, 10);
const data = JSON.parse(readFileSync(fieldsJson, 'utf8'));
const { width, height } = await sharp(inputImage).metadata();

let svgRects = '';
let numBoxes = 0;

for (const field of data.form_fields) {
  if (field.page_number !== pageNumber) continue;

  const drawRect = (box, color) => {
    const [x0, y0, x1, y1] = box;
    svgRects += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${color}" stroke-width="2"/>`;
    numBoxes++;
  };

  drawRect(field.entry_bounding_box, 'red');
  drawRect(field.label_bounding_box, 'blue');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svgRects}</svg>`;

await sharp(inputImage)
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .toFile(outputImage);

console.log(`Created validation image at ${outputImage} with ${numBoxes} bounding boxes`);
