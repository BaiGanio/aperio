/**
 * lib/workers/skills/execution.js — skill injection, dependency resolution,
 * slash-command parsing, and executable-skill running.
 */

import { join } from "path";
import logger from "../../helpers/logger.js";

/**
 * Returns all skills whose frontmatter declares `metadata.load: always`.
 * These are foundational skills (e.g. agent-conduct, conversation-lifecycle)
 * that should be injected on every turn regardless of the user's message.
 */
export function getAlwaysOnSkills(index) {
  return (index ?? []).filter(s => s.load === "always");
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
      logger.error(`[skills] Skill "${skill.name}" depends on "${skill.dependsOn}" but it was not found in the index.`);
    }
  }

  return content;
}

/**
 * Parses a skill-forcing prefix from the beginning of a user message.
 * Two forms are supported, both repeatable and mixable:
 *   - "/skill <name1,name2,...>" — explicit; unknown names are stripped and
 *     reported in notFound.
 *   - "/<skill-name>" — direct shorthand; only consumed when the name resolves
 *     against the index, so message text like "/etc/hosts what is this?" is
 *     never eaten.
 * Names are matched against the skill index case-insensitively and with
 * hyphen-to-space normalization.
 *
 * @param {string} text       Raw user message text
 * @param {Array}  skillIndex Result of loadSkillIndex() (only .name is read)
 * @returns {{ forcedNames: string[], notFound: string[], cleanedText: string }}
 *
 * Examples:
 *   "/skill pdf extract this"       → forcedNames:["pdf"], cleanedText:"extract this"
 *   "/skill pdf,docx read both"     → forcedNames:["pdf","docx"], cleanedText:"read both"
 *   "/skill pdf /skill docx read"   → forcedNames:["pdf","docx"], cleanedText:"read"
 *   "/skill nosuch read"            → forcedNames:[], notFound:["nosuch"], cleanedText:"read"
 *   "/coding-examples show a loop"  → forcedNames:["coding-examples"], cleanedText:"show a loop"
 *   "/nosuch show a loop"           → forcedNames:[], cleanedText:"/nosuch show a loop"
 */
export function parseSlashSkill(text, skillIndex = []) {
  if (!text || typeof text !== "string") return { forcedNames: [], notFound: [], cleanedText: text ?? "" };

  const normalize = n => n.toLowerCase().replace(/-/g, " ");
  const resolved = new Map(); // normalized -> original name
  for (const s of skillIndex) resolved.set(normalize(s.name), s.name);

  const forcedNames = [];
  const notFound   = [];
  let cleaned = text.trimStart();

  const SLASH_SKILL_RE = /^\/skill\s+/i;
  // Direct form: "/<name>" followed by whitespace or end of message. The
  // lookahead keeps path-like text ("/etc/hosts") from ever matching.
  const DIRECT_RE = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?=\s|$)/;

  while (true) {
    if (cleaned.match(SLASH_SKILL_RE)) {
      // Strip the leading "/skill " (case-insensitive)
      const afterSlash = cleaned.replace(SLASH_SKILL_RE, "");
      // Take everything up to the next whitespace or comma+whitespace as the name group
      const nameGroupMatch = afterSlash.match(/^([a-zA-Z][a-zA-Z0-9-]*(?:\s*,\s*[a-zA-Z][a-zA-Z0-9-]*)*)/);
      if (!nameGroupMatch) {
        // "/skill" followed by nothing recognizable — strip it and stop
        cleaned = afterSlash.trimStart();
        break;
      }
      const nameGroup = nameGroupMatch[1];
      // Advance cleaned past the name group
      cleaned = afterSlash.slice(nameGroup.length).trimStart();

      // Split on commas, allowing optional whitespace around them
      const names = nameGroup.split(/\s*,\s*/).filter(Boolean);
      for (const rawName of names) {
        const original = resolved.get(normalize(rawName));
        if (original) {
          if (!forcedNames.includes(original)) forcedNames.push(original);
        } else {
          if (!notFound.includes(rawName)) notFound.push(rawName);
        }
      }
      continue;
    }

    const direct = cleaned.match(DIRECT_RE);
    if (direct) {
      const original = resolved.get(normalize(direct[1]));
      if (!original) break; // not a skill — leave the text untouched
      if (!forcedNames.includes(original)) forcedNames.push(original);
      cleaned = cleaned.slice(direct[0].length).trimStart();
      continue;
    }

    break;
  }

  return { forcedNames, notFound, cleanedText: cleaned };
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
