import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

// ─── Patch fs BEFORE importing roundtable.js ─────────────────────────────────
// writeRoundtableRecord() writes a markdown discussion record to var/roundtables/
// at the end of every discussion. Tests must never touch the real disk, so we
// stub the fs calls it makes. Node binds a module's named `fs` imports from the
// CJS module cache at first import, so patching here — before the dynamic import
// below — makes roundtable.js see these no-ops for every write it attempts.
const require = createRequire(import.meta.url);
const fsSync  = require("fs");
mock.method(fsSync, "mkdirSync",      () => {});
mock.method(fsSync, "existsSync",     () => false);
mock.method(fsSync, "writeFileSync",  () => {});
mock.method(fsSync, "appendFileSync", () => {});

const {
  parseAgreement,
  foldReplyToPlainText,
  buildAnswerPrompt,
  buildReviewPrompt,
  buildRevisePrompt,
  buildRereviewPrompt,
  withUserAttachments,
  runRoundTable,
} = await import("../../../lib/workers/roundtable.js");

// ─── parseAgreement ──────────────────────────────────────────────────────────
describe("parseAgreement", () => {
  test("leading AGREED: is treated as agreement and extracts the body", () => {
    const r = parseAgreement("AGREED: looks correct, Canberra is the capital");
    assert.strictEqual(r.agreed, true);
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.body, "looks correct, Canberra is the capital");
  });

  test("**AGREED:** with markdown bold leading", () => {
    const r = parseAgreement("**AGREED:** yes");
    assert.strictEqual(r.agreed, true);
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.body, "yes");
  });

  test("lowercase agreed: is accepted (case-insensitive)", () => {
    const r = parseAgreement("agreed: ok");
    assert.strictEqual(r.agreed, true);
  });

  test("leading whitespace is tolerated", () => {
    const r = parseAgreement("   \n  AGREED: confirmed");
    assert.strictEqual(r.agreed, true);
    assert.strictEqual(r.body, "confirmed");
  });

  test("numbered objection list is NOT agreement", () => {
    const r = parseAgreement("1. Objection: claim X is wrong because…");
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, false);
  });

  test("AGREED mid-text without leading is flagged malformed", () => {
    const r = parseAgreement("Mostly I agreed but there are concerns about…");
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, true);
  });

  test("empty / null inputs are non-agreement and not malformed", () => {
    for (const v of [null, undefined, "", "   "]) {
      const r = parseAgreement(v);
      assert.strictEqual(r.agreed, false, `value=${JSON.stringify(v)}`);
      assert.strictEqual(r.malformed, false, `value=${JSON.stringify(v)}`);
    }
  });

  test("non-string inputs do not throw", () => {
    assert.doesNotThrow(() => parseAgreement(42));
    assert.doesNotThrow(() => parseAgreement({ foo: 1 }));
  });
});

// ─── foldReplyToPlainText ────────────────────────────────────────────────────
describe("foldReplyToPlainText", () => {
  test("string passthrough (trimmed)", () => {
    assert.strictEqual(foldReplyToPlainText("  hello  "), "hello");
  });

  test("Anthropic-style content blocks: tool_use & tool_result stripped, text kept", () => {
    const blocks = [
      { type: "text", text: "Here is the answer:" },
      { type: "tool_use", id: "toolu_123", name: "recall", input: {} },
      { type: "tool_result", tool_use_id: "toolu_123", content: "some memory" },
      { type: "text", text: "Canberra." },
    ];
    assert.strictEqual(foldReplyToPlainText(blocks), "Here is the answer:\nCanberra.");
  });

  test("empty content array → empty string", () => {
    assert.strictEqual(foldReplyToPlainText([]), "");
  });

  test("null/undefined → empty string", () => {
    assert.strictEqual(foldReplyToPlainText(null), "");
    assert.strictEqual(foldReplyToPlainText(undefined), "");
  });

  test("object with .text falls through to that field", () => {
    assert.strictEqual(foldReplyToPlainText({ text: "hi" }), "hi");
  });
});

