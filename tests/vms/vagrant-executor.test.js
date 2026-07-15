import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolvePromise({ code, stderr }));
  });
}

test("Vagrant executor is syntactically valid and isolates host dependencies", async () => {
  const vagrantfile = await readFile(resolve(ROOT, "vms/Vagrantfile"), "utf8");
  const syntax = await run("ruby", ["-c", "vms/Vagrantfile"]);
  assert.equal(syntax.code, 0, syntax.stderr);
  assert.match(vagrantfile, /synced_folder "\.\."/);
  assert.match(vagrantfile, /type:\s*"rsync"/);
  assert.match(vagrantfile, /"node_modules\/"/);
  assert.match(vagrantfile, /bento\/ubuntu-24\.04-arm64/);
  assert.match(vagrantfile, /bento\/debian-12-arm64/);
  assert.match(vagrantfile, /provider\s+"parallels"/);
  assert.match(vagrantfile, /vms\/smoke\.sh/);
});

test("Vagrant wrapper logs, collects guest output, and destroys on every exit", async () => {
  const wrapper = await readFile(resolve(ROOT, "vms/run-vagrant.sh"), "utf8");
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["vmtest:linux"], "bash vms/run-vagrant.sh ubuntu-lite");
  assert.equal(pkg.scripts["vmtest:linux:debian"], "bash vms/run-vagrant.sh debian-dev");
  assert.match(wrapper, /set -o pipefail/);
  assert.match(wrapper, /VAGRANT_CWD=\"\$ROOT\/vms\"/);
  assert.match(wrapper, /trap cleanup EXIT INT TERM/);
  assert.match(wrapper, /vagrant ssh \"\$PROFILE\"/);
  assert.match(wrapper, /vagrant destroy -f \"\$PROFILE\"/);
  assert.match(wrapper, /tee \"\$LOG\"/);
  assert.match(wrapper, /status=\$\{PIPESTATUS\[0\]\}/);
});

test("Vagrant wrapper rejects an unknown executor before touching Vagrant", async () => {
  const result = await run("bash", ["vms/run-vagrant.sh", "unknown"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage:/);
});
