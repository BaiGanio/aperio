// tests/lib/routes/paths.test.js
// PATH-01 — `~` expansion. Only a bare `~` or `~/...` expands to the home dir;
// `~user/...` is left intact rather than mangled into `<home>user/...`.
// PATH-02 — `realpathSafe`/`isUnder` are the exported, shared containment gate.
// Every module doing path safety must reuse these instead of hand-rolling a
// second implementation that can drift (see issue #301, finding 7).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "os";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "fs";
import { join, resolve, sep } from "path";
import { expandTilde, realpathSafe, isUnder } from "../../../lib/routes/paths.js";

describe("expandTilde", () => {
  const home = homedir();

  test("expands a bare ~", () => assert.equal(expandTilde("~"), home));
  test("expands ~/path", () => assert.equal(expandTilde("~/projects/x"), `${home}/projects/x`));

  test("leaves ~user untouched", () => assert.equal(expandTilde("~bob/secret"), "~bob/secret"));
  test("leaves an embedded ~ untouched", () => assert.equal(expandTilde("/a/~/b"), "/a/~/b"));
  test("leaves absolute paths untouched", () => assert.equal(expandTilde("/etc/passwd"), "/etc/passwd"));
});

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aperio-paths-")));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, allowed, outside };
}

describe("realpathSafe", () => {
  test("resolves an existing path through symlinks", () => {
    const { allowed, outside } = sandbox();
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "s");
    const link = join(allowed, "link.txt");
    symlinkSync(secret, link);

    assert.equal(realpathSafe(link), secret);
  });

  test("resolves the existing prefix and re-appends a non-existent tail", () => {
    const { allowed } = sandbox();
    const target = join(allowed, "does", "not", "exist.txt");

    // Never throws for write targets that do not exist yet.
    assert.equal(realpathSafe(target), target);
  });
});

describe("isUnder", () => {
  test("accepts the root itself and paths beneath it", () => {
    const { allowed } = sandbox();
    const nested = join(allowed, "a", "b");
    mkdirSync(nested, { recursive: true });

    assert.equal(isUnder(allowed, [allowed]), true);
    assert.equal(isUnder(nested, [allowed]), true);
  });

  test("rejects a sibling that merely shares the root's prefix", () => {
    const { root, allowed } = sandbox();
    const sibling = `${allowed}-evil`;
    mkdirSync(sibling, { recursive: true });

    assert.equal(isUnder(sibling, [allowed]), false);
    assert.equal(isUnder(root, [allowed]), false);
  });

  test("rejects a symlink inside the root that escapes it", () => {
    const { allowed, outside } = sandbox();
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "s");
    const link = join(allowed, "link.txt");
    symlinkSync(secret, link);

    assert.equal(isUnder(link, [allowed]), false);
  });

  test("matches on the platform path separator, not a hardcoded slash", () => {
    // On win32 `resolve()` yields backslash-delimited paths, so a hardcoded
    // "/" boundary would collapse containment to exact-equality and reject
    // every real subpath. Assert the boundary the module actually joins on.
    const { allowed } = sandbox();
    const nested = join(allowed, "child");
    mkdirSync(nested, { recursive: true });

    assert.equal(nested, allowed + sep + "child");
    assert.equal(isUnder(nested, [allowed]), true);
  });

  test("expands ~ before checking containment", () => {
    assert.equal(isUnder("~", [realpathSafe(resolve(homedir()))]), true);
  });
});
