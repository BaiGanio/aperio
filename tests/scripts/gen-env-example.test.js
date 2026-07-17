// tests/scripts/gen-env-example.test.js
// Test group C of the .env→DB settings plan (#252): the generator emits a slim
// .env.example (envTemplate keys only) plus a complete docs/config-reference.md,
// and --check gates drift in BOTH files.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../../lib/config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "gen-env-example.js");

const run = (args, dir) =>
  spawnSync(process.execPath, [SCRIPT, "--out-dir", dir, ...args], { encoding: "utf8" });

// Every KEY mentioned as an assignment (set or commented) in the template.
const keysIn = (text) => {
  const keys = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return keys;
};

describe("gen-env-example (#252 group C)", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aperio-genenv-")); });

  test("C1: slim template — exactly the envTemplate keys, ≤ 60 lines, banner present", () => {
    const r = run([], dir);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(dir, ".env.example"), "utf8");

    const expected = new Set(CONFIG.filter((e) => e.envTemplate).map((e) => e.key));
    assert.deepEqual(keysIn(text), expected);

    const lines = text.trimEnd().split("\n").length;
    assert.ok(lines <= 60, `template is ${lines} lines, budget 60`);

    assert.match(text, /config-reference\.md/);
    assert.match(text, /APERIO_CONFIG_PRECEDENCE=env/);
  });

  test("C1 edge: no tier-1 non-START-HERE key appears, even commented", () => {
    run([], dir);
    const text = readFileSync(join(dir, ".env.example"), "utf8");
    for (const e of CONFIG.filter((e) => !e.envTemplate)) {
      assert.ok(!keysIn(text).has(e.key), `${e.key} leaked into the slim template`);
    }
  });

  test("C2: reference page contains every registry key and its help", () => {
    run([], dir);
    const ref = readFileSync(join(dir, "config-reference.md"), "utf8");
    for (const e of CONFIG) {
      assert.ok(ref.includes(e.key), `${e.key} missing from config-reference.md`);
      const firstHelpLine = String(e.help || "").split("\n")[0].trim();
      if (firstHelpLine) {
        assert.ok(ref.includes(firstHelpLine),
          `${e.key} help missing from config-reference.md`);
      }
    }
  });

  test("C3: --check exits non-zero when either file drifts, 0 when both match", () => {
    run([], dir);
    assert.equal(run(["--check"], dir).status, 0);

    for (const f of [".env.example", "config-reference.md"]) {
      const p = join(dir, f);
      const orig = readFileSync(p, "utf8");
      writeFileSync(p, orig + "# drift\n");
      assert.equal(run(["--check"], dir).status, 1, `--check missed drift in ${f}`);
      writeFileSync(p, orig);
    }
    assert.equal(run(["--check"], dir).status, 0);
  });
});
