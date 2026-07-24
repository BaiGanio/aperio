import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { installMemfs } from "../../helpers/memfs.js";

// In-memory fs (zero real disk). Install before importing skills.js so its named
// fs bindings read from the in-RAM map. IMPORTANT: do NOT statically `import
// from "fs"` here — that would create the builtin fs ESM facade before the patch
// and leave skills.js unmocked. Use the patched handle the helper returns.
const mem = installMemfs({ root: "/mem/skills" });
const { loadSkillIndex, matchSkill, matchSkills, semanticRescue, executeSkill, assembleSkillMd, writeOverlaySkill, deleteOverlaySkill, overlaySkillPath, isValidSkillSlug } = await import("../../../lib/workers/skills.js");
after(() => mem.restore());

const fs = mem.fs;
const sandbox = { root: mem.root };

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

    test("does not activate a directly mentioned skill when it is negated", () => {
      const match = matchSkill("Create this in HTML, not PDF", [
        { name: "pdf", description: "PDF processing" },
        { name: "html", description: "HTML frontend" },
      ]);
      assert.strictEqual(match.name, "html");
    });

    test("does not borrow an earlier compound token to bypass name negation", () => {
      const match = matchSkill(
        "canvas-design, not design-randomizer, use theme-factory",
        [{ name: "design-randomizer", description: "Create randomized layouts" }],
      );
      assert.strictEqual(match, null);
    });

    test("recognizes common negative contractions around direct skill names", () => {
      for (const phrase of [
        "Please don't use PDF, use HTML instead",
        "This doesn't need PDF, use HTML instead",
        "We can't use PDF, use HTML instead",
        "I won’t use PDF, use HTML instead",
      ]) {
        const match = matchSkill(phrase, [
          { name: "pdf", description: "PDF processing" },
          { name: "html", description: "HTML frontend" },
        ]);
        assert.strictEqual(match?.name, "html", phrase);
      }
    });

    test("allows a positive mention after an earlier unrelated negation", () => {
      const match = matchSkill("Not PDF; use PDF for the appendix", [
        { name: "pdf", description: "PDF processing" },
      ]);
      assert.strictEqual(match.name, "pdf");
    });

    test("allows a positive mention after an earlier contracted negation", () => {
      const match = matchSkill("Don't use PDF; use PDF for the appendix", [
        { name: "pdf", description: "PDF processing" },
      ]);
      assert.strictEqual(match?.name, "pdf");
    });

    test("matches a directly mentioned skill name in its singular form", () => {
      const match = matchSkill("Extract the text from this PDF", [
        { name: "pdf", description: "PDF processing" },
      ]);
      assert.strictEqual(match?.name, "pdf");
    });

    test("matches a directly mentioned skill name in plural or inflected form", () => {
      for (const [phrase, expected] of [
        ["Extract the text from these PDFs", "pdf"],
        ["Merge the two docxes into one", "docx"],
        ["The builds keep failing on CI", "build"],
        ["We are publishing the release notes", "publish"],
      ]) {
        const match = matchSkill(phrase, [
          { name: "pdf",     description: "PDF processing" },
          { name: "docx",    description: "Word document processing" },
          { name: "build",   description: "Compile the project" },
          { name: "publish", description: "Ship a release" },
        ]);
        assert.strictEqual(match?.name, expected, phrase);
      }
    });

    test("matches a multi-token skill name mentioned in plural form", () => {
      const match = matchSkill("Please run a couple of web searches", mockIndex);
      assert.strictEqual(match?.name, "web-search");
    });

    test("does not activate a plural skill mention when it is negated", () => {
      for (const phrase of [
        "Create this in HTML, not PDFs",
        "Please don't use PDFs, use HTML instead",
        "Build it in HTML without PDFs",
      ]) {
        const match = matchSkill(phrase, [
          { name: "pdf",  description: "PDF processing" },
          { name: "html", description: "HTML frontend" },
        ]);
        assert.strictEqual(match?.name, "html", phrase);
      }
    });

    test("does not borrow a plural compound token to bypass name negation", () => {
      const match = matchSkill(
        "canvas-designs, not design-randomizers, use theme-factory",
        [{ name: "design-randomizer", description: "Create randomized layouts" }],
      );
      assert.strictEqual(match, null);
    });

    test("does not fold short skill names into unrelated words", () => {
      const match = matchSkill("Check the cis boundary conditions", [
        { name: "ci", description: "Continuous integration pipelines" },
      ]);
      assert.strictEqual(match, null);
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

  describe("matchSkills — function-word phrase glue", () => {
    // Regression: keyword tokens use minLen 3, so glue words inside curated
    // keyword phrases ("approve THE change", "WHAT did I write") used to count
    // as curated keyword hits. Two junk hits ("the" + "what") cleared the
    // threshold AND satisfied the qualifies gate, attaching these skills to
    // any off-topic message containing them.
    const glueIndex = [
      { name: "review-like", description: "Use when reviewing a change before it merges — what to look for.", keywords: "code review, approve the change, review the changes" },
      { name: "docs-like", description: "Find content in indexed document folders.", keywords: "what did I write, find the section about, which file mentions" },
    ];

    test("off-topic message full of function words matches nothing", () => {
      const got = matchSkills("You know what I mean? Or are you so sure I can't even read the words?", glueIndex);
      assert.deepEqual(got, []);
    });

    test("genuine keyword hits still match", () => {
      const got = matchSkills("please review the changes in my code", glueIndex);
      assert.strictEqual(got[0]?.name, "review-like");
    });

    // Regression: "write" + "writing" used to count as two distinct hits and
    // clear the threshold on their own — inflections of one word are a single
    // topical signal.
    test("two inflections of one word count as a single hit", () => {
      const idx = [{ name: "tdd-like", description: "Write a failing test first, writing code after.", keywords: "write the failing test, test first" }];
      const got = matchSkills("from where did you came with this response? where I write yo so you are writing me that way?", idx);
      assert.deepEqual(got, []);
    });

    test("ordinary file instructions do not assemble unrelated keyword phrases", () => {
      const idx = [
        {
          name: "docgraph",
          description: "Find, outline, or quote content in indexed document folders containing notes and files.",
          keywords: "find in my notes, where did I write about, what did I write, search my files, which file mentions",
        },
        {
          name: "skill-creator",
          description: "Create new skills and write skill evaluations.",
          keywords: "skill, create skill, new skill, write skill, eval, benchmark",
        },
        {
          name: "code-review-and-quality",
          description: "Review a code change and write useful review comments.",
          keywords: "code review, pull request, review the changes, diff review, review checklist",
        },
      ];
      const prompt = "Create a new file called notes-for-me.md and write a short note inside it: Reminder — review the Lie Catcher results on Friday. Save it and confirm the file path.";

      assert.deepEqual(matchSkills(prompt, idx), []);
    });

    test("generic product and actor vocabulary cannot complete a weak intent match", () => {
      const idx = [{
        name: "memory-like",
        description: "Use the persistent memory store for Aperio agents.",
        keywords: "memory, remember, recall",
        source: "bundled",
      }];

      assert.deepEqual(
        matchSkills("Aperio — Personal Memory Layer for AI Agents. Every agent included.", idx),
        [],
      );
    });

    test("user-authored skills retain product and actor vocabulary", () => {
      const idx = [{
        name: "agent-coordinator",
        description: "Coordinate agents for delegated work.",
        source: "user",
      }];

      assert.deepEqual(
        matchSkills("coordinate agents", idx).map(skill => skill.name),
        ["agent-coordinator"],
      );
    });

    test("does not let a negated direct name consume the skill limit", () => {
      const idx = [
        { name: "canvas-design", description: "Create visual designs" },
        { name: "design-randomizer", description: "Create a design brief" },
        { name: "pdf", description: "Process PDF files" },
        { name: "theme-factory", description: "Style HTML frontend interfaces" },
      ];
      const got = matchSkills(
        "Build HTML with canvas-design, design-randomizer, and theme-factory; not PDF",
        idx,
        { limit: 3 },
      );
      assert.deepEqual(got.map(skill => skill.name), [
        "canvas-design", "design-randomizer", "theme-factory",
      ]);
    });
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

describe("skills.js — user overlay (UI editing)", () => {
  const overlay = join(sandbox.root, "overlay");

  describe("isValidSkillSlug / overlaySkillPath", () => {
    test("accepts kebab-case slugs, rejects traversal and junk", () => {
      assert.equal(isValidSkillSlug("my-skill-1"), true);
      for (const bad of ["../evil", "a/b", "..", "UPPER", "has space", "x".repeat(80), ""]) {
        assert.equal(isValidSkillSlug(bad), false, `should reject ${JSON.stringify(bad)}`);
        assert.throws(() => overlaySkillPath(overlay, bad), `path should reject ${JSON.stringify(bad)}`);
      }
    });
  });

  describe("assembleSkillMd", () => {
    test("round-trips through loadSkillIndex with fields intact", () => {
      writeOverlaySkill(overlay, {
        name: "round-trip", description: "Line one\nLine two",
        keywords: "alpha beta", load: "always", body: "# Heading\n\nThe body.",
      });
      const s = loadSkillIndex(join(sandbox.root, "ghost"), overlay).find(x => x.name === "round-trip");
      assert.equal(s.load, "always");
      assert.equal(s.keywords, "alpha beta");
      assert.equal(s.description, "Line one Line two");   // folded onto one line
      assert.equal(s.source, "user");
      assert.ok(s.content.includes("The body."));
    });
  });

  describe("overlay shadows bundled by name", () => {
    test("a user overlay overrides a same-named bundled skill and is restorable", () => {
      const bundled = join(sandbox.root, "bundled");
      fs.mkdirSync(join(bundled, "greeter"), { recursive: true });
      fs.writeFileSync(join(bundled, "greeter", "SKILL.md"),
        "---\nname: greeter\ndescription: shipped\nmetadata:\n  load: on-demand\n---\nshipped body");

      // before override
      let idx = loadSkillIndex(bundled, overlay);
      let g = idx.find(x => x.name === "greeter");
      assert.equal(g.source, "bundled");
      assert.equal(g.overridden, false);

      // override + disable
      writeOverlaySkill(overlay, { name: "greeter", description: "mine", load: "never", body: "my body" });
      idx = loadSkillIndex(bundled, overlay);
      g = idx.find(x => x.name === "greeter");
      assert.equal(g.source, "user");
      assert.equal(g.overridden, true);
      assert.equal(g.load, "never");
      assert.ok(g.content.includes("my body"));

      // matchSkill never returns a load:never skill
      assert.equal(matchSkill("greeter", idx), null);

      // restore drops the overlay → shipped reappears
      assert.equal(deleteOverlaySkill(overlay, "greeter"), true);
      g = loadSkillIndex(bundled, overlay).find(x => x.name === "greeter");
      assert.equal(g.source, "bundled");
      assert.equal(g.load, "on-demand");
    });
  });

  describe("semanticRescue", () => {
    // Fake embedder: deterministic 2-D unit vectors keyed off a marker word, so
    // cosine similarity to the query [1,0] is exactly controllable — no model.
    const vec = (text) =>
      /alpha/.test(text) ? [1, 0]            // sim 1.00
      : /gamma/.test(text) ? [0.8, 0.6]      // sim 0.80
      : /beta/.test(text) ? [0, 1]           // sim 0.00
      : /trap/.test(text) ? [1, 0]           // sim 1.00 (but load:never — must be skipped)
      : /^QUERY/.test(text) ? [1, 0]         // the message
      : null;
    const embed = async (text) => vec(text);

    const index = [
      { name: "alpha", description: "alpha skill", keywords: "", load: "on-demand" },
      { name: "gamma", description: "gamma skill", keywords: "", load: "on-demand" },
      { name: "beta",  description: "beta skill",  keywords: "", load: "on-demand" },
      { name: "trap",  description: "trap skill",  keywords: "", load: "never" },
    ];
    const names = arr => arr.map(s => s.name);

    test("returns [] when no embedder is supplied", async () => {
      assert.deepEqual(await semanticRescue("QUERY", index, { floor: 0.5 }), []);
    });

    test("returns [] when the message embedding is unavailable", async () => {
      assert.deepEqual(await semanticRescue("nomatch text", index, { generateEmbedding: embed, floor: 0.5 }), []);
    });

    test("ranks by similarity and respects the floor and limit", async () => {
      const got = await semanticRescue("QUERY please", index, { generateEmbedding: embed, floor: 0.5, limit: 2 });
      assert.deepEqual(names(got), ["alpha", "gamma"]); // beta (0.0) excluded, best first
    });

    test("a higher floor admits fewer skills", async () => {
      const got = await semanticRescue("QUERY please", index, { generateEmbedding: embed, floor: 0.9, limit: 5 });
      assert.deepEqual(names(got), ["alpha"]); // gamma (0.8) now below floor
    });

    test("never returns a load:never skill even at similarity 1.0", async () => {
      const got = await semanticRescue("QUERY please", index, { generateEmbedding: embed, floor: 0.5, limit: 5 });
      assert.ok(!names(got).includes("trap"));
    });
  });
});
