import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { loadSkillIndex, matchSkill, matchSkills } from "../../../lib/workers/skills.js";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, "..", "..", "..");
const SKILLS_DIR = resolve(ROOT, "skills");

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
  "pdf": {
    matchPhrases: [
      "create a PDF document",
      "extract text from this scanned PDF",
    ],
    noMatchPhrases: [
      "Write a short HTML file that displays Hello Honesty Check in large blue text. Save it and tell me the exact full path.",
    ],
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
      // "When to Use",
      "camelCase",
      "PascalCase",
      "UPPER_SNAKE_CASE",
      "error handling",
      // "✅ Good",
    ],
  },
};

function loadIndex() {
  return loadSkillIndex(SKILLS_DIR);
}

function discoverSkillNames() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(resolve(SKILLS_DIR, d.name, "SKILL.md")))
    .map(d => d.name);
}

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

describe("skill matching", () => {
  const index = loadIndex();

  test("an HTML artifact request loads frontend design guidance, not PDF", () => {
    const prompt = "Write a short HTML file that displays Hello Honesty Check in large blue text. Save it, and tell me the exact full path where I can find it.";
    const names = matchSkills(prompt, index, { limit: 3 }).map(skill => skill.name);
    assert.equal(names[0], "frontend-design");
  });

  test("a simple Markdown file write does not inject unrelated bundled skills", () => {
    const prompt = "Create a new file called notes-for-me.md and write a short note inside it: Reminder — review the Lie Catcher results on Friday. Save it and confirm the file path.";
    assert.deepEqual(matchSkills(prompt, index), []);
  });

  test("an Aperio presentation request loads pptx without memory or handoff", () => {
    const prompt = `Write a PptxGenJS script aperio-title.js that creates aperio-title.pptx with a single title slide:
- Layout: 16x9
- Title: "Aperio — Personal Memory Layer for AI Agents"
- Subtitle: "One brain. Every agent. Nothing forgotten."
- A thin accent line centered below the title
- Background: white

Use require("pptxgenjs") (CommonJS). Save with writeFile. Print the output path to console.`;

    assert.deepEqual(matchSkills(prompt, index).map(skill => skill.name), ["pptx"]);
  });

  test("natural context-rotation requests still load handoff", () => {
    for (const prompt of [
      "compact this conversation",
      "please compact the current conversation",
      "rotate the context",
    ]) {
      assert.ok(
        matchSkills(prompt, index).some(skill => skill.name === "handoff"),
        `Expected handoff to match: ${prompt}`,
      );
    }
  });

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

  // Merged/retired stubs declare `load: never` and must never be injected,
  // even when their name words appear verbatim in the message. Enforced against
  // a synthetic stub appended to the real index (matchSkill takes the index as
  // an argument), so the guard keeps its teeth even when no deprecated skill
  // happens to remain in the repo — plus every real stub currently present.
  test("load: never stubs are never matched", () => {
    const synthetic = {
      name: "retired-stub",
      description: "Merged elsewhere; retired stub placeholder.",
      keywords: "retired, stub, placeholder",
      category: "",
      load: "never",
      dependsOn: null,
      path: "/nonexistent/SKILL.md",
      content: "",
      hasRunner: false,
      source: "bundled",
      overridden: false,
    };
    const index = [...loadIndex(), synthetic];
    const stubs = index.filter(s => s.load === "never");
    for (const stub of stubs) {
      const phrase = stub.name.replace(/-/g, " "); // e.g. "retired stub" — would name-match if not filtered
      const matched = matchSkill(phrase, index);
      assert.notEqual(matched?.name, stub.name,
        `Stub "${stub.name}" (load: never) should not match phrase "${phrase}"`);
    }
  });
});

describe("skill content", () => {
  const index = loadIndex();

  test("pptx creation requires a workspace builder before execution", () => {
    const content = index.find(s => s.name === "pptx")?.content ?? "";
    assert.match(content, /always starts with `write_file`, not `run_node_script`/i);
    assert.match(content, /never create or overwrite files under `skills\/`/i);
  });

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

describe("system_prompt.md", () => {
  const PROMPT_PATH = resolve(ROOT, "id", "whoami.md");

  test("file exists", () => {
    assert.ok(existsSync(PROMPT_PATH), `whoami.md not found at ${PROMPT_PATH}`);
  });

  test("has substantial content (>100 chars)", () => {
    const content = readFileSync(PROMPT_PATH, "utf-8");
    assert.ok(content.trim().length > 100, "whoami.md appears to be empty or too short");
  });

  test("references coding-standards skill", () => {
    const content = readFileSync(PROMPT_PATH, "utf-8");
    assert.ok(content.includes("coding-standards"),
      "whoami.md should delegate to the coding-standards skill, not inline rules");
  });

  test("does not inline naming conventions (clean separation of concerns)", () => {
    const content = readFileSync(PROMPT_PATH, "utf-8");
    const inlined = ["camelCase", "PascalCase", "UPPER_SNAKE_CASE"].filter(t =>
      content.includes(t)
    );
    assert.equal(inlined.length, 0,
      `whoami.md inline naming rules that belong in coding-standards: ${inlined.join(", ")}`);
  });
});
