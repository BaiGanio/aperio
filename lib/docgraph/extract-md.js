// lib/docgraph/extract-md.js
// Markdown / plain-text extractor. Returns the shared docgraph extractor shape:
//
//   { title, sections: [{ localId, parentLocalId, ord, level, heading,
//                          startOffset, endOffset, text }],
//     refs: [] }
//
// A "section" is an ATX heading line plus its body up to the next heading of
// any level. Hierarchy (parentLocalId) is derived from heading depth via a
// stack. Content before the first heading becomes an untitled preamble section
// (level 0). Plain-text files (no headings) yield a single whole-file section.
//
// Offsets are JS string indices into the original `text` (UTF-16 code units);
// doc_context re-slices the file with the same indexing, so they round-trip.
// refs are deferred to Phase 5 — always [] here.

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export const SUPPORTED_EXTS = new Set(['md', 'mdx', 'markdown', 'rst', 'txt', 'text']);

function deriveTitle(headings, relPath) {
  const h1 = headings.find((h) => h.level === 1);
  if (h1) return h1.heading;
  if (headings.length) return headings[0].heading;
  return relPath.split('/').pop().replace(/\.[^.]+$/, '');
}

export async function extract(input, relPath) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const lines = text.split('\n');

  // Collect heading positions with their char offsets. Skip headings inside
  // fenced code blocks (``` or ~~~) so code comments don't fracture sections.
  const headings = [];
  let offset = 0;
  let inFence = false;
  let fenceMarker = '';
  for (const line of lines) {
    const fence = line.match(/^[ \t]*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMarker = fence[1][0]; }
      else if (fence[1][0] === fenceMarker) { inFence = false; }
    } else if (!inFence) {
      const m = line.match(HEADING_RE);
      if (m) headings.push({ level: m[1].length, heading: m[2].trim(), lineStart: offset });
    }
    offset += line.length + 1; // +1 for the consumed '\n'
  }

  const title = deriveTitle(headings, relPath);
  const sections = [];
  let nextLocalId = 1;
  const stack = []; // [{ level, localId }]

  // `inHierarchy` controls whether the section participates in parent/child
  // nesting. The preamble (leading content before any heading) is recorded but
  // kept out of the stack so it never becomes the parent of a top-level heading.
  const pushSection = ({ level, heading, startOffset, endOffset, inHierarchy = true }) => {
    let parentLocalId = null;
    if (inHierarchy) {
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      parentLocalId = stack.length ? stack[stack.length - 1].localId : null;
    }
    const localId = nextLocalId++;
    sections.push({
      localId,
      parentLocalId,
      ord: sections.length,
      level,
      heading,
      startOffset,
      endOffset,
      text: text.slice(startOffset, endOffset),
    });
    if (inHierarchy) stack.push({ level, localId });
  };

  // Preamble: content before the first heading (or the whole file when there
  // are none).
  const firstHeadingAt = headings.length ? headings[0].lineStart : text.length;
  if (firstHeadingAt > 0 && text.slice(0, firstHeadingAt).trim()) {
    pushSection({ level: 0, heading: null, startOffset: 0, endOffset: firstHeadingAt, inHierarchy: false });
  }

  for (let i = 0; i < headings.length; i++) {
    const startOffset = headings[i].lineStart;
    const endOffset = i + 1 < headings.length ? headings[i + 1].lineStart : text.length;
    pushSection({ level: headings[i].level, heading: headings[i].heading, startOffset, endOffset });
  }

  return { title, sections, refs: [] };
}
