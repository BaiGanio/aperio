import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const read = (file) => readFileSync(resolve(root, file), "utf8");

test("CSP: static UI has no inline event-handler attributes", () => {
  for (const file of ["public/index.html", "public/setup.html"]) {
    const html = read(file);
    assert.doesNotMatch(html, /\bon[a-z]+\s*=/i, `${file} still contains an inline event handler`);
  }
});

test("CSP: setup wizard has no inline script blocks", () => {
  assert.doesNotMatch(read("public/setup.html"), /<script\s*>/i);
  assert.match(read("public/setup.html"), /<script\s+src="scripts\/setup\.js"><\/script>/);
});

test("CSP: generated templates have no inline event-handler attributes", () => {
  for (const file of [
    "public/scripts/markdown.js",
    "public/scripts/rendering.js",
    "public/scripts/sessions.js",
    "public/scripts/streaming.js",
    "public/scripts/wiki-panel.js",
  ]) {
    assert.doesNotMatch(read(file), /on(click|change|input|error)\s*=\s*["'`]/i, `${file} still emits inline handlers`);
  }
});

test("CSP: static UI styles are class-based", () => {
  for (const file of ["public/index.html", "public/setup.html"]) {
    const count = (read(file).match(/\bstyle="/g) || []).length;
    assert.ok(count <= 2, `${file} has ${count} remaining inline styles`);
  }
});

test("CSP: external wiring and policy configuration are present", () => {
  assert.match(read("public/index.js"), /data-action/);
  assert.match(read("lib/server.js"), /APERIO_CSP/);
  assert.match(read("lib/server.js"), /sandboxStatic/);
  assert.match(read(".env.example"), /APERIO_CSP=on/);
});
