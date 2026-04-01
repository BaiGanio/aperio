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
 * Find the best matching skill for a user message.
 * Priority: 
 * 1. Direct Name Match (including hyphen-to-space normalization)
 * 2. Keyword scoring from description
 *
 * @param {string} userMessage
 * @param {Array}  index         Result of loadSkillIndex()
 * @param {number} [threshold]   Min keyword hits to count as a match (default 2)
 */
export function matchSkill(userMessage, index, threshold = 2) {
  if (!index || !index.length) return null;

  const msg = userMessage.toLowerCase();
  
  // 1. PRIORITY: Direct Name Matching
  for (const skill of index) {
    const nameWords = skill.name.toLowerCase().split('-');
    if (nameWords.every(word => msg.includes(word))) {
      return skill;
    }
  }

  // 2. FALLBACK: Keyword Scoring
  let best = null;      // <--- Must be here
  let bestScore = 0;   // <--- Must be here

  for (const skill of index) {
    // Combine description and metadata for better matching
    const metaWords = skill.metadata?.keywords || "";
    const searchableText = `${skill.description} ${metaWords}`.toLowerCase();

    const words = searchableText
      .split(/\W+/)
      .filter(w => w.length > 3);

    const score = words.filter(w => msg.includes(w)).length;

    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }

  return bestScore >= threshold ? best : null;
}

/**
 * Executes a matched skill by dynamically importing its index.js
 * 
 * @param {Object} skill - The skill object from loadSkillIndex()
 * @param {string} input - User input to pass to the skill
 * @returns {Promise<any>} - Result of the skill execution
 */
export async function executeSkill(skill, input) {
  // skills/skill-name/index.js
  const scriptPath = join(skill.path, '..', 'index.js');

  try {
    // Dynamically import the module using the file path
    const module = await import(`file://${scriptPath}`);
    
    if (typeof module.run !== 'function') {
      throw new Error(`Skill "${skill.name}" does not export a run() function.`);
    }

    console.log(`🚀 Executing skill: ${skill.name}...`);
    return await module.run(input);
  } catch (error) {
    console.error(`❌ Execution failed for ${skill.name}:`, error.message);
    throw error;
  }
}

