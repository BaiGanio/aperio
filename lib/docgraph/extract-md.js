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
// A leading YAML frontmatter block (`---` … `---`/`...`) is split off before
// the heading scan: it never lands in a section's text, its flat scalar keys
// are returned as `frontmatter` (null when absent), and its `title:` wins
// title derivation. Parsing is a flat hand-parser by design — no YAML dep;
// nested/list values are simply skipped.
//
// Offsets are JS string indices into the original `text` (UTF-16 code units);
// doc_context re-slices the file with the same indexing, so they round-trip.
// refs are deferred to Phase 5 — always [] here.

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FM_DELIM_OPEN_RE = /^---[ \t]*$/;
const FM_DELIM_CLOSE_RE = /^(---|\.\.\.)[ \t]*$/;
const FM_SCALAR_RE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;

export const SUPPORTED_EXTS = new Set(['md', 'mdx', 'markdown', 'rst', 'txt', 'text']);

function deriveTitle(frontmatter, headings, relPath) {
  if (frontmatter?.title) return frontmatter.title;
  const h1 = headings.find((h) => h.level === 1);
  if (h1) return h1.heading;
  if (headings.length) return headings[0].heading;
  return relPath.split('/').pop().replace(/\.[^.]+$/, '');
}

// Split a leading YAML frontmatter block off `text`. Returns
// { frontmatter, bodyStart }: `frontmatter` is a flat object of the block's
// scalar `key: value` lines (quotes stripped, non-scalar lines skipped) or
// null when there is no block; `bodyStart` is the char offset where the body
// begins (0 when there is no block, so offsets stay raw-file indices either
// way). An unclosed opening `---` is not frontmatter — the whole file is body.
function splitFrontmatter(text) {
  const none = { frontmatter: null, bodyStart: 0 };
  const lines = text.split('\n');
  if (!FM_DELIM_OPEN_RE.test(lines[0]?.replace(/\r$/, '') ?? '')) return none;

  const frontmatter = {};
  let offset = lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    offset += lines[i].length + 1;
    if (FM_DELIM_CLOSE_RE.test(line)) {
      return { frontmatter, bodyStart: Math.min(offset, text.length) };
    }
    const m = line.match(FM_SCALAR_RE);
    if (m && m[2]) {
      frontmatter[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return none;
}

export async function extract(input, relPath) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const { frontmatter, bodyStart } = splitFrontmatter(text);
  const lines = text.slice(bodyStart).split('\n');

  // Collect heading positions with their char offsets. Skip headings inside
  // fenced code blocks (``` or ~~~) so code comments don't fracture sections.
  const headings = [];
  let offset = bodyStart;
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

  const title = deriveTitle(frontmatter, headings, relPath);
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

  // Preamble: body content before the first heading (or the whole body when
  // there are none). Starts after any frontmatter block.
  const firstHeadingAt = headings.length ? headings[0].lineStart : text.length;
  if (firstHeadingAt > bodyStart && text.slice(bodyStart, firstHeadingAt).trim()) {
    pushSection({ level: 0, heading: null, startOffset: bodyStart, endOffset: firstHeadingAt, inHierarchy: false });
  }

  for (let i = 0; i < headings.length; i++) {
    const startOffset = headings[i].lineStart;
    const endOffset = i + 1 < headings.length ? headings[i + 1].lineStart : text.length;
    pushSection({ level: headings[i].level, heading: headings[i].heading, startOffset, endOffset });
  }

  return { title, frontmatter, sections, refs: [] };
}
