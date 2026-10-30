// Protocol parity contract for the terminal clients (#539, P2).
//
// The WS message protocol has no schema. server.js → lib/handlers/ →
// lib/agent/ agree on message shapes by hand, and the terminal fell a whole
// interaction generation behind without a single test going red: a pending
// write could reach the CLI, land in the emitter's unknown-event fallback, and
// dead-end there. The browser's own contract
// (tests/integration/public/streaming-router.test.js) could not catch it —
// it pins the browser's handlers against a hand-written list, so an event the
// browser does not handle is simply absent from both sides.
//
// This is the other direction. The protocol surface is READ OUT OF THE SOURCE
// (tests/helpers/protocolInventory.js) and every member must carry a policy
// below. Add an event anywhere in lib/agent/ or the WS handlers and this test
// fails until someone decides what the terminal does with it. That decision is
// the deliverable — "web-only" is a perfectly good answer, an unexamined
// `[event: …]` line is not.
//
// ── How to fix a failure ────────────────────────────────────────────────────
// Add your new type to CLI_EVENT_POLICY with one of:
//   handled      — lib/emitters/cliEmitter.js has a `case` for it
//   intercepted  — a terminal client consumes it before the emitter sees it
//   internal     — not a UI event at all (a sink, a harness, telemetry)
//   web-only     — the browser renders it; the terminal deliberately does not
// `internal` and `web-only` need a reason. Do not reach for them to silence
// this test.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INDIRECT_EVENT_PRODUCERS,
  collectCliHandledEvents,
  collectInboundTypes,
  collectOutboundEvents,
  collectProxySentTypes,
  producerFiles,
} from "../../helpers/protocolInventory.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const HANDLED     = "handled";
const INTERCEPTED = "intercepted";
const INTERNAL    = "internal";
const WEB_ONLY    = "web-only";

/**
 * Every event a chat producer can emit, and what the terminal does with it.
 * A bare string is the policy; a pair is [policy, reason].
 */
const CLI_EVENT_POLICY = {
  // ── the turn itself ───────────────────────────────────────────────────────
  stream_start: HANDLED,
  stream_end: HANDLED,
  token: HANDLED,
  retract: HANDLED,
  thinking: HANDLED,
  reasoning_start: HANDLED,
  reasoning_token: HANDLED,
  reasoning_done: HANDLED,
  error: HANDLED,

  // ── tools ─────────────────────────────────────────────────────────────────
  tool: HANDLED,
  tool_start: HANDLED,
  tool_result: HANDLED,
  tool_budget_exhausted: HANDLED,
  tool_repeat_break: HANDLED,
  tool_step_limit: HANDLED,
  generated_file: HANDLED,
  workflow_suggestion: HANDLED,
  tool_failure: [INTERNAL, "tool-safety-middleware bookkeeping; the user-facing form is tool_result (ok:false)"],
  tool_result_offloaded: [INTERNAL, "consumed by lib/emitters/sinkEmitter.js to swap in the artifact pointer"],

  // ── confirmations and durable interrupts (this step) ──────────────────────
  action_confirm_pending: HANDLED,
  interrupts: HANDLED,
  interrupt_decided: HANDLED,

  // ── context pressure ──────────────────────────────────────────────────────
  context_warning: HANDLED,
  context_trimmed: HANDLED,
  context_handoff_suggested: HANDLED,
  context_summarize_suggested: HANDLED,
  context_summarized: HANDLED,
  handoff_written: HANDLED,

  // ── knowledge ─────────────────────────────────────────────────────────────
  recall_result: HANDLED,
  ttl_chip: HANDLED,
  skills_matched: HANDLED,
  suggestions_saved: HANDLED,
  startup_breakdown: HANDLED,
  slow_local_turn_detected: HANDLED,
  skills_not_found: [INTERNAL, "turn-planner diagnostic; no UI renders it"],
  answer_artifacts: [WEB_ONLY, "a lightbox/download strip; the CLI already prints each file as generated_file"],
  no_tool_use_detected: [WEB_ONLY, "a browser nudge chip; standalone surfaces the same thing through tool_result"],

  // ── session + sidebar ─────────────────────────────────────────────────────
  session_created: HANDLED,
  session_resumed: HANDLED,
  paths_updated: HANDLED,
  status: HANDLED,
  provider: HANDLED,
  memories: HANDLED,
  deleted: HANDLED,
  self_memories: [INTERCEPTED, "proxy.js reads it directly to print /self, before the emitter"],
  session_branched: [WEB_ONLY, "/branch is #539 Phase 2; the terminal has no branch command yet"],
  model_status: [WEB_ONLY, "boot download/load progress; the CLI prints its own llama.cpp boot lines"],
  turn_complete: [INTERNAL, "turn bookkeeping for the agent harness (lib/helpers/modelTierBench.js)"],

  // ── round table ───────────────────────────────────────────────────────────
  roundtable_phase: HANDLED,
  roundtable_agreed: HANDLED,
  roundtable_no_agreement: HANDLED,
  roundtable_error: HANDLED,
  roundtable_aborted: HANDLED,
  roundtable_manifesto: [INTERNAL, "agent descriptors for the browser's round-table panel chrome"],
  discuss_summary: [WEB_ONLY, "the staged discuss flow is #539 Phase 2; /discuss still uses the direct flag"],
  discuss_staged: [WEB_ONLY, "same staged flow — #539 Phase 2"],
  discuss_declined: [WEB_ONLY, "same staged flow — #539 Phase 2"],

  // ── planning (#320), parked pending #498 ──────────────────────────────────
  plan_created: [INTERNAL, "#320 plan events, held until #498 is decided"],
  plan_step: [INTERNAL, "#320 plan events, held until #498 is decided"],
  plan_drift: [INTERNAL, "#320 plan events, held until #498 is decided"],

  // ── sub-agent spawn ───────────────────────────────────────────────────────
  spawn_refused: [INTERNAL, "lib/agent/spawn.js is unreleased and may be removed; no UI consumes it"],
};

