// tests/skills.test.js
// Structural tests for all skills + system_prompt integrity.
// Run: node --test tests/skills.test.js
//
// Tests are data-driven — adding a new skill folder auto-discovers it.
// Only add an entry to SKILL_FIXTURES when you want to assert specific
// content or matching behaviour for that skill.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { loadSkillIndex, matchSkill } from "../../lib/skills.js";

const __dirname  = dirname(fileURLToPath(import.meta.url));
// File lives at tests/skills/skills.test.js — go up twice to reach project root
const ROOT       = resolve(__dirname, "..", "..");
const SKILLS_DIR = resolve(ROOT, "skills");

// ─── Per-skill fixtures ───────────────────────────────────────────────────────
// Add an entry here when you want to assert on a specific skill's matching
// keywords or required content strings. You do NOT need to touch runAllTests()
// or any loop — the describe blocks below pick these up automatically.
//
// Shape:
//   [skillName]: {
//     matchPhrases:    string[]  — phrases that MUST match this skill
//     noMatchPhrases:  string[]  — phrases that must NOT match this skill
//     requiredContent: string[]  — substrings that must appear in SKILL.md
//   }

// ─── How matchSkill() works (from lib/skills.js) ──────────────────────────────
// 1. NAME MATCH   — every hyphen-split word of the skill name must appear in
//                   the message. e.g. "tool-integration" needs both "tool" AND
//                   "integration" somewhere in the phrase.
// 2. KEYWORD SCORE — description words >3 chars are scored against the message;
//                   threshold is 2 hits. Short or uncommon words won't score.
//
// Write matchPhrases accordingly: use the skill's own hyphen words, or enough
// description keywords to clear the threshold. Do NOT use phrases that rely on
// semantic understanding — the matcher is purely lexical.

