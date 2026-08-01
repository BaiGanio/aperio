// tests/lib/helpers/secureFile.test.js
// DATA-01 — 0600 files / 0700 dirs for local state at rest.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureSecureDir, writeSecureFile } from "../../../lib/helpers/secureFile.js";

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), "aperio-secure-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const mode = (p) => statSync(p).mode & 0o777;

describe("writeSecureFile", () => {
  test("creates a new file 0600", () => {
    const p = join(dir, "fresh.json");
    writeSecureFile(p, "{}");
    assert.equal(mode(p), 0o600);
  });

  test("tightens an existing world-readable file to 0600", () => {
    const p = join(dir, "loose.json");
    writeFileSync(p, "old");
    chmodSync(p, 0o644);
    writeSecureFile(p, "new");
    assert.equal(mode(p), 0o600);
  });
});

describe("ensureSecureDir", () => {
  test("creates a dir 0700", () => {
    const sub = join(dir, "nested", "deep");
    ensureSecureDir(sub);
    assert.equal(mode(sub), 0o700);
  });
});
