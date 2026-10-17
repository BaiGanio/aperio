import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import mammoth from "mammoth";
import JSZip from "jszip";
import sanitizeHtml from "sanitize-html";

import { ArtifactActionError, resolveGeneratedArtifactUrl } from "./artifactActions.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

// A DOCX is a ZIP; the 10 MB check above only bounds the compressed size on
// disk. Mammoth (via its own internal JSZip) will still happily inflate a
// crafted archive's XML/media entries to whatever size the entries declare —
// a classic zip-bomb amplification that can exhaust the server heap or block
// its event loop well before Mammoth ever returns (review round 5, P2). Read
// the archive's central directory ourselves first — this inspects declared
// entry sizes without inflating any entry's data — and refuse anything that
// would expand far past what a real document preview ever needs.
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_ENTRY_COUNT = 2000;

async function assertBoundedDocx(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ArtifactActionError("Document could not be parsed.", 422);
  }
  const entries = Object.values(zip.files).filter(f => !f.dir);
  if (entries.length > MAX_DOCX_ENTRY_COUNT) {
    throw new ArtifactActionError("Document contains too many entries to preview.", 413);
  }
  let total = 0;
  for (const entry of entries) {
    // A well-formed entry always carries this from the central directory
    // (verified against a real generated archive); an entry that somehow
    // doesn't is treated as unbounded and rejected rather than silently
    // skipped, which would defeat the whole check.
    total += entry._data?.uncompressedSize ?? Infinity;
    if (total > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new ArtifactActionError("Document expands beyond the preview size limit.", 413);
    }
  }
}

// Mammoth emits embedded DOCX images as `data:image/...;base64,...` <img src>
// — only raster types here, never `image/svg+xml` (an SVG data URI can carry
// a <script>, and some browsers do execute it in an <img>).
const DATA_IMAGE_SRC_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/]+=*$/i;

const SANITIZE_OPTIONS = {
  allowedTags: [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "sub", "sup",
    "ul", "ol", "li", "blockquote", "pre", "code",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "a", "img",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  transformTags: {
    img: (tagName, attribs) => {
      if (attribs.src?.startsWith("data:") && !DATA_IMAGE_SRC_RE.test(attribs.src)) {
        delete attribs.src;
      }
      return { tagName, attribs };
    },
  },
};

/** Convert a generated DOCX artifact to inert, bounded HTML for browser preview. */
export async function previewDocumentArtifact(url, {
  root = process.cwd(),
  resolveArtifact = resolveGeneratedArtifactUrl,
  convertToHtml = input => mammoth.convertToHtml(input),
  checkDocxBounds = assertBoundedDocx,
} = {}) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(String(url || ""), "http://aperio.local").pathname); }
  catch { throw new ArtifactActionError("Invalid document artifact URL."); }
  if (extname(pathname).toLowerCase() !== ".docx") {
    throw new ArtifactActionError("Only .docx artifacts can be previewed as documents.", 415);
  }

  const path = resolveArtifact(url, root);
  const stats = await stat(path);
  if (stats.size > MAX_FILE_BYTES) {
    throw new ArtifactActionError("Document is too large to preview (10 MB maximum).", 413);
  }

  try {
    const buffer = await readFile(path);
    await checkDocxBounds(buffer);
    const result = await convertToHtml({ buffer });
    return {
      path,
      html: sanitizeHtml(result.value || "", SANITIZE_OPTIONS),
      warnings: (result.messages || []).map(message => String(message.message || message)).slice(0, 20),
    };
  } catch (error) {
    if (error instanceof ArtifactActionError) throw error;
    throw new ArtifactActionError("Document could not be parsed.", 422);
  }
}
