// tests/integration/public/streaming-router.test.js
//
// Protocol contract for the browser streaming client. handleMessage() used to be
// one ~45-branch if-chain in handler.js; it is now a dispatch map fed by the
// domain files under public/scripts/streaming/events/. These tests pin what that
// restructuring must never lose: every message type keeps exactly one handler,
// unknown types stay a silent no-op, the page loads the modules in the order the
// shared globals require, and a full streamed turn still renders one bubble.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

import { STREAMING_SCRIPTS } from "../../helpers/streamingScripts.js";

// Every type the client rendered before the split, plus the connection ack.
// Adding a type here without registering a handler fails; registering one
// without listing it here fails too — so the protocol surface stays explicit.
const EXPECTED_TYPES = [
  // lifecycle
  "status", "startup_breakdown", "provider", "model_status", "paths_updated", "agent_job_done",
  // turn
  "thinking", "tool", "reasoning_start", "reasoning_token", "reasoning_done",
  "stream_start", "token", "retract", "stream_end", "error",
  // context + session
  "context_warning", "context_trimmed", "context_handoff_suggested", "handoff_written",
  "context_summarized", "suggestions_saved", "session_resumed", "session_branched",
  // knowledge
  "memories", "deleted", "ttl_chip", "skills_matched", "capability_notice",
  "generated_file", "answer_artifacts", "no_tool_use_detected", "slow_local_turn_detected",
  // tools + confirmations
  "tool_start", "tool_result", "delete_confirm_pending", "action_confirm_pending",
  "interrupts", "interrupt_decided",
  // round table + discuss
  "roundtable_phase", "roundtable_agreed", "roundtable_no_agreement", "roundtable_error",
  "discuss_summary", "discuss_staged", "discuss_declined",
].sort();

class FakeClassList {
  #classes = new Set();
  add(name) { this.#classes.add(name); }
  remove(name) { this.#classes.delete(name); }
  contains(name) { return this.#classes.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : Boolean(force);
    if (enabled) this.add(name); else this.remove(name);
    return enabled;
  }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag;
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.innerHTML = "";
    this.textContent = "";
    this.title = "";
    this.value = "";
    this.disabled = false;
    this._children = new Map();
    this.appended = [];
  }
  addEventListener() {}
  removeEventListener() {}
  removeAttribute() {}
  setAttribute() {}
  getAttribute() { return null; }
  hasAttribute() { return false; }
  focus() {}
  blur() {}
  click() {}
  remove() { this.removed = true; }
  appendChild(el) { this.appended.push(el); return el; }
  insertBefore(el) { this.appended.push(el); return el; }
  prepend(el) { this.appended.unshift(el); return el; }
  append() {}
  before() {}
  after() {}
  replaceWith() {}
  replaceChild() {}
  insertAdjacentHTML() {}
  querySelector(sel) {
    if (!this._children.has(sel)) this._children.set(sel, new FakeElement());
    return this._children.get(sel);
  }
  querySelectorAll() { return []; }
}

function makeDocument() {
  const byId = new Map();
  const bySelector = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement());
      return byId.get(id);
    },
    querySelector(sel) {
      if (!bySelector.has(sel)) bySelector.set(sel, new FakeElement());
      return bySelector.get(sel);
    },
    createElement(tag) { return new FakeElement(tag); },
    addEventListener() {},
    removeEventListener() {},
  };
}

// One shared vm context standing in for the sequence of <script> tags that share
// a window in production (no bundler, no modules).
function loadApp() {
  const doc = makeDocument();
  const messagesEl = doc.getElementById("messages");
  const context = vm.createContext({
    console,
    document: doc,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: "node-test" },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    requestAnimationFrame(fn) { fn(); },
    CSS: { escape: (s) => String(s) },
    maxCtx: 0,
    window: null,
  });
  context.window = context;
  context.addEventListener = () => {};
  context.t = (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key);
  context.connect = () => {};
  context.applyRoundtableAvailability = () => {};
  context.syncModelSelection = () => {};
  context.syncChipStateLabel = () => {};
  context.messagesEl = messagesEl;
  context.escapeHtml = (s) => String(s ?? "");
  context.scrollToBottom = () => {};

  vm.runInContext(
    readFileSync(new URL("../../../public/index.js", import.meta.url), "utf8"),
    context, { filename: "public/index.js" },
  );
  for (const filename of STREAMING_SCRIPTS) {
    vm.runInContext(
      readFileSync(new URL(`../../../${filename}`, import.meta.url), "utf8"),
      context, { filename },
    );
  }
  return { context, doc, messagesEl };
}

