import { z }                                               from "zod";
import { createHash }                                      from "crypto";
import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from "fs";
import fs                                                  from "fs/promises";
import { join, extname, basename, dirname, resolve as resolvePath } from "path";
import mammoth                                             from "mammoth";
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
import { createInterruptService } from "../../lib/security/interruptService.js";

const __filesDirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR    = resolvePath(__filesDirname, "../../var/uploads");

const ALLOWED_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs", ".java",
  ".json", ".yaml", ".yml", ".toml", ".md", ".txt", ".html",
  ".css", ".sql", ".sh",
]);

// Secret/dotfile deny-list, checked BEFORE the extension allowlist so env files
// and known credential files (which may carry an otherwise-allowed extension,
// e.g. .env.example) can't be read/edited through it (INPUT-01).
const DENIED_BASENAMES = new Set([
  ".npmrc", ".netrc", ".pgpass", ".htpasswd", ".dockercfg",
  ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const DENIED_EXTENSIONS = new Set([".pem", ".key", ".pfx", ".p12", ".keystore"]);
function isSecretFile(filePath) {
  const base = basename(filePath).toLowerCase();
  if (base.startsWith(".env")) return true;   // .env, .env.local, .env.example, …
  if (DENIED_BASENAMES.has(base)) return true;
  return DENIED_EXTENSIONS.has(extname(base));
}
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

// ─── write/edit/append confirm-before-write (WRITE-01) ──────────────────────
// Mirrors delete_file's two-phase commit. write_file / edit_file / append_file
// run directly for frictionless skill output INTO the session scratch workspace,
// but a write that touches a real location (outside /var/scratch/) OR that
// happens in a turn which already read untrusted content (__tainted, set by the
// agent's tool-hook per INJECT-01) is stashed under a token and surfaced to the
// user for confirmation before it executes.

const WRITE_TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes
const FILE_INTERRUPT_SESSION_ID = "mcp-file-actions";
const fallbackInterruptStore = makeMemoryInterruptStore();

function nowIso() { return new Date().toISOString(); }
function expiresAtFromNow() { return new Date(Date.now() + WRITE_TOKEN_TTL_MS).toISOString(); }
function fileToken(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 8)}`; }

function readConfirmToken(args) {
  return args.confirmation_token ?? args.token ?? args.confirm ?? args.confirmationToken ?? null;
}

// A write needs confirmation when it lands outside the session scratch workspace
// OR the turn is tainted by untrusted content. New/overwrite inside scratch in a
// clean turn runs directly so skill output stays frictionless.
function needsWriteConfirm(resolved, args) {
  const inScratch = resolved.includes("/var/scratch/");
  return !inScratch || args.__tainted === true;
}

function taintNote(args) {
  return args.__tainted === true
    ? ["", "⚠️ This turn read untrusted external content (web page / GitHub issue / file) before this write — confirm it is intended."]
    : [];
}

function digestText(text) {
  return "sha256:" + createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

async function targetDigest(path) {
  try {
    const text = await fs.readFile(path, "utf8");
    return digestText(text);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "EISDIR") return null;
    throw err;
  }
}

async function currentTargetDigest(path) {
  return existsSync(path) ? targetDigest(path) : null;
}

function textOut(text) {
  return { content: [{ type: "text", text }] };
}

function makeMemoryInterruptStore() {
  const rows = new Map();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const get = id => clone(rows.get(id) ?? null);
  return {
    async createAgentInterrupt(input) {
      const row = {
        id: input.id,
        session_id: input.sessionId ?? null,
        run_id: input.runId ?? null,
        tool_name: input.toolName,
        canonical_arguments: clone(input.canonicalArguments ?? null),
        protected_payload_ref: clone(input.protectedPayloadRef ?? null),
        digest: input.digest,
        allowed_decisions: clone(input.allowedDecisions),
        decision: null,
        decision_payload: null,
        claim_id: null,
        status: "pending",
        created_at: nowIso(),
        updated_at: nowIso(),
        decided_at: null,
        claimed_at: null,
        completed_at: null,
        expires_at: input.expiresAt ?? null,
      };
      rows.set(row.id, row);
      return get(row.id);
    },
    async getAgentInterrupt(id) { return get(id); },
    async listAgentInterrupts({ sessionId, status = "pending" } = {}) {
      return [...rows.values()]
        .filter(row => !sessionId || row.session_id === sessionId)
        .filter(row => !status || row.status === status)
        .map(row => clone(row));
    },
    async updateAgentInterruptStatus(id, status) {
      const row = rows.get(id);
      if (!row) return null;
      row.status = status;
      row.updated_at = nowIso();
      return get(id);
    },
    async expireAgentInterrupts(now = nowIso()) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.status === "pending" && row.expires_at && row.expires_at <= now) {
          row.status = "expired";
          row.updated_at = now;
          count++;
        }
      }
      return count;
    },
    async decideAgentInterrupt(id, { decision, status, decisionPayload = null, now = nowIso() }) {
      const row = rows.get(id);
      if (!row || row.status !== "pending" || (row.expires_at && row.expires_at <= now)) return null;
      row.decision = decision;
      row.decision_payload = clone(decisionPayload);
      row.status = status;
      row.decided_at = now;
      row.updated_at = now;
      return get(id);
    },
    async claimAgentInterrupt(id, { claimId, now = nowIso() }) {
      const row = rows.get(id);
      if (!row || !["approved", "edited"].includes(row.status) || (row.expires_at && row.expires_at <= now)) return null;
      row.status = "claimed";
      row.claim_id = claimId;
      row.claimed_at = now;
      row.updated_at = now;
      return get(id);
    },
    async completeAgentInterrupt(id, { status = "executed", now = nowIso() } = {}) {
      const row = rows.get(id);
      if (!row || row.status !== "claimed") return null;
      row.status = status;
      row.completed_at = now;
      row.updated_at = now;
      return get(id);
    },
  };
}

function interruptStore(ctx) {
  const store = ctx?.store;
  return store?.createAgentInterrupt && store?.decideAgentInterrupt && store?.claimAgentInterrupt
    ? store
    : fallbackInterruptStore;
}

async function revalidateFileInterrupt({ canonicalArguments }) {
  const args = canonicalArguments ?? {};
  if (!isWritePathAllowed(args.path)) throw new Error(`Write not allowed: ${args.path}`);
  if (args.path && isSecretFile(args.path)) throw new Error(`Secret/credential files cannot be modified: ${basename(args.path)}`);
  if (args.ext && !ALLOWED_EXTENSIONS.has(args.ext)) throw new Error(`File type not allowed: ${args.ext}`);
  const current = await currentTargetDigest(args.path);
  if (current !== args.targetDigest) {
    throw new Error(`Target changed since confirmation was requested: ${args.path}`);
  }
  return args;
}

export function fileInterruptService(ctx) {
  return createInterruptService({
    store: interruptStore(ctx),
    revalidate: revalidateFileInterrupt,
    executeTool: executeFileInterrupt,
  });
}

async function executeFileInterrupt(toolName, args) {
  switch (toolName) {
    case "write_file": return performWrite(args);
    case "append_file": return performAppend(args);
    case "edit_file": return performEdit(args);
    case "delete_file": return performDelete(args);
    default: throw new Error(`Unsupported file interrupt tool: ${toolName}`);
  }
}

async function performWrite({ path: resolved, content, create_dirs = true, existedAtProposal = false, existingSize = null }) {
  try {
    if (create_dirs) {
      const dir = resolved.substring(0, resolved.lastIndexOf("/"));
      if (dir) await fs.mkdir(dir, { recursive: true });
    }

    const sizeBefore = existingSize ?? (existedAtProposal ? (await fs.stat(resolved)).size : null);
    await fs.writeFile(resolved, content, "utf8");
    const sizeKb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
    const msg    = sizeBefore !== null
      ? `✅ Overwrote ${resolved} (${sizeKb} KB, was ${(sizeBefore / 1024).toFixed(1)} KB)`
      : `✅ Created ${resolved} (${sizeKb} KB)`;

    return textOut(msg);
  } catch (err) {
    return textOut(`❌ write_file failed: ${err.message}`);
  }
}

async function performAppend({ path: resolved, content }) {
  try {
    const before = (await fs.readFile(resolved, "utf8")).split("\n");
    await fs.appendFile(resolved, content, "utf8");
    const after  = (await fs.readFile(resolved, "utf8")).split("\n");
    const tail   = after.slice(-5).join("\n");

    return textOut(`✅ Appended to ${resolved}\nWas ${before.length} lines → now ${after.length} lines\n\nLast 5 lines:\n${tail}`);
  } catch (err) {
    return textOut(`❌ append_file failed: ${err.message}`);
  }
}

async function performEdit({ path: filePath, updated, replaced, linesBefore, linesAfter }) {
  try {
    await fs.writeFile(filePath, updated, "utf8");
    return textOut(`✅ Edited ${filePath} (replaced ${replaced} occurrence${replaced > 1 ? "s" : ""}, ${linesBefore} → ${linesAfter} lines)`);
  } catch (err) {
    return textOut(`❌ edit_file failed: ${err.message}`);
  }
}

async function performDelete({ path: filePath }) {
  try {
    await fs.rm(filePath, { recursive: true, force: false });
    if (existsSync(filePath)) throw new Error("file still exists after delete");
    return textOut(`✅ Deleted ${filePath}`);
  } catch (err) {
    return textOut(`❌ delete_file failed: ${err.message}`);
  }
}

async function commitFileInterrupt(ctx, token, invalidText) {
  const service = fileInterruptService(ctx);
  try {
    const row = await service.decide(token, { decision: "approve" });
    if (!row || row.status === "expired") return textOut(invalidText);
    const { result } = await service.claimAndExecute(token);
    return result;
  } catch (err) {
    return textOut(`${invalidText} ${err.message}`);
  }
}

export async function decideFileInterrupt(ctx, token, decisionInput = {}) {
  const service = fileInterruptService(ctx);
  const decision = decisionInput.decision;
  if (decision === "approve" || decision === "edit") {
    const row = await service.decide(token, {
      decision,
      editedArguments: decisionInput.editedArguments,
    });
    if (!row || row.status === "expired") return { row, result: textOut("❌ Confirmation token invalid or expired. Nothing was written.") };
    const executed = await service.claimAndExecute(token);
    return { row: executed.interrupt, result: executed.result };
  }
  const row = await service.decide(token, {
    decision,
    response: decisionInput.response,
  });
  return { row, result: null };
}

// Phase 1: persist the write and return a preview whose `Token:` line the agent
// turns into a confirm button (and strips from the model's view).
async function proposeWrite(ctx, { kind, label, summaryLines, canonicalArguments }) {
  const token = fileToken("wr");
  await fileInterruptService(ctx).create({
    id: token,
    sessionId: ctx?.sessionId ?? process.env.APERIO_SESSION_ID ?? FILE_INTERRUPT_SESSION_ID,
    runId: ctx?.runId ?? process.env.APERIO_RUN_ID ?? null,
    toolName: kind,
    canonicalArguments,
    allowedDecisions: ["approve", "edit", "reject", "respond"],
    expiresAt: expiresAtFromNow(),
  });
  return { content: [{ type: "text", text: [
    `⚠️ ${kind} pending your confirmation — nothing has been written yet.`,
    "",
    ...summaryLines,
    "",
    `Action: ${label}`,
    `Token: ${token}`,
  ].join("\n") }] };
}

// Render one side of a diff, capped so the confirm summary stays readable.
function diffLines(text, sign, max = 20) {
  const lines = text.split("\n");
  const shown = lines.slice(0, max).map(l => `${sign} ${l}`);
  const extra = lines.length - max;
  if (extra > 0) shown.push(`${sign} … (${extra} more line${extra > 1 ? "s" : ""})`);
  return shown;
}

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

export async function writeFileHandler(ctx, args) {
  const token = readConfirmToken(args);
  if (token) return commitFileInterrupt(ctx, token, "❌ Confirmation token invalid or expired. Nothing was written.");

  const { path: filePath, content, create_dirs = true } = args;
  const resolved = filePath.replace(/^~/, process.cwd());
  if (!isWritePathAllowed(resolved))
    return formatPathError("Write", resolved);

  const exists = existsSync(resolved);
  let existingSize = null;
  try { existingSize = exists ? (await fs.stat(resolved)).size : null; } catch {}
  const canonicalArguments = {
    path: resolved,
    content,
    create_dirs,
    targetDigest: await currentTargetDigest(resolved),
    existedAtProposal: exists,
    existingSize,
  };

  if (!needsWriteConfirm(resolved, args)) return performWrite(canonicalArguments);

  const sizeKb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
  return proposeWrite(ctx, {
    kind:  "write_file",
    label: `${exists ? "Overwrite" : "Create"} ${basename(resolved)}`,
    summaryLines: [
      `**Target:** ${resolved}`,
      `**Change:** ${exists ? "overwrite existing file" : "create new file"} (${sizeKb} KB)`,
      ...taintNote(args),
    ],
    canonicalArguments,
  });
}

export async function appendFileHandler(ctx, args) {
  const token = readConfirmToken(args);
  if (token) return commitFileInterrupt(ctx, token, "❌ Confirmation token invalid or expired. Nothing was written.");

  const { path: filePath, content } = args;
  const resolved = filePath.replace(/^~/, process.cwd());
  if (!isWritePathAllowed(resolved))
    return formatPathError("Write", resolved);

  if (!existsSync(resolved))
    return { content: [{ type: "text", text: `❌ File not found: ${resolved}` }] };

  const canonicalArguments = {
    path: resolved,
    content,
    targetDigest: await currentTargetDigest(resolved),
  };

  if (!needsWriteConfirm(resolved, args)) return performAppend(canonicalArguments);

  return proposeWrite(ctx, {
    kind:  "append_file",
    label: `Append to ${basename(resolved)}`,
    summaryLines: [
      `**Target:** ${resolved}`,
      `**Change:** append ${Buffer.byteLength(content, "utf8")} bytes to the end`,
      ...taintNote(args),
    ],
    canonicalArguments,
  });
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
  const token = readConfirmToken(args);
  if (token) return commitFileInterrupt(ctx, token, "❌ Confirmation token invalid or expired. Nothing was written.");

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

  if (isSecretFile(filePath))
    return { content: [{ type: "text", text: `❌ Editing secret/credential files is not allowed: ${basename(filePath)}` }] };

  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext))
    return { content: [{ type: "text", text: `❌ File type not allowed: ${ext}` }] };
  if (!existsSync(filePath))
    return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };

  let original;
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (err) {
    return { content: [{ type: "text", text: `❌ edit_file failed: ${err.message}` }] };
  }

  const occurrences = original.split(old_string).length - 1;
  if (occurrences === 0)
    return { content: [{ type: "text", text: `❌ old_string not found in ${filePath}` }] };
  if (!replace_all && occurrences > 1)
    return { content: [{ type: "text", text: `❌ old_string matches ${occurrences} times. Provide more context to make it unique, or set replace_all: true.` }] };

  const updated = replace_all
    ? original.split(old_string).join(new_string)
    : original.replace(old_string, new_string);
  const replaced = replace_all ? occurrences : 1;
  const canonicalArguments = {
    path: filePath,
    updated,
    replaced,
    linesBefore: original.split("\n").length,
    linesAfter: updated.split("\n").length,
    targetDigest: digestText(original),
    ext,
  };

  if (!needsWriteConfirm(filePath, args)) return performEdit(canonicalArguments);

  return proposeWrite(ctx, {
    kind:  "edit_file",
    label: `Edit ${basename(filePath)}`,
    summaryLines: [
      `**Target:** ${filePath}`,
      `**Diff** (${replaced} occurrence${replaced > 1 ? "s" : ""}):`,
      "```diff",
      ...diffLines(old_string, "-"),
      ...diffLines(new_string, "+"),
      "```",
      ...taintNote(args),
    ],
    canonicalArguments,
  });
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

