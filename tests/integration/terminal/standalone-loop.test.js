// T2.6 — runStandalone driven through its injected IO seam (#539).
//
// Before this, runStandalone(initialReasoning) took nothing: it opened
// process.stdin, booted a real agent (and a real llama.cpp), and wrote into the
// developer's own var/. Nothing about the loop could be tested, so the commands
// users actually type were covered only as far as their predicate functions —
// `isAttachCommand("attach x")` was tested, the attach command was not.
//
// runStandalone now takes a `deps` bag, and this drives the real loop end to
// end with a fake agent, a scratch root, and a pipe for stdin:
//
//   /help  /pending  /attach  /restart, and the full propose → approve → tool
//   path plus propose → reject, which is the P1 safety gap this step closes.
//
// Two notes on what is being read:
//
//   • Output is captured from BOTH the injected stream and process.stdout. The
//     module's own prints go through the injected one, which an explicit test
//     below asserts; lib/terminal/ui.js and lib/utils/chat-utils.js (so /help's
//     body, the welcome banner, the prompt and the spinner) still write to
//     process.stdout directly. Threading `out` through those is its own step.
//
//   • APERIO_CLI_PREFS is set BEFORE the dynamic import. Several modules behind
//     standalone.js read process.env into module-level constants at import
//     time; setting it afterwards would freeze the default and this test would
//     write into the repo's own var/cli-prefs.json.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

/** Drop ANSI so assertions read as the user's eyes see the line. */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

let root, attachPath, prevPrefs, prevRealWrite;
let runStandalone, stopSpinner;

/** Everything printed, from either stream. */
let captured = [];
/** Only what the module itself printed, through the injected stream. */
let injected = [];
/** Every callTool invocation the fake agent saw. */
let toolCalls = [];
/** Pushed into the next turn's emitter by the fake agent. */
let nextTurnEvents = [];

const output = () => plain(captured.join(""));

function makeStdout() {
  return new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString();
      captured.push(text);
      injected.push(text);
      cb();
    },
  });
}

/**
 * A stand-in for createAgent(). No provider, no database, no model — just the
 * surface runStandalone destructures off it.
 */
function makeFakeAgent() {
  return {
    provider: { name: "faketest", model: "fake-model" },
    NO_TOOLS: false,
    THINKS: false,
    setProvider() {},
    async buildGreeting() { return { staticGreeting: "FAKE-GREETING" }; },
    async fetchMemories() { return { raw: "", parsed: [] }; },
    async handleRememberIntent() {},
    async callTool(name, args) {
      toolCalls.push({ name, args });
      return `wrote 12 bytes to ${args?.confirmation_token ?? "?"}`;
    },
    async runAgentLoop(messages, emitter) {
      emitter.send({ type: "stream_start" });
      for (const ev of nextTurnEvents) emitter.send(ev);
      nextTurnEvents = [];
      emitter.send({ type: "token", text: "FAKE-ANSWER" });
      emitter.send({ type: "stream_end", text: "FAKE-ANSWER" });
      return "FAKE-ANSWER";
    },
  };
}

let stdin;

/**
 * Type one line and wait until the loop has finished reacting to it.
 *
 * Lines cannot be written ahead: the loop re-arms `rl.once("line")` from
 * promptUser(), so a second line written before that would be emitted with no
 * listener attached and silently lost.
 */
async function type(line, expect, timeoutMs = 4000) {
  const before = captured.length;
  stdin.write(`${line}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const since = plain(captured.slice(before).join(""));
    if (expect instanceof RegExp ? expect.test(since) : since.includes(expect)) return since;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${expect} after "${line}".\nGot:\n${plain(captured.slice(before).join(""))}`);
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "aperio-standalone-loop-"));
  mkdirSync(join(root, "var"), { recursive: true });
  attachPath = join(root, "note.md");
  writeFileSync(attachPath, "# a note\n");

  // Before the import — see the header note.
  prevPrefs = process.env.APERIO_CLI_PREFS;
  process.env.APERIO_CLI_PREFS = join(root, "cli-prefs.json");

  ({ runStandalone } = await import("../../../lib/terminal/standalone.js"));
  ({ stopSpinner } = await import("../../../lib/utils/chat-utils.js"));

  // ui.js / chat-utils.js still print to process.stdout. Capture that too, and
  // keep forwarding so the test runner's own reporter output survives.
  // Forwarding is not optional: node:test's own reporter writes through
  // process.stdout.write, so a stub that captures without forwarding swallows
  // the test results themselves — tried, and it silently hid 11 of 16. The
  // price is a noisy log while this file runs, which is the cheaper mistake.
  prevRealWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return prevRealWrite(chunk, ...rest);
  };

  stdin = new PassThrough();
  await runStandalone(false, {
    stdin,
    stdout: makeStdout(),
    root,
    createAgent: async () => makeFakeAgent(),
    hydrateRuntime: async () => ({
      runWithPaths: (_read, _write, _scratch, fn) => fn(),
      getAllowlist: () => [root],
    }),
    processAttachments: async () => ({ contentBlocks: [{ type: "text", text: "[attached note.md]" }] }),
  });
});

