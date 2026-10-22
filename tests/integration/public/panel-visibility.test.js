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
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.value = "";
  }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  prepend(...nodes) { this.children.unshift(...nodes); }
  querySelectorAll() { return []; }
  addEventListener() {}
  focus() {}
}

function loadBrowserScript(file, elements, extras = {}) {
  const document = {
    addEventListener() {},
    getElementById(id) { return elements[id] ?? null; },
    createElement(tag) { return new FakeElement(tag); },
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {},
  };
  const context = vm.createContext({
    console,
    document,
    localStorage,
    // Default no-op clock, kept for the scripts that only use setTimeout for
    // focus/animation nudges. A test that needs the clock to actually tick
    // passes its own setTimeout/clearTimeout through `extras` (see the
    // settings-overlay timeout tests) — `extras` is spread last and wins.
    setTimeout() {},
    clearTimeout() {},
    // Real AbortController: load() cancels its own fetch, and a stub here
    // would hide a fix that works in every browser.
    AbortController,
    window: null,
    ...extras,
  });
  context.window = context;
  vm.runInContext(readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8"), context, { filename: file });
  return context;
}

function actionForButton(id) {
  const html = readFileSync(new URL("../../../public/index.html", import.meta.url), "utf8");
  const button = html.match(new RegExp(`<button\\s+id=["']${id}["'][^>]*>`, "i"))?.[0];
  assert.ok(button, `button #${id} exists in the real sidebar`);
  const action = button.match(/data-action=["']([^"']+)["']/i)?.[1];
  assert.ok(action, `button #${id} declares a data-action`);
  return action;
}

test("Config click overrides CSP hiding and the next click closes it", () => {
  const overlay = new FakeElement();
  const context = loadBrowserScript("public/scripts/settings-overlay.js", { settingsOverlay: overlay });
  const action = actionForButton("configBtn");

  context[action]();
  assert.equal(overlay.style.display, "flex");

  context[action]();
  assert.equal(overlay.style.display, "none");
});

test("a rejected restart restores the page instead of polling forever", async () => {
  const overlay = new FakeElement();
  const title = new FakeElement();
  const message = new FakeElement();
  let shownError = null;
  const context = loadBrowserScript("public/scripts/settings-overlay.js", {
    restartOverlay: overlay,
    restartOverlayTitle: title,
    restartOverlayMsg: message,
  }, {
    fetch: async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({ error: "setup_required" }),
    }),
    t(key) { return key === "nav_power_restart" ? "Restart server" : key; },
    showErrorModal(error) { shownError = error; },
  });

  await context.restartAperio();

  assert.equal(overlay.style.display, "none");
  assert.match(shownError, /Restart server.*setup_required/);
});

test("Dataset Lab click overrides CSP hiding and the next click closes it", async () => {
  const panel = new FakeElement();
  const backdrop = new FakeElement();
  const body = new FakeElement();
  const context = loadBrowserScript("public/scripts/dataset-lab-panel.js", {
    "dataset-lab-panel": panel,
    "dataset-lab-backdrop": backdrop,
    "dataset-lab-body": body,
  }, {
    fetch: async () => ({ json: async () => ({ datasets: [] }) }),
  });
  const action = actionForButton("datasetLabBtn");

  await context[action]();
  assert.equal(panel.style.display, "flex");
  assert.equal(backdrop.style.display, "block");

  await context[action]();
  assert.equal(panel.style.display, "none");
  assert.equal(backdrop.style.display, "none");
});

// ── S2.3 — the settings overlay must tell "slow" apart from "dead" ─────────
// public/index.html ships <div class="stov-empty" data-i18n="stov_loading">
// already inside #stovBody. load() only ever replaces it on success or on a
// rejected fetch, so before this fix a server with a blocked event loop left
// that "Loading…" placeholder on screen for ever, with no hint anything was
// wrong. These three tests pin the deadline, the happy path and the cancel.

