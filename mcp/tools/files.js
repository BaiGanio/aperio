import { z }                                               from "zod";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import fs                                                  from "fs/promises";
import { join, extname, basename }                         from "path";
import {
  isReadPathAllowed,
  isWritePathAllowed,
  ALLOWED_READ_PATHS,
  ALLOWED_WRITE_PATHS,
} from "../../lib/routes/paths.js";

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

function formatPathError(action, filePath, allowedPaths) {
  return { content: [{ type: "text", text: `❌ ${action} not allowed: ${filePath}\nAllowed ${action.toLowerCase()} paths: ${allowedPaths.join(", ")}` }] };
}

export async function readFileHandler({ path: filePath, max_lines, offset = 0 }) {
  if (!isReadPathAllowed(filePath))
    return formatPathError("Read", filePath, ALLOWED_READ_PATHS);

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
  if (!isWritePathAllowed(filePath))
    return formatPathError("Write", filePath, ALLOWED_WRITE_PATHS);

  try {
    const resolved = filePath.replace(/^~/, process.cwd());

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
  if (!isWritePathAllowed(filePath))
    return formatPathError("Write", filePath, ALLOWED_WRITE_PATHS);

  try {
    const resolved = filePath.replace(/^~/, process.cwd());

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
    return formatPathError("Read", projectPath, ALLOWED_READ_PATHS);

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
      try { s = statSync(fullPath); } catch { continue; }
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
}