/**
 * Every inbound WS message type, and whether the terminal proxy can send it.
 * A bare string is the policy; a pair is [policy, reason].
 */
const PROXY_INBOUND_POLICY = {
  init: "sends",
  chat: "sends",
  set_lang: "sends",
  summarize: "sends",
  handoff: "sends",
  resume_session: "sends",
  switch_model: "sends",
  get_memories: "sends",
  get_self_memories: "sends",
  delete_memory: "sends",
  confirm_action: "sends",
  interrupt_decision: "sends",
  stop: ["other", "sent by the SIGINT handler in lib/terminal/signals.js, not by a command"],
  set_paths: [WEB_ONLY, "allowed folders are edited in Settings; the CLI reads them at boot"],
  save_suggestions: [WEB_ONLY, "#539 Phase 2; `remember that …` is the terminal's route today"],
  branch_conversation: [WEB_ONLY, "#539 Phase 2; no /branch command yet"],
  discuss_start: [WEB_ONLY, "the staged discuss flow is #539 Phase 2"],
  discuss_confirm: [WEB_ONLY, "the staged discuss flow is #539 Phase 2"],
};

const policyOf = (table, type) => (Array.isArray(table[type]) ? table[type][0] : table[type]);
const reasonOf = (table, type) => (Array.isArray(table[type]) ? table[type][1] : null);

// ═══════════════════════════════════════════════════════════════════════════════
// The inventory itself must keep working
// ═══════════════════════════════════════════════════════════════════════════════

