import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../..");

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
    assert.equal(data.files.length, await countTestFiles(resolve(ROOT, "tests/e2e")));
    assert.ok(data.files.some((file) => file.name.startsWith("real-app/real-app-")));
    assert.ok(data.files.every((file) => file.name.includes("/")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function countTestFiles(dir) {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countTestFiles(resolve(dir, entry.name));
    else if (entry.name.endsWith(".test.js")) count++;
  }
  return count;
}
