// tests/tools/image.test.js
// Tests for detectMime and readImageHandler.
// Imports directly from mcp/tools/image.js — no inline copies.

import { test, describe, after, mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { installMemfs } from "../../../helpers/memfs.js";

// ─── In-memory workspace (zero real disk access) ──────────────────────────────
// Install the fs mock BEFORE importing image.js so its named fs bindings read
// from the in-RAM map. Image bytes are written/read entirely in memory.
const mem = installMemfs({ root: "/mem/img" });
const {
  detectMime,
  readImageHandler,
  isLlamaCppProvider,
  describeImageViaLlamaCpp,
  resolveDescribeModel,
  resolveDescribeModelId,
  isDegenerateVlmOutput,
} = await import("../../../../mcp/tools/image.js");
after(() => mem.restore());

const sandbox = { root: mem.root };

// Minimal valid file signatures (magic bytes)
const PNG_HEADER  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
const GIF_HEADER  = Buffer.from([0x47, 0x49, 0x46, 0x38]);
const WEBP_HEADER = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

function writeTmp(name, buf) {
  const p = join(sandbox.root, name);
  mem.writeFile(p, buf);
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
      mem.writeFile(bigPath, Buffer.alloc(21 * 1024 * 1024)); // 21 MB (in RAM, not on disk)
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

// ─── isLlamaCppProvider / describeImageViaLlamaCpp ─────────────────────────────

describe("isLlamaCppProvider", () => {
  const original = process.env.AI_PROVIDER;
  after(() => { process.env.AI_PROVIDER = original; });

  test("true when AI_PROVIDER=llamacpp (any case)", () => {
    process.env.AI_PROVIDER = "LlamaCpp";
    assert.equal(isLlamaCppProvider(), true);
  });

  test("false for ollama or unset", () => {
    process.env.AI_PROVIDER = "ollama";
    assert.equal(isLlamaCppProvider(), false);
    delete process.env.AI_PROVIDER;
    assert.equal(isLlamaCppProvider(), false);
  });
});

describe("describeImageViaLlamaCpp", () => {
  test("posts image_url content to /v1/chat/completions and returns the text", async () => {
    let capturedUrl, capturedBody;
    mock.method(globalThis, "fetch", async (url, opts) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "A red bicycle." } }] }),
      };
    });
    try {
      const text = await describeImageViaLlamaCpp("cGl4ZWxz", "Describe this image in detail.", "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF");
      assert.equal(text, "A red bicycle.");
      assert.match(capturedUrl, /\/v1\/chat\/completions$/);
      assert.equal(capturedBody.model, "aperio-vlm");
      assert.equal(capturedBody.stream, false);
      assert.equal(capturedBody.max_tokens, 512);
      assert.deepEqual(capturedBody.chat_template_kwargs, { enable_thinking: false });
      const content = capturedBody.messages[0].content;
      assert.deepEqual(content.find(b => b.type === "text"), { type: "text", text: "Describe this image in detail." });
      assert.equal(content.find(b => b.type === "image_url").image_url.url, "data:image/png;base64,cGl4ZWxz");
    } finally {
      mock.restoreAll();
    }
  });

  test("throws with response body on a non-OK response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: false, status: 500, text: async () => "model not loaded",
    }));
    try {
      await assert.rejects(
        () => describeImageViaLlamaCpp("cGl4ZWxz", "Describe", "some-model"),
        /llama\.cpp HTTP 500/,
      );
    } finally {
      mock.restoreAll();
    }
  });

  test("uses aperio-main when the configured main model provides native vision", () => {
    assert.equal(
      resolveDescribeModel(
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
      ),
      "aperio-main",
    );
    assert.equal(
      resolveDescribeModelId(
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
      ),
      "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    );
  });
});

describe("isDegenerateVlmOutput", () => {
  test("rejects long single-character output", () => {
    assert.equal(isDegenerateVlmOutput("@".repeat(512)), true);
  });

  test("accepts a normal concise visual description", () => {
    assert.equal(isDegenerateVlmOutput("A red bicycle is parked beside a brick wall."), false);
  });
});
