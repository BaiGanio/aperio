import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillIndex, matchSkill, executeSkill } from "../../lib/skills.js";

const TMP = join(tmpdir(), `aperio-skills-test-${process.pid}`);

before(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

after(async () => {
  await fsPromises.rm(TMP, { recursive: true, force: true });
});

describe("skills.js", () => {
  
  describe("loadSkillIndex", () => {
    test("returns empty array if directory does not exist", () => {
      const result = loadSkillIndex(join(TMP, "ghost-folder"));
      assert.deepEqual(result, []);
    });

    test("recursively finds SKILL.md files and parses frontmatter", () => {
      const skillDir = join(TMP, "skill-a");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(join(skillDir, "SKILL.md"), 
        "---\nname: test-skill\ndescription: A test skill for keyword matching\n---\nBody content"
      );

      const index = loadSkillIndex(TMP);
      assert.strictEqual(index.length, 1);
      assert.strictEqual(index[0].name, "test-skill");
      assert.strictEqual(index[0].description, "A test skill for keyword matching");
    });

    test("skips files without a name in frontmatter", () => {
      const badDir = join(TMP, "bad-skill");
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(join(badDir, "SKILL.md"), "---\ndescription: no name\n---");

      const index = loadSkillIndex(TMP);
      // Should still be 1 from the previous test (if run in same dir) or 0
      assert.ok(!index.find(s => s.description === "no name"));
    });

    test("silently skips unreadable skill files", () => {
      const lockDir = join(TMP, "locked-skill");
      fs.mkdirSync(lockDir, { recursive: true });
      const p = join(lockDir, "SKILL.md");
      fs.writeFileSync(p, "---\nname: locked\n---");
      
      // Make it unreadable
      fs.chmodSync(p, 0o000);

      try {
        const index = loadSkillIndex(TMP);
        assert.ok(!index.find(s => s.name === "locked"));
      } finally {
        // Restore so 'after' hook can delete it
        fs.chmodSync(p, 0o770);
      }
    });

  });

  describe("matchSkill", () => {
    const mockIndex = [
      { name: "web-search", description: "Search the internet for info", metadata: { keywords: "browser google" } },
      { name: "image-gen", description: "Create visual art and pictures", metadata: { keywords: "draw paint" } }
    ];

    test("matches by direct name (hyphenated)", () => {
      const match = matchSkill("Please run a web search", mockIndex);
      assert.strictEqual(match.name, "web-search");
    });

    test("matches by keyword scoring in description", () => {
      // "internet" and "info" are > 3 chars and exist in description
      const match = matchSkill("I need some internet info", mockIndex, 2);
      assert.strictEqual(match.name, "web-search");
    });

    test("handles skills with no metadata property", () => {
      const simpleIndex = [{ name: "simple", description: "Just a description" }];
      const match = matchSkill("description", simpleIndex, 1);
      assert.strictEqual(match.name, "simple");
    });

    test("returns null if score is below threshold", () => {
      const match = matchSkill("just one keyword: internet", mockIndex, 2);
      assert.strictEqual(match, null);
    });

    test("returns null for empty index", () => {
      assert.strictEqual(matchSkill("hello", []), null);
    });
  });

  describe("executeSkill", () => {
    test("successfully executes a skill's run function", async () => {
      const skillDir = join(TMP, "run-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = join(skillDir, "SKILL.md");
      const scriptFile = join(skillDir, "index.js");
      
      fs.writeFileSync(skillFile, "---\nname: run-me\n---");
      fs.writeFileSync(scriptFile, "export async function run(input) { return `Hello ${input}`; }");

      const skill = { name: "run-me", path: skillFile };
      const result = await executeSkill(skill, "World");
      assert.strictEqual(result, "Hello World");
    });

    test("throws error if run function is missing", async (t) => {
      // Mock console.error to keep the test output clean
      const errorMock = t.mock.method(console, 'error', () => {});

      const skillDir = join(TMP, "fail-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = join(skillDir, "SKILL.md");
      fs.writeFileSync(join(skillDir, "index.js"), "export const x = 1;");

      const skill = { name: "fail-skill", path: skillFile };
      
      await assert.rejects(
        executeSkill(skill, "input"), 
        /does not export a run\(\) function/
      );

      // Verify console.error was actually called
      assert.strictEqual(errorMock.mock.callCount(), 1);
    });
  });
});
