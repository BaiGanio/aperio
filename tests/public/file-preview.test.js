import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const source = readFileSync(resolve("public/scripts/rendering.js"), "utf8");

test("HTML preview controls are not permanently hidden by the CSP utility class", () => {
  assert.doesNotMatch(source, /fpm-source-btn[^"`]*csp-style-13/);
  assert.doesNotMatch(source, /fpm-frame[^"`]*csp-style-13/);
});

test("HTML artifact modal exposes preview, code, browser, and folder actions", () => {
  for (const className of [
    "fpm-preview-btn",
    "fpm-code-btn",
    "fpm-browser-btn",
    "fpm-folder-btn",
  ]) {
    assert.match(source, new RegExp(className), `missing ${className}`);
  }
  assert.match(source, /window\.open\([^)]*"_blank"/);
  assert.match(source, /fetch\("\/api\/artifact\/reveal"/);
});

test("generated file preview retains the artifact URL for external actions", () => {
  assert.match(source, /modal\.dataset\.artifactUrl\s*=\s*url/);
});

test("failed generated-file fetch hides actions for the unavailable artifact", async () => {
  const start = source.indexOf("async function openGeneratedFileModal");
  const end = source.indexOf("\n}\n\n// Open an HTML string", start) + 2;
  const functionSource = source.slice(start, end);
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        classList: { add() {} },
        dataset: {},
        hidden: true,
        innerHTML: "",
        style: {},
        textContent: "",
      });
    }
    return elements.get(selector);
  };
  const modal = element("#file-preview-modal");
  modal.querySelector = element;

  const context = vm.createContext({
    document: { getElementById: () => modal },
    ensureFileModal() {},
    fetch: async () => { throw new Error("offline"); },
    getFileIcon: () => "",
    renderFileModal() {},
  });
  vm.runInContext(`${functionSource}; this.openGeneratedFileModal = openGeneratedFileModal;`, context);

  await context.openGeneratedFileModal("/scratch/session-1/missing.html", "missing.html");

  assert.equal(element(".fpm-browser-btn").hidden, true);
  assert.equal(element(".fpm-folder-btn").hidden, true);
});
