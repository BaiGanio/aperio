import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

async function exists(file) {
  try { await access(resolve(ROOT, file), constants.F_OK); return true; }
  catch { return false; }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolvePromise({ code, stdout, stderr }));
  });
}

test("shared VM smoke contract files exist", async () => {
  for (const file of ["vms/smoke.sh", "vms/smoke.ps1", "vms/README.md"]) {
    assert.equal(await exists(file), true, `${file} exists`);
  }
});

test("POSIX smoke contract is syntactically valid", async () => {
  const result = await run("bash", ["-n", "vms/smoke.sh"]);
  assert.equal(result.code, 0, result.stderr);
});

test("lite smoke workflow delegates to the shared contract", async () => {
  const workflow = await readFile(resolve(ROOT, ".github/workflows/ci.lite-smoke.yml"), "utf8");
  assert.match(workflow, /bash vms\/smoke\.sh \./);
  assert.match(workflow, /vms\\smoke\.ps1/);
  assert.doesNotMatch(workflow, /for _ in \$\(seq 1 90\)/);
});
