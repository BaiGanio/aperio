/**
 * lib/workers/skills/overlay.js — user overlay skill read/write (var/skills/<name>/SKILL.md).
 */

import { writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, resolve, sep } from "path";

// Skill identity used for the overlay directory name. Kept strict so a user-
// supplied name can never escape the overlay dir (path traversal) or collide
// with shell/FS-special characters.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSkillSlug(name) {
  return typeof name === "string" && name.length <= 64 && SLUG_RE.test(name);
}

/** Absolute path to a skill's overlay SKILL.md, guaranteed to sit inside overlayDir. */
export function overlaySkillPath(overlayDir, name) {
  if (!isValidSkillSlug(name)) throw new Error(`Invalid skill name: ${name}`);
  const dir = resolve(overlayDir, name);
  const root = resolve(overlayDir);
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`Refusing to write outside the overlay dir: ${name}`);
  }
  return join(dir, "SKILL.md");
}

/**
 * Serialize a skill back to SKILL.md text that parseFrontmatter() can read.
 * Description uses folded (>) style so multi-line prose stays valid.
 */
export function assembleSkillMd({ name, description = "", body = "", keywords = "", load = "on-demand" }) {
  const descBlock = description.trim()
    ? `description: >\n${description.trim().split("\n").map(l => `  ${l.trim()}`).join("\n")}\n`
    : `description: ""\n`;
  const meta = [`  load: ${load}`];
  if (keywords.trim()) meta.unshift(`  keywords: ${keywords.trim().replace(/\n+/g, " ")}`);

  return (
    `---\n` +
    `name: ${name}\n` +
    descBlock +
    `metadata:\n${meta.join("\n")}\n` +
    `---\n\n` +
    `${body.replace(/\s+$/, "")}\n`
  );
}

/** Write (or overwrite) a user overlay skill. Returns the file path. */
export function writeOverlaySkill(overlayDir, payload) {
  const filePath = overlaySkillPath(overlayDir, payload.name);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, assembleSkillMd(payload), "utf-8");
  return filePath;
}

/** Remove a user overlay skill dir. Returns true if something was removed. */
export function deleteOverlaySkill(overlayDir, name) {
  const filePath = overlaySkillPath(overlayDir, name);
  const dir = join(filePath, "..");
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
