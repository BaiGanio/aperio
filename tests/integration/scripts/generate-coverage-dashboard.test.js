import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../..");

test("coverage dashboard generator preserves LCOV line, branch, and function totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aperio-coverage-dashboard-"));
  const input = join(dir, "lcov.info");
  const output = join(dir, "coverage-data.js");
  const lcov = [
    "SF:/workspace/aperio/lib/example.js",
    "FNDA:1,covered",
    "FNDA:0,uncovered",
    "DA:1,1",
    "DA:2,0",
    "BRDA:1,0,0,1",
    "BRDA:1,0,1,-",
    "end_of_record",
    "",
  ].join("\n");

  try {
    await writeFile(input, lcov);
    await execFileAsync(process.execPath, [
      "scripts/generate-coverage-dashboard.js",
      "--input", input,
      "--output", output,
    ], { cwd: ROOT });

    const generated = await readFile(output, "utf8");
    const data = JSON.parse(generated.replace(/^window\.APERIO_COVERAGE = /, "").replace(/;\n$/, ""));
    assert.equal(data.files.length, 1);
    assert.equal(data.files[0].path, "lib/example.js");
    assert.deepEqual(data.totals, {
      linesFound: 2,
      linesHit: 1,
      branchesFound: 2,
      branchesHit: 1,
      functionsFound: 2,
      functionsHit: 1,
      percent: 50,
      branchesPercent: 50,
      functionsPercent: 50,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
