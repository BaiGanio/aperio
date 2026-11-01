// tests/unit/agent/redaction-relay.test.js
//
// Issue #531, review round 3, P1: Codex runs its own mcp/index.js subprocess
// and calls tools directly, bypassing callToolHooked entirely (lib/agent/
// providers/codex.js:311-313) — so the proactive path that normally merges a
// recall result's redaction map into the turn's redactionMap never runs for
// it, and echoed placeholders reached Codex users unrestored. installRedactionRelay's
// on-demand fallback (scan streamed text for embedded correlation ids, redeem
// each unseen one via takeRedactionMap()) is what closes that gap — this
// tests the relay directly, with a fake takeRedactionMap, so it runs fast and
// without a real MCP round trip.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installRedactionRelay } from "../../../lib/agent/redaction-relay.js";

const ID_A = "c0ffee00-0000-4000-8000-000000000000";
const ID_B = "d0ffee00-0000-4000-8000-000000000000";
const TOKEN_A = `«${ID_A}_0_EMAIL_0»`;
const TOKEN_B = `«${ID_B}_0_EMAIL_0»`;

function makeEmitter() {
  const events = [];
  return { send: (msg) => events.push(msg), events };
}

describe("installRedactionRelay — proactively populated map (normal providers)", () => {
  test("restores a token event whose correlation id is already in redactionMap", async (t) => {
    const emitter = makeEmitter();
    const redactionMap = new Map([[TOKEN_A, "alice@example.com"]]);
    const takeRedactionMap = t.mock.fn(async () => { throw new Error("must not be called — already known"); });
    const relay = installRedactionRelay(emitter, redactionMap, takeRedactionMap);

    emitter.send({ type: "token", text: `Contact: ${TOKEN_A}` });
    emitter.send({ type: "stream_end", text: `Contact: ${TOKEN_A}` });
    await relay.drain();

    assert.equal(takeRedactionMap.mock.callCount(), 0);
    assert.deepEqual(emitter.events.map(e => e.text), ["Contact: alice@example.com", "Contact: alice@example.com"]);
  });
});

