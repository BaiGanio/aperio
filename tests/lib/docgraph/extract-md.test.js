// tests/lib/docgraph/extract-md.test.js
// Unit tests for the Markdown/text extractor — headings, hierarchy, preamble,
// fenced-code handling, title derivation. Pure function, no DB.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extract } from "../../../lib/docgraph/extract-md.js";

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
});
