// tests/tools/image.test.js
// Tests for readImageHandler and detectMime.
// Uses real temp image files built from raw bytes — no external image fixtures needed.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

import { readImageHandler, detectMime } from "../../mcp/tools/image.js";

// ─── Temp directory ───────────────────────────────────────────────────────────

const TEST_ROOT = join(tmpdir(), `aperio-image-test-${randomBytes(4).toString("hex")}`);
mkdirSync(TEST_ROOT, { recursive: true });

after(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

// ─── Minimal valid image bytes (magic numbers only) ───────────────────────────
// These are not valid displayable images, but they are enough to test the
// handler's file-reading, mime-detection, and base64-encoding paths.

const PNG_MAGIC  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
const GIF_MAGIC  = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_MAGIC = Buffer.from([
  0x52, 0x49, 0x46, 0x46,   // RIFF
  0x00, 0x00, 0x00, 0x00,   // file size (placeholder)
  0x57, 0x45, 0x42, 0x50,   // WEBP
]);

function writeTmpImage(name, buf) {
  const p = join(TEST_ROOT, name);
  writeFileSync(p, buf);
  return p;
}

// ─── detectMime ───────────────────────────────────────────────────────────────

describe("detectMime", () => {
  test("detects PNG from magic bytes", () => {
    assert.equal(detectMime(PNG_MAGIC, ".png"), "image/png");
  });

  test("detects JPEG from magic bytes", () => {
    assert.equal(detectMime(JPEG_MAGIC, ".jpg"), "image/jpeg");
  });

  test("detects GIF from magic bytes", () => {
    assert.equal(detectMime(GIF_MAGIC, ".gif"), "image/gif");
  });

  test("detects WebP from magic bytes", () => {
    assert.equal(detectMime(WEBP_MAGIC, ".webp"), "image/webp");
  });

  test("falls back to extension when magic bytes are unknown", () => {
    const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    assert.equal(detectMime(unknown, ".png"), "image/png");
    assert.equal(detectMime(unknown, ".jpg"), "image/jpeg");
  });

  test("falls back to image/jpeg for completely unknown input", () => {
    const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    assert.equal(detectMime(unknown, ".xyz"), "image/jpeg");
  });
});

// ─── readImageHandler — path branch ──────────────────────────────────────────

describe("readImageHandler (local file path)", () => {
  test("reads a PNG file and returns a base64 image block", async () => {
    const p = writeTmpImage("test.png", PNG_MAGIC);
    const result = await readImageHandler({ path: p });
    const imgBlock = result.content.find(b => b.type === "image");
    assert.ok(imgBlock, "should have an image block");
    assert.equal(imgBlock.mimeType, "image/png");
    assert.ok(typeof imgBlock.data === "string" && imgBlock.data.length > 0);
  });

  test("reads a JPEG file and detects correct mime type", async () => {
    const p = writeTmpImage("test.jpg", JPEG_MAGIC);
    const result = await readImageHandler({ path: p });
    const imgBlock = result.content.find(b => b.type === "image");
    assert.equal(imgBlock.mimeType, "image/jpeg");
  });

  test("respects mime_type override", async () => {
    const p = writeTmpImage("ambiguous.jpg", JPEG_MAGIC);
    const result = await readImageHandler({ path: p, mime_type: "image/png" });
    const imgBlock = result.content.find(b => b.type === "image");
    assert.equal(imgBlock.mimeType, "image/png");
  });

  test("includes prompt as a text block before the image", async () => {
    const p = writeTmpImage("prompted.png", PNG_MAGIC);
    const result = await readImageHandler({ path: p, prompt: "What is in this image?" });
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, "What is in this image?");
    assert.equal(result.content[1].type, "image");
  });

  test("returns only an image block when no prompt given", async () => {
    const p = writeTmpImage("no-prompt.png", PNG_MAGIC);
    const result = await readImageHandler({ path: p });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "image");
  });

  test("returns error for non-existent file", async () => {
    const result = await readImageHandler({ path: join(TEST_ROOT, "ghost.png") });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("returns error for unsupported extension", async () => {
    const p = writeTmpImage("bad.bmp", Buffer.from([0x42, 0x4D]));
    const result = await readImageHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ Unsupported image format"));
    assert.ok(result.content[0].text.includes(".bmp"));
  });
});

// ─── readImageHandler — base64 data branch ───────────────────────────────────

describe("readImageHandler (base64 data)", () => {
  test("accepts raw base64 data and returns an image block", async () => {
    const b64 = PNG_MAGIC.toString("base64");
    const result = await readImageHandler({ data: b64 });
    const imgBlock = result.content.find(b => b.type === "image");
    assert.ok(imgBlock);
    assert.equal(imgBlock.data, b64);
  });

  test("strips data-URI header and extracts mime type", async () => {
    const b64 = PNG_MAGIC.toString("base64");
    const result = await readImageHandler({ data: `data:image/png;base64,${b64}` });
    const imgBlock = result.content.find(b => b.type === "image");
    assert.equal(imgBlock.mimeType, "image/png");
    assert.equal(imgBlock.data, b64);
  });

  test("respects mime_type override over data-URI header", async () => {
    const b64 = PNG_MAGIC.toString("base64");
    const result = await readImageHandler({ data: `data:image/png;base64,${b64}`, mime_type: "image/webp" });
    const imgBlock = result.content.find(b => b.type === "image");
    assert.equal(imgBlock.mimeType, "image/webp");
  });

  test("defaults to image/jpeg for raw base64 without URI header", async () => {
    const b64 = JPEG_MAGIC.toString("base64");
    const result = await readImageHandler({ data: b64 });
    const imgBlock = result.content.find(b => b.type === "image");
    assert.equal(imgBlock.mimeType, "image/jpeg");
  });

  test("returns error for obviously invalid base64", async () => {
    const result = await readImageHandler({ data: "!!!not-base64-at-all!!!" });
    assert.ok(result.content[0].text.includes("❌ 'data' does not look like valid base64"));
  });

  test("includes prompt before image block for data branch too", async () => {
    const b64 = PNG_MAGIC.toString("base64");
    const result = await readImageHandler({ data: b64, prompt: "Describe this." });
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[1].type, "image");
  });
});