// A clock the test drives by hand. The harness's default setTimeout is a
// no-op, which would silently swallow any timeout-based fix.
function manualClock() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeout(fn, ms) { pending.set(nextId, { fn, ms }); return nextId++; },
    clearTimeout(id) { pending.delete(id); },
    // Delays still armed. toggleSettingsOverlay() also arms a 60 ms focus
    // nudge, so the load deadline is identified by its much longer delay.
    get pendingDelays() { return [...pending.values()].map((x) => x.ms); },
    get pendingLoadDeadlines() { return this.pendingDelays.filter((ms) => ms >= 1000); },
    // Fire every timer whose delay is at or under `ms`.
    advance(ms) {
      for (const [id, timer] of [...pending]) {
        if (timer.ms <= ms) { pending.delete(id); timer.fn(); }
      }
    },
  };
}

function overlayElements() {
  return {
    settingsOverlay: new FakeElement(),
    stovBody: new FakeElement(),
    stovNav: new FakeElement(),
    stovSearch: new FakeElement("input"),
    stovFoot: new FakeElement(),
    stovFootMsg: new FakeElement(),
    stovSaveBtn: new FakeElement("button"),
    stovDiscardBtn: new FakeElement("button"),
  };
}

test("a never-settling config schema fetch shows the busy message, not Loading… for ever", async () => {
  const elements = overlayElements();
  elements.stovBody.innerHTML = '<div class="stov-empty" data-i18n="stov_loading">Loading…</div>';
  const clock = manualClock();
  let signal = null;
  const context = loadBrowserScript("public/scripts/settings-overlay.js", elements, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // Never settles on its own — exactly a server whose loop is blocked.
    fetch: (_url, opts = {}) => new Promise((_resolve, reject) => {
      signal = opts.signal;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    t(key) { return key; },
  });

  const open = context.toggleSettingsOverlay();
  await Promise.resolve();
  assert.ok(signal, "load() must pass an AbortSignal to fetch");
  assert.match(elements.stovBody.innerHTML, /stov_loading|Loading…/,
    "before the deadline the shipped placeholder is still what the user sees");

  clock.advance(60_000);
  await open;
  await new Promise((r) => setImmediate(r));

  assert.ok(signal.aborted, "the deadline must abort the request");
  assert.match(elements.stovBody.innerHTML, /stov_load_busy/,
    "after the deadline the user is told the server is busy");
  assert.doesNotMatch(elements.stovBody.innerHTML, /Loading…/);
});

test("a normal config schema response still renders the panel", async () => {
  const elements = overlayElements();
  elements.stovBody.innerHTML = '<div class="stov-empty" data-i18n="stov_loading">Loading…</div>';
  const clock = manualClock();
  const schema = {
    fields: [{
      key: "LLAMACPP_MODEL", category: "provider", type: "string",
      value: "qwen", default: "", tier: 1, example: "",
    }],
  };
  const context = loadBrowserScript("public/scripts/settings-overlay.js", elements, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: async () => ({ ok: true, json: async () => schema }),
    t(key) { return key; },
  });

  await context.toggleSettingsOverlay();
  await new Promise((r) => setImmediate(r));

  assert.doesNotMatch(elements.stovBody.innerHTML, /stov_load_busy|stov_load_failed/,
    "a healthy server must never show the busy or failed state");
  assert.doesNotMatch(elements.stovBody.innerHTML, /Loading…/,
    "the shipped placeholder is replaced by the rendered panel");
  assert.ok(elements.stovNav.children.length > 0, "the category nav was rendered");
  assert.deepEqual(clock.pendingLoadDeadlines, [], "the deadline timer is cleared on success");
});

test("closing the settings panel mid-load aborts the schema fetch", async () => {
  const elements = overlayElements();
  const clock = manualClock();
  let signal = null;
  const context = loadBrowserScript("public/scripts/settings-overlay.js", elements, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: (_url, opts = {}) => new Promise((_resolve, reject) => {
      signal = opts.signal;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    t(key) { return key; },
  });

  const open = context.toggleSettingsOverlay();
  await Promise.resolve();
  assert.equal(signal.aborted, false);

  context.toggleSettingsOverlay();                 // the close click
  await open;
  await new Promise((r) => setImmediate(r));

  assert.equal(signal.aborted, true, "the in-flight fetch is cancelled on close");
  assert.equal(elements.settingsOverlay.style.display, "none");
  // A user-initiated close is not a failure: it must not paint an error.
  assert.doesNotMatch(elements.stovBody.innerHTML, /stov_load_busy|stov_load_failed/);
  assert.deepEqual(clock.pendingLoadDeadlines, [], "the deadline timer is cleared on close too");
});
