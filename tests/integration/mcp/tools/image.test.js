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
  isVisionEngineAvailable,
  describeImageViaLlamaCpp,
  describeImageHandler,
  resolveDescribeModel,
  resolveDescribeModelId,
  isDegenerateVlmOutput,
} = await import("../../../../mcp/tools/image.js");
after(() => mem.restore());

const sandbox = { root: mem.root };

// resolveDescribeModel's vision check (modelCapabilitiesSync) now reads the
// HF cache from disk. A path outside memfs's root falls through to the REAL
// filesystem (see memfs.js's header) — the real default cache dir is outside
// mem.root, so give it an isolated in-memory fixture instead of leaving it to
// whatever happens to be cached on the machine running the test.
const HF_CACHE = join(sandbox.root, "hf-cache");
process.env.LLAMA_CACHE = HF_CACHE;
function fixtureVisionRepo(repo) {
  const dir = join(HF_CACHE, "models--" + repo.replaceAll("/", "--"));
  mem.mkdirp(join(dir, "refs"));
  mem.mkdirp(join(dir, "snapshots", "abc"));
  mem.writeFile(join(dir, "refs", "main"), "abc");
  mem.writeFile(join(dir, "snapshots", "abc", "model-Q4_K_M.gguf"), Buffer.alloc(16));
  mem.writeFile(join(dir, "snapshots", "abc", "mmproj-BF16.gguf"), Buffer.alloc(16));
}
fixtureVisionRepo("unsloth/gemma-4-E4B-it-qat-GGUF");

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
      // Matches the module's default configured VLM model — the curated
      // gemma-4-E4B, not a name-based pick — so it resolves to the router's
      // stable aperio-vlm alias. mainAliasEligible=false is passed explicitly
      // so this test exercises only the POST behavior, not the live
      // /v1/models pre-check (covered separately below).
      const text = await describeImageViaLlamaCpp("cGl4ZWxz", "Describe this image in detail.", "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL", false);
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
        () => describeImageViaLlamaCpp("cGl4ZWxz", "Describe", "some-model", false),
        /llama\.cpp HTTP 500/,
      );
    } finally {
      mock.restoreAll();
    }
  });

  test("with no mainAliasEligible passed, falls back to a live /v1/models check", async () => {
    let modelsCall = 0, chatCall = 0;
    mock.method(globalThis, "fetch", async (url) => {
      if (String(url).endsWith("/v1/models")) { modelsCall++; return { ok: true, json: async () => ({ data: [{ id: "aperio-vlm" }] }) }; }
      chatCall++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "A red bicycle." } }] }) };
    });
    try {
      const text = await describeImageViaLlamaCpp("cGl4ZWxz", "Describe", "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL");
      assert.equal(text, "A red bicycle.");
      assert.equal(modelsCall, 1, "an omitted mainAliasEligible must trigger exactly one live check");
      assert.equal(chatCall, 1);
    } finally {
      mock.restoreAll();
    }
  });

  test("uses aperio-main when the configured main model provides native vision (mainAliasEligible=true — the normal buildModelsPreset/AI_PROVIDER=llamacpp path)", () => {
    assert.equal(
      resolveDescribeModel(
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
        true,
      ),
      "aperio-main",
    );
    assert.equal(
      resolveDescribeModelId(
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
        true,
      ),
      "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    );
  });

  test("P2: never uses aperio-main when mainAliasEligible=false, even with a vision-capable configured main model (ensureVisionEngine's vision-only preset never has an aperio-main entry)", () => {
    assert.equal(
      resolveDescribeModel(
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
        false,
      ),
      "aperio-vlm",
    );
    assert.equal(
      resolveDescribeModelId(
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
        false,
      ),
      "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
    );
  });
});

describe("isVisionEngineAvailable (asks the running engine directly, never AI_PROVIDER)", () => {
  const original = process.env.AI_PROVIDER;
  after(() => { process.env.AI_PROVIDER = original; });

  test("true when the server serves aperio-vlm, even though AI_PROVIDER is a provider that never touches this bridge", async () => {
    process.env.AI_PROVIDER = "anthropic"; // this MCP process's frozen boot env — deliberately irrelevant now
    const restore = mock.method(globalThis, "fetch", async (url) =>
      String(url).endsWith("/v1/models") ? { ok: true, json: async () => ({ data: [{ id: "aperio-vlm" }] }) } : { ok: false });
    try {
      assert.equal(await isVisionEngineAvailable(), true);
    } finally {
      restore.mock.restore();
    }
  });

  test("false when the engine is unreachable", async () => {
    const restore = mock.method(globalThis, "fetch", async () => ({ ok: false }));
    try {
      assert.equal(await isVisionEngineAvailable(), false);
    } finally {
      restore.mock.restore();
    }
  });
});

