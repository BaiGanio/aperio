// tests/public/provider-cost-truthfulness.test.js
//
// Group A of trash/plans/provider-ux-parity/provider-ux-parity-tests.md (WS1 —
// cost truthfulness). Loads the real public/index.js + the public/scripts/streaming/
// in a vm context with a minimal auto-vivifying fake DOM (same pattern as
// tests/public/panel-visibility.test.js), so these tests exercise production
// source rather than a reimplemented copy.

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
  appendChild(el) { return el; }
  insertBefore(el) { return el; }
  prepend() {}
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

// Loads the real frontend source (index.js + the streaming/ modules) into one
// shared vm context, standing in for a sequence of <script> tags sharing a
// window in a browser — which is how they actually run in production (no
// bundler, no modules).
function loadApp() {
  const doc = makeDocument();
  const roundtableCalls = [];
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
  context.t = (key) => key;
  context.connect = () => {};
  context.applyRoundtableAvailability = (avail, reason) => { roundtableCalls.push({ avail, reason }); };
  context.syncModelSelection = () => {};
  context.syncChipStateLabel = () => {};

  vm.runInContext(
    readFileSync(new URL("../../../public/index.js", import.meta.url), "utf8"),
    context, { filename: "public/index.js" },
  );
  for (const part of ["state", "handler", "roundtable", "deliverables", "badges", "tool-cards", "interrupts"]) {
    const filename = `public/scripts/streaming/${part}.js`;
    vm.runInContext(
      readFileSync(new URL(`../../../${filename}`, import.meta.url), "utf8"),
      context, { filename },
    );
  }

  return { context, doc, roundtableCalls };
}

function peek(context, expr) {
  return vm.runInContext(expr, context);
}

// ─── A1 — setCostProvider stores rates ─────────────────────────────────────

test("A1: setCostProvider stores rates and updateContextBar shows a real total", () => {
  const { context, doc } = loadApp();
  context.setCostProvider("deepseek", "deepseek-v4-pro", { in: 0.55, out: 2.19 }, false, false);
  context.updateContextBar(1_000_000, 128_000, 1_000_000);

  const costEl = doc.getElementById("costText");
  assert.equal(costEl.textContent, "~$2.7400");
  assert.equal(costEl.style.display, "inline");
  assert.deepEqual(peek(context, "_currentCostRates"), { in: 0.55, out: 2.19 });
});

test("A1 edge: costRates null shows the unavailable dash with a tooltip", () => {
  const { context, doc } = loadApp();
  context.setCostProvider("deepseek", "deepseek-v4-pro", null, false, false);
  context.updateContextBar(1_000_000, 128_000, 0);

  const costEl = doc.getElementById("costText");
  assert.equal(costEl.textContent, "—");
  assert.equal(costEl.title, "ctx_cost_unavailable");
});

test("A1 edge: a sparse re-announce (costRates undefined) keeps the prior rate object, not accumulates it", () => {
  const { context, doc } = loadApp();
  context.setCostProvider("deepseek", "deepseek-v4-pro", { in: 1, out: 1 }, false, false);
  context.updateContextBar(1_000_000, 128_000, 0);
  const firstCost = doc.getElementById("costText").textContent;
  assert.equal(firstCost, "~$1.0000");

  // Sparse re-announce: no costRates argument at all.
  context.setCostProvider("deepseek", "deepseek-v4-pro", undefined, undefined, undefined);
  assert.deepEqual(peek(context, "_currentCostRates"), { in: 1, out: 1 }, "rate object unchanged");

  // Session total is a running accumulation across turns — documented behavior,
  // not reset by a sparse re-announce.
  context.updateContextBar(1_000_000, 128_000, 0);
  assert.equal(doc.getElementById("costText").textContent, "~$2.0000");
});

test("A1 edge: switching provider replaces the rate object rather than merging it", () => {
  const { context, doc } = loadApp();
  context.setCostProvider("deepseek", "deepseek-v4-pro", { in: 1, out: 1 }, false, false);
  context.setCostProvider("anthropic", "claude-x", { in: 3, out: 15 }, false, false);
  assert.deepEqual(peek(context, "_currentCostRates"), { in: 3, out: 15 });
  context.updateContextBar(1_000_000, 128_000, 0);
  assert.equal(doc.getElementById("costText").textContent, "~$3.0000");
});

// ─── A2 — subscription providers show no $ ─────────────────────────────────

test("A2: subscription providers (claude-code, codex) hide the cost chip", () => {
  for (const name of ["claude-code", "codex"]) {
    const { context, doc } = loadApp();
    context.setCostProvider(name, "some-model", { in: 3, out: 15 }, false, true);
    context.updateContextBar(1_000_000, 128_000, 0);
    assert.equal(doc.getElementById("costText").style.display, "none", `${name} should hide cost`);
  }
});

