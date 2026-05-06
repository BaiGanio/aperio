// tests/lib/handlers/attatchments/index.test.js
// Tests for processAttachments in lib/handlers/attachments/index.js

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { processAttachments } from "../../../../lib/handlers/attachments/index.js";

// ─── Stubs ────────────────────────────────────────────────────────────────────

const stub = (label) => async () => ({ blocks: [{ type: "text", text: label }], hint: `[${label}]`, meta: { name: `${label}.file`, type: "text/plain" } });

const mockHandleImage = mock.fn(stub("image"));
const mockHandleText  = mock.fn(stub("text"));
const mockHandlePdf   = mock.fn(stub("pdf"));
const mockHandleDocx  = mock.fn(stub("docx"));
const mockHandlePptx  = mock.fn(stub("pptx"));

const deps = {
  _handleImage: mockHandleImage,
  _handleText:  mockHandleText,
  _handlePdf:   mockHandlePdf,
  _handleDocx:  mockHandleDocx,
  _handlePptx:  mockHandlePptx,
};

function resetAll() {
  [mockHandleImage, mockHandleText, mockHandlePdf, mockHandleDocx, mockHandlePptx]
    .forEach(fn => fn.mock.resetCalls());
}

function att(name, data = "ZmFrZQ==") {
  return { name, data };
}

const DIR = "/srv/app";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("processAttachments", () => {
  test("returns empty contentBlocks and empty hint for zero attachments", async () => {
    resetAll();
    const { contentBlocks, hint } = await processAttachments([], DIR, deps);

    assert.deepEqual(contentBlocks, []);
    assert.equal(hint, "");
  });

  test("returns attachmentMeta array with one entry per attachment", async () => {
    resetAll();
    const { attachmentMeta } = await processAttachments([att("file.txt"), att("doc.pdf")], DIR, deps);

    assert.equal(attachmentMeta.length, 2);
  });

  test("routes .jpg to handleImage", async () => {
    resetAll();
    await processAttachments([att("photo.jpg")], DIR, deps);

    assert.equal(mockHandleImage.mock.calls.length, 1);
    assert.equal(mockHandleText.mock.calls.length, 0);
  });

  test("routes all image extensions to handleImage", async () => {
    for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".webp"]) {
      resetAll();
      await processAttachments([att(`file${ext}`)], DIR, deps);
      assert.equal(mockHandleImage.mock.calls.length, 1, `expected handleImage for ${ext}`);
    }
  });

  test("routes common text extensions to handleText", async () => {
    for (const ext of [".txt", ".md", ".js", ".ts", ".py", ".json", ".yaml", ".go", ".sql"]) {
      resetAll();
      await processAttachments([att(`file${ext}`)], DIR, deps);
      assert.equal(mockHandleText.mock.calls.length, 1, `expected handleText for ${ext}`);
    }
  });

  test("routes .pdf to handlePdf", async () => {
    resetAll();
    await processAttachments([att("doc.pdf")], DIR, deps);

    assert.equal(mockHandlePdf.mock.calls.length, 1);
  });

  test("routes .docx to handleDocx", async () => {
    resetAll();
    await processAttachments([att("report.docx")], DIR, deps);

    assert.equal(mockHandleDocx.mock.calls.length, 1);
  });

  test("routes .pptx to handlePptx", async () => {
    resetAll();
    await processAttachments([att("slides.pptx")], DIR, deps);

    assert.equal(mockHandlePptx.mock.calls.length, 1);
  });

  test("unsupported extension returns empty blocks and not-supported hint", async () => {
    resetAll();
    const { contentBlocks, hint } = await processAttachments([att("archive.zip")], DIR, deps);

    assert.equal(contentBlocks.length, 0);
    assert.ok(hint.includes("archive.zip"));
    assert.ok(hint.toLowerCase().includes("not supported"));
    assert.equal(mockHandleImage.mock.calls.length, 0);
    assert.equal(mockHandlePdf.mock.calls.length, 0);
  });

  test("contentBlocks from multiple attachments are merged in order", async () => {
    resetAll();
    mockHandleText.mock.mockImplementationOnce(async () => ({
      blocks: [{ type: "text", text: "first" }], hint: "",
    }));
    mockHandlePdf.mock.mockImplementationOnce(async () => ({
      blocks: [{ type: "text", text: "second" }], hint: "",
    }));

    const { contentBlocks } = await processAttachments(
      [att("a.txt"), att("b.pdf")], DIR, deps
    );

    assert.equal(contentBlocks.length, 2);
    assert.equal(contentBlocks[0].text, "first");
    assert.equal(contentBlocks[1].text, "second");
  });

  test("hints from multiple attachments are concatenated", async () => {
    resetAll();
    mockHandleText.mock.mockImplementationOnce(async () => ({ blocks: [], hint: "HINT_A" }));
    mockHandlePdf.mock.mockImplementationOnce(async ()  => ({ blocks: [], hint: "HINT_B" }));

    const { hint } = await processAttachments([att("a.md"), att("b.pdf")], DIR, deps);

    assert.ok(hint.includes("HINT_A"));
    assert.ok(hint.includes("HINT_B"));
  });

  test("extension matching is case-insensitive", async () => {
    resetAll();
    await processAttachments([att("PHOTO.PNG")], DIR, deps);

    assert.equal(mockHandleImage.mock.calls.length, 1);
  });

  test("basename is used so path traversal components are stripped from the name", async () => {
    resetAll();
    await processAttachments([att("../../etc/passwd.txt")], DIR, deps);

    assert.equal(mockHandleText.mock.calls.length, 1);
    const passedName = mockHandleText.mock.calls[0].arguments[1];
    assert.equal(passedName, "passwd.txt");
  });
});
