import { z }                                               from "zod";
import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from "fs";
import fs                                                  from "fs/promises";
import { join, extname, basename, dirname, resolve as resolvePath } from "path";
import { fileURLToPath }                                   from "url";
import { v4 as uuidv4 }                                   from "uuid";
import ExcelJS                                             from "exceljs";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, TableRow, TableCell, Table, WidthType,
} from "docx";
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
  const active   = getActivePaths();
  const paths    = action === "Read" ? active.readPaths : active.writePaths;
  const primary  = paths[0] ?? process.cwd();
  const list     = paths.map(p => `  - ${p}`).join("\n");
  // Guess a corrected path: strip any leading prefix that looks like a wrong
  // root alias and re-anchor to the actual primary allowed path.
  // Handles: /aperio/…, /home/user/projects/aperio/…, /project/…, etc.
  const projectName = primary.split("/").pop();
  const projectRe  = new RegExp(`^.*?/${projectName}(?=/|$)`);
  const tail = filePath.replace(projectRe, "")    // strip up to and including /aperio
                        .replace(/^\/project\b/, ""); // /project/… → /…
  const suggested = tail ? `${primary}${tail}` : primary;
  return { content: [{ type: "text", text:
    `❌ ${action} not allowed: ${filePath}\n\n` +
    `CORRECT PATH TO USE: ${suggested}\n\n` +
    `Retry the tool call immediately with the corrected path above. Do NOT ask the user — ` +
    `you already have the information needed to proceed.\n\n` +
    `Allowed ${action.toLowerCase()} paths:\n${list}`
  }] };
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

export async function editFileHandler(ctx, args) {
  const filePath = args.path;
  // Normalize the find/replace text from whatever alias the model used. First
  // string-valued match wins; spaced keys ("old string") are covered too.
  const pick = (...keys) => {
    for (const k of keys) { const v = args[k]; if (typeof v === "string") return v; }
    return undefined;
  };
  const old_string  = pick("old_string", "old", "oldText", "oldStr", "old_str", "old string");
  const new_string  = pick("new_string", "new", "newText", "newStr", "new_str", "new string");
  const replace_all = args.replace_all ?? false;

  if (typeof old_string !== "string" || typeof new_string !== "string")
    return { content: [{ type: "text", text: `❌ edit_file needs "old_string" (text to find) and "new_string" (replacement). Received keys: ${Object.keys(args).filter(k => k !== "path").join(", ") || "none"}.` }] };

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
        text: `APERIO_FILE:${JSON.stringify({ filename: safeName.endsWith(".xlsx") ? safeName : safeName + ".xlsx", url: publicUrl, sizeKb, path: outPath })}`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ generate_xlsx failed: ${err.message}` }] };
  }
}

export async function generateDocxHandler({ filename, sections }) {
  try {
    const scratchDir = getActiveScratchDir();
    const outDir     = scratchDir ?? UPLOADS_DIR;
    const urlBase    = scratchDir ? `/scratch/${basename(scratchDir)}` : "/uploads";
    await fs.mkdir(outDir, { recursive: true });

    const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const outName  = `${uuidv4().slice(0, 8)}-${safeName.endsWith(".docx") ? safeName : safeName + ".docx"}`;
    const outPath  = join(outDir, outName);
    const publicUrl = `${urlBase}/${outName}`;

    const children = [];

    for (const section of sections) {
      if (section.heading) {
        children.push(new Paragraph({
          text:    section.heading,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
        }));
      }
      for (const para of (section.paragraphs ?? [])) {
        if (typeof para === "string") {
          children.push(new Paragraph({ children: [new TextRun(para)], spacing: { after: 120 } }));
        } else if (para.type === "table" && Array.isArray(para.rows)) {
          const tableRows = para.rows.map(row =>
            new TableRow({
              children: row.map(cell =>
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun(String(cell ?? ""))] })],
                  width: { size: Math.floor(9360 / row.length), type: WidthType.DXA },
                })
              ),
            })
          );
          children.push(new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        }
      }
    }

    const doc  = new Document({ sections: [{ children }] });
    const buf  = await Packer.toBuffer(doc);
    await fs.writeFile(outPath, buf);
    const stat   = await fs.stat(outPath);
    const sizeKb = (stat.size / 1024).toFixed(1);

    return {
      content: [{
        type: "text",
        text: `APERIO_FILE:${JSON.stringify({ filename: safeName.endsWith(".docx") ? safeName : safeName + ".docx", url: publicUrl, sizeKb, path: outPath })}`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ generate_docx failed: ${err.message}` }] };
  }
}

// ─── delete_file — two-phase commit ───────────────────────────────────────────

const DELETE_TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes
const pendingDeletes = new Map(); // token → { path, expiresAt }

function pruneExpiredTokens() {
  const now = Date.now();
  for (const [token, entry] of pendingDeletes) {
    if (now >= entry.expiresAt) pendingDeletes.delete(token);
  }
}

function generateDeleteToken() {
  return "del_" + Math.random().toString(36).slice(2, 8);
}

