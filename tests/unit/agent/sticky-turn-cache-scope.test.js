// tests/unit/agent/sticky-turn-cache-scope.test.js
//
// P1 review finding: createAgent() runs once at server boot and the resulting
// agent is shared by EVERY WebSocket connection (lib/server.js's single
// `createAgent()` call feeds `makeWsHandler({ agent, ... })`, registered once
// as the `connection` listener in lib/server/ws.js — every new connection
// invokes that same closure). turn-planner.js's sticky pin/carry fold
// (llamacpp-multiturn-latency plan) makes a turn's tool plan depend on the
// FULL conversation history, not just the turn number and current text — but
// `ensureTurn`'s cache used to be a single `turnCache` object keyed only by
// `${turnNum}|${userText}`. Two unrelated conversations that happen to reach
// the same turn number with the same current text (e.g. both replying
// "yes, do it" after a completely different flow) would collide on that key:
// the second one silently received the FIRST one's cached plan, pinning
// whatever tools ITS history had armed instead of its own.
//
// Fixed by scoping the cache to each conversation's own `messages` array
// reference (a WeakMap) — every WebSocket connection already allocates its
// own `messages` array once (wsHandler's `const messages = []`) and mutates
// it in place for the connection's whole lifetime, so that reference was
// already the right scope to cache against.
//
// This test drives the real `createAgent()`/`ensureTurn` path (mocked MCP
// transport only — no network calls are needed since getAnthropicTools does
// not itself talk to the model) with TWO independent conversations sharing
// ONE agent instance, reproducing the exact "yes, do it" collision from the
// review comment.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgent } from "../../../lib/agent.js";

const FAKE_ROOT = "/fake/project";

