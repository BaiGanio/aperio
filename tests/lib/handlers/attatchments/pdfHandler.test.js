// tests/lib/handlers/attatchments/pdfHandler.test.js
// Tests for handlePdf in lib/handlers/attachments/pdfHandler.js

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { handlePdf } from "../../../../lib/handlers/attachments/pdfHandler.js";

// ─── Stubs ────────────────────────────────────────────────────────────────────

const mockExtractPdfText = mock.fn(async () => ({
  type: "text",
  text: "default extracted text",
  pageCount: 1,
  scannedPages: [],
  title: "",
  truncated: false,
}));

const mockWriteFile = mock.fn(async () => undefined);

const deps = {
  _extractPdfText: mockExtractPdfText,
  _fs: { writeFile: mockWriteFile },
};

function makeAtt(data = "ZmFrZXBkZg==") {
  return { data };
}

function setExtractResult(overrides) {
  mockExtractPdfText.mock.resetCalls();
  mockWriteFile.mock.resetCalls();
  mockExtractPdfText.mock.mockImplementationOnce(async () => ({
    type: "text",
    text: "default text",
    pageCount: 1,
    scannedPages: [],
    title: "",
    truncated: false,
    ...overrides,
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handlePdf", () => {
  test("type=text returns one text block with page count", async () => {
    setExtractResult({ type: "text", text: "hello pdf", pageCount: 3 });
    const result = await handlePdf(makeAtt(), "doc.pdf", "/tmp/uploads", deps);

    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].type, "text");
    assert.ok(result.blocks[0].text.includes("3 pages"));
  });

  test("type=text block includes extracted text", async () => {
    setExtractResult({ type: "text", text: "important content" });
    const result = await handlePdf(makeAtt(), "report.pdf", "/tmp/uploads", deps);

    assert.ok(result.blocks[0].text.includes("important content"));
  });

  test("type=text hint includes filename and page count", async () => {
    setExtractResult({ type: "text", pageCount: 5 });
    const result = await handlePdf(makeAtt(), "annual.pdf", "/tmp/uploads", deps);

    assert.ok(result.hint.includes("annual.pdf"));
    assert.ok(result.hint.includes("5 pages"));
  });

  test("type=text with truncated=true adds warning in block text and hint", async () => {
    setExtractResult({ type: "text", text: "content", truncated: true });
    const result = await handlePdf(makeAtt(), "big.pdf", "/tmp/uploads", deps);

    assert.ok(result.blocks[0].text.includes("truncated") || result.blocks[0].text.includes("⚠️"));
    assert.ok(result.hint.includes("truncated"));
  });

  test("type=scanned returns empty blocks", async () => {
    setExtractResult({ type: "scanned", text: "", pageCount: 2, scannedPages: [1, 2] });
    const result = await handlePdf(makeAtt(), "scan.pdf", "/tmp/uploads", deps);

    assert.equal(result.blocks.length, 0);
  });

  test("type=scanned hint mentions scanned and includes filename", async () => {
    setExtractResult({ type: "scanned", text: "", pageCount: 1, scannedPages: [1] });
    const result = await handlePdf(makeAtt(), "image-only.pdf", "/tmp/uploads", deps);

    assert.ok(result.hint.includes("image-only.pdf"));
    assert.ok(result.hint.toLowerCase().includes("scanned"));
  });

  test("type=mixed returns one text block with extracted text", async () => {
    setExtractResult({ type: "mixed", text: "partial text", pageCount: 4, scannedPages: [2, 4] });
    const result = await handlePdf(makeAtt(), "mixed.pdf", "/tmp/uploads", deps);

    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].text.includes("partial text"));
  });

  test("type=mixed hint lists scanned page numbers", async () => {
    setExtractResult({ type: "mixed", text: "some text", pageCount: 3, scannedPages: [1, 3] });
    const result = await handlePdf(makeAtt(), "partial.pdf", "/tmp/uploads", deps);

    assert.ok(result.hint.includes("1"));
    assert.ok(result.hint.includes("3"));
  });

  test("type=empty returns empty blocks with informative hint", async () => {
    setExtractResult({ type: "empty", text: "", pageCount: 0, scannedPages: [] });
    const result = await handlePdf(makeAtt(), "empty.pdf", "/tmp/uploads", deps);

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("empty.pdf"));
  });

  test("unknown type returns empty blocks with type name in hint", async () => {
    setExtractResult({ type: "future-format" });
    const result = await handlePdf(makeAtt(), "weird.pdf", "/tmp/uploads", deps);

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("future-format"));
  });

  test("title in result is included in the block label", async () => {
    setExtractResult({ type: "text", text: "body", title: "Annual Report" });
    const result = await handlePdf(makeAtt(), "ar.pdf", "/tmp/uploads", deps);

    assert.ok(result.blocks[0].text.includes("Annual Report"));
  });

  test("writeFile is called once with a .pdf filename", async () => {
    setExtractResult({});
    await handlePdf(makeAtt(), "save.pdf", "/tmp/uploads", deps);

    assert.equal(mockWriteFile.mock.calls.length, 1);
    const [filePath] = mockWriteFile.mock.calls[0].arguments;
    assert.ok(filePath.endsWith(".pdf"));
  });

  test("extractPdfText failure returns empty blocks and error hint", async () => {
    mockExtractPdfText.mock.resetCalls();
    mockWriteFile.mock.resetCalls();
    mockExtractPdfText.mock.mockImplementationOnce(async () => {
      throw new Error("corrupted PDF");
    });

    const result = await handlePdf(makeAtt(), "broken.pdf", "/tmp/uploads", deps);

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("Failed to process PDF"));
    assert.ok(result.hint.includes("broken.pdf"));
    assert.ok(result.hint.includes("corrupted PDF"));
  });
});
