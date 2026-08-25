import { test } from "node:test";
import assert from "node:assert/strict";

// voice.js touches `window` before its capability guard.
globalThis.window = globalThis;

await import("../../../public/scripts/voice.js");

const { createTranscriptAccumulator } = globalThis.AperioVoiceTranscript;

// A SpeechRecognitionEvent carries the *cumulative* result list plus the index
// the browser wants us to start reading from.
function event(resultIndex, all) {
  return {
    resultIndex,
    results: all.map((r) => ({ 0: { transcript: r.text }, isFinal: r.isFinal })),
  };
}

test("keeps earlier speech when a pause finalizes a chunk", () => {
  const acc = createTranscriptAccumulator("");

  acc.push(event(0, [{ text: "hello there", isFinal: false }]));
  const finalized = acc.push(event(0, [{ text: "hello there", isFinal: true }]));
  assert.equal(finalized.text, "hello there");
  assert.equal(finalized.isFinal, true);

  // After the pause the browser jumps resultIndex past the finalized chunk.
  const resumed = acc.push(event(1, [
    { text: "hello there", isFinal: true },
    { text: " and welcome", isFinal: false },
  ]));
  assert.equal(resumed.text, "hello there and welcome");
  assert.equal(resumed.isFinal, false);
});

test("overwrites an interim chunk when the same index is finalized", () => {
  const acc = createTranscriptAccumulator("");
  acc.push(event(0, [{ text: "one", isFinal: true }]));
  acc.push(event(1, [
    { text: "one", isFinal: true },
    { text: " tw", isFinal: false },
  ]));
  const out = acc.push(event(1, [
    { text: "one", isFinal: true },
    { text: " two", isFinal: true },
  ]));
  assert.equal(out.text, "one two");
});

test("survives several pauses in a row", () => {
  const acc = createTranscriptAccumulator("");
  const chunks = [];
  for (const text of ["first", " second", " third"]) {
    chunks.push({ text, isFinal: true });
    acc.push(event(chunks.length - 1, chunks.slice()));
  }
  assert.equal(acc.text(), "first second third");
});

test("appends to text the user already typed instead of wiping it", () => {
  const acc = createTranscriptAccumulator("typed already ");
  const out = acc.push(event(0, [{ text: " spoken part", isFinal: true }]));
  assert.equal(out.text, "typed already spoken part");
});

test("an empty base adds no leading space", () => {
  const acc = createTranscriptAccumulator("");
  assert.equal(acc.push(event(0, [{ text: "hi", isFinal: true }])).text, "hi");
});