// ─── read_docx ────────────────────────────────────────────────────────────────

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

// ─── delete_file — two-phase commit ───────────────────────────────────────────

const DELETE_TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes

export async function deleteFileHandler(args, ctx = {}) {
  // Normalize token aliases — models frequently use "token", "confirm", etc.
  const confirmation_token =
    args.confirmation_token ?? args.token ?? args.confirm ??
    args.auth_token ?? args.confirmationToken ?? null;

  // Phase 2: commit. The token maps to the path stashed at propose time, so the
  // confirmation needs only the token — the web button click executes this
  // directly on the server, and a terminal user can reply with the token.
  if (confirmation_token) {
    return commitFileInterrupt(ctx, confirmation_token, "❌ Confirmation token invalid or expired. Deletion aborted.");
  }

  // Phase 1: propose.
  const filePath = args.path;
  if (!isWritePathAllowed(filePath))
    return formatPathError("Write", filePath);
  if (!existsSync(filePath))
    return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };

  // If a live token was already issued for this path, re-surface it so the
  // user doesn't have to re-confirm with yet another token.
  const service = fileInterruptService(ctx);
  const pending = await service.list({
    sessionId: ctx?.sessionId ?? process.env.APERIO_SESSION_ID ?? FILE_INTERRUPT_SESSION_ID,
  });
  const existing = pending.find(row =>
    row.tool_name === "delete_file" && row.canonical_arguments?.path === filePath
  );
  if (existing) {
    const expiresAt = existing.expires_at ? new Date(existing.expires_at).getTime() : Date.now() + DELETE_TOKEN_TTL_MS;
      return {
        content: [{
        type: "text",
        text: `⚠️ Deletion pending confirmation\nTarget: ${filePath}\nToken: ${existing.id}\n\nA token was already issued. Confirm with token "${existing.id}". It expires in ${Math.ceil((expiresAt - Date.now()) / 1000)}s.`,
        }],
      };
  }

  const token = fileToken("del");
  await service.create({
    id: token,
    sessionId: ctx?.sessionId ?? process.env.APERIO_SESSION_ID ?? FILE_INTERRUPT_SESSION_ID,
    runId: ctx?.runId ?? process.env.APERIO_RUN_ID ?? null,
    toolName: "delete_file",
    canonicalArguments: {
      path: filePath,
      targetDigest: await currentTargetDigest(filePath),
    },
    allowedDecisions: ["approve", "reject", "respond"],
    expiresAt: new Date(Date.now() + DELETE_TOKEN_TTL_MS).toISOString(),
  });

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
      description: "Write content to a file on disk. Creates the file if it doesn't exist, overwrites if it does. Confirm-before-write: a write outside the session workspace (or after reading untrusted content) is proposed for the user to confirm — just call once and end your turn; do NOT fabricate confirmation_token.",
      inputSchema: z.object({
        path:        z.string().describe("Absolute or ~ path to the file to write"),
        content:     z.string().optional().describe("Full content to write to the file"),
        create_dirs: z.boolean().optional().describe("Create parent directories if they don't exist. Default true."),
        confirmation_token: z.string().optional().describe("RESERVED for the confirm flow — leave empty when proposing."),
      }).passthrough(),
    },
    (args) => writeFileHandler(ctx, args)
  );

  server.registerTool(
    "append_file",
    {
      description: "Append content to the end of an existing file without touching the rest. Content is appended verbatim — include a leading newline (\\n) if you want the content to start on a new line. Confirm-before-write applies as for write_file.",
      inputSchema: z.object({
        path:    z.string().describe("Absolute path to the file"),
        content: z.string().optional().describe("Content to append verbatim. Start with \\n to append on a new line; omit it to continue on the same line."),
        confirmation_token: z.string().optional().describe("RESERVED for the confirm flow — leave empty when proposing."),
      }).passthrough(),
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
    "read_docx",
    {
      description: "Read a .docx file from disk and return its content as HTML with full structure preserved (paragraphs, tables, headings, lists). Use this whenever you need to read or extract data from a Word document — do NOT use unpack.py or read_file for .docx files.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the .docx file"),
      }),
    },
    readDocxHandler
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
    (args) => deleteFileHandler(args, ctx)
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
      description: "Generate a .docx Word document and make it available for download. ONLY use this when the user explicitly asks for a Word document output. Do NOT call this as a side-effect of another task (e.g. converting DOCX→XLSX, reading a file, summarizing). If the user asked for an xlsx or any non-docx format, do NOT also call generate_docx.",
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
