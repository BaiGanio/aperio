// tests/lib/handlers/attatchments/docxHandler.test.js
// Tests for handleDocx in lib/handlers/attachments/docxHandler.js

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { handleDocx } from "../../../../lib/handlers/attachments/docxHandler.js";

// ─── Stubs ────────────────────────────────────────────────────────────────────

const mockExtractRawText = mock.fn(async () => ({
  value: "Document body text.",
  messages: [],
}));

const deps = { _mammoth: { extractRawText: mockExtractRawText } };

function makeAtt(text = "dummy") {
  return { data: Buffer.from(text).toString("base64") };
}

function setMammothResult(value, messages = []) {
  mockExtractRawText.mock.resetCalls();
  mockExtractRawText.mock.mockImplementationOnce(async () => ({ value, messages }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleDocx", () => {
  test("returns one text block on successful extraction", async () => {
    setMammothResult("Hello from Word.");
    const result = await handleDocx(makeAtt(), "report.docx", deps);

    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].type, "text");
  });

  test("block text includes extracted content", async () => {
    setMammothResult("Important paragraph here.");
    const result = await handleDocx(makeAtt(), "notes.docx", deps);

    assert.ok(result.blocks[0].text.includes("Important paragraph here."));
  });

  test("block text wraps content in a fenced code block", async () => {
    setMammothResult("Some text");
    const result = await handleDocx(makeAtt(), "doc.docx", deps);

    assert.ok(result.blocks[0].text.includes("```\n"));
    assert.ok(result.blocks[0].text.includes("\n```"));
  });

  test("block text includes Attached file label with filename", async () => {
    setMammothResult("content");
    const result = await handleDocx(makeAtt(), "contract.docx", deps);

    assert.ok(result.blocks[0].text.includes("[Attached file: contract.docx]"));
  });

  test("hint includes filename", async () => {
    setMammothResult("text");
    const result = await handleDocx(makeAtt(), "proposal.docx", deps);

    assert.ok(result.hint.includes("proposal.docx"));
  });

  test("whitespace-only value returns empty blocks with informative hint", async () => {
    setMammothResult("   ");
    const result = await handleDocx(makeAtt(), "empty.docx", deps);

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("empty.docx"));
  });

  test("null value from mammoth treated as empty", async () => {
    setMammothResult(null);
    const result = await handleDocx(makeAtt(), "null.docx", deps);

    assert.equal(result.blocks.length, 0);
  });

  test("mammoth extractRawText receives an object with a Buffer in buffer property", async () => {
    setMammothResult("ok");
    await handleDocx(makeAtt("hello"), "check.docx", deps);

    const callArg = mockExtractRawText.mock.calls[0].arguments[0];
    assert.ok("buffer" in callArg, "should pass an object with a buffer property");
    assert.ok(Buffer.isBuffer(callArg.buffer), "buffer property should be a Buffer");
  });

  test("mammoth error returns empty blocks and error hint", async () => {
    mockExtractRawText.mock.resetCalls();
    mockExtractRawText.mock.mockImplementationOnce(async () => {
      throw new Error("corrupt docx");
    });

    const result = await handleDocx(makeAtt(), "bad.docx", deps);

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("Failed to parse DOCX"));
    assert.ok(result.hint.includes("bad.docx"));
    assert.ok(result.hint.includes("corrupt docx"));
  });
});