function stubMcpTransport(t) {
  t.mock.method(StdioClientTransport.prototype, "start", async () => {});
  t.mock.method(StdioClientTransport.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({
    tools: [
      { name: "doc_search", description: "search documents", inputSchema: z.object({ query: z.string() }) },
      { name: "db_query", description: "query the database", inputSchema: z.object({ sql: z.string() }) },
    ],
  }));
  t.mock.method(Client.prototype, "callTool", async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  t.mock.method(Client.prototype, "request", async () => ({}));
}

describe("ensureTurn's cache is scoped per conversation, not shared agent-wide (P1 review finding)", () => {
  test("two conversations at the same turn number and text, with different histories, do not cross-contaminate pinned tools", async (t) => {
    stubMcpTransport(t);
    process.env.AI_PROVIDER = "llamacpp";
    process.env.LLAMACPP_MODEL = "sticky-cache-scope-test-model";
    // Local models need an explicit capability allowlist entry to get tools at
    // all (isCapableModel) — cloud providers skip this, but the sticky pin
    // mechanism itself only activates for providerName === "llamacpp", so a
    // cloud provider can't be used to exercise it here.
    process.env.APERIO_CAPABLE_MODELS = "sticky-cache-scope-test-model";

    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });

    // Conversation A: turn 1 genuinely calls doc_search, turn 2 is a
    // keyword-free filler (so turn 1's wording falls out of the ordinary
    // 2-turn text window by turn 3 — isolating the STICKY carry-forward as
    // the only possible source of doc_search at turn 3, same isolation
    // technique turn-planner.test.js's own sticky-fold suite uses).
    const historyA = [
      { role: "user", content: "search my documents for the invoice" },
      { role: "assistant", content: [{ type: "tool_use", name: "doc_search", input: {}, id: "a1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "ok" }] },
      { role: "assistant", content: "Found some documents." },

      { role: "user", content: "ok continue" },
      { role: "assistant", content: "Sure." },
    ];
    // Conversation B: a completely separate flow that arms a DIFFERENT tool.
    const historyB = [
      { role: "user", content: "now query the database schema" },
      { role: "assistant", content: [{ type: "tool_use", name: "db_query", input: {}, id: "b1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] },
      { role: "assistant", content: "Here is the schema." },

      { role: "user", content: "ok continue" },
      { role: "assistant", content: "Sure." },
    ];

    // Both conversations reach turn 3 with the IDENTICAL current text — the
    // exact collision the review comment describes.
    const turn3A = [...historyA, { role: "user", content: "yes, do it" }];
    const turn3B = [...historyB, { role: "user", content: "yes, do it" }];

    // Query A first so its plan populates the (agent-wide, shared) memoized
    // path under key "3|11|yes, do it" — under the old bug this cached
    // result would then be handed straight back for B's identical key below.
    const toolsA = agent.getAnthropicTools("yes, do it", turn3A).map(t => t.name);
    const toolsB = agent.getAnthropicTools("yes, do it", turn3B).map(t => t.name);

    assert.ok(toolsA.includes("doc_search"), "conversation A's own history should still carry doc_search forward");
    assert.ok(!toolsA.includes("db_query"), "conversation A must not pick up B's tool");

    assert.ok(toolsB.includes("db_query"), "conversation B's own history must carry db_query forward, not A's cached plan");
    assert.ok(!toolsB.includes("doc_search"),
      "conversation B must not inherit conversation A's pinned tool just because both happened to reach turn 3 with identical text (the P1 bug this test guards against)");
  });
});

// The skill-block pin (#250, 2026-08-13) stores each conversation's resolved
// block and feeds it back on the next turn so llama.cpp sees a byte-identical
// system prompt. It is per-conversation state on the SAME shared agent, so it
// needs the same scoping guarantee as the turn cache above — and this is the
// only test that exercises the store/feed-back wiring end to end (the unit
// suite in turn-planner.test.js passes `pinnedSkillNames` in by hand).
describe("the skill-block pin is per-conversation and holds the block byte-stable", () => {
  function skillRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-skill-pin-"));
    for (const [name, body] of [["widget-helper", "WIDGET BODY"], ["planner-helper", "PLANNER BODY"]]) {
      fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
      fs.writeFileSync(
        path.join(root, "skills", name, "SKILL.md"),
        ["---", `name: ${name}`, `description: ${name} skill`, "metadata:", "  load: on-demand", "---", "", body].join("\n"),
        "utf8",
      );
    }
    return root;
  }

  test("a live flow re-sends the same block, and another conversation is unaffected", async (t) => {
    stubMcpTransport(t);
    process.env.AI_PROVIDER = "llamacpp";
    process.env.LLAMACPP_MODEL = "skill-pin-scope-test-model";
    process.env.APERIO_CAPABLE_MODELS = "skill-pin-scope-test-model";
    const root = skillRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const agent = await createAgent({ root, version: "1.0.0" });

    // Conversation A, mutated in place exactly like wsHandler's own array.
    const openText = "please use the widget helper on this";
    const convoA = [{ role: "user", content: openText }];
    const turn0 = agent.getSystemPrompt(openText, "en", "", convoA);
    assert.match(turn0, /WIDGET BODY/, "the opening turn resolves its own skill normally");

    // The flow calls a tool (arming the pin window), then a follow-up turn
    // whose text matches a DIFFERENT skill — the round-6 turn 1→2 shape.
    const pivotText = "now use the planner helper for the breakdown";
    convoA.push(
      { role: "assistant", content: [{ type: "tool_use", name: "doc_search", input: {}, id: "a1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "ok" }] },
      { role: "assistant", content: "Found some documents." },
      { role: "user", content: pivotText },
    );
    const turn1 = agent.getSystemPrompt(pivotText, "en", "", convoA);
    // The whole system prompt, not just the block: a byte-identical system
    // prompt across the boundary IS the property llama.cpp's KV cache reads
    // (the run's `sysHash` holding constant).
    assert.equal(turn1, turn0, "the system prompt must be byte-identical across the turn boundary");

    // Conversation B: same current text, its own array, no flow behind it.
    const convoB = [{ role: "user", content: pivotText }];
    const blockB = agent.getSystemPrompt(pivotText, "en", "", convoB);
    assert.match(blockB, /PLANNER BODY/, "an unrelated conversation resolves its own match");
    assert.doesNotMatch(blockB, /WIDGET BODY/, "and never inherits another conversation's pinned block");
  });
});
