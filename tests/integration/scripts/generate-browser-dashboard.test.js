import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../..");
const BROWSER_DIR = resolve(ROOT, "tests/browser");

/** Every browser spec on disk, named and ordered the way the generator emits them. */
function browserSpecsOnDisk(dir = BROWSER_DIR) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return browserSpecsOnDisk(full);
      return entry.name.endsWith(".spec.js") ? [relative(BROWSER_DIR, full).replaceAll("\\", "/")] : [];
    })
    .sort((a, b) => a.localeCompare(b));
}

test("Browser dashboard generator transforms Playwright reporter JSON without running tests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aperio-browser-dashboard-"));
  const input = join(dir, "results.json");
  const output = join(dir, "browser-data.js");
  const result = {
    generatedAt: "2026-07-29T00:00:00.000Z",
    source: "tests/browser/",
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration_ms: 5,
    passRate: 100,
    suites: [{
      name: "App shell smoke",
      testCount: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      duration_ms: 5,
      passRate: 100,
      tests: [{
        name: "loads the shell",
        file: "smoke/app-shell.spec.js",
        status: "pass",
        duration_ms: 5,
        error: null,
      }],
    }],
  };

  try {
    await writeFile(input, JSON.stringify(result));
    await execFileAsync(process.execPath, [
      "scripts/generate-browser-dashboard.js",
      "--input", input,
      "--output", output,
    ], { cwd: ROOT });

    const generated = await readFile(output, "utf8");
    assert.match(generated, /^window\.APERIO_BROWSER = /);
    const data = JSON.parse(
      generated.replace(/^window\.APERIO_BROWSER = /, "").replace(/;\n$/, "")
    );
    assert.equal(data.total, 1);
    assert.equal(data.passed, 1);
    assert.equal(typeof data.commit, "string");
    // The generator lists every spec on disk, not just the ones the reporter
    // JSON mentions — that is how a spec nobody ran still shows up with a zero
    // test count. Derive the expectation the same way instead of hardcoding it,
    // so adding a browser spec doesn't fail an unrelated test.
    assert.deepEqual(data.files.map(file => file.name), browserSpecsOnDisk());
    assert.equal(data.files.find(file => file.name === "smoke/app-shell.spec.js").testCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
