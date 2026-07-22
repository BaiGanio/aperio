import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");

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
  assert.match(workflow, /APERIO_INSTALL_NO_START=1/);
  assert.match(workflow, /vmtest-sentinel/);
  assert.match(workflow, /uninstall\.sh/);
  // uninstall.sh deliberately leaves the container folder in place, so the
  // workflow must assert on the pieces it actually removes, not the folder.
  assert.match(workflow, /test ! -e "\$install_dir\/node_modules"/);
  assert.match(workflow, /test ! -e "\$install_dir\/var"/);
  assert.match(workflow, /test ! -e "\$install_dir\/\.sqlite"/);
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
  // node_modules/ appears near-instantly but npm populates it over several
  // seconds; the wait must key off npm's own last-write marker, not the
  // directory's mere existence, or smoke.ps1 can run against a half-installed tree.
  assert.match(workflow, /node_modules\/\.package-lock\.json/);
});

test("nightly/full-suite job is pinned to ARM runner labels", async () => {
  const workflow = await readFile(resolve(ROOT, ".github/workflows/ci.install-matrix.yml"), "utf8");
  assert.match(workflow, /ubuntu-24\.04-arm/);
  assert.match(workflow, /windows-11-arm/);
  assert.match(workflow, /full-suite-arm/);
  assert.match(workflow, /npm run test:ci/);
  assert.match(workflow, /name: Run full test suite\s+shell: bash\s+run: npm run test:ci/);
});

test("Codecov refreshes complete coverage and test dashboards", async () => {
  const coverageWorkflow = await readFile(resolve(ROOT, ".github/workflows/ci.codecov.yml"), "utf8");
  const e2eWorkflow = await readFile(resolve(ROOT, ".github/workflows/ci.e2e-real.yml"), "utf8");
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));

  assert.match(coverageWorkflow, /^  coverage-tests:/m);
  assert.match(coverageWorkflow, /npm run test:ci/);
  assert.match(coverageWorkflow, /npm run coverage:dashboard/);
  assert.match(coverageWorkflow, /npm run unit:dashboard/);
  assert.match(coverageWorkflow, /npm run integration:dashboard/);
  assert.match(coverageWorkflow, /^  e2e-dashboard:/m);
  assert.match(coverageWorkflow, /npm run test:e2e:ci:dashboard/);
  assert.match(coverageWorkflow, /needs: \[coverage-tests, e2e-dashboard\]/);
  assert.match(e2eWorkflow, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(e2eWorkflow, /^  (push|pull_request|schedule):/m);
  assert.match(e2eWorkflow, /npm run test:e2e:real/);
  assert.match(e2eWorkflow, /timeout-minutes:\s*10/);

  assert.match(pkg.scripts["test:ci"], /--reporter=lcov/);
  assert.match(pkg.scripts["test:ci"], /find tests\/unit tests\/integration -name/);
  assert.match(pkg.scripts["test:ci"], /ci-json\.js/);
  assert.match(pkg.scripts["test:ci"], /tests\/results\/test-results\.json/);
  assert.doesNotMatch(pkg.scripts["test:ci"], /unit-json\.js|integration-json\.js/);
  assert.match(pkg.scripts["test:unit:ci"], /find tests\/unit -name/);
  assert.match(pkg.scripts["test:integration:ci"], /find tests\/integration -name/);
  assert.match(pkg.scripts["test:e2e:ci"], /find tests\/e2e -name/);
  assert.doesNotMatch(pkg.scripts["test:e2e:ci"], /-not -name/);
  assert.match(pkg.scripts["test:e2e:ci"], /tests\/results\/e2e-results\.json/);
  assert.match(pkg.scripts["test:unit:ci"], /tests\/results\/unit-results\.json/);
  assert.match(pkg.scripts["test:integration:ci"], /tests\/results\/integration-results\.json/);
  assert.equal(pkg.scripts["test:ci:unit"], "npm run test:unit:ci");
  assert.equal(pkg.scripts["test:ci:integration"], "npm run test:integration:ci");
  assert.equal(pkg.scripts["test:unit:dashboard"], "npm run test:unit:ci:dashboard");
  assert.equal(pkg.scripts["test:e2e:dashboard"], "npm run test:e2e:ci:dashboard");
  assert.match(pkg.scripts["test:e2e:real"], /--test-concurrency=2/);
});
