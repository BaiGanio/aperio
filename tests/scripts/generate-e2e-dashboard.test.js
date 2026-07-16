import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");

test("E2E dashboard generator transforms existing reporter JSON without running tests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aperio-e2e-dashboard-"));
  const input = join(dir, "results.json");
  const output = join(dir, "e2e-data.js");
  const result = {
    generatedAt: "2026-07-16T00:00:00.000Z",
    source: "tests/e2e/",
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration_ms: 5,
    passRate: 100,
    suites: [],
  };

  try {
    await writeFile(input, JSON.stringify(result));
    await execFileAsync(process.execPath, [
      "scripts/generate-e2e-dashboard.js",
      "--input", input,
      "--output", output,
    ], { cwd: ROOT });

    const generated = await readFile(output, "utf8");
    assert.match(generated, /^window\.APERIO_E2E = /);
    const data = JSON.parse(generated.replace(/^window\.APERIO_E2E = /, "").replace(/;\n$/, ""));
    assert.equal(data.total, 1);
    assert.equal(data.passed, 1);
    assert.equal(typeof data.commit, "string");
    assert.ok(Array.isArray(data.files));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
