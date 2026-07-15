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

test("Docker runner requires an image and never pulls missing local tags", async () => {
  const script = await readFile(resolve(ROOT, "vms/docker/run.sh"), "utf8");
  assert.match(script, /--image/);
  assert.match(script, /docker image inspect "\$IMAGE"/);
  assert.match(script, /local image is missing \(no pull attempted\)/);
  assert.match(script, /ghcr\.io\//);
  assert.match(script, /docker pull "\$IMAGE"/);
});

test("Docker runner uses isolated non-default networking and volume state", async () => {
  const script = await readFile(resolve(ROOT, "vms/docker/run.sh"), "utf8");
  assert.match(script, /docker volume create/);
  assert.match(script, /--mount "type=volume/);
  assert.match(script, /DB_BACKEND=sqlite/);
  assert.match(script, /127\.0\.0\.1:\$\{PORT\}:31337/);
  assert.match(script, /PORT.*31337/);
  assert.match(script, /SQLITE_PATH=\/app\/var\/vms\.db/);
});

test("Docker runner records metadata, checks the UI contract, and always cleans up", async () => {
  const script = await readFile(resolve(ROOT, "vms/docker/run.sh"), "utf8");
  assert.match(script, /trap cleanup EXIT INT TERM/);
  assert.match(script, /docker inspect "\$CONTAINER"/);
  assert.match(script, /docker logs "\$CONTAINER"/);
  assert.match(script, /docker rm -f "\$CONTAINER"/);
  assert.match(script, /docker volume rm "\$VOLUME"/);
  assert.match(script, /api\/bootstrap\/state/);
  assert.match(script, /setup\.html/);
});

test("Docker workflow builds local image and accepts an explicit published reference", async () => {
  const workflow = await readFile(resolve(ROOT, ".github/workflows/ci.docker-smoke.yml"), "utf8");
  assert.match(workflow, /docker\/build-push-action/);
  assert.match(workflow, /load: true/);
  assert.match(workflow, /aperio:test-local/);
  assert.match(workflow, /ghcr_digest/);
  assert.match(workflow, /inputs\.ghcr_digest/);
  assert.match(workflow, /vms\/docker\/run\.sh/);
});

test("Docker runner rejects a missing image before creating resources", async () => {
  const result = await run("bash", ["vms/docker/run.sh", "--image", "aperio:missing-static-test"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no pull attempted|docker is required|choose a valid/);
});
