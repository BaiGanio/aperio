import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");

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

test("Windows smoke contract survives legacy PowerShell argument passing and keeps logs separate", async () => {
  const script = await readFile(resolve(ROOT, "vms/smoke.ps1"), "utf8");
  assert.match(script, /process\.versions\.node\.match\(\/\^\\d\+\/\)\[0\]/);
  assert.match(script, /-RedirectStandardOutput\s+\$StdoutLog/);
  assert.match(script, /-RedirectStandardError\s+\$StderrLog/);
  assert.doesNotMatch(script, /-RedirectStandardOutput\s+(['"])([^'"\r\n]+)\1\s+-RedirectStandardError\s+\1\2\1/);
});

test("one-liner installer exposes a documented automation mode without changing interactive launch", async () => {
  const installer = await readFile(resolve(ROOT, ".github/lite/install.sh"), "utf8");
  assert.match(installer, /APERIO_INSTALL_NO_START/);
  assert.match(installer, /ask\(\)[\s\S]+APERIO_INSTALL_NO_START[\s\S]+return/);
  assert.match(installer, /elif \[ -r \/dev\/tty \]/);
  assert.match(installer, /exec bash START\.sh/);
});

test("lite smoke workflow delegates to the shared contract", async () => {
  const workflow = await readFile(resolve(ROOT, ".github/workflows/ci.lite-smoke.yml"), "utf8");
  assert.match(workflow, /bash vms\/smoke\.sh \./);
  assert.match(workflow, /vms\\smoke\.ps1/);
  assert.doesNotMatch(workflow, /ci.lite-smoke.yml.*ci.lite-smoke\.yml/);
  assert.doesNotMatch(workflow, /for _ in \$\(seq 1 90\)/);
});

test("visual VM guide links to maintained instructions and describes both desktop reset modes", async () => {
  const guide = await readFile(resolve(ROOT, "docs/vms.html"), "utf8");
  assert.doesNotMatch(guide, /href="README\.md"/);
  assert.match(guide, /snapshot \+ linked clone/i);
  assert.match(guide, /private paths and runtime details/i);
});
