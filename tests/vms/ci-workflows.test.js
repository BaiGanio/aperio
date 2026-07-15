import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

test("lite smoke covers five supported hosted OS/architecture runners", async () => {
  const workflow = await readFile(resolve(ROOT, ".github/workflows/ci.lite-smoke.yml"), "utf8");
  assert.match(workflow, /fail-fast:\s*false/);
  for (const runner of ["ubuntu-latest", "ubuntu-24.04-arm", "macos-latest", "windows-latest", "windows-11-arm"]) {
    assert.match(workflow, new RegExp(`os: ${runner.replace(/[.-]/g, "\\$&")}`));
  }
  assert.match(workflow, /timeout-minutes:\s*15/);
  assert.match(workflow, /RUNNER_ARCH/);
  assert.match(workflow, /test "\$RUNNER_ARCH" = ARM64/);
});

test("install matrix exercises local installer, update path, uninstall, and smoke", async () => {
  const workflow = await readFile(resolve(ROOT, ".github/workflows/ci.install-matrix.yml"), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /file:\/\/\$GITHUB_WORKSPACE/);
  assert.match(workflow, /git branch --force/);
  assert.match(workflow, /bash \.github\/lite\/install\.sh <\/dev\/null/);
  assert.match(workflow, /vmtest-sentinel/);
  assert.match(workflow, /uninstall\.sh/);
  assert.match(workflow, /test ! -e "\$install_dir"/);
  assert.match(workflow, /vms\/smoke\.sh/);
});

test("install matrix packages the Windows launcher and runs PowerShell smoke", async () => {
  const workflow = await readFile(resolve(ROOT, ".github/workflows/ci.install-matrix.yml"), "utf8");
  assert.match(workflow, /git archive --format=tar/);
  assert.match(workflow, /Compress-Archive/);
  assert.match(workflow, /Expand-Archive/);
  assert.match(workflow, /START\.bat/);
  assert.match(workflow, /taskkill\.exe .*\/T \/F/);
  assert.match(workflow, /vms\/smoke\.ps1/);
});

test("nightly/full-suite job is pinned to ARM runner labels", async () => {
  const workflow = await readFile(resolve(ROOT, ".github/workflows/ci.install-matrix.yml"), "utf8");
  assert.match(workflow, /ubuntu-24\.04-arm/);
  assert.match(workflow, /windows-11-arm/);
  assert.match(workflow, /full-suite-arm/);
  assert.match(workflow, /npm run test:ci/);
});
