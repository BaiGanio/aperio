// mcp/tools/files/perform.js — the actual disk mutations for write/append/edit/
// delete, run either directly (no confirm needed) or via the interrupt service
// once a proposed write is approved (see interrupt.js's executeFileInterrupt).

import { existsSync } from "fs";
import fs from "fs/promises";
import { textOut } from "./helpers.js";

export async function performWrite({ path: resolved, content, create_dirs = true, existedAtProposal = false, existingSize = null }) {
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

export async function performAppend({ path: resolved, content }) {
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

export async function performEdit({ path: filePath, old_string, new_string, replace_all }) {
  try {
    const original = await fs.readFile(filePath, "utf8");
    const occurrences = original.split(old_string).length - 1;
    if (occurrences === 0)
      return textOut(`❌ old_string not found in ${filePath} — the file changed since this edit was proposed. Re-read it and retry.`);
    if (!replace_all && occurrences > 1)
      return textOut(`❌ old_string matches ${occurrences} times in ${filePath} now — the file changed since this edit was proposed. Re-read it and retry with more context, or set replace_all: true.`);

    const updated = replace_all
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string);
    const replaced = replace_all ? occurrences : 1;
    await fs.writeFile(filePath, updated, "utf8");
    return textOut(`✅ Edited ${filePath} (replaced ${replaced} occurrence${replaced > 1 ? "s" : ""}, ${original.split("\n").length} → ${updated.split("\n").length} lines)`);
  } catch (err) {
    return textOut(`❌ edit_file failed: ${err.message}`);
  }
}

export async function performDelete({ path: filePath }) {
  try {
    await fs.rm(filePath, { recursive: true, force: false });
    if (existsSync(filePath)) throw new Error("file still exists after delete");
    return textOut(`✅ Deleted ${filePath}`);
  } catch (err) {
    return textOut(`❌ delete_file failed: ${err.message}`);
  }
}
