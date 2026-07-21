// tests/public/provider-capability-notice.test.js
//
// Group F of trash/plans/provider-ux-parity/provider-ux-parity-tests.md (WS6 —
// honest capability signals), F1 only: the client-side render half of the
// image-drop notice. Loads the real public/index.js + public/scripts/streaming.js
// in a vm context with a minimal auto-vivifying fake DOM (same pattern as
// tests/public/provider-cost-truthfulness.test.js), so these tests exercise
// production source rather than a reimplemented copy.
//
// F2 (skills-absence) has no client render surface — the plan's documentation
// route was chosen, verified instead by tests/lib/agent/*.test.js confirming
// codex/claude-code never call getSystemPrompt, plus the FEATURES.md note.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
  constructor() {
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.innerHTML = "";
    this.textContent = "";
    this.title = "";
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
  remove() {}
  appendChild(el) { this.appended.push(el); return el; }
  insertBefore(el) { this.appended.push(el); return el; }
  prepend(el) { this.appended.unshift(el); return el; }
  append() {}
  before() {}
  after() {}
  replaceWith() {}
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
    createElement() { return new FakeElement(); },
    addEventListener() {},
    removeEventListener() {},
  };
}

// Loads the real frontend source into one shared vm context, standing in for
// two <script> tags sharing a window (no bundler, no modules — same as prod).
function loadApp() {
  const doc = makeDocument();
  const tCalls = [];
  const messagesEl = doc.getElementById("messages");
  const context = vm.createContext({
    console,
    document: doc,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: "node-test" },
    setTimeout() {},
    maxCtx: 0,
    window: null,
  });
  context.window = context;
  context.addEventListener = () => {};
  // Real i18n.js is not loaded here (only index.js + streaming.js, per the
  // A-group precedent) — record calls so tests can assert the correct fixed
  // key + params were used without needing real translated strings.
  context.t = (key, params) => { tCalls.push({ key, params }); return params ? `${key}(${JSON.stringify(params)})` : key; };
  context.connect = () => {};
  context.applyRoundtableAvailability = () => {};
  context.syncModelSelection = () => {};
  context.syncChipStateLabel = () => {};
  // chat.js (not loaded here) is what normally sets window.messagesEl and
  // defines escapeHtml in production; streaming.js's chip renderers
  // reference both as bare globals. Mirror chat.js's exact implementation.
  context.messagesEl = messagesEl;
  context.escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  context.scrollToBottom = () => {};

  vm.runInContext(
    readFileSync(new URL("../../public/index.js", import.meta.url), "utf8"),
    context, { filename: "public/index.js" },
  );
  vm.runInContext(
    readFileSync(new URL("../../public/scripts/streaming.js", import.meta.url), "utf8"),
    context, { filename: "public/scripts/streaming.js" },
  );

  return { context, doc, messagesEl, tCalls };
}

// ─── F1 — image-drop notice render ─────────────────────────────────────────

test("F1: a capability_notice{kind:images_dropped} renders one notice into the message feed", () => {
  const { context, messagesEl, tCalls } = loadApp();
  context.handleMessage({ type: "capability_notice", kind: "images_dropped", provider: "codex" });

  assert.equal(messagesEl.appended.length, 1);
  const notice = messagesEl.appended[0];
  assert.equal(notice.className, "capability-notice");
  assert.ok(notice.innerHTML.includes("images_dropped_notice"), "must call t() with the fixed key, never render server text raw");
  assert.ok(notice.innerHTML.includes("codex"));

  // The i18n lookup is a literal known key in the client source, matching the
  // pattern every other event (context_trimmed, skills_matched, …) already
  // uses — the #177 lesson: never interpolate an unknown/server-supplied key.
  // (index.js's own boot-time UI init makes a few unrelated t() calls first —
  // filter to the one this notice is responsible for. params is a vm-realm
  // object literal built inside streaming.js, so compare via JSON rather
  // than assert.deepEqual, which treats cross-realm plain objects as
  // not-reference-equal even when structurally identical.)
  const noticeCalls = tCalls.filter(c => c.key === "images_dropped_notice");
  assert.equal(noticeCalls.length, 1);
  assert.equal(JSON.stringify(noticeCalls[0].params), JSON.stringify({ provider: "codex" }));
});

test("F1: provider name is HTML-escaped before insertion", () => {
  const { context, messagesEl } = loadApp();
  context.handleMessage({ type: "capability_notice", kind: "images_dropped", provider: "<img src=x onerror=alert(1)>" });

  const notice = messagesEl.appended[0];
  assert.ok(!notice.innerHTML.includes("<img"), "raw markup must not reach innerHTML unescaped");
});

test("F1: an unknown capability_notice kind renders nothing (forward-compatible, not a raw dump)", () => {
  const { context, messagesEl } = loadApp();
  context.handleMessage({ type: "capability_notice", kind: "something_future", provider: "codex" });

  assert.equal(messagesEl.appended.length, 0);
});

test("F1: a skills_matched chip and a capability_notice in the same turn coexist (no clobbering)", () => {
  const { context, messagesEl } = loadApp();
  context.handleMessage({ type: "capability_notice", kind: "images_dropped", provider: "claude-code" });
  context.handleMessage({ type: "skills_matched", turn: 1, skills: [{ name: "frontend-design", description: "", always: false, tokens: 10 }] });

  assert.equal(messagesEl.appended.length, 2);
  assert.equal(messagesEl.appended[0].className, "capability-notice");
  assert.ok(messagesEl.appended[1].className.includes("skills-chip"));
});
