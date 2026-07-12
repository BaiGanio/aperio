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
 *
 * All skills are on-demand — injected only when the user message matches.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, resolve, sep } from "path";
import { createHash } from "crypto";
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
 *   dependsOn:   string,   // from frontmatter metadata.depends-on (skill name)
 *   path:        string,   // absolute path to SKILL.md
 *   content:     string,   // full file content for LLM injection
 *   hasRunner:   boolean,  // true if a sibling index.js exists
 * }
 *
 * @param {string} skillsDir  Absolute path to root/skills/
 */
function loadSkillFile(filePath, source) {
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

// ─── User overlay read/write ──────────────────────────────────────────────────

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

// Generic English function words and skill-doc boilerplate. These carry no
// topical signal, but verbose skill descriptions are full of them, so counting
// them lets unrelated skills clear the match threshold ("read the config file"
// scoring xlsx via "file"). Stripped before scoring. Includes 3-letter words:
// keyword tokens use minLen 3, so phrase glue inside curated keywords
// ("approve THE change", "WHAT did I write") would otherwise count as curated
// hits — satisfying the qualifies gate and matching skills on any message that
// contains "the"/"what". Function words inside keyword phrases are exactly
// what this strips; no skill's match may depend on them.
const SKILL_STOPWORDS = new Set([
  "this", "that", "these", "those", "there", "then", "than", "them", "they",
  "their", "your", "yours", "with", "from", "into", "onto", "while", "will",
  "would", "could", "should", "have", "been", "being", "about", "also", "even",
  "just", "like", "only", "very", "much", "many", "some", "such", "more", "most",
  "each", "used", "using", "user", "want", "wants", "need", "needs", "task",
  "tasks", "skill", "skills", "trigger", "triggers", "deliverable", "primary",
  "especially", "instead", "involved", "involving", "regardless", "whenever",
  "anything", "something", "between", "here", "does", "done", "make", "made",
  "both", "input", "output", "content", "proper", "other", "something",
  "the", "and", "for", "are", "was", "has", "can", "did", "not", "you",
  "all", "any", "but", "how", "who", "why",
  "what", "when", "where", "which", "know", "mean",
]);

// Tokens are matched as whole words against the message (see scoreSkill), not
// as substrings — so "api" no longer matches "therapist" and "data" no longer
// matches "database". Curated keywords keep their short, intentional tokens
// (api, csv, ocr, pdf), while prose descriptions stay at >3 chars to suppress
// stray short words.
function skillTokens(text, minLen) {
  return new Set(
    (text ?? "").toLowerCase().split(/\W+/).filter(w => w.length >= minLen && !SKILL_STOPWORDS.has(w))
  );
}

// Crude suffix fold so inflections of one word count as ONE hit when scoring:
// "write"/"writing" or "test"/"tests"/"testing" are a single topical signal,
// not two — the match threshold means "two independent signals". Strips a
// common verb/plural suffix plus a trailing "e" ("write" and "writing" both
// fold to "writ"). False merges ("caring"/"cars" → "car") only make matching
// stricter, never looser. Folding applies to hit COUNTING only — whether a
// token matches the message is still exact whole-word.
function foldToken(w) {
  const folded = w.replace(/(?:ing|ed|es|s)$/, "").replace(/e$/, "");
  return folded.length >= 3 ? folded : w;
}

/**
 * Score a single skill against the message's word set.
 *
 *   score      — count of DISTINCT (deduped, stopword-filtered, suffix-folded)
 *                tokens from the skill's description + keywords present as
 *                whole words in the message. Deduping stops a skill that
 *                repeats "file"/"spreadsheet" in its description from
 *                out-scoring a genuinely relevant one.
 *   qualifies  — gate: a skill that declares curated keywords must hit at least
 *                one of them; a match coming purely from generic description
 *                prose no longer counts. Skills without keywords keep the legacy
 *                description-only behaviour, so nothing regresses.
 */
function scoreSkill(skill, msgWords) {
  const kwRaw = (skill.keywords ?? "").trim();
  const kwHits = [...skillTokens(kwRaw, 3)].filter(t => msgWords.has(t));
  const descHits = [...skillTokens(skill.description, 4)].filter(t => msgWords.has(t));
  const hits = new Set([...kwHits, ...descHits].map(foldToken));
  return { score: hits.size, qualifies: kwRaw ? kwHits.length > 0 : true };
}

function messageWords(msg) {
  return new Set(msg.split(/\W+/).filter(Boolean));
}

/**
 * Find the best matching skill for a user message.
 *
 * Priority:
 *   1. Direct name match (hyphen/space normalized)
 *   2. Keyword scoring from description + metadata.keywords (see scoreSkill)
 *
 * @param {string} userMessage
 * @param {Array}  index         Result of loadSkillIndex()
 * @param {number} [threshold]   Min keyword hits to count as a match (default 2)
 * @returns {Object|null}        Best matching skill, or null
 */
export function matchSkill(userMessage, index, threshold = 2) {
  if (!index?.length) return null;

  // Merged/retired stubs declare `load: never` and must never be injected.
  index = index.filter(s => s.load !== "never");

  const msg = userMessage.toLowerCase();

  // 1. Direct name match (normalize hyphens to spaces for flexible matching)
  for (const skill of index) {
    const nameWords = skill.name.toLowerCase().replace(/-/g, " ").split(" ");
    if (nameWords.every(word => msg.includes(word))) {
      return skill;
    }
  }

  // 2. Keyword scoring
  const msgWords = messageWords(msg);
  let best = null;
  let bestScore = 0;

  for (const skill of index) {
    const { score, qualifies } = scoreSkill(skill, msgWords);
    if (qualifies && score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }

  return bestScore >= threshold ? best : null;
}

/**
 * Like matchSkill but returns up to `limit` skills whose score meets the
 * threshold, ordered by descending score. A direct name match always wins
 * the first slot. Used when a request legitimately spans multiple domains
 * (e.g. coding-standards + working-with-files).
 *
 * @param {string} userMessage
 * @param {Array}  index
 * @param {Object} [opts]
 * @param {number} [opts.threshold=2]
 * @param {number} [opts.limit=3]
 * @returns {Array} Matched skills, possibly empty.
 */
export function matchSkills(userMessage, index, { threshold = 2, limit = 3 } = {}) {
  if (!index?.length) return [];

  // Merged/retired stubs declare `load: never` and must never be injected.
  index = index.filter(s => s.load !== "never");

  const msg = userMessage.toLowerCase();
  const picked = [];
  const seen = new Set();

  // 1. Direct name matches first (preserve insertion order).
  for (const skill of index) {
    const nameWords = skill.name.toLowerCase().replace(/-/g, " ").split(" ");
    if (nameWords.every(word => msg.includes(word))) {
      picked.push({ skill, score: Infinity });
      seen.add(skill.name);
    }
  }

  // 2. Keyword scoring for everything else.
  const msgWords = messageWords(msg);
  const scored = [];
  for (const skill of index) {
    if (seen.has(skill.name)) continue;
    const { score, qualifies } = scoreSkill(skill, msgWords);
    if (qualifies && score >= threshold) scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score);

  return [...picked, ...scored].slice(0, limit).map(x => x.skill);
}

// ─── Semantic rescue (embedding fallback) ─────────────────────────────────────
//
// Additive tier used ONLY when the deterministic lexical matcher above returns
// nothing. Kept separate from matchSkills so the lexical path stays synchronous
// and deterministic — autotune's score.mjs measures that tier unchanged, and
// this fallback can only fill a blank turn, never override a keyword match.
//
// Per-provider cosine floors come from skills/autotune/calibrate.mjs:
//   transformers — measured on mxbai-embed-large-v1 (holdout 0.571 → 0.857).
//   voyage       — NOT yet calibrated; run the harness with a key and set
//                  APERIO_SKILL_SEMANTIC_FLOOR (voyage-3 has a different scale).
const PROVIDER_FLOORS = { transformers: 0.54, voyage: 0.5 };

function resolveFloor() {
  const cfg = parseFloat(process.env.APERIO_SKILL_SEMANTIC_FLOOR);
  if (Number.isFinite(cfg)) return cfg;
  const provider = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();
  return PROVIDER_FLOORS[provider] ?? 0.54;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

// Skill vectors are embedded once and cached by content hash for the process
// lifetime, so a SKILL.md edit (new hash) re-embeds automatically and a warm
// process pays only the one message embedding per rescued turn.
const _skillVecCache = new Map(); // `${name}:${sha1(text)}` -> number[]

const skillEmbedText = (skill) => `${skill.description ?? ""} ${skill.keywords ?? ""}`.trim();

/**
 * Embedding-similarity fallback for when matchSkills() returns [].
 * Returns up to `limit` skills whose cosine similarity to the message clears the
 * floor, best first — or [] if embeddings are unavailable or nothing qualifies.
 * Never throws: a missing/failing embedder degrades to no match so the (empty)
 * lexical result simply stands.
 *
 * @param {string} userMessage
 * @param {Array}  index                     Result of loadSkillIndex()
 * @param {Object} opts
 * @param {Function} opts.generateEmbedding  async (text, inputType) => number[]|null
 * @param {number} [opts.floor]              cosine floor (default: per-provider)
 * @param {number} [opts.limit=2]
 */
export async function semanticRescue(userMessage, index, { generateEmbedding, floor = resolveFloor(), limit = 2 } = {}) {
  if (!userMessage || !index?.length || typeof generateEmbedding !== "function") return [];
  const candidates = index.filter(s => s.load !== "never");

  let msgVec;
  try { msgVec = await generateEmbedding(userMessage, "query"); }
  catch (err) { logger.warn(`[skills] semantic rescue: message embed failed: ${err.message}`); return []; }
  if (!Array.isArray(msgVec) || !msgVec.length) return [];

  const scored = [];
  for (const skill of candidates) {
    const text = skillEmbedText(skill);
    if (!text) continue;
    const cacheKey = `${skill.name}:${createHash("sha1").update(text).digest("hex")}`;
    let vec = _skillVecCache.get(cacheKey);
    if (!vec) {
      try { vec = await generateEmbedding(text, "document"); }
      catch { vec = null; }
      if (!Array.isArray(vec) || !vec.length) continue;
      _skillVecCache.set(cacheKey, vec);
    }
    const sim = cosine(msgVec, vec);
    if (sim >= floor) scored.push({ skill, sim });
  }

  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, limit).map(x => x.skill);
}

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
