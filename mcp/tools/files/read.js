// mcp/tools/files/read.js — read-only file tools: read_file, scan_project,
// grep_files, read_docx.

import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from "fs";
import fs from "fs/promises";
import { join, extname, basename, relative } from "path";
import mammoth from "mammoth";
import { isReadPathAllowed } from "../../../lib/routes/paths.js";
import {
  ALLOWED_EXTENSIONS, isSecretFile, formatPathError,
  READ_FILE_CHUNK_SIZE, READ_FILE_MAX_OFFSET, SKIP_DIRS, KEY_FILES, CODE_EXTS,
} from "./helpers.js";

export async function readFileHandler({ path: filePath, max_lines, offset = 0 }) {
  if (!isReadPathAllowed(filePath))
    return formatPathError("Read", filePath);

  if (isSecretFile(filePath))
    return { content: [{ type: "text", text: `❌ Reading secret/credential files is not allowed: ${basename(filePath)}` }] };

  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext))
    return { content: [{ type: "text", text: `❌ File type not allowed: ${ext}` }] };
  if (!existsSync(filePath))
    return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };

  const stat = statSync(filePath);
  if (stat.size > 500_000)
    return { content: [{ type: "text", text: `❌ File too large (${Math.round(stat.size / 1024)}KB). Max 500KB.` }] };

  const lines     = readFileSync(filePath, "utf-8").split("\n");
  const limit     = Math.min(max_lines ?? READ_FILE_CHUNK_SIZE, READ_FILE_CHUNK_SIZE);
  const start     = Math.min(offset, lines.length, READ_FILE_MAX_OFFSET);
  const end       = start + limit;
  const chunk     = lines.slice(start, end);
  const truncated = end < lines.length;

  return {
    content: [{
      type: "text",
      text: `📄 ${filePath} (${lines.length} lines):\n\n${chunk.join("\n")}${truncated ? `\n\n⚠️ Truncated at line ${end}. Use offset: ${end} to continue.` : ""}`,
    }],
  };
}

// scanProjectHandler is read-only; it only traverses the FS and doesn't
// expose file contents outside of KEY_FILES, so it uses the read guard.
export async function scanProjectHandler({ path: projectPath, read_key_files = true }) {
  if (!isReadPathAllowed(projectPath))
    return formatPathError("Read", projectPath);

  if (!existsSync(projectPath))
    return { content: [{ type: "text", text: `❌ Path not found: ${projectPath}` }] };
  if (!statSync(projectPath).isDirectory())
    return { content: [{ type: "text", text: `❌ Not a directory: ${projectPath}` }] };

  let fileCount = 0;
  const keyFileContents = [];

  function buildTree(dir, depth = 0) {
    if (depth > 3 || fileCount > 50) return "";
    let tree = "";
    let entries;
    try { entries = readdirSync(dir); } catch { return ""; }
    for (const entry of entries.sort()) {
      if (fileCount > 50) { tree += `${"  ".repeat(depth)}...\n`; break; }
      const fullPath = join(dir, entry);
      let s;
      try { s = lstatSync(fullPath); } catch { continue; }
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        tree += `${"  ".repeat(depth)}📁 ${entry}/\n`;
        tree += buildTree(fullPath, depth + 1);
      } else {
        fileCount++;
        const icon = CODE_EXTS.has(extname(entry).toLowerCase()) ? "📄" : "📋";
        tree += `${"  ".repeat(depth)}${icon} ${entry}\n`;
        if (read_key_files && KEY_FILES.has(entry)) {
          try {
            const content = readFileSync(fullPath, "utf-8").split("\n").slice(0, 100).join("\n");
            keyFileContents.push(`\n--- ${entry} ---\n${content}`);
          } catch {}
        }
      }
    }
    return tree;
  }

  const tree = buildTree(projectPath);
  let output = `🗂️ Project: ${basename(projectPath)}\nPath: ${projectPath}\nFiles: ${fileCount}\n\n${tree}`;
  if (keyFileContents.length) output += `\n\n📋 Key files:${keyFileContents.join("\n")}`;
  output += `\n\n💡 Use read_file to dive into specific files.`;

  return { content: [{ type: "text", text: output }] };
}

export async function grepFilesHandler({
  path: searchPath,
  pattern,
  case_sensitive = true,
  max_results = 50,
}) {
  if (typeof pattern !== "string" || !pattern.length)
    return { content: [{ type: "text", text: "❌ grep_files needs a non-empty pattern." }] };
  if (!isReadPathAllowed(searchPath)) return formatPathError("Read", searchPath);
  if (!existsSync(searchPath))
    return { content: [{ type: "text", text: `❌ Path not found: ${searchPath}` }] };

  const needle = case_sensitive ? pattern : pattern.toLowerCase();
  const limit = Math.max(1, Math.min(Number(max_results) || 50, 200));
  const matches = [];
  let capped = false;
  const rootIsDirectory = statSync(searchPath).isDirectory();

  function searchFile(filePath) {
    if (isSecretFile(filePath) || !ALLOWED_EXTENSIONS.has(extname(filePath).toLowerCase())) return;
    let stat;
    try { stat = statSync(filePath); } catch { return; }
    if (!stat.isFile() || stat.size > 500_000) return;
    let content;
    try { content = readFileSync(filePath, "utf8"); } catch { return; }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const haystack = case_sensitive ? lines[index] : lines[index].toLowerCase();
      if (!haystack.includes(needle)) continue;
      const displayPath = rootIsDirectory
        ? relative(searchPath, filePath)
        : basename(filePath);
      matches.push(`${displayPath}:${index + 1}:${lines[index].slice(0, 300)}`);
      if (matches.length >= limit) { capped = true; return; }
    }
  }

  function walk(entryPath) {
    if (matches.length >= limit) return;
    let stat;
    try { stat = lstatSync(entryPath); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { searchFile(entryPath); return; }
    if (!stat.isDirectory()) return;
    let entries;
    try { entries = readdirSync(entryPath); } catch { return; }
    for (const entry of entries.sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(join(entryPath, entry));
      if (matches.length >= limit) return;
    }
  }

  walk(searchPath);
  if (!matches.length) {
    return { content: [{ type: "text", text: `No matches for "${pattern}" under ${searchPath}.` }] };
  }
  const capNote = capped ? ` (showing first ${limit} matches)` : "";
  return { content: [{ type: "text", text: `🔎 ${matches.length} match${matches.length === 1 ? "" : "es"}${capNote}:\n${matches.join("\n")}` }] };
}

export async function readDocxHandler({ path: filePath }) {
  if (!isReadPathAllowed(filePath))
    return formatPathError("Read", filePath);
  if (!existsSync(filePath))
    return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };
  if (extname(filePath).toLowerCase() !== ".docx")
    return { content: [{ type: "text", text: `❌ read_docx only supports .docx files` }] };

  try {
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.convertToHtml({ buffer });
    const html = result.value?.trim();
    if (!html)
      return { content: [{ type: "text", text: `⚠️ DOCX appears to be empty or image-only: ${filePath}` }] };
    return {
      content: [{
        type: "text",
        text: `📄 ${basename(filePath)} — content with structure preserved (HTML):\n\n${html}`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ read_docx failed: ${err.message}` }] };
  }
}