// ─── Prompt builders ─────────────────────────────────────────────────────────
describe("PHASE-tagged prompt builders", () => {
  test("buildAnswerPrompt leads with PHASE: ANSWER", () => {
    const p = buildAnswerPrompt("What is the capital of Australia?");
    assert.match(p, /^PHASE: ANSWER\n/);
    assert.match(p, /What is the capital of Australia\?/);
  });

  test("buildReviewPrompt quotes user text and A1 with > markers", () => {
    const p = buildReviewPrompt("What is 2+2?", "It's 4.");
    assert.match(p, /^PHASE: REVIEW/);
    assert.match(p, /Original user question:\n> What is 2\+2\?/);
    assert.match(p, /Agent A's answer:\n> It's 4\./);
  });

  test("buildRevisePrompt quotes A1 and B1 objections", () => {
    const p = buildRevisePrompt("q?", "A1 text", "1. objection");
    assert.match(p, /^PHASE: REVISE/);
    assert.match(p, /Your previous answer:\n> A1 text/);
    assert.match(p, /Agent B's objections:\n> 1\. objection/);
  });

  test("buildRereviewPrompt quotes prior objections and revised A2", () => {
    const p = buildRereviewPrompt("q?", "1. prior obj", "revised A2");
    assert.match(p, /^PHASE: REREVIEW/);
    assert.match(p, /Your prior objections:\n> 1\. prior obj/);
    assert.match(p, /Agent A's revised answer:\n> revised A2/);
  });

  test("multi-line content is quoted with continuation > markers", () => {
    const p = buildReviewPrompt("line1\nline2", "a1");
    assert.match(p, /> line1\n> line2/);
  });
});

// ─── Test helpers ────────────────────────────────────────────────────────────
// Mock mirrors the real provider-loop contract: it appends an `assistant` turn
// onto the `messages` array (the orchestrator must NOT do so itself, otherwise
// round 2 would see a doubled assistant turn against a real provider).
function makeMockAgent({ id = "primary", persona = id, replies = [] } = {}) {
  let callIdx = 0;
  const calls = [];
  return {
    id, persona,
    provider: { name: "mock", model: `mock-${id}` },
    callTool: async () => "No memories found.",
    async runAgentLoop(messages, emitter, opts, _getAbort, _setAbort) {
      const userMsg = messages[messages.length - 1];
      calls.push({ messageCount: messages.length, prompt: userMsg?.content, opts });
      const reply = replies[callIdx++] ?? "AGREED: fallback agreement";
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "token", text: reply });
      emitter.send({ type: "stream_end", text: reply, usage: { input_tokens: 0, output_tokens: 0 } });
      // Mirror real provider behaviour: append the assistant turn ourselves.
      messages.push({ role: "assistant", content: reply });
      return reply;
    },
    _calls: calls,
  };
}

function makeMockWs() {
  const sent = [];
  return {
    sent,
    send(raw) { sent.push(JSON.parse(raw)); },
  };
}

