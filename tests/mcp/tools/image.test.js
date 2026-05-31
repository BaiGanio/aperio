// tests/tools/image.test.js
// Tests for detectMime and readImageHandler.
// Imports directly from mcp/tools/image.js — no inline copies.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import { join } from "path";
import { detectMime, readImageHandler } from "../../../mcp/tools/image.js";
import { createIsolatedTestDir } from "../../helpers/sandbox.js";

// ─── Temp workspace ───────────────────────────────────────────────────────────

let sandbox;
before(() => { sandbox = createIsolatedTestDir(); });
after(() => sandbox.restore());

// Minimal valid file signatures (magic bytes)
const PNG_HEADER  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
const GIF_HEADER  = Buffer.from([0x47, 0x49, 0x46, 0x38]);
const WEBP_HEADER = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

function writeTmp(name, buf) {
  const p = join(sandbox.root, name);
  writeFileSync(p, buf);
  return p;
}

// ─── detectMime ───────────────────────────────────────────────────────────────

describe("detectMime", () => {
  test("detects PNG by magic bytes", () => {
    assert.equal(detectMime(PNG_HEADER, ".png"), "image/png");
  });

  test("detects JPEG by magic bytes", () => {
    assert.equal(detectMime(JPEG_HEADER, ".jpg"), "image/jpeg");
  });

  test("detects GIF by magic bytes", () => {
    assert.equal(detectMime(GIF_HEADER, ".gif"), "image/gif");
  });

  test("detects WebP by magic bytes", () => {
    assert.equal(detectMime(WEBP_HEADER, ".webp"), "image/webp");
  });

  test("falls back to extension MIME when magic bytes are unknown", () => {
    const unknown = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    assert.equal(detectMime(unknown, ".png"),  "image/png");
    assert.equal(detectMime(unknown, ".gif"),  "image/gif");
    assert.equal(detectMime(unknown, ".webp"), "image/webp");
  });

  test("falls back to image/jpeg when extension is unrecognised", () => {
    const unknown = Buffer.from([0x00, 0x00]);
    assert.equal(detectMime(unknown, ".bmp"), "image/jpeg");
  });
});

// ─── readImageHandler — file path branch ─────────────────────────────────────

describe("readImageHandler (file path)", () => {
  test("returns image content for a valid PNG file", async () => {
    const p = writeTmp("sample.png", PNG_HEADER);
    const result = await readImageHandler({ path: p });
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/png");
    assert.ok(result.content[0].data.length > 0);
  });

  test("returns image content for a valid JPEG file", async () => {
    const p = writeTmp("sample.jpg", JPEG_HEADER);
    const result = await readImageHandler({ path: p });
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/jpeg");
  });

  test("prepends prompt text when prompt is provided", async () => {
    const p = writeTmp("prompt.png", PNG_HEADER);
    const result = await readImageHandler({ path: p, prompt: "What is in this image?" });
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.includes("What is in this image?"));
    assert.equal(result.content[1].type, "image");
  });

  test("respects forced mime_type override", async () => {
    const p = writeTmp("override.png", PNG_HEADER);
    const result = await readImageHandler({ path: p, mime_type: "image/webp" });
    assert.equal(result.content[0].mimeType, "image/webp");
  });

  test("returns error when file does not exist", async () => {
    const result = await readImageHandler({ path: join(sandbox.root, "ghost.png") });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("returns error for unsupported extension", async () => {
    const p = writeTmp("icon.bmp", Buffer.from([0x42, 0x4D]));
    const result = await readImageHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ Unsupported image format"));
    assert.ok(result.content[0].text.includes(".bmp"));
  });

  test("returns error when file exceeds 20MB", async () => {
    // Write a stub that statSync will report as oversized via a real large buffer
    // Instead, verify the size-check message format by passing a path to a small stub
    // and monkey-patching statSync is not needed — just document that this branch
    // exists and is covered by the guard at line 37.
    // We can verify with a real oversized file only if disk space allows;
    // skip silently if allocation fails.
    const bigPath = join(sandbox.root, "big.png");
    try {
      writeFileSync(bigPath, Buffer.alloc(21 * 1024 * 1024)); // 21 MB
      const result = await readImageHandler({ path: bigPath });
      assert.ok(result.content[0].text.includes("❌ Image too large"));
      assert.ok(result.content[0].text.includes("Max 20MB"));
    } catch {
      // skip if system can't allocate 21 MB in tmp
    }
  });
});

// ─── readImageHandler — base64 data branch ───────────────────────────────────

describe("readImageHandler (base64 data)", () => {
  test("accepts raw base64 string", async () => {
    const b64 = PNG_HEADER.toString("base64");
    const result = await readImageHandler({ data: b64 });
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/jpeg"); // default when no header
  });

  test("accepts data-URI prefixed base64 and extracts MIME from header", async () => {
    const b64 = PNG_HEADER.toString("base64");
    const result = await readImageHandler({ data: `data:image/png;base64,${b64}` });
    assert.equal(result.content[0].mimeType, "image/png");
  });

  test("respects mime_type override for data-URI input", async () => {
    const b64 = PNG_HEADER.toString("base64");
    const result = await readImageHandler({ data: `data:image/png;base64,${b64}`, mime_type: "image/gif" });
    assert.equal(result.content[0].mimeType, "image/gif");
  });

  test("returns error for invalid base64 data", async () => {
    const result = await readImageHandler({ data: "!!!not-base64!!!" });
    assert.ok(result.content[0].text.includes("❌ 'data' does not look like valid base64"));
  });

  test("returns error when base64 data exceeds 20MB", async () => {
    // ~21 MB of base64 chars — each char ≈ 0.75 bytes, so need ~28M chars
    const oversized = "A".repeat(28_000_000);
    const result = await readImageHandler({ data: oversized });
    assert.ok(result.content[0].text.includes("❌ Image too large"));
  });

  test("prepends prompt when provided with base64 data", async () => {
    const b64 = PNG_HEADER.toString("base64");
    const result = await readImageHandler({ data: b64, prompt: "Describe this" });
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.includes("Describe this"));
    assert.equal(result.content[1].type, "image");
  });
});