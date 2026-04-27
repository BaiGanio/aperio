import path from "path";
import fs from "fs/promises";
import { resolve } from "path";

import { handleImage } from "./handlers/imageHandler.js";
import { handleText  } from "./handlers/textHandler.js";
import { handlePdf   } from "./handlers/pdfHandler.js";

// ─── Extension sets ───────────────────────────────────────────────────────────
// To add DOCX support in the future:
//   1. import { handleDocx } from "./handlers/docxHandler.js";
//   2. Add a DOCX_EXTS set below
//   3. Add one else-if branch in processAttachments()

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown",
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".json", ".yaml", ".yml", ".toml", ".env.example",
  ".html", ".css", ".scss", ".sql", ".sh", ".bash",
  ".csv", ".xml", ".graphql", ".prisma",
]);

const SUPPORTED_LABEL = "images (jpg/png/gif/webp), text files (txt/md/js/ts/py/json/…), PDFs";

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
export async function processAttachments(attachments, __dirname) {
  const uploadDir = resolve(__dirname, "uploads");
  await fs.mkdir(uploadDir, { recursive: true });

  const contentBlocks = [];
  let hint = "";

  for (const att of attachments) {
    const name = path.basename(att.name);
    const ext  = path.extname(name).toLowerCase();

    let result;

    if      (IMAGE_EXTS.has(ext)) result = await handleImage(att, name, uploadDir);
    else if (TEXT_EXTS.has(ext))  result = await handleText(att, name, ext);
    else if (ext === ".pdf")      result = await handlePdf(att, name, uploadDir);
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