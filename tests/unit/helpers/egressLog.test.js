import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const MODULE = fileURLToPath(new URL("../../../lib/helpers/egressLog.js", import.meta.url));

test("rotates the egress log at a bounded size and keeps one backup", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aperio-egress-"));
  try {
    const script = [
      `const { logEgress } = await import(${JSON.stringify(`file://${MODULE}`)});`,
      `logEgress({ tool: "test", host: "example.test", target: "x".repeat(${5 * 1024 * 1024 - 200}) });`,
      `logEgress({ tool: "test", host: "example.test", target: "after-rotation" });`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production" },
    });
    assert.equal(result.status, 0, result.stderr);

    const log = join(cwd, "var/logs/egress.log");
    const rotated = join(cwd, "var/logs/egress.log.1");
    assert.ok(statSync(rotated).size > 5 * 1024 * 1024 - 500, "the previous log was rotated");
    assert.match(readFileSync(log, "utf8"), /after-rotation/);
    assert.ok(statSync(log).size < 1000, "the active log contains only post-rotation entries");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
