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
  constructor() {
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.innerHTML = "";
    this.textContent = "";
  }

  addEventListener() {}
  focus() {}
}

function loadBrowserScript(file, elements, extras = {}) {
  const document = {
    addEventListener() {},
    getElementById(id) { return elements[id] ?? null; },
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {},
  };
  const context = vm.createContext({
    console,
    document,
    localStorage,
    setTimeout() {},
    window: null,
    ...extras,
  });
  context.window = context;
  vm.runInContext(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"), context, { filename: file });
  return context;
}

function actionForButton(id) {
  const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
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
