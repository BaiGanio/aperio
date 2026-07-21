// tests/lib/docgraph/extract-md.test.js
// Unit tests for the Markdown/text extractor — headings, hierarchy, preamble,
// fenced-code handling, title derivation. Pure function, no DB.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extract } from "../../lib/docgraph/extract-md.js";

describe("extract-md", () => {
  test("derives title from first H1 and builds heading hierarchy", async () => {
    const md = [
      "# Project Notes",
      "",
      "Intro paragraph.",
      "",
      "## Background",
      "Some background.",
      "",
      "### Detail",
      "A nested detail.",
      "",
      "## Plan",
      "The plan.",
    ].join("\n");

    const { title, sections } = await extract(md, "notes/project.md");
    assert.equal(title, "Project Notes");

    const byHeading = Object.fromEntries(sections.filter(s => s.heading).map(s => [s.heading, s]));
    assert.ok(byHeading["Project Notes"], "has H1 section");
    assert.equal(byHeading["Project Notes"].level, 1);
    assert.equal(byHeading["Background"].level, 2);
    assert.equal(byHeading["Detail"].level, 3);

    // Detail nests under Background; Background and Plan nest under the H1.
    assert.equal(byHeading["Detail"].parentLocalId, byHeading["Background"].localId);
    assert.equal(byHeading["Background"].parentLocalId, byHeading["Project Notes"].localId);
    assert.equal(byHeading["Plan"].parentLocalId, byHeading["Project Notes"].localId);
    assert.equal(byHeading["Project Notes"].parentLocalId, null);
  });

  test("preamble before first heading is a level-0 section with no parent and no children", async () => {
    const md = "Loose intro text.\n\n# Title\nBody.";
    const { sections } = await extract(md, "x.md");
    const preamble = sections.find(s => s.level === 0);
    const h1 = sections.find(s => s.heading === "Title");
    assert.ok(preamble, "preamble exists");
    assert.equal(preamble.heading, null);
    assert.equal(preamble.parentLocalId, null);
    // H1 must NOT be parented to the preamble.
    assert.equal(h1.parentLocalId, null);
  });

  test("ignores ATX headings inside fenced code blocks", async () => {
    const md = [
      "# Real Heading",
      "```",
      "# not a heading",
      "```",
      "## Another Real",
    ].join("\n");
    const { sections } = await extract(md, "x.md");
    const headings = sections.filter(s => s.heading).map(s => s.heading);
    assert.deepEqual(headings, ["Real Heading", "Another Real"]);
  });

  test("plain text with no headings yields one section titled from filename", async () => {
    const { title, sections } = await extract("just some prose here", "folder/my-note.txt");
    assert.equal(title, "my-note");
    assert.equal(sections.length, 1);
    assert.equal(sections[0].level, 0);
    assert.match(sections[0].text, /just some prose/);
  });

  test("section offsets round-trip against the source", async () => {
    const md = "# A\nalpha\n## B\nbeta";
    const { sections } = await extract(md, "x.md");
    for (const s of sections) {
      assert.equal(md.slice(s.startOffset, s.endOffset), s.text);
    }
  });

  describe("frontmatter", () => {
    test("leading frontmatter is stripped from sections and parsed to flat scalars", async () => {
      const md = [
        "---",
        "type: note",
        'title: "Quoted Title"',
        "tags:",
        "  - one",
        "---",
        "Preamble text.",
        "",
        "# Heading",
        "Body.",
      ].join("\n");

      const { title, frontmatter, sections } = await extract(md, "x.md");
      assert.equal(frontmatter.type, "note");
      assert.equal(frontmatter.title, "Quoted Title");
      assert.equal(title, "Quoted Title");
      // Nested/list values are skipped, not mangled.
      assert.equal(frontmatter.tags, undefined);
      // No section text contains the frontmatter block.
      for (const s of sections) assert.doesNotMatch(s.text, /type: note/);
      const preamble = sections.find(s => s.level === 0);
      assert.match(preamble.text, /Preamble text/);
    });

    test("offsets still round-trip against the raw file when frontmatter is present", async () => {
      const md = "---\ntype: note\n---\nintro\n\n# A\nalpha\n## B\nbeta";
      const { sections } = await extract(md, "x.md");
      assert.ok(sections.length >= 3);
      for (const s of sections) {
        assert.equal(md.slice(s.startOffset, s.endOffset), s.text);
      }
    });

    test("frontmatter-less documents behave exactly as before", async () => {
      const md = "Loose intro.\n\n# Title\nBody.";
      const { frontmatter, sections } = await extract(md, "x.md");
      assert.equal(frontmatter, null);
      assert.equal(sections.find(s => s.level === 0).startOffset, 0);
    });

    test("a thematic break mid-file is not frontmatter", async () => {
      const md = "# A\nalpha\n\n---\n\nmore text";
      const { frontmatter, sections } = await extract(md, "x.md");
      assert.equal(frontmatter, null);
      assert.match(sections.find(s => s.heading === "A").text, /---/);
    });

    test("an unclosed opening --- is treated as content, not frontmatter", async () => {
      const md = "---\nnot: closed\nno delimiter follows";
      const { frontmatter, sections } = await extract(md, "x.md");
      assert.equal(frontmatter, null);
      assert.equal(sections.length, 1);
      assert.equal(sections[0].startOffset, 0);
      assert.match(sections[0].text, /not: closed/);
    });

    test("file that is only frontmatter yields no sections and keeps the title", async () => {
      const md = "---\ntitle: Meta Only\ntype: stub\n---\n";
      const { title, frontmatter, sections } = await extract(md, "meta.md");
      assert.equal(title, "Meta Only");
      assert.equal(frontmatter.type, "stub");
      assert.equal(sections.length, 0);
    });

    test("frontmatter closed by ... and CRLF line endings both parse", async () => {
      const md = "---\r\ntype: memo\r\n...\r\nbody line";
      const { frontmatter, sections } = await extract(md, "x.md");
      assert.equal(frontmatter.type, "memo");
      assert.equal(md.slice(sections[0].startOffset, sections[0].endOffset), sections[0].text);
      assert.match(sections[0].text, /body line/);
      assert.doesNotMatch(sections[0].text, /type: memo/);
    });
  });
});
