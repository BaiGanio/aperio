// lib/terminal/attachments.js
// Stateless attachment helpers: reading a file off disk into the
// base64/mime shape the WS + agent paths expect, and the shared per-session
// scratch-workspace system directive.

import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { extname, basename, resolve } from "path";
import { checkAttachmentSize } from "../helpers/attachmentLimits.js";

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Reads one file into the base64/mime shape the WS + agent paths expect.
 *
 * Async and bounded, both deliberately (S2.10). The previous version called
 * `readFileSync(abs).toString("base64")` with no size check at all, so it held
 * the raw buffer and the ~1.33x base64 string at once and blocked the event
 * loop for the whole read — and it called `statSync` *after* reading, so the
 * one number that could have refused the file was computed too late to help.
 * The size is now taken from `statSync` FIRST and an over-limit file returns
 * before anything is read or encoded. The limit itself is shared with the web
 * path via lib/helpers/attachmentLimits.js; there is exactly one budget.
 */
export async function readAttachment(filePath) {
  const abs  = resolve(filePath);
  if (!existsSync(abs)) return { error: `file not found: ${filePath}` };

  const stat = statSync(abs);
  if (stat.isDirectory()) return { error: `not a file: ${filePath}` };

  const name    = basename(abs);
  const verdict = checkAttachmentSize(stat.size, name);
  if (!verdict.ok) return { error: verdict.reason };

  const ext    = extname(abs).toLowerCase();
  const data   = (await readFile(abs)).toString("base64");
  const sizeKb = Math.round(stat.size / 1024);
  const type   = MIME_BY_EXT[ext] ?? "text/plain";
  return { name, data, type, sizeKb, ext };
}

// The per-session scratch-workspace system directive. Shared by the initial
// session and any in-process `restart` so the two never drift.
export function buildWorkspaceDirective(scratchDir) {
  return (
    `## Session workspace\n` +
    `This conversation has a private scratch workspace at:\n\`${scratchDir}\`\n\n` +
    `Write **generated artifacts** here — generator scripts (e.g. pptx/xlsx builder .js), ` +
    `intermediate files, and final output files (pptx, xlsx, etc.). Create the directory if it ` +
    `does not exist. Do NOT write into \`skills/*/scratch/\`. Scripts run as ES modules ` +
    `(the project is \`type: module\`): use \`import x from 'pkg'\`, not \`require()\`. Files here are retained with the ` +
    `session and cleaned up automatically when it expires, so the user can download results meanwhile.\n\n` +
    `For everything else you can work freely: read and edit files anywhere within your allowed ` +
    `folders (the project directory by default, plus any folders the user added in Settings). ` +
    `The scratch workspace is only for generated output — it is not the only place you can write.`
  );
}
