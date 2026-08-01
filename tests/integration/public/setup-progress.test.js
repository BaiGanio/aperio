import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const setup = readFileSync(new URL("../../../public/setup.html", import.meta.url), "utf8");
const setupScript = readFileSync(new URL("../../../public/scripts/setup.js", import.meta.url), "utf8");
const setupSource = `${setup}\n${setupScript}`;

test("setup page exposes quantitative model-download UI states", () => {
  for (const state of ["downloading", "completed", "failed", "aborted"]) {
    assert.match(setupSource, new RegExp(`status.*${state}|${state}.*status`));
  }
  assert.match(setupSource, /total unknown/);
  assert.match(setupSource, /Resuming download/);
  assert.match(setupSource, /ETA/);
  assert.match(setupSource, /addEventListener\("progress"/);
  assert.match(setupSource, /is-indeterminate/);
  assert.match(setupScript, /if \(download\) applyDownloadProgress\(download\)/);
  assert.match(setupSource, /cachedModels/);
  assert.match(setupSource, /Installed/);
  assert.match(setupSource, /Download the recommended model/);
});

test("setup screen switching overrides hidden CSP placeholder styles", () => {
  assert.match(setupScript, /el\.style\.display = "flex"/);
  assert.match(setupScript, /progressView\.style\.display = "block"/);
});

test("setup failure UI never invents model-download progress", () => {
  assert.doesNotMatch(setupScript, /fill\.style\.width = "35%"/);
  assert.match(setupScript, /Download did not start/);
  assert.match(setupScript, /Transfer interrupted — retry will resume/);
  assert.match(setupScript, /setup_step_of", \{ n: done, total \}/);
  assert.doesNotMatch(setupScript, /applyDownloadProgress\(\{ status:.*data\.message/);
  assert.match(setupScript, /if \(!e\.data\) return/);
  assert.match(setupScript, /resetDownloadProgress\(\)/);
});

test("setup specs identify total memory and the model-cache filesystem", () => {
  assert.match(setupScript, /GiB/);
  assert.match(setupScript, /s\.diskPath/);
  assert.match(setupScript, /gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL/);
});
