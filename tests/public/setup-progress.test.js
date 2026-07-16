import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const setup = readFileSync(new URL("../../public/setup.html", import.meta.url), "utf8");

test("setup page exposes quantitative model-download UI states", () => {
  for (const state of ["downloading", "completed", "failed", "aborted"]) {
    assert.match(setup, new RegExp(`status.*${state}|${state}.*status`));
  }
  assert.match(setup, /total unknown/);
  assert.match(setup, /Resuming download/);
  assert.match(setup, /ETA/);
  assert.match(setup, /addEventListener\("progress"/);
});