// ─── runRoundTable orchestrator ──────────────────────────────────────────────
describe("runRoundTable orchestrator", () => {
  test("agreement on round 1 — A answers, B says AGREED, no second A call", async () => {
    const primary  = makeMockAgent({ id: "primary",  replies: ["Canberra is the capital."] });
    const verifier = makeMockAgent({ id: "verifier", replies: ["AGREED: that is correct."] });
    const ws = makeMockWs();
    const transcript = [];

    const result = await runRoundTable({
      primary, verifier,
      userText: "What is the capital of Australia?",
      sharedTranscript: transcript,
      ws,
      maxRounds: 3,
    });

    assert.strictEqual(result.agreed, true);
    assert.strictEqual(result.text, "that is correct.");
    assert.strictEqual(result.rounds, 2);                  // A1 + B1 → 2 agent turns
    assert.strictEqual(primary._calls.length, 1);          // A never called again
    assert.strictEqual(verifier._calls.length, 1);

    // Final consensus appended to shared transcript
    assert.strictEqual(transcript.at(-1).role, "assistant");
    assert.strictEqual(transcript.at(-1).content, "that is correct.");

    // Roundtable_agreed event emitted
    const agreedEvent = ws.sent.find(e => e.type === "roundtable_agreed");
    assert.ok(agreedEvent, "expected roundtable_agreed event");
    assert.strictEqual(agreedEvent.text, "that is correct.");

    // Phase chips emitted in order: answer → review
    const phases = ws.sent.filter(e => e.type === "roundtable_phase").map(e => e.phase);
    assert.deepStrictEqual(phases, ["answer", "review"]);

    // Every token/stream event carries agent_id
    const streamEvents = ws.sent.filter(e => ["stream_start", "token", "stream_end"].includes(e.type));
    for (const e of streamEvents) {
      assert.ok(e.agent_id, `event ${e.type} missing agent_id`);
    }
  });

  test("agreement on round 2 — A revises, B agrees", async () => {
    const primary  = makeMockAgent({ id: "primary",  replies: ["First answer.", "Revised answer addressing your points."] });
    const verifier = makeMockAgent({ id: "verifier", replies: ["1. Missing X.\n2. Wrong about Y.", "AGREED: the revision covers it."] });
    const ws = makeMockWs();
    const transcript = [];

    const result = await runRoundTable({
      primary, verifier,
      userText: "Is JS single-threaded?",
      sharedTranscript: transcript,
      ws,
      maxRounds: 3,
    });

    assert.strictEqual(result.agreed, true);
    assert.strictEqual(result.text, "the revision covers it.");
    assert.strictEqual(primary._calls.length, 2);
    assert.strictEqual(verifier._calls.length, 2);

    // Phases: answer → review → revise → rereview
    const phases = ws.sent.filter(e => e.type === "roundtable_phase").map(e => e.phase);
    assert.deepStrictEqual(phases, ["answer", "review", "revise", "rereview"]);

    // Re-review prompt to verifier should quote prior objections AND revised A
    const lastVerifierCall = verifier._calls.at(-1).prompt;
    assert.match(lastVerifierCall, /PHASE: REREVIEW/);
    assert.match(lastVerifierCall, /Missing X/);
    assert.match(lastVerifierCall, /Revised answer addressing your points/);
  });

  test("cap hit — no agreement after maxRounds, both positions surface", async () => {
    const primary  = makeMockAgent({ id: "primary",  replies: ["A1", "A2", "A3"] });
    const verifier = makeMockAgent({ id: "verifier", replies: ["1. obj", "1. still wrong", "1. still wrong v2"] });
    const ws = makeMockWs();
    const transcript = [];

    const result = await runRoundTable({
      primary, verifier,
      userText: "contested question",
      sharedTranscript: transcript,
      ws,
      maxRounds: 3,
    });

    assert.strictEqual(result.agreed, false);
    assert.strictEqual(result.positions.primary,  "A3");
    assert.strictEqual(result.positions.verifier, "1. still wrong v2");

    const noAgreeEvent = ws.sent.find(e => e.type === "roundtable_no_agreement");
    assert.ok(noAgreeEvent);
    assert.deepStrictEqual(noAgreeEvent.positions.map(p => p.agent_id), ["primary", "verifier"]);

    // Transcript holds both positions in a single composite assistant message
    const last = transcript.at(-1);
    assert.strictEqual(last.role, "assistant");
    assert.match(last.content, /no consensus/i);
    assert.match(last.content, /Agent A/);
    assert.match(last.content, /Agent B/);
  });

  test("abort before round 1 → no agent called, aborted event emitted", async () => {
    const primary  = makeMockAgent({ id: "primary"  });
    const verifier = makeMockAgent({ id: "verifier" });
    const ws = makeMockWs();
    const ac = new AbortController();
    ac.abort();

    const result = await runRoundTable({
      primary, verifier,
      userText: "anything",
      sharedTranscript: [],
      ws,
      getAbort: () => ac,
      setAbort: () => {},
      maxRounds: 3,
    });

    assert.strictEqual(result.interrupted, true);
    assert.strictEqual(primary._calls.length, 0);
    assert.strictEqual(verifier._calls.length, 0);
    assert.ok(ws.sent.find(e => e.type === "roundtable_aborted"));
  });

  test("rejects missing primary or verifier", async () => {
    await assert.rejects(
      runRoundTable({ primary: null, verifier: makeMockAgent(), userText: "x", ws: makeMockWs(), sharedTranscript: [] }),
      /requires both primary and verifier/,
    );
    await assert.rejects(
      runRoundTable({ primary: makeMockAgent(), verifier: null, userText: "x", ws: makeMockWs(), sharedTranscript: [] }),
      /requires both primary and verifier/,
    );
  });

  test("rejects empty userText", async () => {
    await assert.rejects(
      runRoundTable({
        primary: makeMockAgent(), verifier: makeMockAgent(),
        userText: "   ", ws: makeMockWs(), sharedTranscript: [],
      }),
      /non-empty userText/,
    );
  });

  test("attachments are propagated to BOTH agents' first turns", async () => {
    const primary  = makeMockAgent({ id: "primary",  replies: ["I see a red square."] });
    const verifier = makeMockAgent({ id: "verifier", replies: ["AGREED: it is a red square."] });
    const ws = makeMockWs();

    const userContent = [
      { type: "text",  text: "What is in this image?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ];

    await runRoundTable({
      primary, verifier,
      userText: "What is in this image?",
      userContent,
      sharedTranscript: [],
      ws,
      maxRounds: 3,
    });

    // Agent A's first prompt must be a content-block array containing the image block.
    const aFirst = primary._calls[0].prompt;
    assert.ok(Array.isArray(aFirst), "agent A turn 1 prompt should be content blocks (not a string)");
    assert.ok(aFirst.find(b => b.type === "image"), "agent A turn 1 must include the image block");
    assert.match(aFirst[0].text, /^PHASE: ANSWER/);

    // Agent B's REVIEW prompt must also include the image so it can verify A's reading.
    const bFirst = verifier._calls[0].prompt;
    assert.ok(Array.isArray(bFirst), "agent B turn 1 prompt should be content blocks");
    assert.ok(bFirst.find(b => b.type === "image"), "agent B REVIEW must include the image");
    assert.match(bFirst[0].text, /^PHASE: REVIEW/);
  });

  test("plain-text userContent stays a string (no needless content-blocks wrapper)", async () => {
    const primary  = makeMockAgent({ id: "primary",  replies: ["Canberra."] });
    const verifier = makeMockAgent({ id: "verifier", replies: ["AGREED: yes."] });
    const ws = makeMockWs();

    await runRoundTable({
      primary, verifier,
      userText: "Capital of Australia?",
      userContent: "Capital of Australia?",  // string form
      sharedTranscript: [],
      ws,
      maxRounds: 3,
    });

    assert.strictEqual(typeof primary._calls[0].prompt, "string", "no attachments → string prompt");
    assert.match(primary._calls[0].prompt, /^PHASE: ANSWER/);
  });

  test("tools are NOT disabled (agents can call read_image / read_file etc.)", async () => {
    const primary  = makeMockAgent({ id: "primary",  replies: ["Canberra."] });
    const verifier = makeMockAgent({ id: "verifier", replies: ["AGREED: yes."] });
    const ws = makeMockWs();

    await runRoundTable({
      primary, verifier,
      userText: "Capital of Australia?",
      sharedTranscript: [],
      ws,
      maxRounds: 3,
    });

    for (const c of [...primary._calls, ...verifier._calls]) {
      assert.notStrictEqual(c.opts?.noTools, true, "round-table must not force noTools:true");
    }
  });

  test("orchestrator does NOT push its own assistant turn — the provider loop owns that", async () => {
    // Round 2 requires the buffer shape [user, assistant, user] after turn 1.
    // If the orchestrator double-pushed, round 2's REVISE prompt would see
    // [user, assistant, assistant, user] and the test would catch it.
    const primary  = makeMockAgent({ id: "primary",  replies: ["A1", "A2"] });
    const verifier = makeMockAgent({ id: "verifier", replies: ["1. obj", "AGREED: ok"] });
    const ws = makeMockWs();

    await runRoundTable({
      primary, verifier,
      userText: "q?",
      sharedTranscript: [],
      ws,
      maxRounds: 3,
    });

    // primary turn 2 saw the buffer [user(ANSWER), assistant(A1), user(REVISE)] — len 3.
    assert.strictEqual(primary._calls[1].messageCount, 3,
      "round 2 must see exactly one assistant turn between the two user turns");
  });

  test("user turn is NOT re-pushed to sharedTranscript (wsHandler already pushed it)", async () => {
    const primary  = makeMockAgent({ id: "primary",  replies: ["A."] });
    const verifier = makeMockAgent({ id: "verifier", replies: ["AGREED: ok."] });
    const ws = makeMockWs();
    // Simulate wsHandler having already pushed the user turn with attachments.
    const transcript = [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: {} }] }];

    await runRoundTable({
      primary, verifier,
      userText: "hi",
      sharedTranscript: transcript,
      ws,
      maxRounds: 3,
    });

    // Final transcript: one user (the pre-existing one) + one assistant (consensus).
    assert.strictEqual(transcript.length, 2);
    assert.strictEqual(transcript[0].role, "user");
    assert.ok(Array.isArray(transcript[0].content), "original user message preserved with attachments");
    assert.strictEqual(transcript[1].role, "assistant");
  });
});

