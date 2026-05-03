// tests/execution.test.js
// Tests for skill execution — loading and invoking skill index.js modules.
// Run: node --test tests/execution.test.js
//
// Each skill that exports `run()` is exercised with a representative input.
// Add an entry to EXECUTION_FIXTURES to cover a new skill — nothing else changes.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

import { loadSkillIndex, matchSkill } from "../../lib/workers/skills.js";

const __dirname  = dirname(fileURLToPath(import.meta.url));
// File lives at tests/skills/execution.test.js — go up twice to reach project root
const ROOT       = resolve(__dirname, "..", "..");
const SKILLS_DIR = resolve(ROOT, "skills");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// Map skill name → sample input used to invoke skill.run(input).
// The test only checks that run() resolves without throwing and returns a
// non-empty string. Add richer assertions in the `extraAssertions` callback.
//
// Shape:
//   [skillName]: {
//     input:            string    — passed to skill.run(input)
//     extraAssertions?: (output: string) => void
//   }

// Add a skill here only once its index.js is ready to execute.
// Skills without index.js should not be listed — the skills.test.js file
// already validates their SKILL.md structure independently.
const EXECUTION_FIXTURES = {
  "reasoning-planning": {
    input: "How would you build a chatbot that learns from user corrections?",
    extraAssertions(output) {
      assert.ok(output.length > 50, "Expected a substantive response from reasoning-planning");
    },
  },
  // "coding-standards": { input: "..." },  // uncomment when index.js is created
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function executeSkill(skill, input) {
  const skillDir    = resolve(skill.path, "..");
  const scriptPath  = resolve(skillDir, "index.js");
  const module      = await import(pathToFileURL(scriptPath).href);

  if (typeof module.run !== "function") {
    throw new Error(`Skill "${skill.name}" missing export: async function run(input)`);
  }

  return module.run(input);
}

// ─── Tests ────────────────────────────────────────────────────────────────────
// Load index once at module level — before() is async and runs too late for
// synchronous describe() bodies that need to call index.find() at definition time.

const index = loadSkillIndex(SKILLS_DIR);

describe("skill matching (integration)", () => {
  test("matchSkill returns null for an unrecognised phrase", () => {
    const result = matchSkill("xyzzy frobnicate quantum banana", index);
    assert.equal(result, null);
  });

  test("matchSkill returns the closest skill for a known phrase", () => {
    const result = matchSkill("reasoning planning for this task", index);
    assert.ok(result, "Expected a match for a phrase containing 'reasoning' and 'planning'");
    assert.equal(result.name, "reasoning-planning");
  });
});

describe("skill execution", () => {
  for (const [skillName, fixture] of Object.entries(EXECUTION_FIXTURES)) {
    describe(skillName, () => {
      const skill      = index.find(s => s.name === skillName);
      const scriptPath = skill ? resolve(skill.path, "..", "index.js") : null;
      const hasIndex   = !!scriptPath && existsSync(scriptPath);

      // test("index.js exists", () => {
      //   assert.ok(skill, `Skill "${skillName}" not found in index`);
      //   assert.ok(hasIndex,
      //     `Missing skills/${skillName}/index.js — create it with: export async function run(input) {}`);
      // });

      test("run(input) resolves and returns a non-empty string", {
        skip: !hasIndex ? `skills/${skillName}/index.js not yet created` : false,
      }, async () => {
        const output = await executeSkill(skill, fixture.input);
        assert.equal(typeof output, "string", "run() must return a string");
        assert.ok(output.trim().length > 0,  "run() returned an empty string");
      });

      if (EXECUTION_FIXTURES[skillName].extraAssertions) {
        test("extra assertions", {
          skip: !hasIndex ? `skills/${skillName}/index.js not yet created` : false,
        }, async () => {
          const output = await executeSkill(skill, fixture.input);
          fixture.extraAssertions(output);
        });
      }
    });
  }
});