/**
 * lib/skills.js — Skill loader for Aperio
 *
 * Scans root/skills/ for SKILL.md files, parses their frontmatter,
 * and picks the best match for a given user message.
 *
 * Usage inside agent.js:
 *   import { loadSkillIndex, matchSkill } from "./skills.js";
 *   const skillIndex = loadSkillIndex(resolve(root, "skills"));
 *   const skill = matchSkill(userMessage, skillIndex);
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

// ─── Frontmatter parser ───────────────────────────────────────────────────────

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("---", 3);
  if (end === -1) return {};

  const fm = content.slice(3, end);
  const result = {};
  for (const line of fm.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

// ─── Recursive SKILL.md finder ────────────────────────────────────────────────

function findSkillFiles(dir) {
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
 * Returns an array of { name, description, path, content }.
 * Safe to call at startup — returns [] if the skills dir doesn't exist yet.
 *
 * @param {string} skillsDir  Absolute path to root/skills/
 */
export function loadSkillIndex(skillsDir) {
  const files = findSkillFiles(skillsDir);
  const index = [];

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      if (fm.name) {
        index.push({
          name:        fm.name,
          description: fm.description ?? "",
          path:        filePath,
          content,
        });
      }
    } catch {
      // skip unreadable skill files silently
    }
  }

  if (index.length > 0) {
    console.log(`📚 Skills loaded: ${index.map(s => s.name).join(", ")}`);
  }

  return index;
}

/**
 * Find the best matching skill for a user message using keyword scoring.
 * Returns the skill object or null if nothing scores above the threshold.
 *
 * @param {string} userMessage
 * @param {Array}  index         Result of loadSkillIndex()
 * @param {number} [threshold]   Min keyword hits to count as a match (default 2)
 */
export function matchSkill(userMessage, index, threshold = 2) {
  if (!index.length) return null;

  const msg = userMessage.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const skill of index) {
    const words = skill.description
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3);   // skip short stop-words

    const score = words.filter(w => msg.includes(w)).length;

    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }

  return bestScore >= threshold ? best : null;
}