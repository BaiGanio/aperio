import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

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

test("macOS executor uses a linked clone and excludes host dependencies", async () => {
  const script = await readFile(resolve(ROOT, "vms/mac/run.sh"), "utf8");
  assert.match(script, /prlctl clone.*--linked/);
  assert.match(script, /--exclude node_modules\//);
  assert.match(script, /--exclude var\//);
  assert.match(script, /--exclude \.sqlite\//);
  assert.match(script, /--exclude vms\/out\//);
  assert.match(script, /--shf-host-add/);
  assert.match(script, /--mode ro/);
  assert.match(script, /prlctl exec.*run-guest\.sh/);
});

test("macOS executor cleans the fixed-name clone on every exit path", async () => {
  const script = await readFile(resolve(ROOT, "vms/mac/run.sh"), "utf8");
  assert.match(script, /trap cleanup EXIT INT TERM/);
  assert.match(script, /prlctl stop.*--kill/);
  assert.match(script, /prlctl set.*--shf-host-del/);
  assert.match(script, /prlctl delete.*--yes/);
  assert.match(script, /delete_run_vm/);
  assert.match(script, /the pristine parent is never started or deleted/);
  assert.match(script, /tee "\$LOG"/);
});

test("macOS guest runner asserts Darwin ARM64 and invokes the shared smoke contract", async () => {
  const guest = await readFile(resolve(ROOT, "vms/mac/run-guest.sh"), "utf8");
  assert.match(guest, /uname -s/);
  assert.match(guest, /uname -m/);
  assert.match(guest, /APERIO_REPO_URL="file:\/\/\$STAGE"/);
  assert.match(guest, /npm install/);
  assert.match(guest, /vms\/smoke\.sh/);
  assert.match(guest, /exec > .*tee "\$LOG"/);
});

test("macOS executor exposes the required command configuration", async () => {
  const script = await readFile(resolve(ROOT, "vms/mac/run.sh"), "utf8");
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["vmtest:mac"], "bash vms/mac/run.sh");
  assert.match(script, /VMTEST_MAC_PRISTINE_VM/);
  assert.match(script, /VMTEST_MAC_RUN_VM/);
  assert.match(script, /VMTEST_MAC_GUEST_STAGE/);
  assert.match(script, /VMTEST_MAC_READY_ATTEMPTS/);
  assert.match(script, /prlctl start/);
});

test("macOS executor rejects a missing pristine VM before staging files", async () => {
  const result = await run("bash", ["vms/mac/run.sh"]);
  assert.notEqual(result.code, 0);
});