// ─── withUserAttachments ─────────────────────────────────────────────────────
describe("withUserAttachments", () => {
  test("string passthrough when userContent is a string", () => {
    assert.strictEqual(withUserAttachments("PHASE: ANSWER\nhi", "hi"), "PHASE: ANSWER\nhi");
  });

  test("string passthrough when userContent has no non-text blocks", () => {
    const out = withUserAttachments("PHASE: ANSWER\nhi", [{ type: "text", text: "hi" }]);
    assert.strictEqual(out, "PHASE: ANSWER\nhi");
  });

  test("wraps with content blocks when an image block is present", () => {
    const blocks = [
      { type: "text",  text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
    ];
    const out = withUserAttachments("PHASE: ANSWER\nwhat is this?", blocks);
    assert.ok(Array.isArray(out));
    assert.strictEqual(out[0].type, "text");
    assert.match(out[0].text, /^PHASE: ANSWER/);
    assert.strictEqual(out[1].type, "image");
  });

  test("drops only the first block (user's typed text replaced by PHASE prompt)", () => {
    const blocks = [
      { type: "text",  text: "what is this?" },
      { type: "image", source: {} },
      { type: "text",  text: "[Attached file: notes.md] ..." },
    ];
    const out = withUserAttachments("PHASE: ANSWER\n...", blocks);
    assert.strictEqual(out.length, 3, "PHASE text + image + inlined-file text");
    assert.strictEqual(out[0].type, "text");
    assert.match(out[0].text, /^PHASE: ANSWER/);
    assert.strictEqual(out[1].type, "image");
    assert.strictEqual(out[2].type, "text");
    assert.match(out[2].text, /Attached file: notes\.md/);
  });

  test("forwards inlined text-file attachments (regression: agents must see uploaded JSON/code/markdown)", () => {
    // Mirrors what wsHandler builds when the user uploads characters.json:
    //   [user text, inlined file content as a text block]
    const blocks = [
      { type: "text", text: "what's on this file?" },
      { type: "text", text: "\n[Attached file: characters.json]\n```json\n{\"a\":1}\n```" },
    ];
    const out = withUserAttachments("PHASE: ANSWER\nwhat's on this file?", blocks);
    assert.ok(Array.isArray(out), "file attachment must promote prompt to content blocks");
    assert.strictEqual(out.length, 2);
    assert.match(out[1].text, /characters\.json/);
    assert.match(out[1].text, /"a":1/);
  });
});
