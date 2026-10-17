// tests/scripts/gen-env-example.test.js
// Test group C of the .env→DB settings plan (#252): the generator emits the
// complete registry as both .env.example and docs/config-reference.md (every
// variable Aperio reads, in both places — dev users get everything in one
// file), and --check gates drift in BOTH files.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../../../lib/config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
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

  test("C1: complete template — every registry key present, banner present", () => {
    const r = run([], dir);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(dir, ".env.example"), "utf8");

    const expected = new Set(CONFIG.map((e) => e.key));
    assert.deepEqual(keysIn(text), expected);

    assert.match(text, /config-reference\.md/);
    assert.match(text, /APERIO_CONFIG_PRECEDENCE=env/);
    assert.match(text, /STOP HERE/);
  });

  test("C1 edge: each key's active state follows its registry `show` metadata", () => {
    run([], dir);
    const text = readFileSync(join(dir, ".env.example"), "utf8");
    const lines = text.split("\n");
    for (const e of CONFIG) {
      const assignLine = lines.find((l) => l.replace(/^#\s*/, "").startsWith(`${e.key}=`));
      assert.ok(assignLine, `${e.key} assignment line missing`);
      const isActive = !assignLine.trimStart().startsWith("#");
      const expected = e.show === "set";
      assert.equal(isActive, expected,
        `${e.key} should be ${expected ? "active" : "commented"}`);
    }
  });

  test("C1 edge: the selected fresh-install Postgres profile ships active", () => {
    run([], dir);
    const text = readFileSync(join(dir, ".env.example"), "utf8");
    const lines = text.split("\n");
    for (const key of ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "DATABASE_URL"]) {
      const assignLine = lines.find((l) => l.replace(/^#\s*/, "").startsWith(`${key}=`));
      assert.ok(assignLine, `${key} assignment line missing`);
      assert.ok(!assignLine.trimStart().startsWith("#"), `${key} must render active`);
    }
    assert.match(text, /^APERIO_ALLOW_DEFAULT_DB_PASSWORD=1$/m);
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