describe("installRedactionRelay — on-demand fallback (Codex-style bypass)", () => {
  test("redeems a correlation id embedded in the text when redactionMap starts empty", async () => {
    const emitter = makeEmitter();
    const redactionMap = new Map(); // nothing proactively populated — the Codex case
    const takeRedactionMap = async (id) => (id === ID_A ? { [TOKEN_A]: "alice@example.com" } : null);
    const relay = installRedactionRelay(emitter, redactionMap, takeRedactionMap);

    emitter.send({ type: "token", text: `Contact: ${TOKEN_A}` });
    emitter.send({ type: "stream_end", text: `Contact: ${TOKEN_A}` });
    await relay.drain();

    assert.deepEqual(emitter.events.map(e => e.text), ["Contact: alice@example.com", "Contact: alice@example.com"]);
    assert.equal(redactionMap.get(TOKEN_A), "alice@example.com", "the redeemed entry must be merged into the turn's map");
  });

  test("redeems each distinct correlation id only once even if it appears in multiple events", async (t) => {
    const emitter = makeEmitter();
    const redactionMap = new Map();
    const takeRedactionMap = t.mock.fn(async () => ({ [TOKEN_A]: "alice@example.com" }));
    const relay = installRedactionRelay(emitter, redactionMap, takeRedactionMap);

    emitter.send({ type: "token", text: `First: ${TOKEN_A}` });
    emitter.send({ type: "token", text: `Second: ${TOKEN_A}` });
    emitter.send({ type: "stream_end", text: "" });
    await relay.drain();

    assert.equal(takeRedactionMap.mock.callCount(), 1, "a single-use id must only be redeemed once per turn");
    assert.deepEqual(emitter.events.map(e => e.text), ["First: alice@example.com", "Second: alice@example.com", ""]);
  });

  test("an unknown/expired id (takeRedactionMap returns null) leaves the placeholder untouched, no throw", async () => {
    const emitter = makeEmitter();
    const redactionMap = new Map();
    const relay = installRedactionRelay(emitter, redactionMap, async () => null);

    emitter.send({ type: "token", text: `Contact: ${TOKEN_A}` });
    await relay.drain();

    assert.equal(emitter.events[0].text, `Contact: ${TOKEN_A}`);
  });

  test("a rejected takeRedactionMap call does not throw or break later events", async () => {
    const emitter = makeEmitter();
    const redactionMap = new Map();
    const relay = installRedactionRelay(emitter, redactionMap, async () => { throw new Error("mcp timeout"); });

    emitter.send({ type: "token", text: `Contact: ${TOKEN_A}` });
    emitter.send({ type: "stream_end", text: "done" });
    await relay.drain();

    assert.equal(emitter.events[0].text, `Contact: ${TOKEN_A}`, "unresolved placeholder passes through unchanged");
    assert.equal(emitter.events[1].text, "done");
  });

  test("preserves event order when an early token needs an async lookup and a later one does not", async () => {
    const emitter = makeEmitter();
    const redactionMap = new Map();
    let resolveFirst;
    const takeRedactionMap = (id) => id === ID_A
      ? new Promise((res) => { resolveFirst = () => res({ [TOKEN_A]: "alice@example.com" }); })
      : Promise.resolve(null);
    const relay = installRedactionRelay(emitter, redactionMap, takeRedactionMap);

    emitter.send({ type: "token", text: TOKEN_A }); // slow — held open below
    emitter.send({ type: "tool", name: "some_tool" }); // no lookup needed, must still land AFTER the token above
    emitter.send({ type: "stream_end", text: "" });

    // Let the chain's first .then() actually start running (far enough to
    // call takeRedactionMap(ID_A) and assign resolveFirst) before asserting
    // nothing has been forwarded yet — send() itself only schedules work.
    await new Promise((r) => setImmediate(r));
    assert.equal(emitter.events.length, 0);
    resolveFirst();
    await relay.drain();

    assert.deepEqual(emitter.events.map(e => e.type), ["token", "tool", "stream_end"]);
    assert.equal(emitter.events[0].text, "alice@example.com");
  });

  test("two different correlation ids in the same reply both redeem correctly", async () => {
    const emitter = makeEmitter();
    const redactionMap = new Map();
    const takeRedactionMap = async (id) => {
      if (id === ID_A) return { [TOKEN_A]: "alice@example.com" };
      if (id === ID_B) return { [TOKEN_B]: "bob@example.com" };
      return null;
    };
    const relay = installRedactionRelay(emitter, redactionMap, takeRedactionMap);

    emitter.send({ type: "stream_end", text: `${TOKEN_A} and ${TOKEN_B}` });
    await relay.drain();

    assert.equal(emitter.events[0].text, "alice@example.com and bob@example.com");
  });

  test("a correlation id split across two token chunks still redeems, with no raw fragment forwarded", async (t) => {
    const emitter = makeEmitter();
    const redactionMap = new Map(); // empty map — must not take the fast path on the first half
    const takeRedactionMap = t.mock.fn(async (id) => (id === ID_A ? { [TOKEN_A]: "alice@example.com" } : null));
    const relay = installRedactionRelay(emitter, redactionMap, takeRedactionMap);

    const splitPoint = TOKEN_A.indexOf("_0_EMAIL_0»"); // lands mid-UUID
    emitter.send({ type: "token", text: `Contact: ${TOKEN_A.slice(0, splitPoint)}` });
    emitter.send({ type: "token", text: TOKEN_A.slice(splitPoint) });
    emitter.send({ type: "stream_end", text: "" });
    await relay.drain();

    assert.equal(takeRedactionMap.mock.callCount(), 1, "the id must resolve once both halves are seen");
    const forwardedText = emitter.events.map(e => e.text ?? "").join("");
    assert.equal(forwardedText, "Contact: alice@example.com", "no half of the correlation id ever reaches the caller unrestored");
    assert.ok(!forwardedText.includes("«"), "no raw placeholder fragment leaks out");
  });

  test("no takeRedactionMap function at all (proactive-only mode) — unknown tokens just pass through", async () => {
    const emitter = makeEmitter();
    const redactionMap = new Map();
    const relay = installRedactionRelay(emitter, redactionMap); // 3rd arg omitted

    emitter.send({ type: "token", text: `Contact: ${TOKEN_A}` });
    await relay.drain();

    assert.equal(emitter.events[0].text, `Contact: ${TOKEN_A}`);
  });
});

describe("installRedactionRelay — emitter identity", () => {
  test("drain() restores emitter.send to the exact original function reference", async () => {
    const original = () => {};
    const emitter = { send: original };
    const relay = installRedactionRelay(emitter, new Map());
    assert.notEqual(emitter.send, original, "send must be patched while installed");
    await relay.drain();
    assert.equal(emitter.send, original, "must be the SAME reference, not a rebuilt/bound copy");
  });
});
