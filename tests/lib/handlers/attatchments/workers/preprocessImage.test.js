// tests/lib/handlers/attatchments/workers/preprocessImage.test.js
// Tests for preprocessImage and preprocessBase64 in lib/handlers/attachments/workers/preprocessImage.js

import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  preprocessImage,
  preprocessBase64,
} from "../../../../../lib/handlers/attachments/workers/preprocessImage.js";
import logger from "../../../../../lib/helpers/logger.js";

// ─── Silence logger during tests ──────────────────────────────────────────────
before(() => { mock.method(logger, "debug", () => {}); });
after(() => mock.restoreAll());

// ─── Mock sharp factory ────────────────────────────────────────────────────────

function makeMockSharp({ meta = {}, output = Buffer.from("png") } = {}) {
  const chain = {
    metadata: async () => ({ format: "png", width: 100, height: 100, channels: 3, hasAlpha: false, ...meta }),
    flatten:      () => chain,
    toColorspace: () => chain,
    resize:       () => chain,
    png:          () => chain,
    toBuffer:     async () => output,
  };
  return () => chain;
}

// ─── preprocessImage tests ────────────────────────────────────────────────────

describe("preprocessImage", () => {
  test("returns a Buffer", async () => {
    const result = await preprocessImage(Buffer.from("fake"), {
      _sharp: makeMockSharp(),
    });
    assert.ok(Buffer.isBuffer(result));
  });

  test("default size is 896 — returns a buffer without options", async () => {
    const result = await preprocessImage(Buffer.from("fake"), {
      _sharp: makeMockSharp(),
    });
    assert.ok(Buffer.isBuffer(result));
  });

  test("custom size option is forwarded to resize", async () => {
    let capturedArgs;
    const output = Buffer.from("sized");
    const chain = {
      metadata: async () => ({ format: "png", width: 100, height: 100, channels: 3, hasAlpha: false }),
      flatten:      () => chain,
      toColorspace: () => chain,
      resize:       (...args) => { capturedArgs = args; return chain; },
      png:          () => chain,
      toBuffer:     async () => output,
    };
    const mockSharp = () => chain;

    await preprocessImage(Buffer.from("fake"), { size: 512, _sharp: mockSharp });

    assert.ok(capturedArgs, "resize should have been called");
    assert.strictEqual(capturedArgs[0], 512);
    assert.strictEqual(capturedArgs[1], 512);
  });

  test('"dark" background resolves to { r: 30, g: 30, b: 30 }', async () => {
    let capturedBg;
    const chain = {
      metadata: async () => ({ format: "png", width: 100, height: 100, channels: 3, hasAlpha: false }),
      flatten:      (opts) => { capturedBg = opts.background; return chain; },
      toColorspace: () => chain,
      resize:       () => chain,
      png:          () => chain,
      toBuffer:     async () => Buffer.from("ok"),
    };

    await preprocessImage(Buffer.from("fake"), { background: "dark", _sharp: () => chain });

    assert.deepStrictEqual(capturedBg, { r: 30, g: 30, b: 30 });
  });

  test("a raw { r, g, b } object is forwarded directly as background", async () => {
    let capturedBg;
    const chain = {
      metadata: async () => ({ format: "png", width: 100, height: 100, channels: 3, hasAlpha: false }),
      flatten:      (opts) => { capturedBg = opts.background; return chain; },
      toColorspace: () => chain,
      resize:       () => chain,
      png:          () => chain,
      toBuffer:     async () => Buffer.from("ok"),
    };

    const customBg = { r: 10, g: 20, b: 30 };
    await preprocessImage(Buffer.from("fake"), { background: customBg, _sharp: () => chain });

    assert.deepStrictEqual(capturedBg, customBg);
  });

  test("unknown string background falls back to white { r: 255, g: 255, b: 255 }", async () => {
    let capturedBg;
    const chain = {
      metadata: async () => ({ format: "png", width: 100, height: 100, channels: 3, hasAlpha: false }),
      flatten:      (opts) => { capturedBg = opts.background; return chain; },
      toColorspace: () => chain,
      resize:       () => chain,
      png:          () => chain,
      toBuffer:     async () => Buffer.from("ok"),
    };

    await preprocessImage(Buffer.from("fake"), { background: "neon-pink", _sharp: () => chain });

    assert.deepStrictEqual(capturedBg, { r: 255, g: 255, b: 255 });
  });

  test("returned buffer matches what toBuffer() resolved to", async () => {
    const expected = Buffer.from("exact-output-bytes");
    const result = await preprocessImage(Buffer.from("fake"), {
      _sharp: makeMockSharp({ output: expected }),
    });
    assert.deepStrictEqual(result, expected);
  });
});

// ─── preprocessBase64 tests ───────────────────────────────────────────────────

describe("preprocessBase64", () => {
  test("plain base64 → returns a base64 string (no data-URI prefix)", async () => {
    const original = Buffer.from("hello world");
    const input = original.toString("base64");
    const result = await preprocessBase64(input, {
      _sharp: makeMockSharp({ output: original }),
    });
    assert.strictEqual(typeof result, "string");
    assert.ok(!result.startsWith("data:"));
  });

  test("data-URI prefix is stripped before processing", async () => {
    const payload = Buffer.from("image-data");
    const dataUri = `data:image/png;base64,${payload.toString("base64")}`;

    const result = await preprocessBase64(dataUri, {
      _sharp: makeMockSharp({ output: payload }),
    });
    assert.strictEqual(typeof result, "string");
    assert.ok(!result.startsWith("data:"));
  });

  test("returned string can be decoded back to the original buffer", async () => {
    const expected = Buffer.from("round-trip-content");
    const input = expected.toString("base64");

    const result = await preprocessBase64(input, {
      _sharp: makeMockSharp({ output: expected }),
    });

    const decoded = Buffer.from(result, "base64");
    assert.deepStrictEqual(decoded, expected);
  });
});