export async function deleteFileHandler(args) {
  // Normalize token aliases — models frequently use "token", "confirm", etc.
  const confirmation_token =
    args.confirmation_token ?? args.token ?? args.confirm ??
    args.auth_token ?? args.confirmationToken ?? null;

  pruneExpiredTokens();

  // Phase 2: commit. The token maps to the path stashed at propose time, so the
  // confirmation needs only the token — the web button click executes this
  // directly on the server, and a terminal user can reply with the token.
  if (confirmation_token) {
    const entry = pendingDeletes.get(confirmation_token);
    if (!entry || Date.now() >= entry.expiresAt) {
      pendingDeletes.delete(confirmation_token);
      return { content: [{ type: "text", text: `❌ Confirmation token invalid or expired. Deletion aborted.` }] };
    }
    pendingDeletes.delete(confirmation_token);

    const filePath = entry.path;
    if (!isWritePathAllowed(filePath))
      return formatPathError("Write", filePath);
    try {
      await fs.unlink(filePath);
      return { content: [{ type: "text", text: `✅ Deleted ${filePath}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ delete_file failed: ${err.message}` }] };
    }
  }

  // Phase 1: propose.
  const filePath = args.path;
  if (!isWritePathAllowed(filePath))
    return formatPathError("Write", filePath);
  if (!existsSync(filePath))
    return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };

  // If a live token was already issued for this path, re-surface it so the
  // user doesn't have to re-confirm with yet another token.
  for (const [existing, entry] of pendingDeletes) {
    if (entry.path === filePath) {
      return {
        content: [{
          type: "text",
          text: `⚠️ Deletion pending confirmation\nTarget: ${filePath}\nToken: ${existing}\n\nA token was already issued. Confirm with token "${existing}". It expires in ${Math.ceil((entry.expiresAt - Date.now()) / 1000)}s.`,
        }],
      };
    }
  }

  const token = generateDeleteToken();
  pendingDeletes.set(token, { path: filePath, expiresAt: Date.now() + DELETE_TOKEN_TTL_MS });

  return {
    content: [{
      type: "text",
      text: `⚠️ Deletion pending confirmation\nTarget: ${filePath}\nToken: ${token}\n\nTo complete this deletion, confirm with token "${token}". This token expires in 2 minutes.`,
    }],
  };
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
      // old_string/new_string are the canonical params, but weaker models
      // frequently guess `old`/`new`, `oldText`/`newText`, etc. — those used to
      // fail schema validation and trigger a wasteful retry loop. We make the
      // canonical fields optional, declare the common aliases, and .passthrough()
      // any other key so the handler can normalize whatever the model sent
      // instead of bouncing the call. See editFileHandler.
      inputSchema: z.object({
        path:        z.string().describe("Absolute path to the file"),
        old_string:  z.string().optional().describe("Exact text to find (must be unique in the file unless replace_all is true)"),
        new_string:  z.string().optional().describe("Text to replace it with"),
        old:         z.string().optional().describe("Alias for old_string"),
        new:         z.string().optional().describe("Alias for new_string"),
        oldText:     z.string().optional().describe("Alias for old_string"),
        newText:     z.string().optional().describe("Alias for new_string"),
        replace_all: z.boolean().optional().describe("Replace every occurrence of old_string. Default false."),
      }).passthrough(),
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
    "delete_file",
    {
      description: "Delete a file from disk. Confirm-before-write: call WITHOUT confirmation_token to propose; the user is shown a confirm button (or, in the terminal, a token to reply with) and the deletion runs when they confirm. Do NOT fabricate a token and do NOT call again yourself — just propose, then end your turn. Only pass confirmation_token if the user's own message contains a token like 'del_ab12cd'.",
      inputSchema: z.object({
        path:               z.string().optional().describe("Absolute path to the file to delete (required when proposing)."),
        confirmation_token: z.string().optional().describe("RESERVED for the confirm flow — leave empty when proposing. Only set it if the user's message contains a token."),
        token:              z.string().optional().describe("Alias for confirmation_token"),
        confirm:            z.string().optional().describe("Alias for confirmation_token"),
      }).passthrough(),
    },
    deleteFileHandler
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

  server.registerTool(
    "generate_docx",
    {
      description: "Generate a .docx Word document and make it available for download. Use this whenever the user asks to create a Word document, report, summary, or any .docx file.",
      inputSchema: z.object({
        filename: z.string().describe("Output filename, e.g. 'report.docx'"),
        sections: z.array(
          z.object({
            heading:    z.string().optional().describe("Section heading (rendered as Heading 1)"),
            paragraphs: z.array(
              z.union([
                z.string().describe("Plain text paragraph"),
                z.object({
                  type: z.literal("table"),
                  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).describe("Table rows, each row is an array of cell values"),
                }),
              ])
            ).describe("Paragraph texts or table objects"),
          })
        ).describe("Document sections, each with an optional heading and paragraphs"),
      }),
    },
    generateDocxHandler
  );
}