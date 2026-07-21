import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFile as readTextFile } from "node:fs/promises";

const ROOT = resolve(import.meta.dirname, "../../..");

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolvePromise({ code, stderr }));
  });
}

test("Windows Parallels executor has disposable snapshot cleanup", async () => {
  const script = await readFile(resolve(ROOT, "vms/win/run.sh"), "utf8");
  assert.match(script, /snapshot-list/);
  assert.match(script, /snapshot-switch/);
  assert.match(script, /trap cleanup EXIT INT TERM/);
  assert.match(script, /prlctl stop.*--kill/);
  assert.match(script, /snapshot-switch.*--skip-resume/);
  assert.match(script, /prlctl set.*--shf-host-add/);
  assert.match(script, /--exclude node_modules\//);
  assert.match(script, /tee \"\$LOG\"/);
  const pkg = JSON.parse(await readTextFile(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["vmtest:windows"], "bash vms/win/run.sh");
});

test("Windows guest executor runs the shared PowerShell smoke contract", async () => {
  const guest = await readFile(resolve(ROOT, "vms/win/run-guest.ps1"), "utf8");
  assert.match(guest, /START\.bat/);
  assert.match(guest, /Start-Process/);
  assert.match(guest, /taskkill\.exe/);
  assert.match(guest, /smoke\.ps1/);
  assert.match(guest, /Start-Transcript/);
});

test("Windows executor rejects a missing VM before staging files", async () => {
  const result = await run("bash", ["vms/win/run.sh"]);
  assert.notEqual(result.code, 0);
});