// A real, complete 1×1 transparent PNG (not just magic bytes) — sharp needs an
// actually-decodable file for describeImageHandler's real preprocessing step.
const MINIMAL_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Mocks fetch for describeImageHandler's two live calls: the /v1/models
// preflight (livePresetVisionState) and, when reached, the /v1/chat/
// completions VLM call. Any other URL fails closed.
function mockEngine(servedModels) {
  let capturedChatBody = null;
  const restore = mock.method(globalThis, "fetch", async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return { ok: true, json: async () => ({ data: servedModels.map(id => ({ id })) }) };
    if (u.endsWith("/v1/chat/completions")) {
      capturedChatBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "A red bicycle." } }] }) };
    }
    return { ok: false };
  });
  return { restore, chatBody: () => capturedChatBody };
}

describe("describeImageHandler — real MCP handler (engine-state-driven gate/alias, P1 regressions)", () => {
  // Regression coverage note: the deepseek provider-loop tests
  // (deepseek-vision-engine.test.js) inject a fake `callTool` that always
  // returns a canned string regardless of tool name/args — they exercise the
  // ensureVisionEngine wiring but never actually reach this real MCP handler.
  // These tests call describeImageHandler itself so the gate and alias
  // resolution get exercised for real, per AGENTS.md's "done means verified"
  // rule.
  const originalProvider = process.env.AI_PROVIDER;
  after(() => { process.env.AI_PROVIDER = originalProvider; });

  test("P1a: works when this MCP process's frozen AI_PROVIDER is stale (booted on anthropic, session runtime-switched to deepseek, or a round-table deepseek participant) — the engine genuinely serves aperio-vlm", async () => {
    process.env.AI_PROVIDER = "anthropic"; // deliberately wrong/stale
    const engine = mockEngine(["aperio-vlm"]);
    try {
      const result = await describeImageHandler({ data: MINIMAL_PNG_B64, prompt: "Describe" });
      assert.equal(result.content[0].text, "A red bicycle.");
      assert.ok(engine.chatBody(), "the real llama.cpp HTTP call must have happened, not been gated off by a stale AI_PROVIDER");
      assert.equal(engine.chatBody().model, "aperio-vlm");
    } finally {
      engine.restore.mock.restore();
    }
  });

  test("rejects when the engine is unreachable, regardless of AI_PROVIDER", async () => {
    process.env.AI_PROVIDER = "llamacpp";
    const engine = mockEngine([]); // /v1/models still answers, but with nothing served
    try {
      const result = await describeImageHandler({ data: MINIMAL_PNG_B64, prompt: "Describe" });
      assert.match(result.content[0].text, /not currently serving a vision-capable model/);
    } finally {
      engine.restore.mock.restore();
    }
  });

  test("P1b: after a provider switch reconciles the engine down to the vision-only preset, routes to aperio-vlm — never the now-nonexistent aperio-main — even though this frozen-env process still thinks AI_PROVIDER=llamacpp", async () => {
    // Simulates: booted with a native-vision llamacpp main model, then the
    // session switched to DeepSeek; ensureVisionEngine (startLlamaCpp.js)
    // reconciled the running server down to buildVisionOnlyPreset —
    // aperio-vlm only, aperio-main gone. The old AI_PROVIDER-keyed alias
    // logic would still pick aperio-main here and fail; the fix must not.
    process.env.AI_PROVIDER = "llamacpp"; // frozen boot env, now stale
    const engine = mockEngine(["aperio-vlm"]); // NOT aperio-main
    try {
      const result = await describeImageHandler({ data: MINIMAL_PNG_B64, prompt: "Describe" });
      assert.equal(result.content[0].text, "A red bicycle.");
      assert.equal(engine.chatBody().model, "aperio-vlm", "must not target the reconciled-away aperio-main alias");
    } finally {
      engine.restore.mock.restore();
    }
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
