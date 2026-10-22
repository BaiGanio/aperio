// lib/docgraph/extract-worker.js
// Worker-thread entry for docgraph extraction. Mirrors
// lib/codegraph/extract-worker.js; see lib/helpers/extractorPool.js for why.
//
// The registry is closed: the main thread sends a key, never a module path.
// Keys match the EXTRACTORS table in lib/docgraph/indexer.js.
//
// Several of these extractors pull in heavyweight parsers (PDF, OOXML). Loading
// them here means the main thread never imports them at all once the worker is
// up, which is the point.

import { parentPort } from 'node:worker_threads';
import { extract as extractMd } from './extract-md.js';
import { extract as extractHtml } from './extract-html.js';
import { extract as extractPdf } from './extract-pdf.js';
import { extract as extractDocx } from './extract-docx.js';
import { extract as extractXlsx } from './extract-xlsx.js';
import { extract as extractPptx } from './extract-pptx.js';
import { extract as extractEml } from './extract-eml.js';

const EXTRACTORS = {
  md: extractMd,
  html: extractHtml,
  pdf: extractPdf,
  docx: extractDocx,
  xlsx: extractXlsx,
  pptx: extractPptx,
  eml: extractEml,
};

// Every docgraph extractor is handed the file's bytes and most call
// `buf.toString('utf8')`. A Buffer does not survive structured clone as a
// Buffer — it arrives as a plain Uint8Array, whose `toString()` returns
// "104,101,108,..." rather than text. A whole corpus indexed that way still
// "succeeds": it just produces one garbage section per document. Re-wrap the
// bytes, sharing the same memory, before any extractor sees them.
const asBuffer = (source) =>
  source instanceof Uint8Array && !Buffer.isBuffer(source)
    ? Buffer.from(source.buffer, source.byteOffset, source.byteLength)
    : source;

parentPort.on('message', async ({ id, key, source, relPath }) => {
  const fn = EXTRACTORS[key];
  if (!fn) {
    parentPort.postMessage({ id, ok: false, error: { message: `unknown extractor key: ${key}`, code: 'EXTRACT_NO_KEY' } });
    return;
  }
  try {
    // { title, sections, refs, summary?, frontmatter? } — plain data.
    parentPort.postMessage({ id, ok: true, result: await fn(asBuffer(source), relPath) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { message: err?.message ?? String(err), code: err?.code } });
  }
});
