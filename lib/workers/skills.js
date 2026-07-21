/**
 * lib/workers/skills.js — Skill loader for Aperio (barrel)
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
 *
 * All skills are on-demand — injected only when the user message matches.
 *
 * Implementation lives in lib/workers/skills/*: loader (discovery + frontmatter),
 * overlay (user overlay read/write), matching (keyword scoring), semantic
 * (embedding fallback), execution (injection + slash parsing + runners).
 */

export {
  parseFrontmatter,
  findSkillFiles,
  loadSkillFile,
  loadSkillIndex,
} from "./skills/loader.js";

export {
  isValidSkillSlug,
  overlaySkillPath,
  assembleSkillMd,
  writeOverlaySkill,
  deleteOverlaySkill,
} from "./skills/overlay.js";

export {
  matchSkill,
  matchSkills,
} from "./skills/matching.js";

export {
  semanticRescue,
} from "./skills/semantic.js";

export {
  getAlwaysOnSkills,
  injectSkill,
  parseSlashSkill,
  executeSkill,
} from "./skills/execution.js";
