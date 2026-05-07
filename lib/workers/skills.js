/**
 * lib/skills.js — Skill loader for Aperio
 *
 * Scans root/skills/ for SKILL.md files, parses their frontmatter,
 * and picks the best match for a given user message.
 *
 * Two skill types are supported:
 *   - Prompt skills (SKILL.md only): content is injected into the LLM system prompt
 *   - Executable skills (SKILL.md + index.js): run as code via executeSkill()
 *
 * Usage inside agent.js:
 *   import { loadSkillIndex, matchSkill, injectSkill, executeSkill } from "./skills.js";
 *
 *   const skillIndex = loadSkillIndex(resolve(root, "skills"));
 *
 *   // For prompt-based skills (most skills):
 *   const skill = matchSkill(userMessage, skillIndex);
 *   if (skill) systemPrompt += injectSkill(skill);
 *
 *   // For executable skills (skills with index.js):
 *   const skill = matchSkill(userMessage, skillIndex);
 *   if (skill?.hasRunner) result = await executeSkill(skill, userMessage);
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import logger from "../helpers/logger.js";

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
function parseFrontmatter(content) {
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
 * Returns an array of skill objects ready for matchSkill() and injectSkill().
 * Safe to call at startup — returns [] if the skills dir doesn't exist yet.
 *
 * Each skill object:
 * {
 *   name:        string,   // from frontmatter
 *   description: string,   // from frontmatter
 *   keywords:    string,   // from frontmatter metadata.keywords (flat string)
 *   category:    string,   // from frontmatter metadata.category
 *   load:        string,   // "always" | "on-demand" (default: "on-demand")
 *   dependsOn:   string,   // from frontmatter metadata.depends-on (skill name)
 *   path:        string,   // absolute path to SKILL.md
 *   content:     string,   // full file content for LLM injection
 *   hasRunner:   boolean,  // true if a sibling index.js exists
 * }
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

      if (!fm.name) continue; // skip files without a name — not a valid skill

      const meta = fm.metadata ?? {};

      index.push({
        name:        fm.name,
        description: fm.description ?? "",
        keywords:    meta.keywords   ?? "",
        category:    meta.category   ?? "",
        load:        meta.load       ?? "on-demand",
        dependsOn:   meta["depends-on"] ?? null,
        path:        filePath,
        content,
        hasRunner:   existsSync(join(filePath, "..", "index.js")),
      });
    } catch {
      // skip unreadable skill files silently
    }
  }

  if (index.length > 0) {
    // console.log(`📚 Skills loaded: ${index.map(s => s.name).join(", ")}`);
    logger.info(`📚 Skills loaded: ${index.length}`);
  }

  return index;
}

/**
 * Find the best matching skill for a user message.
 *
 * Priority:
 *   1. Direct name match (hyphen/space normalized)
 *   2. Keyword scoring from description + metadata.keywords
 *
 * Does NOT return skills with load: "always" — those are handled
 * separately by getAlwaysOnSkills() and injected unconditionally.
 *
 * @param {string} userMessage
 * @param {Array}  index         Result of loadSkillIndex()
 * @param {number} [threshold]   Min keyword hits to count as a match (default 2)
 * @returns {Object|null}        Best matching skill, or null
 */
export function matchSkill(userMessage, index, threshold = 2) {
  if (!index?.length) return null;

  const msg = userMessage.toLowerCase();

  // Only match on-demand skills — always-on skills are injected separately
  const onDemand = index.filter(s => s.load !== "always");

  // 1. Direct name match (normalize hyphens to spaces for flexible matching)
  for (const skill of onDemand) {
    const nameWords = skill.name.toLowerCase().replace(/-/g, " ").split(" ");
    if (nameWords.every(word => msg.includes(word))) {
      return skill;
    }
  }

  // 2. Keyword scoring — description + metadata keywords combined
  let best = null;
  let bestScore = 0;

  for (const skill of onDemand) {
    const searchable = `${skill.description} ${skill.keywords}`.toLowerCase();
    const words = searchable.split(/\W+/).filter(w => w.length > 3);
    const score = words.filter(w => msg.includes(w)).length;

    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }

  return bestScore >= threshold ? best : null;
}

/**
 * Returns all skills marked load: "always".
 * Inject these into every system prompt unconditionally.
 *
 * @param {Array} index  Result of loadSkillIndex()
 * @returns {Array}      Skills with load: "always"
 */
export function getAlwaysOnSkills(index) {
  return index.filter(s => s.load === "always");
}

/**
 * Returns the content of a skill ready to inject into a system prompt.
 * If the skill declares a depends-on, the dependency is resolved from the
 * index and prepended automatically.
 *
 * @param {Object} skill   A skill object from loadSkillIndex()
 * @param {Array}  index   Full skill index (for dependency resolution)
 * @returns {string}       Skill content (with dependency prepended if needed)
 */
export function injectSkill(skill, index = []) {
  let content = skill.content;

  if (skill.dependsOn) {
    const dep = index.find(s => s.name === skill.dependsOn);
    if (dep) {
      content = dep.content + "\n\n---\n\n" + content;
    } else {
      logger.warn(`⚠️  Skill "${skill.name}" depends on "${skill.dependsOn}" but it was not found in the index.`);
    }
  }

  return content;
}

/**
 * Executes a skill that has a sibling index.js (hasRunner: true).
 * For prompt-based skills, use injectSkill() instead.
 *
 * @param {Object} skill   A skill object with hasRunner: true
 * @param {string} input   User input to pass to the skill's run() function
 * @returns {Promise<any>} Result of skill execution
 */
export async function executeSkill(skill, input) {
  if (!skill.hasRunner) {
    throw new Error(
      `Skill "${skill.name}" has no index.js runner. Use injectSkill() to inject it as a prompt instead.`
    );
  }

  const scriptPath = join(skill.path, "..", "index.js");

  try {
    const module = await import(`file://${scriptPath}`);

    if (typeof module.run !== "function") {
      throw new Error(`Skill "${skill.name}" does not export a run() function.`);
    }

    logger.info(`🚀 Executing skill: ${skill.name}...`);
    return await module.run(input);
  } catch (error) {
    logger.error(`❌ Execution failed for ${skill.name}:`, error.message);
    throw error;
  }
}