// tests/harness/no-tool-use-diagnostic.test.js
//
// Regression coverage for checkNoToolUse() (lib/agent/turn-diagnostics.js)
// against the real runAgentLoop, not just the isolated unit test — the unit
// test (tests/unit/agent/turn-diagnostics.test.js) proves the function is
// correct given a `hadMutationToolOffered` flag, but can't prove the CALLER
// (lib/agent/index.js) computes that flag correctly. A code-review P2 found
// that computing it from the pre-cap profile plan (turn.profiles) is wrong:
// tool-profiles.js can classify a turn as "file-edit" from the user's text
// alone, then have every one of that profile's tools stripped out by the
// agent's own toolAllowlist or by capToolsForProvider's schema-budget cap —
// in which case the model never actually had a file-write tool in hand, and
// the pre-cap check would still fire a false "wrote code instead of a file"
// warning. The fix reads the flag from the turn's FINAL attached tool-name
// set (turnCacheByMessages.get(messages).names) instead. This file drives
// two real turns through a real runAgentLoop with a narrowed toolAllowlist
// to prove that fix, plus a counter-scenario proving the diagnostic still
// fires when a mutation tool genuinely is available and ignored (so the fix
// doesn't just always suppress the check).
//
// Uses the same real-loop/fake-model harness as tests/harness/harness.test.js
// (see tests/harness/README.md) but drives createAgent directly, since
// run-scenario.js's shared helper supports neither a custom toolAllowlist
// nor more than one runAgentLoop call per scenario.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgent } from "../../lib/agent.js";
import { makeSinkEmitter } from "../../lib/emitters/sinkEmitter.js";
import { runWithPaths } from "../../lib/routes/paths.js";
import { createHarnessHostTools } from "./host-tools.js";

function stubMcpTransport(t) {
  t.mock.method(StdioClientTransport.prototype, "start", async () => {});
  t.mock.method(StdioClientTransport.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: [] }));
  t.mock.method(Client.prototype, "callTool", async () => {
    throw new Error("scenario reached the real MCP boundary — every tool used must be a host tool");
  });
}

// userText deliberately matches tool-profiles.js's fileEditIntent regex
// (explicitPersistenceIntent "edit" + a named .js file target), so file-edit
// is classified active regardless of what's actually attachable.
const FILE_EDIT_USER_TEXT = "edit utils.js to add a cache";
const FENCED_CODE_ANSWER = "Here's the change:\n```js\nfunction withCache() {}\n```";

async function setup(t, { toolAllowlist }) {
  stubMcpTransport(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-harness-notool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratchDir = path.join(root, "scratch");
  fs.mkdirSync(scratchDir, { recursive: true });

  // Mutable and re-read fresh by mock-provider.js on every runAgentLoop call
  // (`const script = Array.isArray(provider.script) ? provider.script : []`
  // inside the loop body), so mutating its contents between two separate
  // runAgentLoop calls scripts two independent "turns" against one agent.
  const script = [];
  const agent = await createAgent({
    root,
    version: "1.0.0-harness",
    spec: { id: "no-tool-use-diagnostic-test-agent", toolAllowlist },
    providerConfig: { name: "mock", script },
    hostTools: createHarnessHostTools({ scratchDir }),
  });

  const sink = makeSinkEmitter();
  const messages = [];

  async function runTurn(userText) {
    messages.push({ role: "user", content: userText });
    script.length = 0;
    script.push({ text: FENCED_CODE_ANSWER });
    return runWithPaths([root], [root], scratchDir, () =>
      agent.runAgentLoop(messages, sink.emitter, {}, () => null, () => {}));
  }

  return { runTurn, sink };
}

test("a false-write-claim-shaped turn does NOT warn when the mutation tool was capped away by the agent's toolAllowlist", async (t) => {
  // No "write_file"/"edit_file"/"append_file"/etc — only "recall", which
  // preflight always probes and host-tools.js always services, so the turn
  // completes cleanly with no tool actually available to write with.
  const { runTurn, sink } = await setup(t, { toolAllowlist: ["recall"] });

  await runTurn(FILE_EDIT_USER_TEXT);
  await runTurn(FILE_EDIT_USER_TEXT + " again");

  assert.ok(
    !sink.events.some(e => e.type === "no_tool_use_detected"),
    "no_tool_use_detected must not fire when no mutation tool was ever actually attached this turn",
  );
});

test("the same scenario still warns when the mutation tool IS actually available and ignored (proves the fix isn't a blanket suppression)", async (t) => {
  const { runTurn, sink } = await setup(t, { toolAllowlist: null });

  await runTurn(FILE_EDIT_USER_TEXT);
  let fired = sink.events.some(e => e.type === "no_tool_use_detected");
  assert.equal(fired, false, "a single turn is not yet evidence");

  await runTurn(FILE_EDIT_USER_TEXT + " again");
  fired = sink.events.some(e => e.type === "no_tool_use_detected");
  assert.ok(fired, "no_tool_use_detected should still fire when write_file was genuinely offered and never called");
});

// The second P2 finding this file used to cover (modelIsCapable() gating on
// APERIO_CAPABLE_MODELS) no longer applies: that name-list capability gate
// was deleted 2026-08-26 (model-vision-autodetect plan, WS2) — every model
// gets tools now, so there is no "incapable model never offered any tools"
// state left to guard against.

function sseChunk(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

function fencedCodeSseStream() {
  const enc = new TextEncoder();
  const chunks = [
    sseChunk({ choices: [{ index: 0, delta: { content: FENCED_CODE_ANSWER }, finish_reason: null }] }),
    sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { input_tokens: 10, output_tokens: 8 } }),
    "data: [DONE]\n\n",
  ];
  return new ReadableStream({
    start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); },
  });
}

