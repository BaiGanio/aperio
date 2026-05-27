import { z }                                               from "zod";
import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from "fs";
import fs                                                  from "fs/promises";
import { join, extname, basename, dirname, resolve as resolvePath } from "path";
import { fileURLToPath }                                   from "url";
import { v4 as uuidv4 }                                   from "uuid";
import ExcelJS                                             from "exceljs";
import {
  isReadPathAllowed,
  isWritePathAllowed,
  getActivePaths,
  getActiveScratchDir,
} from "../../lib/routes/paths.js";

const __filesDirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR    = resolvePath(__filesDirname, "../../var/uploads");

const ALLOWED_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs", ".java",
  ".json", ".yaml", ".yml", ".toml", ".md", ".txt", ".html",
  ".css", ".sql", ".sh", ".env.example",
]);
const READ_FILE_CHUNK_SIZE = 500;
const READ_FILE_MAX_OFFSET = 10_000;

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__", ".venv", "venv"]);
const KEY_FILES = new Set(["package.json", "README.md", "readme.md", "pyproject.toml", "Cargo.toml", "go.mod", "docker-compose.yml"]);
const CODE_EXTS = new Set([".js", ".ts", ".py", ".go", ".rs", ".java", ".jsx", ".tsx"]);

function formatPathError(action, filePath) {
  const active = getActivePaths();
  const paths  = action === "Read" ? active.readPaths : active.writePaths;
  return { content: [{ type: "text", text: `❌ ${action} not allowed: ${filePath}\nAllowed ${action.toLowerCase()} paths: ${paths.join(", ")}` }] };
}

export async function readFileHandler({ path: filePath, max_lines, offset = 0 }) {
  if (!isReadPathAllowed(filePath))
    return formatPathError("Read", filePath);

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

export async function writeFileHandler(ctx, { path: filePath, content, create_dirs = true }) {
  const resolved = filePath.replace(/^~/, process.cwd());
  if (!isWritePathAllowed(resolved))
    return formatPathError("Write", resolved);

  try {

    if (create_dirs) {
      const dir = resolved.substring(0, resolved.lastIndexOf("/"));
      if (dir) await fs.mkdir(dir, { recursive: true });
    }

    let existingSize = null;
    try { existingSize = (await fs.stat(resolved)).size; } catch {}

    await fs.writeFile(resolved, content, "utf8");
    const sizeKb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
    const msg    = existingSize !== null
      ? `✅ Overwrote ${resolved} (${sizeKb} KB, was ${(existingSize / 1024).toFixed(1)} KB)`
      : `✅ Created ${resolved} (${sizeKb} KB)`;

    return { content: [{ type: "text", text: msg }] };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ write_file failed: ${err.message}` }] };
  }
}

export async function appendFileHandler(ctx, { path: filePath, content }) {
  const resolved = filePath.replace(/^~/, process.cwd());
  if (!isWritePathAllowed(resolved))
    return formatPathError("Write", resolved);

  try {

    if (!existsSync(resolved))
      return { content: [{ type: "text", text: `❌ File not found: ${resolved}` }] };

    const before = (await fs.readFile(resolved, "utf8")).split("\n");
    await fs.appendFile(resolved, content, "utf8");
    const after  = (await fs.readFile(resolved, "utf8")).split("\n");
    const tail   = after.slice(-5).join("\n");

    return {
      content: [{ type: "text", text: `✅ Appended to ${resolved}\nWas ${before.length} lines → now ${after.length} lines\n\nLast 5 lines:\n${tail}` }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ append_file failed: ${err.message}` }] };
  }
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