// ─── Load-order contract ─────────────────────────────────────────────────────

test("index.html loads exactly the streaming modules the tests exercise, in order", () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  const loaded = [...html.matchAll(/<script src="(scripts\/streaming\/[^"]+)"><\/script>/g)]
    .map(m => `public/${m[1]}`);
  assert.deepEqual(loaded, STREAMING_SCRIPTS,
    "public/index.html and tests/helpers/streamingScripts.js drifted apart");
});

test("the router is defined before the event files that register into it", () => {
  assert.equal(STREAMING_SCRIPTS[0], "public/scripts/streaming/state.js");
  assert.equal(STREAMING_SCRIPTS[1], "public/scripts/streaming/handler.js");
  const firstEvent = STREAMING_SCRIPTS.findIndex(f => f.includes("/events/"));
  assert.ok(firstEvent > 1, "event domain files must load after handler.js");
});

// ─── Dispatch completeness ───────────────────────────────────────────────────

test("every supported message type has exactly one registered handler", () => {
  const { context } = loadApp();
  // Spread into this realm: the vm's Array has a different prototype identity.
  assert.deepEqual([...context.window.Aperio.streamRouter.types()], EXPECTED_TYPES);
});

test("registering a second handler for a type is a load-time error", () => {
  const { context } = loadApp();
  assert.throws(
    () => context.window.Aperio.streamRouter.on("stream_end", () => {}),
    /duplicate handler registered for "stream_end"/,
  );
});

test("an unknown or malformed message is ignored rather than thrown", () => {
  const { context } = loadApp();
  assert.doesNotThrow(() => context.handleMessage({ type: "type_from_a_newer_server" }));
  assert.doesNotThrow(() => context.handleMessage({}));
  assert.doesNotThrow(() => context.handleMessage(null));
});

// ─── One streamed turn, end to end ───────────────────────────────────────────

test("a full streamed turn renders one answer bubble and settles the UI", () => {
  const { context } = loadApp();
  const finalized = [];
  const bubble = { wrap: new FakeElement(), bubble: new FakeElement() };
  context.createStreamingBubble = () => bubble;
  context.finalizeStreamingBubble = (b, text) => finalized.push(text);
  context.addThinking = () => {};
  context.removeThinking = () => {};
  context.removeToolIndicator = () => {};
  context.setStatus = () => {};
  context.settleTurnTimer = () => {};
  context.updateContextBar = () => {};
  context._scheduleStreamRender = () => {};
  context._refineStartupBanner = () => {};
  context._annotateTokenBadges = () => {};
  context.chatInput = new FakeElement();
  context.sendBtn = new FakeElement();
  context.stopBtn = new FakeElement();

  context.handleMessage({ type: "thinking" });
  context.handleMessage({ type: "stream_start" });
  context.handleMessage({ type: "token", text: "Hello" });
  context.handleMessage({ type: "token", text: ", world" });
  context.handleMessage({ type: "stream_end", usage: { output_tokens: 4, input_tokens: 10 } });

  assert.deepEqual(finalized, ["Hello, world"], "the turn produced exactly one finalized bubble");
  assert.equal(vm.runInContext("streamingBubble", context), null, "bubble state is released");
  assert.equal(vm.runInContext("streamingText", context), "", "buffered text is released");
  assert.equal(vm.runInContext("isThinking", context), false);
  assert.equal(context.stopBtn.style.display, "none", "the stop button is retired");
});

test("a retract drops the streamed bubble and its buffered text", () => {
  const { context } = loadApp();
  const bubble = { wrap: new FakeElement(), bubble: new FakeElement() };
  context.createStreamingBubble = () => bubble;
  context.removeThinking = () => {};
  context.removeToolIndicator = () => {};
  context.setStatus = () => {};
  context._scheduleStreamRender = () => {};
  context.chatInput = new FakeElement();
  context.sendBtn = new FakeElement();
  context.stopBtn = new FakeElement();

  context.handleMessage({ type: "stream_start" });
  context.handleMessage({ type: "token", text: '{"name":"read_file"' });
  context.handleMessage({ type: "retract" });

  assert.equal(vm.runInContext("streamingBubble", context), null);
  assert.equal(vm.runInContext("streamingText", context), "");
});
