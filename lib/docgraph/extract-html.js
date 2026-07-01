// lib/docgraph/extract-html.js
// HTML extractor. Splits on <h1>…<h6> into hierarchical sections, strips
// markup, decodes the common entities. No DOM dependency — regex over clean-ish
// HTML is enough for heading-based sectioning (the brief's Phase 3 plan; add
// cheerio only if this proves too blunt). Shared by extract-docx.js, which
// feeds it mammoth's HTML output.
//
// Returns the shared docgraph extractor shape: { title, sections, refs }.
// Offsets are not meaningful after tag-stripping, so sections carry text only.

const HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

const stripTags = (s) =>
  decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

const baseName = (relPath) => relPath.split('/').pop().replace(/\.[^.]+$/, '');

/**
 * Parse an HTML string into docgraph sections. Exposed separately so
 * extract-docx.js can reuse it on mammoth's converted HTML.
 */
export function parseHtml(html, relPath) {
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  const heads = [];
  let m;
  HEADING_RE.lastIndex = 0;
  while ((m = HEADING_RE.exec(cleaned)) !== null) {
    heads.push({ level: Number(m[1]), heading: stripTags(m[2]), start: m.index, contentStart: m.index + m[0].length });
  }

  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch && stripTags(titleMatch[1])) || heads[0]?.heading || baseName(relPath);

  const sections = [];
  let nextLocalId = 1;
  const stack = [];
  const push = ({ level, heading, text, inHierarchy = true }) => {
    let parentLocalId = null;
    if (inHierarchy) {
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      parentLocalId = stack.length ? stack[stack.length - 1].localId : null;
    }
    const localId = nextLocalId++;
    sections.push({ localId, parentLocalId, ord: sections.length, level, heading, text });
    if (inHierarchy) stack.push({ level, localId });
  };

  const firstAt = heads.length ? heads[0].start : cleaned.length;
  const preamble = stripTags(cleaned.slice(0, firstAt));
  if (preamble) push({ level: 0, heading: null, text: preamble, inHierarchy: false });

  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : cleaned.length;
    const body = stripTags(cleaned.slice(heads[i].contentStart, end));
    const text = body ? `${heads[i].heading}\n${body}` : heads[i].heading;
    push({ level: heads[i].level, heading: heads[i].heading, text });
  }

  return { title, sections, refs: [] };
}

export async function extract(input, relPath) {
  const html = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  return parseHtml(html, relPath);
}