// ── Third P2 finding: the vision filter runs AFTER the cached plan ──────────
//
// turn.names is the cached, pre-vision-filter set. resolveToolNamesForTurn()
// then applies filterVisionTools(), which — for a capable local model on a
// standalone-vision turn — CLEARS the set entirely (tool-profiles.js:243), so
// the model receives no tools at all. Reading the flag off turn.names missed
// that: a file-edit-shaped turn leaves its profile in the two-turn
// classification window (recentUserText), so the immediately following
// image-only turn still plans write_file/edit_file it will never be sent, and
// a small OCR-style fenced-code answer completed the streak and fired the
// warning the earlier two fixes exist to prevent.

const IMAGE_USER_TEXT = "describe this image";
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a standalone-vision turn does NOT warn, even though the cached plan still names a mutation tool the vision filter stripped (P2 regression)", async (t) => {
  stubMcpTransport(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) return { ok: true, status: 200, body: null, text: async () => "" };
    if (u.endsWith("/chat/completions")) return { ok: true, status: 200, body: fencedCodeSseStream() };
    throw new Error(`unexpected fetch in this test: ${u}`);
  });

  // modelCapabilitiesSync(model).vision must be true, or llamacpp.js routes
  // the raw image through the VLM bridge (which would answer the turn itself
  // and never reach the main loop) — measured from a cached mmproj file now,
  // not a name-list. Every model gets tools regardless of name (the
  // APERIO_CAPABLE_MODELS gate this test used to also need was deleted
  // 2026-08-26), so only the vision cache fixture is needed here.
  const model = "harness-org/vision-test-model-GGUF";
  const previousLlamaCache = process.env.LLAMA_CACHE;
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-harness-notool-vision-cache-"));
  const repoDir = path.join(cacheRoot, "models--" + model.replaceAll("/", "--"));
  const snap = path.join(repoDir, "snapshots", "abc");
  fs.mkdirSync(path.join(repoDir, "refs"), { recursive: true });
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "refs", "main"), "abc");
  fs.writeFileSync(path.join(snap, "model-Q4_K_M.gguf"), Buffer.alloc(16));
  fs.writeFileSync(path.join(snap, "mmproj-BF16.gguf"), Buffer.alloc(16));
  process.env.LLAMA_CACHE = cacheRoot;
  t.after(() => {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    if (previousLlamaCache === undefined) delete process.env.LLAMA_CACHE;
    else process.env.LLAMA_CACHE = previousLlamaCache;
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-harness-notool-vision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratchDir = path.join(root, "scratch");
  fs.mkdirSync(scratchDir, { recursive: true });

  const agent = await createAgent({
    root,
    version: "1.0.0-harness",
    providerConfig: { name: "llamacpp", model },
    hostTools: createHarnessHostTools({ scratchDir }),
  });

  const sink = makeSinkEmitter();
  const messages = [];
  const run = () => runWithPaths([root], [root], scratchDir, () =>
    agent.runAgentLoop(messages, sink.emitter, {}, () => null, () => {}));

  // Turn 1: a genuine file-edit turn answered with prose — write_file really
  // was offered and ignored, so this legitimately puts the streak at 1.
  messages.push({ role: "user", content: FILE_EDIT_USER_TEXT });
  await run();
  assert.equal(
    sink.events.some(e => e.type === "no_tool_use_detected"), false,
    "a single turn is not yet evidence",
  );

  // Turn 2: image only. recentUserText's two-turn window still carries turn
  // 1's file-edit wording, so the cached plan still names write_file — but
  // filterVisionTools cleared every tool before the request went out.
  messages.push({
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: ONE_PIXEL_PNG } },
      { type: "text", text: IMAGE_USER_TEXT },
    ],
  });
  await run();

  assert.ok(
    !sink.events.some(e => e.type === "no_tool_use_detected"),
    "no_tool_use_detected must not fire on a turn whose tools the vision filter stripped before sending",
  );
});
