// tests/lib/handlers/attatchments/docxHandler.test.js
// Tests for handleDocx in lib/handlers/attachments/docxHandler.js

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { handleDocx } from "../../../../lib/handlers/attachments/docxHandler.js";

// ─── Stubs ────────────────────────────────────────────────────────────────────

const mockConvertToHtml = mock.fn(async () => ({
  value: "<p>Document body text.</p>",
  messages: [],
}));

const deps = { _mammoth: { convertToHtml: mockConvertToHtml } };

function makeAtt(text = "dummy") {
  return { data: Buffer.from(text).toString("base64") };
}

function setMammothResult(value, messages = []) {
  mockConvertToHtml.mock.resetCalls();
  mockConvertToHtml.mock.mockImplementationOnce(async () => ({ value, messages }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleDocx", () => {
  test("returns one text block on successful extraction", async () => {
    setMammothResult("<p>Hello from Word.</p>");
    const result = await handleDocx(makeAtt(), "report.docx", deps);

    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].type, "text");
  });

  test("block text includes extracted content", async () => {
    setMammothResult("<p>Important paragraph here.</p>");
    const result = await handleDocx(makeAtt(), "notes.docx", deps);

    assert.ok(result.blocks[0].text.includes("Important paragraph here."));
  });

  test("block text includes table HTML when present", async () => {
    setMammothResult("<table><tr><td>Col A</td><td>Col B</td></tr><tr><td>1</td><td>2</td></tr></table>");
    const result = await handleDocx(makeAtt(), "data.docx", deps);

    assert.ok(result.blocks[0].text.includes("<table>"));
    assert.ok(result.blocks[0].text.includes("<td>Col A</td>"));
  });

  test("block text includes Attached file label with filename", async () => {
    setMammothResult("<p>content</p>");
    const result = await handleDocx(makeAtt(), "contract.docx", deps);

    assert.ok(result.blocks[0].text.includes("[Attached file: contract.docx"));
  });

  test("hint includes filename", async () => {
    setMammothResult("<p>text</p>");
    const result = await handleDocx(makeAtt(), "proposal.docx", deps);

    assert.ok(result.hint.includes("proposal.docx"));
  });

  test("hint advises using inline content directly", async () => {
    setMammothResult("<p>text</p>");
    const result = await handleDocx(makeAtt(), "proposal.docx", deps);

    assert.ok(result.hint.includes("do not call unpack.py"));
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

  test("mammoth convertToHtml receives an object with a Buffer in buffer property", async () => {
    setMammothResult("<p>ok</p>");
    await handleDocx(makeAtt("hello"), "check.docx", deps);

    const callArg = mockConvertToHtml.mock.calls[0].arguments[0];
    assert.ok("buffer" in callArg, "should pass an object with a buffer property");
    assert.ok(Buffer.isBuffer(callArg.buffer), "buffer property should be a Buffer");
  });

  test("mammoth error returns empty blocks and error hint", async () => {
    mockConvertToHtml.mock.resetCalls();
    mockConvertToHtml.mock.mockImplementationOnce(async () => {
      throw new Error("corrupt docx");
    });

    const result = await handleDocx(makeAtt(), "bad.docx", deps);

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("Failed to parse DOCX"));
    assert.ok(result.hint.includes("bad.docx"));
    assert.ok(result.hint.includes("corrupt docx"));
  });
});