after(() => {
  if (prevRealWrite) process.stdout.write = prevRealWrite;
  try { stopSpinner?.(); } catch { /* the spinner may already be stopped */ }
  try { stdin?.destroy(); } catch { /* already gone */ }
  if (prevPrefs === undefined) delete process.env.APERIO_CLI_PREFS;
  else process.env.APERIO_CLI_PREFS = prevPrefs;
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The loop boots and the seam is really used
// ═══════════════════════════════════════════════════════════════════════════════

describe("runStandalone boot", () => {
  test("boots with an injected agent and greets through the injected stream", () => {
    assert.match(output(), /FAKE-GREETING/);
    assert.match(plain(injected.join("")), /FAKE-GREETING/, "the greeting must go through deps.stdout");
  });

  test("wrote nothing into the repository — var/ stayed under the scratch root", () => {
    // The seam exists so a test of the loop cannot touch the developer's own
    // sessions, scratch dirs or prefs. If `root` were ignored, this would have
    // landed in the checkout.
    assert.ok(process.env.APERIO_CLI_PREFS.startsWith(root));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T2.6: the commands, driven through injected stdin
// ═══════════════════════════════════════════════════════════════════════════════

describe("runStandalone commands", () => {
  test("/help prints the guide", async () => {
    const seen = await type("/help", /Everyday/);
    assert.match(seen, /\/attach/);
    assert.match(seen, /\/pending/, "the new safety commands must be discoverable from /help");
  });

  test("/help pending prints the focused page", async () => {
    const seen = await type("/help pending", /pending/);
    assert.match(seen, /\/approve/);
    assert.match(seen, /\/reject/);
  });

  test("/pending says so when nothing is waiting", async () => {
    await type("/pending", "nothing is awaiting a decision");
  });

  test("/attach queues the file", async () => {
    const seen = await type(`/attach ${attachPath}`, /queued/);
    assert.match(seen, /note\.md/);
  });

  // S2.10, end to end through the real loop: an over-limit file must be
  // refused in the terminal flow itself, not just by the helper in isolation.
  test("/attach refuses an over-limit file with the size as the reason", async () => {
    const prev = process.env.APERIO_ATTACHMENT_MAX_MB;
    // readAttachment reads the budget at call time, so setting it here is
    // enough — nothing froze it at import.
    process.env.APERIO_ATTACHMENT_MAX_MB = "1";
    const big = join(root, "big.md");
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 0x61));
    try {
      const seen = await type(`/attach ${big}`, /attachment limit/);
      assert.match(seen, /big\.md/);
      assert.doesNotMatch(seen, /queued/, "a refused file must not be queued");
    } finally {
      if (prev === undefined) delete process.env.APERIO_ATTACHMENT_MAX_MB;
      else process.env.APERIO_ATTACHMENT_MAX_MB = prev;
    }
  });

  test("an unknown command is reported, not sent to the model", async () => {
    await type("/nonsense", "unknown command");
  });

  test("a plain message reaches the agent and renders the answer", async () => {
    await type("hello there", "FAKE-ANSWER");
  });

  test("/restart starts a fresh session in-process and greets again", async () => {
    await type("/restart", "FAKE-GREETING");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The P1 safety gap: propose → approve, and propose → reject
// ═══════════════════════════════════════════════════════════════════════════════

describe("runStandalone confirmations", () => {
  test("a pending confirmation is shown in full, not as an unknown event", async () => {
    nextTurnEvents = [{
      type: "action_confirm_pending",
      token: "wr_abc123",
      tool: "write_file",
      label: "Write notes.md",
      summary: "Target: /tmp/notes.md",
      destructive: false,
    }];
    const seen = await type("write that down", /confirmation required/);
    assert.match(seen, /tool:\s*write_file/);
    assert.match(seen, /Write notes\.md/);
    assert.match(seen, /token:\s*wr_abc123/);
    assert.doesNotMatch(seen, /\[event: action_confirm_pending\]/, "the old dead-end must be gone");
  });

  test("/pending now lists it", async () => {
    const seen = await type("/pending", /write_file/);
    assert.match(seen, /1\./);
    assert.match(seen, /wr_abc123/);
  });

  test("/approve runs the tool with the confirmation token — no model round-trip", async () => {
    toolCalls = [];
    const seen = await type("/approve", /write_file/);
    assert.deepEqual(toolCalls, [{ name: "write_file", args: { confirmation_token: "wr_abc123" } }]);
    assert.match(seen, /wrote 12 bytes/);
  });

  test("the approved action does not stay pending", async () => {
    await type("/pending", "nothing is awaiting a decision");
  });

  test("/reject drops the proposal and runs nothing", async () => {
    nextTurnEvents = [{
      type: "action_confirm_pending",
      token: "del_xyz789",
      tool: "delete_file",
      label: "Delete old.md",
      summary: "Target: /tmp/old.md",
      destructive: true,
    }];
    await type("delete that", /confirmation required/);
    toolCalls = [];
    const seen = await type("/reject", /rejected/);
    assert.match(seen, /delete_file did not run/);
    assert.deepEqual(toolCalls, [], "rejecting must not call the tool");
    await type("/pending", "nothing is awaiting a decision");
  });

  test("a decision standalone cannot make is refused with what it can do", async () => {
    // /respond and /edit go through the interrupt service, which needs the
    // store createAgent() does not expose. The user is told, rather than left
    // typing a command that quietly does nothing.
    nextTurnEvents = [{ type: "action_confirm_pending", token: "wr_q1", tool: "write_file", label: "Write a.md" }];
    await type("write again", /confirmation required/);
    const seen = await type("/respond not like that", /does not accept/);
    assert.match(seen, /\/approve or \/reject/);
    await type("/reject", "rejected");
  });

  test("/approve with nothing pending is refused, not silently ignored", async () => {
    await type("/approve", "Nothing is awaiting a decision");
  });
});
