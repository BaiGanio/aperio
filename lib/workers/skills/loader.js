/**
 * lib/workers/skills/loader.js — SKILL.md discovery, frontmatter parsing, and index assembly.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import logger from "../../helpers/logger.js";

// ─── Frontmatter parser ───────────────────────────────────────────────────────

/**
 * Parses YAML-style frontmatter including flat keys and one level of
 * nested blocks (e.g. metadata: keywords, category, load, depends-on).
 *
 * Supports:
 *   key: value
 *   key: >
 *     multiline value folded into one string
 *   nested:
 *     child-key: value
 *
 * @param {string} content  Raw file content starting with ---
 * @returns {Object}        Parsed frontmatter as a plain object
 */
export function parseFrontmatter(content) {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("---", 3);
  if (end === -1) return {};

  const lines = content.slice(3, end).split("\n");
  const result = {};
  let currentKey = null;       // top-level key currently being built
  let currentNested = null;    // nested object being built (e.g. result.metadata)
  let foldedKey = null;        // key expecting a folded (>) multiline value
  let foldedLines = [];        // accumulated lines for a folded value

  const flushFolded = () => {
    if (foldedKey !== null) {
      const value = foldedLines.join(" ").trim();
      if (currentNested) {
        currentNested[foldedKey] = value;
      } else {
        result[foldedKey] = value;
      }
      foldedKey = null;
      foldedLines = [];
    }
  };

  for (const rawLine of lines) {
    // Continuation of a folded (>) multiline value — indented line
    if (foldedKey !== null && rawLine.match(/^\s{2,}\S/)) {
      foldedLines.push(rawLine.trim());
      continue;
    } else {
      flushFolded();
    }

    // Skip blank lines and comment lines
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

    const colon = rawLine.indexOf(":");
    if (colon === -1) continue;

    const indent = rawLine.match(/^(\s*)/)[1].length;
    const key   = rawLine.slice(indent, colon).trim();
    const val   = rawLine.slice(colon + 1).trim();

    if (indent === 0) {
      // Top-level key
      currentNested = null;
      currentKey = key;

      if (val === ">") {
        // Start of a folded multiline value
        foldedKey = key;
        foldedLines = [];
      } else if (val === "") {
        // Start of a nested block
        result[key] = {};
        currentNested = result[key];
      } else {
        result[key] = val;
      }
    } else if (indent > 0 && currentNested !== null) {
      // Nested key under a block (e.g. metadata:)
      if (val === ">") {
        foldedKey = key;
        foldedLines = [];
      } else {
        // Strip surrounding quotes if present
        currentNested[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  }

  flushFolded();
  return result;
}

// ─── Recursive SKILL.md finder ────────────────────────────────────────────────

export function findSkillFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSkillFiles(full));
    } else if (entry.name === "SKILL.md") {
      results.push(full);
    }
  }
  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load all skills from a directory.
 * Returns an array of skill objects ready for matchSkill() and injectSkill().
 * Safe to call at startup — returns [] if the skills dir doesn't exist yet.
 *
 * Each skill object:
 * {
 *   name:        string,   // from frontmatter
 *   description: string,   // from frontmatter
 *   keywords:    string,   // from frontmatter metadata.keywords (flat string)
 *   category:    string,   // from frontmatter metadata.category
 *   dependsOn:   string,   // from frontmatter metadata.depends-on (skill name)
 *   path:        string,   // absolute path to SKILL.md
 *   content:     string,   // full file content for LLM injection
 *   hasRunner:   boolean,  // true if a sibling index.js exists
 * }
 *
 * @param {string} skillsDir  Absolute path to root/skills/
 */
export function loadSkillFile(filePath, source) {
  const content = readFileSync(filePath, "utf-8");
  const fm = parseFrontmatter(content);
  if (!fm.name) return null; // skip files without a name — not a valid skill

  const meta = fm.metadata ?? {};
  return {
    name:        fm.name,
    description: fm.description ?? "",
    keywords:    meta.keywords   ?? "",
    category:    meta.category   ?? "",
    load:        meta.load       ?? "on-demand",
    dependsOn:   meta["depends-on"] ?? null,
    path:        filePath,
    content,
    hasRunner:   existsSync(join(filePath, "..", "index.js")),
    source,                 // "bundled" | "agent" | "user"
    overridden:  false,     // set true below when a user overlay shadows a bundled skill
  };
}

/**
 * Load all skills from the bundled skills/ dir, then merge optional
 * agent-specific skills and a user overlay on top.
 *
 * A user overlay (var/skills/<name>/SKILL.md) shadows the bundled skill with the
 * same frontmatter `name`. The shipped tree is never mutated, so app updates stay
 * clean and "reset to default" is just deleting the overlay file. User edits,
 * always-on toggles and disables (load: never) all live as overlay files.
 *
 * @param {string} skillsDir   Absolute path to root/skills/ (shipped skills)
 * @param {string} [overlayDir] Absolute path to the writable user overlay dir
 * @param {string[]} [agentSkillDirs] Absolute paths to bundle-local skill dirs
 */
export function loadSkillIndex(skillsDir, overlayDir, agentSkillDirs = []) {
  const byName = new Map();

  const ingest = (dir, source) => {
    for (const filePath of findSkillFiles(dir)) {
      try {
        const skill = loadSkillFile(filePath, source);
        if (!skill) continue;
        if (source !== "bundled" && byName.has(skill.name)) skill.overridden = true;
        byName.set(skill.name, skill); // overlay (loaded second) wins
      } catch (err) {
        logger.error(`[skills] Failed to load skill at ${filePath}: ${err.message}`);
      }
    }
  };

  ingest(skillsDir, "bundled");
  for (const dir of agentSkillDirs ?? []) ingest(dir, "agent");
  if (overlayDir) ingest(overlayDir, "user");

  const index = [...byName.values()];

  if (index.length > 0) {
    // "indexed" not "loaded": this only reads SKILL.md files into memory. Skills
    // are injected into the prompt on demand (per-turn), so this costs 0 prompt
    // tokens — only the matched + always-on skills are ever sent to the model.
    const overrides = index.filter(s => s.source === "user").length;
    logger.info(`📚 Skills indexed: ${index.length}${overrides ? ` (${overrides} user override${overrides > 1 ? "s" : ""})` : ""} (0 prompt tokens until matched)`);
  }

  return index;
}
