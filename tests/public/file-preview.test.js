import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