test("A2 edge: switching claude-code -> deepseek mid-session re-shows the chip", () => {
  const { context, doc } = loadApp();
  context.setCostProvider("claude-code", "claude-code-model", { in: 3, out: 15 }, false, true);
  context.updateContextBar(1_000_000, 128_000, 0);
  assert.equal(doc.getElementById("costText").style.display, "none");

  context.setCostProvider("deepseek", "deepseek-v4-pro", { in: 0.55, out: 2.19 }, false, false);
  context.updateContextBar(1_000_000, 128_000, 0);
  assert.equal(doc.getElementById("costText").style.display, "inline");
});

// ─── A3 — llamacpp mid-turn provider re-emit doesn't clobber ───────────────

const BOOT_PROVIDER_MSG = {
  type: "provider",
  name: "llamacpp",
  model: "qwen2.5-coder-7b",
  db: "sqlite",
  thinks: true,
  contextWindow: 8192,
  contextCapacityPct: 42,
  costRates: { in: 1, out: 2 },
  imageTokens: 1200,
  toolEligible: true,
  local: true,
  subscription: false,
  roundtableAvailable: true,
  roundtableReason: null,
  agents: [{ id: "primary", persona: "primary", name: "llamacpp", model: "qwen2.5-coder-7b" }],
};

// Mirrors the real sparse re-emit at lib/agent/providers/llamacpp.js — only
// name/model/thinks/contextWindow, everything else genuinely omitted.
const SPARSE_MIDTURN_MSG = {
  type: "provider",
  name: "llamacpp",
  model: "qwen2.5-coder-7b",
  thinks: true,
  contextWindow: 16384,
};

test("A3: a sparse llamacpp mid-turn provider re-emit doesn't clobber boot-time state", () => {
  const { context, roundtableCalls } = loadApp();

  context.handleMessage(BOOT_PROVIDER_MSG);
  assert.equal(roundtableCalls.length, 1);
  assert.equal(roundtableCalls[0].avail, true);
  assert.equal(context.maxCtx, 8192);
  assert.equal(peek(context, "window.maxCtxCapacityPct"), 42);
  assert.deepEqual(peek(context, "_currentCostRates"), { in: 1, out: 2 });
  assert.equal(peek(context, "_imageTokenCost"), 1200);

  context.handleMessage(SPARSE_MIDTURN_MSG);

  // Not clobbered: roundtable availability was never (re-)called with false.
  assert.ok(roundtableCalls.every(c => c.avail !== false), "applyRoundtableAvailability must not be called with false");
  assert.equal(roundtableCalls.length, 1, "sparse re-emit must not re-invoke the roundtable toggle at all");
  // Preserved boot values.
  assert.equal(peek(context, "window.maxCtxCapacityPct"), 42);
  assert.deepEqual(peek(context, "_currentCostRates"), { in: 1, out: 2 });
  assert.equal(peek(context, "_imageTokenCost"), 1200);
  // Only contextWindow (maxCtx) updates.
  assert.equal(context.maxCtx, 16384);
});

test("A3 edge: the sparse message arriving first (reconnect race) does not crash", () => {
  const { context, roundtableCalls } = loadApp();
  assert.doesNotThrow(() => context.handleMessage(SPARSE_MIDTURN_MSG));
  assert.equal(context.maxCtx, 16384);
  assert.equal(roundtableCalls.length, 0);
});

// Risk called out in the plan: the frontend `provider` merge change touches
// boot ordering (_syncStartupContextBar) — startup_breakdown and provider can
// arrive in either order, and the banner sync must not misbehave either way.
test("A3 regression: startup_breakdown + provider boot ordering (either order) still renders the context bar", () => {
  const breakdown = { type: "startup_breakdown", identity: 500, skills: [], memoryTokens: 0, toolSchemas: 0 };

  const first = loadApp();
  first.context.handleMessage(breakdown);
  first.context.handleMessage(BOOT_PROVIDER_MSG);
  assert.equal(first.context.maxCtx, 8192);
  assert.equal(first.doc.getElementById("ctxText").textContent, `${(500).toLocaleString()} / ${(8192).toLocaleString()} (42% RAM)`);

  const second = loadApp();
  second.context.handleMessage(BOOT_PROVIDER_MSG);
  second.context.handleMessage(breakdown);
  assert.equal(second.context.maxCtx, 8192);
  assert.equal(second.doc.getElementById("ctxText").textContent, `${(500).toLocaleString()} / ${(8192).toLocaleString()} (42% RAM)`);
});

// ─── A4 — local detection via server-sent flag ─────────────────────────────

test("A4: provider message local:true hides cost regardless of provider name", () => {
  const { context, doc } = loadApp();
  context.setCostProvider("some-future-local-provider", "model-x", { in: 3, out: 15 }, true, false);
  context.updateContextBar(1_000_000, 128_000, 0);
  assert.equal(doc.getElementById("costText").style.display, "none");
});

test("A4 edge: a provider named 'llamacpp' with local:false still shows cost (flag wins over name)", () => {
  const { context, doc } = loadApp();
  context.setCostProvider("llamacpp", "model-x", { in: 3, out: 15 }, false, false);
  context.updateContextBar(1_000_000, 128_000, 0);
  assert.equal(doc.getElementById("costText").style.display, "inline");
});
