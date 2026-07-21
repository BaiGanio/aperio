// lib/terminal/attachments.js
// Stateless attachment helpers: reading a file off disk into the
// base64/mime shape the WS + agent paths expect, and the shared per-session
// scratch-workspace system directive.

import { existsSync, readFileSync, statSync } from "fs";
import { extname, basename, resolve } from "path";

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function readAttachment(filePath) {
  const abs  = resolve(filePath);
  if (!existsSync(abs)) return { error: `file not found: ${filePath}` };
  const ext    = extname(abs).toLowerCase();
  const name   = basename(abs);
  const data   = readFileSync(abs).toString("base64");
  const sizeKb = Math.round(statSync(abs).size / 1024);
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