export async function editFileHandler(ctx, { path: filePath, old_string, new_string, replace_all = false }) {
  if (!isWritePathAllowed(filePath))
    return formatPathError("Write", filePath);

  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext))
    return { content: [{ type: "text", text: `❌ File type not allowed: ${ext}` }] };
  if (!existsSync(filePath))
    return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };

  try {
    const original = await fs.readFile(filePath, "utf8");

    const occurrences = original.split(old_string).length - 1;
    if (occurrences === 0)
      return { content: [{ type: "text", text: `❌ old_string not found in ${filePath}` }] };
    if (!replace_all && occurrences > 1)
      return { content: [{ type: "text", text: `❌ old_string matches ${occurrences} times. Provide more context to make it unique, or set replace_all: true.` }] };

    const updated = replace_all
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string);

    await fs.writeFile(filePath, updated, "utf8");

    const linesBefore = original.split("\n").length;
    const linesAfter  = updated.split("\n").length;
    const replaced    = replace_all ? occurrences : 1;
    return {
      content: [{ type: "text", text: `✅ Edited ${filePath} (replaced ${replaced} occurrence${replaced > 1 ? "s" : ""}, ${linesBefore} → ${linesAfter} lines)` }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ edit_file failed: ${err.message}` }] };
  }
}

export async function generateXlsxHandler({ filename, sheets }) {
  try {
    // Write into the session scratch workspace when one is active (so the file
    // is pruned with the session); fall back to var/uploads outside a session
    // context (e.g. CLI). The matching static mount serves each location.
    const scratchDir = getActiveScratchDir();
    const outDir     = scratchDir ?? UPLOADS_DIR;
    const urlBase    = scratchDir ? `/scratch/${basename(scratchDir)}` : "/uploads";
    await fs.mkdir(outDir, { recursive: true });

    const safeName  = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const outName   = `${uuidv4().slice(0, 8)}-${safeName.endsWith(".xlsx") ? safeName : safeName + ".xlsx"}`;
    const outPath   = join(outDir, outName);
    const publicUrl = `${urlBase}/${outName}`;

    const wb = new ExcelJS.Workbook();

    for (const sheet of sheets) {
      const ws = wb.addWorksheet(sheet.name || "Sheet1");

      // Write headers with bold formatting
      if (sheet.headers?.length) {
        const headerRow = ws.addRow(sheet.headers);
        headerRow.eachCell(cell => {
          cell.font = { bold: true };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } };
        });
      }

      // Write data rows; strings starting with "=" become formulas
      for (const row of (sheet.rows ?? [])) {
        const rowValues = row.map(v => {
          if (typeof v === "string" && v.startsWith("=")) return { formula: v.slice(1) };
          return v ?? null;
        });
        ws.addRow(rowValues);
      }

      // Auto-width columns (cap at 40)
      ws.columns.forEach(col => {
        let max = 10;
        col.eachCell?.({ includeEmpty: false }, cell => {
          const len = String(cell.value?.formula ?? cell.value ?? "").length;
          if (len > max) max = len;
        });
        col.width = Math.min(max + 2, 40);
      });
    }

    await wb.xlsx.writeFile(outPath);
    const stat   = await fs.stat(outPath);
    const sizeKb = (stat.size / 1024).toFixed(1);

    return {
      content: [{
        type: "text",
        text: `APERIO_FILE:${JSON.stringify({ filename: safeName.endsWith(".xlsx") ? safeName : safeName + ".xlsx", url: publicUrl, sizeKb })}`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ generate_xlsx failed: ${err.message}` }] };
  }
}

// ─── MCP registration ─────────────────────────────────────────────────────────
// ctx is kept for backward compatibility but path guards are now handled
// directly via the imported validators above.

export function register(server, ctx) {
  server.registerTool(
    "read_file",
    {
      description: "Read a file from disk. Max 500 lines. Only reads code and text files.",
      inputSchema: z.object({
        path:      z.string().describe("Absolute path to the file"),
        max_lines: z.number().min(1).max(READ_FILE_CHUNK_SIZE).optional().describe(`Max lines to read, default ${READ_FILE_CHUNK_SIZE}`),
        offset:    z.number().min(0).max(READ_FILE_MAX_OFFSET).optional().describe("Line number to start reading from, default 0"),
      }),
    },
    readFileHandler
  );

  server.registerTool(
    "write_file",
    {
      description: "Write content to a file on disk. Creates the file if it doesn't exist, overwrites if it does.",
      inputSchema: z.object({
        path:        z.string().describe("Absolute or ~ path to the file to write"),
        content:     z.string().describe("Full content to write to the file"),
        create_dirs: z.boolean().optional().describe("Create parent directories if they don't exist. Default true."),
      }),
    },
    (args) => writeFileHandler(ctx, args)
  );

  server.registerTool(
    "append_file",
    {
      description: "Append content to the end of an existing file without touching the rest.",
      inputSchema: z.object({
        path:    z.string().describe("Absolute path to the file"),
        content: z.string().describe("Content to append (added at the end of the file)"),
      }),
    },
    (args) => appendFileHandler(ctx, args)
  );

  server.registerTool(
    "edit_file",
    {
      description: "Replace an exact string in a file. Fails if old_string appears more than once unless replace_all is true. Use read_file first to confirm the exact text.",
      inputSchema: z.object({
        path:        z.string().describe("Absolute path to the file"),
        old_string:  z.string().describe("Exact text to find (must be unique in the file unless replace_all is true)"),
        new_string:  z.string().describe("Text to replace it with"),
        replace_all: z.boolean().optional().describe("Replace every occurrence of old_string. Default false."),
      }),
    },
    (args) => editFileHandler(ctx, args)
  );

  server.registerTool(
    "scan_project",
    {
      description: "Scan a project folder. Returns file tree + reads key files. Skips node_modules, .git, build folders.",
      inputSchema: z.object({
        path:           z.string().describe("Absolute path to the project root"),
        read_key_files: z.boolean().optional().describe("Read key file contents, default true"),
      }),
    },
    scanProjectHandler
  );

  server.registerTool(
    "generate_xlsx",
    {
      description: "Generate a .xlsx Excel file and make it available for download. Use this whenever the user asks to create a spreadsheet, budget, table, or any Excel file. Strings starting with '=' in rows are treated as Excel formulas.",
      inputSchema: z.object({
        filename: z.string().describe("Output filename, e.g. 'budget_2024.xlsx'"),
        sheets: z.array(
          z.object({
            name:    z.string().describe("Sheet tab name"),
            headers: z.array(z.string()).describe("Column header labels (first row, bold)"),
            rows:    z.array(
              z.array(z.union([z.string(), z.number(), z.null()]))
            ).describe("Data rows. Strings starting with '=' are Excel formulas (omit the leading '=', e.g. '=SUM(B2:E2)' → pass '=SUM(B2:E2)')."),
          })
        ).describe("One or more worksheets to include in the workbook"),
      }),
    },
    generateXlsxHandler
  );
}