const SKILL_FIXTURES = {
  "reasoning-planning": {
    // Name match: "reasoning" + "planning" both present
    matchPhrases:    [
      "reasoning and planning",
      "help me with reasoning planning for this task",
    ],
    // These words don't contain "reasoning" AND "planning" together,
    // and won't score 2 keyword hits against this skill's description
    noMatchPhrases:  ["naming conventions", "tool integration"],
    requiredContent: ["When to Use"],
  },
  "tool-integration": {
    // Name match: "tool" + "integration" both present
    matchPhrases:    [
      "tool integration with external services",
      "how does tool integration work",
    ],
    noMatchPhrases:  [],
    requiredContent: [],
  },
  "memory-learning": {
    // Name match: "memory" + "learning" both present
    matchPhrases:    [
      "memory learning from past sessions",
      "memory and learning system",
    ],
    noMatchPhrases:  [],
    requiredContent: [],
  },
  "coding-standards": {
    // Name match: "coding" + "standards" both present
    matchPhrases:    [
      "coding standards for this project",
      "what are the coding standards here",
    ],
    noMatchPhrases:  ["memory learning", "tool integration"],
    requiredContent: [
      "When to Use",
      "camelCase",
      "PascalCase",
      "UPPER_SNAKE_CASE",
      "error handling",
      "✅ Good",
    ],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadIndex() {
  return loadSkillIndex(SKILLS_DIR);
}

function discoverSkillNames() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

// ─── 1. Discovery ─────────────────────────────────────────────────────────────

describe("skill discovery", () => {
  test("skills directory exists", () => {
    assert.ok(existsSync(SKILLS_DIR), `Expected skills dir at ${SKILLS_DIR}`);
  });

  test("loadSkillIndex returns at least one skill", () => {
    const index = loadIndex();
    assert.ok(index.length > 0, "No skills found — create at least one skill folder");
  });

  test("every discovered folder appears in the loaded index", () => {
    const folderNames = discoverSkillNames();
    const indexNames  = loadIndex().map(s => s.name);
    for (const name of folderNames) {
      assert.ok(indexNames.includes(name), `Skill folder "${name}" not found in index`);
    }
  });
});

// ─── 2. Structural validation (runs for every skill automatically) ────────────

describe("skill structure", () => {
  const index = loadIndex();

  for (const skill of index) {
    describe(skill.name, () => {
      test("has a non-empty name", () => {
        assert.ok(skill.name?.trim().length > 0);
      });

      test("has a description", () => {
        assert.ok(skill.description?.trim().length > 0,
          `Skill "${skill.name}" is missing a description`);
      });

      test("has non-empty content", () => {
        assert.ok(skill.content?.length > 0,
          `Skill "${skill.name}" SKILL.md is empty`);
      });

      test("SKILL.md file exists on disk", () => {
        assert.ok(existsSync(skill.path),
          `SKILL.md not found at ${skill.path}`);
      });
    });
  }
});

// ─── 3. Per-skill fixture tests (only for skills listed in SKILL_FIXTURES) ────

describe("skill matching", () => {
  const index = loadIndex();

  for (const [skillName, fixture] of Object.entries(SKILL_FIXTURES)) {
    describe(skillName, () => {
      for (const phrase of fixture.matchPhrases ?? []) {
        test(`matches: "${phrase}"`, () => {
          const matched = matchSkill(phrase, index);
          assert.ok(matched, `No skill matched for phrase: "${phrase}"`);
          assert.equal(matched.name, skillName,
            `Expected "${skillName}" but got "${matched?.name}" for phrase: "${phrase}"`);
        });
      }

      for (const phrase of fixture.noMatchPhrases ?? []) {
        test(`does NOT match: "${phrase}"`, () => {
          const matched = matchSkill(phrase, index);
          assert.notEqual(matched?.name, skillName,
            `Phrase "${phrase}" should not match "${skillName}"`);
        });
      }
    });
  }
});

describe("skill content", () => {
  const index = loadIndex();

  for (const [skillName, fixture] of Object.entries(SKILL_FIXTURES)) {
    if (!fixture.requiredContent?.length) continue;

    describe(skillName, () => {
      const skill = index.find(s => s.name === skillName);

      test("skill exists in index", () => {
        assert.ok(skill, `Skill "${skillName}" not found — add it or remove its fixture entry`);
      });

      for (const term of fixture.requiredContent) {
        test(`contains: "${term}"`, () => {
          assert.ok(skill, `Skill "${skillName}" not loaded`);
          assert.ok(
            skill.content.toLowerCase().includes(term.toLowerCase()),
            `"${term}" not found in ${skillName}/SKILL.md`,
          );
        });
      }
    });
  }
});

// ─── 4. system_prompt.md integrity ───────────────────────────────────────────

describe("system_prompt.md", () => {
  const PROMPT_PATH = resolve(ROOT, "prompts", "system_prompt.md");

  test("file exists", () => {
    assert.ok(existsSync(PROMPT_PATH), `system_prompt.md not found at ${PROMPT_PATH}`);
  });

  test("has substantial content (>100 chars)", () => {
    const content = readFileSync(PROMPT_PATH, "utf-8");
    assert.ok(content.trim().length > 100, "system_prompt.md appears to be empty or too short");
  });

  test("references coding-standards skill", () => {
    const content = readFileSync(PROMPT_PATH, "utf-8");
    assert.ok(content.includes("coding-standards"),
      "system_prompt.md should delegate to the coding-standards skill, not inline rules");
  });

  test("defines recall tool", () => {
    const content = readFileSync(PROMPT_PATH, "utf-8");
    assert.ok(content.includes("recall"), "recall tool definition missing from system_prompt.md");
  });

  test("defines conversation lifecycle (START and END sections)", () => {
    const content = readFileSync(PROMPT_PATH, "utf-8");
    assert.ok(content.includes("START of every conversation"),
      "Missing 'START of every conversation' section");
    assert.ok(content.includes("END of every conversation"),
      "Missing 'END of every conversation' section");
  });

  test("does not inline naming conventions (clean separation of concerns)", () => {
    const content = readFileSync(PROMPT_PATH, "utf-8");
    const inlined = ["camelCase", "PascalCase", "UPPER_SNAKE_CASE"].filter(t =>
      content.includes(t)
    );
    assert.equal(inlined.length, 0,
      `system_prompt.md inlines naming rules that belong in coding-standards: ${inlined.join(", ")}`);
  });
});