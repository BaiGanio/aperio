// tests/lib/handlers/attatchments/pptxHandler.test.js
// Tests for handlePptx in lib/handlers/attachments/pptxHandler.js
// Uses real AdmZip to build PPTX-like fixture buffers (no mocking needed).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { handlePptx } from "../../../../lib/handlers/attachments/pptxHandler.js";

// ─── Fixture builder ──────────────────────────────────────────────────────────

function slideXml(texts = []) {
  const runs = texts.map(t => `<a:r><a:t>${t}</a:t></a:r>`).join("");
  return `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p>${runs}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

function notesXml(texts = []) {
  const runs = texts.map(t => `<a:r><a:t>${t}</a:t></a:r>`).join("");
  return `<p:notes><p:cSld><p:sp><p:txBody><a:p>${runs}</a:p></p:txBody></p:sp></p:cSld></p:notes>`;
}

function makePptx({ slides = [], notes = [] } = {}) {
  const zip = new AdmZip();
  slides.forEach((texts, i) => {
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(slideXml(texts)));
  });
  notes.forEach((texts, i) => {
    zip.addFile(`ppt/notesSlides/notesSlide${i + 1}.xml`, Buffer.from(notesXml(texts)));
  });
  return zip.toBuffer().toString("base64");
}

function makeAtt(slides, notes) {
  return { data: makePptx({ slides, notes }) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handlePptx", () => {
  test("single-slide pptx returns one text block", async () => {
    const result = await handlePptx(makeAtt([["Hello world"]]), "deck.pptx");

    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].type, "text");
  });

  test("block text includes slide heading and content", async () => {
    const result = await handlePptx(makeAtt([["Title Text"]]), "deck.pptx");

    assert.ok(result.blocks[0].text.includes("--- Slide 1 ---"));
    assert.ok(result.blocks[0].text.includes("Title Text"));
  });

  test("multiple slides appear in order", async () => {
    const result = await handlePptx(
      makeAtt([["First"], ["Second"], ["Third"]]),
      "multi.pptx"
    );
    const text = result.blocks[0].text;

    assert.ok(text.indexOf("Slide 1") < text.indexOf("Slide 2"));
    assert.ok(text.indexOf("Slide 2") < text.indexOf("Slide 3"));
    assert.ok(text.includes("First"));
    assert.ok(text.includes("Second"));
    assert.ok(text.includes("Third"));
  });

  test("block text includes Attached file label with slide count", async () => {
    const result = await handlePptx(makeAtt([["A"], ["B"]]), "report.pptx");

    assert.ok(result.blocks[0].text.includes("[Attached file: report.pptx — 2 slides]"));
  });

  test("hint includes filename and slide count", async () => {
    const result = await handlePptx(makeAtt([["slide 1"]]), "talk.pptx");

    assert.ok(result.hint.includes("talk.pptx"));
    assert.ok(result.hint.includes("1 slide"));
  });

  test("speaker notes are appended to the corresponding slide", async () => {
    const result = await handlePptx(
      makeAtt([["Slide content"]], [["These are the speaker notes"]]),
      "noted.pptx"
    );
    const text = result.blocks[0].text;

    assert.ok(text.includes("Slide content"));
    assert.ok(text.includes("Speaker notes"));
    assert.ok(text.includes("These are the speaker notes"));
  });

  test("slide with no text shows (no text) placeholder", async () => {
    const result = await handlePptx(makeAtt([[]]), "blank.pptx");

    assert.ok(result.blocks[0].text.includes("(no text)"));
  });

  test("empty zip with no slide files returns empty blocks", async () => {
    const zip = new AdmZip();
    const data = zip.toBuffer().toString("base64");
    const result = await handlePptx({ data }, "empty.pptx");

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("empty.pptx"));
  });

  test("invalid buffer returns empty blocks and error hint", async () => {
    const result = await handlePptx({ data: "bm90YXppcA==" }, "corrupt.pptx");

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("Failed to parse PPTX"));
    assert.ok(result.hint.includes("corrupt.pptx"));
  });

  test("multiple text runs on one slide are joined", async () => {
    const result = await handlePptx(makeAtt([["Part one", "Part two"]]), "runs.pptx");

    assert.ok(result.blocks[0].text.includes("Part one"));
    assert.ok(result.blocks[0].text.includes("Part two"));
  });
});
