// mcp/tools/files/write.js — write_file, append_file, edit_file. Each runs
// directly when the write target and turn don't require confirmation, or
// stashes a proposal for the user via interrupt.js's confirm-before-write flow.

import { existsSync } from "fs";
import fs from "fs/promises";
import { basename, extname } from "path";
import { isWritePathAllowed } from "../../../lib/routes/paths.js";
import { ALLOWED_EXTENSIONS, isSecretFile, formatPathError } from "./helpers.js";
import { performWrite, performAppend, performEdit } from "./perform.js";
import {
  readConfirmToken, commitFileInterrupt, needsWriteConfirm, taintNote,
  proposeWrite, currentTargetDigest,
} from "./interrupt.js";

// Render one side of a diff, capped so the confirm summary stays readable.
function diffLines(text, sign, max = 20) {
  const lines = text.split("\n");
  const shown = lines.slice(0, max).map(l => `${sign} ${l}`);
  const extra = lines.length - max;
  if (extra > 0) shown.push(`${sign} … (${extra} more line${extra > 1 ? "s" : ""})`);
  return shown;
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

  if (!needsWriteConfirm(args)) return performWrite(canonicalArguments);

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

  if (!needsWriteConfirm(args)) return performAppend(canonicalArguments);

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

  // No targetDigest snapshot here (unlike write/append/delete): performEdit
  // reapplies old_string/new_string against the file's live content at
  // execution time, so this doesn't bake a stale full-text replacement that
  // would silently discard an earlier edit confirmed earlier in the same
  // turn (#299).
  const replaced = replace_all ? occurrences : 1;
  const canonicalArguments = { path: filePath, old_string, new_string, replace_all, ext };

  if (!needsWriteConfirm(args)) return performEdit(canonicalArguments);

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