describe("protocol inventory", () => {
  test("the producer scan reaches real files", () => {
    const files = producerFiles();
    assert.ok(files.length > 20, `expected the producer scan to cover lib/agent et al, got ${files.length}`);
  });

  test("the scan finds events of both call shapes", () => {
    const found = collectOutboundEvents();
    // send("x", {...}) — the WS handler's shape
    assert.ok(found.has("session_created"));
    // emitter.send({ type: "x" }) — the agent's shape
    assert.ok(found.has("stream_start"));
    assert.ok(found.size > 40, `expected a substantial protocol surface, got ${found.size}`);
  });

  test("every declared indirect producer still mints its event", () => {
    // The scraper cannot see an envelope built by a factory, so those are
    // declared. If a rename made the declaration false, the protocol surface
    // would silently shrink and this contract would stop guarding that event.
    for (const [type, rel] of Object.entries(INDIRECT_EVENT_PRODUCERS)) {
      const src = readFileSync(resolve(ROOT, rel), "utf-8");
      assert.ok(src.includes(`"${type}"`), `${rel} no longer mentions "${type}"`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Outbound: every emitted event is classified for the terminal
// ═══════════════════════════════════════════════════════════════════════════════

describe("terminal event parity", () => {
  test("every event a producer can emit has a policy", () => {
    const found = collectOutboundEvents();
    const missing = [...found.entries()]
      .filter(([type]) => !(type in CLI_EVENT_POLICY))
      .map(([type, files]) => `  ${type}  (${files.join(", ")})`);
    assert.deepEqual(
      missing, [],
      "unclassified protocol additions — add each to CLI_EVENT_POLICY in this file:\n" + missing.join("\n"),
    );
  });

  test("no policy entry names an event nothing emits any more", () => {
    // Keeps the table from rotting into a list of ghosts. This is the assertion
    // that caught `delete_confirm_pending`: cliEmitter.js had a case for it and
    // nothing had emitted it since the generic confirm flow replaced it, so the
    // terminal's only confirmation path was unreachable code.
    const found = collectOutboundEvents();
    const ghosts = Object.keys(CLI_EVENT_POLICY).filter(t => !found.has(t));
    assert.deepEqual(ghosts, [], `no producer emits these any more — delete them from CLI_EVENT_POLICY: ${ghosts.join(", ")}`);
  });

  test("every policy uses a known value", () => {
    const known = [HANDLED, INTERCEPTED, INTERNAL, WEB_ONLY];
    for (const type of Object.keys(CLI_EVENT_POLICY)) {
      assert.ok(known.includes(policyOf(CLI_EVENT_POLICY, type)), `${type}: unknown policy`);
    }
  });

  test("internal and web-only each carry a reason", () => {
    for (const type of Object.keys(CLI_EVENT_POLICY)) {
      const policy = policyOf(CLI_EVENT_POLICY, type);
      if (policy !== INTERNAL && policy !== WEB_ONLY) continue;
      const reason = reasonOf(CLI_EVENT_POLICY, type);
      assert.ok(reason && reason.length > 15, `${type}: ${policy} needs a reason saying why`);
    }
  });

  test('every "handled" event really has a case in cliEmitter.js', () => {
    const cases = collectCliHandledEvents();
    const claimed = Object.keys(CLI_EVENT_POLICY).filter(t => policyOf(CLI_EVENT_POLICY, t) === HANDLED);
    const absent = claimed.filter(t => !cases.includes(t));
    assert.deepEqual(absent, [], `claimed handled but no case in lib/emitters/cliEmitter.js: ${absent.join(", ")}`);
  });

  test("every case in cliEmitter.js is classified as handled", () => {
    const cases = collectCliHandledEvents();
    const unclassified = cases.filter(t => policyOf(CLI_EVENT_POLICY, t) !== HANDLED);
    assert.deepEqual(unclassified, [], `cliEmitter.js handles these but the policy does not say so: ${unclassified.join(", ")}`);
  });

  // ── the P1 safety gap, pinned so it cannot reopen ─────────────────────────

  test("the confirmation and interrupt events are handled, not web-only", () => {
    // The whole point of the step. A consequential tool action must be
    // answerable from a terminal session; demoting any of these back to the
    // unknown-event fallback is the regression this test exists to catch.
    for (const type of ["action_confirm_pending", "interrupts", "interrupt_decided"]) {
      assert.equal(policyOf(CLI_EVENT_POLICY, type), HANDLED, type);
      assert.ok(collectCliHandledEvents().includes(type), `${type} has no case in cliEmitter.js`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Inbound: every message the server accepts is accounted for
// ═══════════════════════════════════════════════════════════════════════════════

describe("terminal inbound parity", () => {
  test("every inbound message type the server accepts has a policy", () => {
    const missing = collectInboundTypes().filter(t => !(t in PROXY_INBOUND_POLICY));
    assert.deepEqual(missing, [], `add each to PROXY_INBOUND_POLICY in this file: ${missing.join(", ")}`);
  });

  test("no policy entry names a message the server no longer accepts", () => {
    const inbound = collectInboundTypes();
    const ghosts = Object.keys(PROXY_INBOUND_POLICY).filter(t => !inbound.includes(t));
    assert.deepEqual(ghosts, [], `the server dropped these — delete them from PROXY_INBOUND_POLICY: ${ghosts.join(", ")}`);
  });

  test('every "sends" message is really built by the proxy', () => {
    const sent = collectProxySentTypes();
    const claimed = Object.keys(PROXY_INBOUND_POLICY).filter(t => PROXY_INBOUND_POLICY[t] === "sends");
    const absent = claimed.filter(t => !sent.includes(t));
    assert.deepEqual(absent, [], `claimed as sent but not built in proxy.js or confirm.js: ${absent.join(", ")}`);
  });

  test("the proxy sends nothing the server does not accept", () => {
    const inbound = collectInboundTypes();
    const stray = collectProxySentTypes().filter(t => !inbound.includes(t));
    assert.deepEqual(stray, [], `the proxy sends these but wsHandler.js has no case: ${stray.join(", ")}`);
  });

  test("the decision messages are sendable from the proxy", () => {
    // Acceptance criteria 1 and 2: a proposal must be answerable over the wire.
    const sent = collectProxySentTypes();
    assert.ok(sent.includes("confirm_action"), "proxy.js cannot approve a confirmation");
    assert.ok(sent.includes("interrupt_decision"), "proxy.js cannot decide a durable interrupt");
  });

  test("a web-only inbound message carries a reason", () => {
    for (const type of Object.keys(PROXY_INBOUND_POLICY)) {
      const policy = policyOf(PROXY_INBOUND_POLICY, type);
      if (policy === "sends") continue;
      const reason = reasonOf(PROXY_INBOUND_POLICY, type);
      assert.ok(reason && reason.length > 15, `${type}: ${policy} needs a reason saying why`);
    }
  });
});
