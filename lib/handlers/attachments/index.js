import path from "path";
import fs from "fs/promises";
import { resolve } from "path";

import { handleImage } from "./imageHandler.js";
import { handleText  } from "./textHandler.js";
import { handlePdf   } from "./pdfHandler.js";
import { handleDocx  } from "./docxHandler.js";
import { handlePptx  } from "./pptxHandler.js";

// ─── Extension sets ───────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown",
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".json", ".yaml", ".yml", ".toml", ".env.example",
  ".html", ".css", ".scss", ".sql", ".sh", ".bash",
  ".csv", ".xml", ".graphql", ".prisma",
]);

const SUPPORTED_LABEL =
  "images (jpg/png/gif/webp), text files (txt/md/js/ts/py/json/…), PDFs, Word docs (.docx), PowerPoint (.pptx)";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Routes each attachment to the correct handler and merges results.
 * Returns content blocks to append to the message and a hint string
 * to append to the user's text block.
 *
 * @param {object[]} attachments  - Raw attachments array from the WS message
 * @param {string}   __dirname    - Server root (used to resolve the uploads dir)
 * @returns {{ contentBlocks: object[], hint: string }}
 */
export async function processAttachments(attachments, __dirname, {
  _fs = fs,
  _handleImage = handleImage,
  _handleText  = handleText,
  _handlePdf   = handlePdf,
  _handleDocx  = handleDocx,
  _handlePptx  = handlePptx,
} = {}) {
  const uploadDir = resolve(__dirname, "uploads");
  await _fs.mkdir(uploadDir, { recursive: true });

  const contentBlocks = [];
  let hint = "";

  for (const att of attachments) {
    const name = path.basename(att.name);
    const ext  = path.extname(name).toLowerCase();

    let result;

    if (IMAGE_EXTS.has(ext)) result = await _handleImage(att, name, uploadDir);
    else if (TEXT_EXTS.has(ext)) result = await _handleText(att, name, ext);
    else if (ext === ".pdf") result = await _handlePdf(att, name, uploadDir);
    else if (ext === ".docx") result = await _handleDocx(att, name);
    else if (ext === ".pptx") result = await _handlePptx(att, name);
    else {
      console.warn(`⚠️  Unsupported attachment: ${name}`);
      result = {
        blocks: [],
        hint: `\n[System: Attachment received but not supported: ${name} (${ext}). Supported: ${SUPPORTED_LABEL}.]`,
      };
    }

    contentBlocks.push(...result.blocks);
    hint += result.hint;
  }

  return { contentBlocks, hint };
}