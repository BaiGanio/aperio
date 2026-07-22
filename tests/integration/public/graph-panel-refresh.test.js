import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeElement {
  constructor() {
    this.style = {};
    this.value = "";
    this.innerHTML = "";
    this.dataset = {};
  }

  addEventListener() {}
  focus() {}
  querySelectorAll() { return []; }
}

function loadPanel(kind) {
  const prefix = kind === "docgraph" ? "dg" : "cg";
  const panelId = `${kind}-panel`;
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  element(panelId).style.display = "none";

  const timers = [];
  const requests = [];
  let status = { enabled: true, phase: "idle", roots: [] };
  const repos = kind === "docgraph"
    ? { enabled: true, repos: [] }
    : { enabled: true, repos: [] };
  const document = {
    addEventListener() {},
    getElementById: element,
  };
  const context = vm.createContext({
    console,
    document,
    window: null,
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    fetch: async (url) => {
      requests.push(url);
      const payload = url.endsWith("/status") ? status : repos;
      return { ok: true, json: async () => payload };
    },
  });
  context.window = context;
  vm.runInContext(
    readFileSync(new URL(`../../../public/scripts/${kind}-panel.js`, import.meta.url), "utf8"),
    context,
    { filename: `public/scripts/${kind}-panel.js` },
  );

  return {
    context,
    elements,
    timers,
    requests,
    prefix,
    panelId,
    setStatus(next) { status = next; },
  };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

for (const kind of ["docgraph", "codegraph"]) {
  const toggle = kind === "docgraph" ? "toggleDocgraphPanel" : "toggleCodegraphPanel";
  const reposUrl = `/api/${kind}/repos`;

  test(`${kind} reloads indexed folders every time the panel opens`, async () => {
    const app = loadPanel(kind);

    await app.context[toggle]();
    await flushAsyncWork();
    const firstIdleTimer = app.timers.find((timer) => timer.delay === 5000 && !timer.cleared);
    assert.ok(firstIdleTimer);
    await app.context[toggle]();
    assert.equal(firstIdleTimer.cleared, true, "closing the panel releases its discovery timer");
    await app.context[toggle]();
    await flushAsyncWork();

    assert.equal(app.requests.filter((url) => url === reposUrl).length, 2);
  });

  test(`${kind} discovers indexing started outside the panel`, async () => {
    const app = loadPanel(kind);
    await app.context[toggle]();
    await flushAsyncWork();

    const idleTimer = app.timers.find((timer) => timer.delay === 5000 && !timer.cleared);
    assert.ok(idleTimer, "an open idle panel keeps a bounded discovery poll alive");

    const counts = kind === "docgraph" ? { docs: 20, chunks: 40 } : { files: 20, symbols: 40 };
    app.setStatus({
      enabled: true,
      phase: "indexing",
      roots: [{ path: "/tmp/new-root", phase: "indexing", error: null, ...counts }],
    });
    await idleTimer.fn();
    await flushAsyncWork();

    const liveRegion = app.elements.get(`${app.prefix}-live-region`);
    assert.match(liveRegion.innerHTML, /Indexing 0\/1 folder/);
    assert.ok(app.timers.some((timer) => timer.delay === 1500 && !timer.cleared));
  });
}
