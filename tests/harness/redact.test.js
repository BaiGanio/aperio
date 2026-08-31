// tests/harness/redact.test.js
//
// Issue #531 — Privacy Shield's redact() had no restore() caller: a recall
// result scrubbed for a cloud provider stayed scrubbed forever, so the user
// saw literal «LABEL_N» placeholder tokens instead of their real data. This
// drives the REAL runAgentLoop (lib/agent/index.js) against a scripted mock
// answer that echoes the placeholder back verbatim — exactly what a live
// cloud model does when it repeats tool-result content — and asserts the
// user-facing text (both the streamed events and the returned finalText) has
// the real value restored, not the placeholder. See README.md for what is
// real vs. faked in this harness.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./run-scenario.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, "scenarios");

function loadScenario(id) {
  return JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, `${id}.json`), "utf8"));
}

describe("Privacy Shield redact mode — the response path restores real values", () => {
  test("a placeholder the model echoes back is restored before it reaches the user", async (t) => {
    const scenario = loadScenario("redact-restore");
    const { events, finalText, messages } = await runScenario(t, scenario);

    const tokenEvents = events.filter(e => e.type === "token");
    assert.ok(tokenEvents.length > 0, "the answer must have streamed at least one token event");
    for (const e of tokenEvents) {
      assert.ok(!e.text.includes("«0_EMAIL_0»"), `a "token" event leaked the raw placeholder: ${e.text}`);
    }
    assert.ok(
      tokenEvents.some(e => e.text.includes("alice@example.com")),
      "the restored email must reach the client via a token event"
    );

    // The turn emits two stream_end events: the inter-tool one right after
    // the recall call (empty text, mid-turn) and the real terminal one
    // carrying the model's answer — take the last, not the first.
    const streamEnd = events.filter(e => e.type === "stream_end").at(-1);
    assert.ok(streamEnd, "stream_end must fire");
    assert.ok(!streamEnd.text.includes("«0_EMAIL_0»"), "stream_end must not carry the raw placeholder either");
    assert.ok(streamEnd.text.includes("alice@example.com"), "stream_end's text must carry the restored value");

    assert.ok(!finalText.includes("«0_EMAIL_0»"), "the returned finalText (background/sink callers) must be restored too");
    assert.ok(finalText.includes("alice@example.com"));

    // Review round 2, P1: `messages` is the conversation history re-sent to
    // the cloud provider as context on the NEXT turn — restoring the real
    // PII there would resend exactly what redact mode was withholding. The
    // assistant turn this scenario just produced must still carry the
    // placeholder, never the real email.
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.role, "assistant");
    const assistantText = typeof lastMsg.content === "string"
      ? lastMsg.content
      : lastMsg.content.map(b => b.text ?? "").join("");
    assert.ok(assistantText.includes("«0_EMAIL_0»"),
      "the persisted, model-facing history must keep the placeholder");
    assert.ok(!assistantText.includes("alice@example.com"),
      "the persisted, model-facing history must never carry the restored PII");
  });
});
