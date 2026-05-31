import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { loadSkillIndex, matchSkill, executeSkill } from "../../../lib/workers/skills.js";
import { createIsolatedTestDir } from "../../helpers/sandbox.js";

let sandbox;
before(() => { sandbox = createIsolatedTestDir(); });
after(() => sandbox.restore());

describe("skills.js", () => {
  
  describe("loadSkillIndex", () => {
    test("returns empty array if directory does not exist", () => {
      const result = loadSkillIndex(join(sandbox.root, "ghost-folder"));
      assert.deepEqual(result, []);
    });

    test("recursively finds SKILL.md files and parses frontmatter", () => {
      const skillDir = join(sandbox.root, "skill-a");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(join(skillDir, "SKILL.md"), 
        "---\nname: test-skill\ndescription: A test skill for keyword matching\n---\nBody content"
      );

      const index = loadSkillIndex(sandbox.root);
      assert.strictEqual(index.length, 1);
      assert.strictEqual(index[0].name, "test-skill");
      assert.strictEqual(index[0].description, "A test skill for keyword matching");
    });

    test("skips files without a name in frontmatter", () => {
      const badDir = join(sandbox.root, "bad-skill");
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(join(badDir, "SKILL.md"), "---\ndescription: no name\n---");

      const index = loadSkillIndex(sandbox.root);
      // Should still be 1 from the previous test (if run in same dir) or 0
      assert.ok(!index.find(s => s.description === "no name"));
    });

    test("silently skips unreadable skill files", () => {
      const lockDir = join(sandbox.root, "locked-skill");
      fs.mkdirSync(lockDir, { recursive: true });
      const p = join(lockDir, "SKILL.md");
      fs.writeFileSync(p, "---\nname: locked\n---");
      
      // Make it unreadable
      fs.chmodSync(p, 0o000);

      try {
        const index = loadSkillIndex(sandbox.root);
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

    // test("returns null for empty index", () => {
    //   assert.strictEqual(matchSkill("hello", []), null);
    // });
  });

  // describe("executeSkill", () => {
  //   test("successfully executes a skill's run function", async () => {
  //     const skillDir = join(sandbox.root, "run-skill");
  //     fs.mkdirSync(skillDir, { recursive: true });
  //     const skillFile = join(skillDir, "SKILL.md");
  //     const scriptFile = join(skillDir, "index.js");
      
  //     fs.writeFileSync(skillFile, "---\nname: run-me\n---");
  //     fs.writeFileSync(scriptFile, "export async function run(input) { return `Hello ${input}`; }");

  //     const skill = { name: "run-me", path: skillFile };
  //     const result = await executeSkill(skill, "World");
  //     assert.strictEqual(result, "Hello World");
  //   });

  //   test("throws error if run function is missing", async (t) => {
  //     // Mock console.error to keep the test output clean
  //     const errorMock = t.mock.method(console, 'error', () => {});

  //     const skillDir = join(sandbox.root, "fail-skill");
  //     fs.mkdirSync(skillDir, { recursive: true });
  //     const skillFile = join(skillDir, "SKILL.md");
  //     fs.writeFileSync(join(skillDir, "index.js"), "export const x = 1;");

  //     const skill = { name: "fail-skill", path: skillFile };
      
  //     await assert.rejects(
  //       executeSkill(skill, "input"), 
  //       /does not export a run\(\) function/
  //     );

  //     // Verify console.error was actually called
  //     assert.strictEqual(errorMock.mock.callCount(), 1);
  //   });
  // });
});
