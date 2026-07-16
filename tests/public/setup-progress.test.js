import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const setup = readFileSync(new URL("../../public/setup.html", import.meta.url), "utf8");
const setupScript = readFileSync(new URL("../../public/scripts/setup.js", import.meta.url), "utf8");
const setupSource = `${setup}\n${setupScript}`;

test("setup page exposes quantitative model-download UI states", () => {
  for (const state of ["downloading", "completed", "failed", "aborted"]) {
    assert.match(setupSource, new RegExp(`status.*${state}|${state}.*status`));
  }
  assert.match(setupSource, /total unknown/);
  assert.match(setupSource, /Resuming download/);
  assert.match(setupSource, /ETA/);
  assert.match(setupSource, /addEventListener\("progress"/);
});
