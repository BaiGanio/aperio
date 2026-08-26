// tests/integration/agent/providers/deepseek-vision-engine.test.js
//
// WS4 (model-vision-autodetect plan): DeepSeek is a provider-level vision
// blind, so an image turn routes through the local VLM bridge — and since
// server.js only boots llama-server for AI_PROVIDER=llamacpp, that engine may
// not be running yet on a DeepSeek install. runDeepSeekLoop now calls
// ensureVisionEngine() first. This file covers the wiring: the no-op fast
// path when the engine is already up, and the user-facing notice when it
// fails to start.
//
// Isolated from tests/unit/providers/deepseek.test.js because it needs its
// own child_process.spawn mock, installed before startLlamaCpp.js (imported
// transitively via deepseek.js) creates its ESM facade for "child_process" —
// same technique as tests/integration/mcp/tools/shell.test.js.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const cp = require("child_process");

let spawnCalls = [];
mock.method(cp, "spawn", (...args) => {
  spawnCalls.push(args);
  return { on: () => {}, unref: () => {}, pid: 70001 };
});

// Isolate llama.cpp's preset/state lifecycle from the shared ./var/llamacpp a
// real Aperio process reads and writes (same requirement as
// startLlamaCpp.test.js — PRESET_DIR is frozen at import time).
const RUNTIME_DIR = mkdtempSync(join(tmpdir(), "aperio-deepseek-vision-test-"));
process.env.APERIO_LLAMACPP_RUNTIME_DIR = RUNTIME_DIR;
process.env.NODE_ENV ??= "test";
after(() => { rmSync(RUNTIME_DIR, { recursive: true, force: true }); });

let runDeepSeekLoop;
before(async () => {
  const mod = await import("../../../../lib/agent/providers/deepseek.js");
  runDeepSeekLoop = mod.runDeepSeekLoop;
});

function baseCtx(overrides = {}) {
  return {
    provider: {
      name: "deepseek",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-test",
      contextWindow: 64000,
      vision: false,
    },
    callTool: mock.fn(async (name) => {
      assert.equal(name, "describe_image");
      return "A red bicycle.";
    }),
    getSystemPrompt: () => "You are a helpful assistant.",
    getOpenAiTools: () => [],
    reasoningAdapter: {
      createState: () => ({}),
      processDelta: (delta) => ({ contentToken: delta?.content ?? "" }),
      thinks: false,
      stripReasoning: (t) => t,
    },
    state: { noTools: false, thinks: false },
    ...overrides,
  };
}

function sseStream(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); } });
}

function textSSEChunks(text) {
  return [
    `data: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":null}]}\n\n`,
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":4}}\n\n',
    "data: [DONE]\n\n",
  ];
}

const imageMessages = () => [{
  role: "user",
  content: [
    { type: "text", text: "what colour is this?" },
    { type: "image", source: { media_type: "image/png", data: "cGl4ZWxz" } },
  ],
}];

afterEach(() => { spawnCalls = []; });

describe("runDeepSeekLoop — ensureVisionEngine wiring", () => {
  test("already-up llama-server: no spawn, image still gets bridged normally", async (t) => {
    t.mock.method(globalThis, "fetch", async (url) => {
      if (String(url).endsWith("/health")) return { ok: true };
      return { ok: true, status: 200, body: sseStream(textSSEChunks("It's red.")), text: async () => "" };
    });

    const emitter = { send: mock.fn() };
    const result = await runDeepSeekLoop(imageMessages(), emitter, {}, undefined, () => {}, baseCtx());

    assert.equal(result, "It's red.");
    assert.equal(spawnCalls.length, 0, "an already-up engine must never be spawned");
  });

  test("a failed vision-engine start surfaces a user-facing notice and still answers text-only", { timeout: 20_000 }, async (t) => {
    t.mock.method(globalThis, "fetch", async (url) => {
      if (String(url).endsWith("/health")) return { ok: false }; // never comes up
      return { ok: true, status: 200, body: sseStream(textSSEChunks("I can't see it, but here's my answer.")), text: async () => "" };
    });
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });

    const emitter = { send: mock.fn() };
    const p = runDeepSeekLoop(imageMessages(), emitter, {}, undefined, () => {}, baseCtx());

    // Let ensureVisionEngine's internal ensureLlamaCpp reach its spawn-poll
    // wait loop, then fast-forward past MAX_WAIT_MS (30s) so it times out.
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    t.mock.timers.tick(31_000);
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

    const result = await p;
    assert.equal(result, "I can't see it, but here's my answer.", "the turn still completes, text-only");
    const sentText = emitter.send.mock.calls.map(c => c.arguments[0]?.text ?? "").join("");
    assert.match(sentText, /Vision not available/i);
    assert.match(sentText, /local vision model could not start/i);
  });
});
