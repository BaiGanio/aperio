// tests/lib/handlers/attatchments/imageHandler.test.js
// Tests for handleImage in lib/handlers/attachments/imageHandler.js

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { handleImage } from "../../../../lib/handlers/attachments/imageHandler.js";

// ─── Stubs ────────────────────────────────────────────────────────────────────

const mockPreprocessBase64 = mock.fn(async () => "bW9ja2VkYmFzZTY0");
const mockWriteFile        = mock.fn(async () => undefined);

const deps = {
  _preprocessBase64: mockPreprocessBase64,
  _fs: { writeFile: mockWriteFile },
};

function makeAtt(data = "aW1hZ2VkYXRh") {
  return { data };
}

function reset(returnValue) {
  mockPreprocessBase64.mock.resetCalls();
  mockWriteFile.mock.resetCalls();
  if (returnValue !== undefined) {
    mockPreprocessBase64.mock.mockImplementationOnce(async () => returnValue);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleImage", () => {
  test("returns one image content block on success", async () => {
    reset();
    const result = await handleImage(makeAtt(), "photo.png", "/tmp/uploads", deps);

    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].type, "image");
  });

  test("image block source type is base64 with media_type image/png", async () => {
    reset();
    const result = await handleImage(makeAtt(), "shot.jpg", "/tmp/uploads", deps);

    const src = result.blocks[0].source;
    assert.equal(src.type, "base64");
    assert.equal(src.media_type, "image/png");
  });

  test("image block data equals what preprocessBase64 returned", async () => {
    reset("dGVzdGltYWdlZGF0YQ==");
    const result = await handleImage(makeAtt(), "img.webp", "/tmp/uploads", deps);

    assert.equal(result.blocks[0].source.data, "dGVzdGltYWdlZGF0YQ==");
  });

  test("hint contains the original filename", async () => {
    reset();
    const result = await handleImage(makeAtt(), "diagram.gif", "/tmp/uploads", deps);

    assert.ok(result.hint.includes("diagram.gif"));
  });

  test("preprocessBase64 is called with the attachment data", async () => {
    reset();
    const attData = "c29tZWltYWdlZGF0YQ==";
    await handleImage(makeAtt(attData), "x.png", "/tmp/uploads", deps);

    assert.equal(mockPreprocessBase64.mock.calls.length, 1);
    assert.equal(mockPreprocessBase64.mock.calls[0].arguments[0], attData);
  });

  test("preprocessBase64 options include background white and size 896", async () => {
    reset();
    await handleImage(makeAtt(), "img.png", "/tmp/uploads", deps);

    const opts = mockPreprocessBase64.mock.calls[0].arguments[1];
    assert.equal(opts.background, "white");
    assert.equal(opts.size, 896);
  });

  test("writeFile is called once with a .png filename", async () => {
    reset();
    await handleImage(makeAtt(), "img.jpeg", "/tmp/uploads", deps);

    assert.equal(mockWriteFile.mock.calls.length, 1);
    const [filePath] = mockWriteFile.mock.calls[0].arguments;
    assert.ok(filePath.endsWith(".png"));
  });

  test("returns empty blocks and error hint when preprocessBase64 throws", async () => {
    reset();
    mockPreprocessBase64.mock.mockImplementationOnce(async () => {
      throw new Error("sharp failed");
    });

    const result = await handleImage(makeAtt(), "bad.png", "/tmp/uploads", deps);

    assert.equal(result.blocks.length, 0);
    assert.ok(result.hint.includes("Failed to process image"));
    assert.ok(result.hint.includes("bad.png"));
    assert.ok(result.hint.includes("sharp failed"));
  });

  test("hint is a non-empty string on success", async () => {
    reset();
    const result = await handleImage(makeAtt(), "ok.png", "/tmp/uploads", deps);

    assert.equal(typeof result.hint, "string");
    assert.ok(result.hint.length > 0);
  });
});
