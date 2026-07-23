/**
 * lib/agent/turn-planner.js — pure turn analysis (issue #307 Phase 5a, category 1).
 *
 * Extracted from lib/agent/index.js's ensureTurn(): text extraction, slash-skill
 * parsing, keyword tool-profile classification, and skill matching/merging
 * (forced > always-on > keyword > semantic). Deliberately excludes schema-token
 * budget capping (capToolsForProvider) — that stays with tool-profiles.js/index.js
 * since it needs live provider state (contextWindow), not just the turn's text.
 *
 * No closures, no side effects: pendingForcedSkillNames/pendingSemanticSkillNames
 * are consumed by VALUE (the caller in index.js owns resetting its own queues —
 * same "exactly one place owns this state" convention as lib/emitters/handlers/ws/*.js).
 * The "skills_not_found" emit also stays with the caller, which has the emitter.
 */
import { parseSlashSkill, matchSkills, getAlwaysOnSkills } from "../workers/skills.js";
import { isStandaloneVisionRequest } from "../helpers/imageBridge.js";
import {
  SYNTHETIC_USER,
  TOOL_PROFILES,
  HOST_TOOL_PROFILES,
  FIRST_TURN_TOOLS,
  classifyProfiles,
  filterToolsForIntent,
} from "./tool-profiles.js";

export function extractUserText(m) {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.find(b => b.type === "text")?.text ?? "";
  return "";
}

const RECENT_USER_TURNS = 2;
export function recentUserText(messages, userText) {
  const all = messages
    .filter(m => m.role === "user" && !m[SYNTHETIC_USER])
    .map(extractUserText)
    .filter(Boolean);
  const priors = (all.length > 0 && all[all.length - 1] === userText) ? all.slice(0, -1) : all;
  const window = priors.slice(-(RECENT_USER_TURNS - 1));
  return [...window, userText].filter(Boolean).join(" ");
}

/**
 * Plan a turn's uncapped tool names and matched skills from the message text
 * alone. Returns { turnNum, profiles, names, skills, notFound, hasInlineImage,
 * standaloneVision }. `names` is NOT yet capped to a schema-token budget — the
 * caller applies capToolsForProvider() afterward, since that needs the live
 * provider's contextWindow.
 */
export function planTurnTools(messages, userText, {
  turnNum,
  skillIndex,
  shellAllowed,
  pendingForcedSkillNames = [],
  pendingSemanticSkillNames = [],
} = {}) {
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const currentIsSynthetic = !!lastUser?.[SYNTHETIC_USER] && extractUserText(lastUser) === userText;

  // Parse /skill prefix from the raw text before matching — this ensures the
  // slash command itself isn't scored as keyword baggage. The cleaned text
  // (without /skill) is what we match and what the LLM sees.
  const rawText = currentIsSynthetic ? "" : recentUserText(messages, userText);
  const slashResult = parseSlashSkill(rawText, skillIndex);
  const text = currentIsSynthetic ? "" : slashResult.cleanedText;

  // Skill matching intentionally does NOT use the multi-turn window above:
  // skills are a visible, heavy context injection (shown to the user as a
  // skill card), so folding in the prior turn's vocabulary caused stale
  // skills to attach to unrelated follow-ups — e.g. a debugging turn's
  // "crash"/"stack trace" language was still in scope on the next, unrelated
  // "hey, how are you?" and wrongly attached debugging-and-error-recovery.
  // /skill forcing is scoped the same way, since parseSlashSkill only
  // matches a "/skill " prefix at the very start of the string — anchored
  // to the current message, not wherever the window happens to start.
  const currentSlash = currentIsSynthetic ? { forcedNames: [], notFound: [], cleanedText: "" } : parseSlashSkill(userText, skillIndex);
  const skillMatchText = currentIsSynthetic ? "" : currentSlash.cleanedText;

  const profiles = classifyProfiles(text);
  let names = new Set([...profiles].flatMap((p) => [
    ...(TOOL_PROFILES[p] ?? []),
    ...(HOST_TOOL_PROFILES[p] ?? []),
  ]));
  if (turnNum <= 1) for (const n of FIRST_TURN_TOOLS) names.add(n);
  if (!shellAllowed) names.delete("run_shell");
  names = filterToolsForIntent(names, text);
  const alwaysOn = getAlwaysOnSkills(skillIndex);
  const matched  = matchSkills(skillMatchText, skillIndex, { limit: 3 });
  const skills = [];
  const seen = new Set();

  // Forced skills (from /skill prefix or from wsHandler) go first.
  const forcedNames = [...new Set([...pendingForcedSkillNames, ...currentSlash.forcedNames])];
  const notFound = [...currentSlash.notFound];
  for (const name of forcedNames) {
    const skill = skillIndex.find(s => s.name === name);
    if (skill && !seen.has(skill.name)) {
      skills.push(skill);
      seen.add(skill.name);
    } else if (!skill && !notFound.includes(name)) {
      notFound.push(name);
    }
  }

  // Semantic-rescue picks (embedding fallback) behave like keyword matches.
  // They are only ever non-empty when matchSkills found nothing this turn
  // (see runAgentLoop), so they fill the blank rather than override anything.
  const semanticMatched = pendingSemanticSkillNames
    .map(n => skillIndex.find(s => s.name === n))
    .filter(Boolean);
  for (const s of [...alwaysOn, ...matched, ...semanticMatched]) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    skills.push(s);
  }
  for (const s of skills) {
    if (s.content?.includes("`node ")) names.add("run_node_script");
    if (s.content?.includes("`python")) names.add("run_python_script");
  }

  const hasInlineImage = messages.some(m =>
    m.role === "user" && Array.isArray(m.content) &&
    m.content.some(b => b?.type === "image" && b.source?.data),
  );
  const standaloneVision = hasInlineImage && isStandaloneVisionRequest(userText, { hasImage: true });

  return { turnNum, profiles, names, skills, notFound, hasInlineImage, standaloneVision };
}
