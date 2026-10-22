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
import {
  expandTilde,
  realpathSafe,
  isUnder,
  resolveScratchPath,
  runWithPaths,
} from "../../../lib/routes/paths.js";

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

describe("resolveScratchPath", () => {
  test("rebases a legacy scratch-root file into the active session workspace", () => {
    const sessionScratch = join(process.cwd(), "var", "scratch", "session-123");
    const legacyPath = join(process.cwd(), "var", "scratch", "create-pdf.js");

    const resolved = runWithPaths([], [], sessionScratch, () =>
      resolveScratchPath(legacyPath),
    );

    assert.equal(resolved, join(sessionScratch, "create-pdf.js"));
  });

  test("leaves absolute paths outside the legacy scratch root unchanged", () => {
    const sessionScratch = join(process.cwd(), "var", "scratch", "session-123");
    const projectPath = join(process.cwd(), "scripts", "build.js");

    const resolved = runWithPaths([], [], sessionScratch, () =>
      resolveScratchPath(projectPath),
    );

    assert.equal(resolved, projectPath);
  });

  test("rebases a repeated legacy path when the session file now exists", () => {
    const { allowed: sessionScratch } = sandbox();
    const sessionScript = join(sessionScratch, "create-pdf.js");
    const legacyPath = join(process.cwd(), "var", "scratch", "create-pdf.js");
    writeFileSync(sessionScript, "// generated");

    const resolved = runWithPaths([], [], sessionScratch, () =>
      resolveScratchPath(legacyPath, { mustExist: true }),
    );

    assert.equal(resolved, sessionScript);
  });

  // Regression: a model asked for a PPTX/PDF/etc. routinely invents its own
  // output folder name ("outputs/deck.pptx") instead of using a bare filename.
  // write_file's create_dirs would otherwise silently mkdir -p that brand-new
  // folder straight into the real project tree instead of the session
  // workspace. The redirect must fire for this nested case exactly as it
  // already does for a flat "BASE_DIR/file.js" write.
  test("redirects a new absolute path under a NOT-YET-EXISTING project subdirectory into scratch", () => {
    const sessionScratch = join(process.cwd(), "var", "scratch", "session-456");
    const inventedPath = join(process.cwd(), "aperio-test-invented-outputs-dir", "deck.pptx");

    const resolved = runWithPaths([], [], sessionScratch, () =>
      resolveScratchPath(inventedPath, { redirectProjectRoot: true }),
    );

    assert.equal(resolved, join(sessionScratch, "deck.pptx"));
  });

  // An absolute path under a directory that's a genuine, existing part of the
  // project (the model editing a real source file) must never be hijacked
  // into scratch — the redirect is only for directories the model just made up.
  test("leaves an absolute path under an EXISTING project directory unchanged", () => {
    const sessionScratch = join(process.cwd(), "var", "scratch", "session-456");
    const realProjectPath = join(process.cwd(), "lib", "aperio-test-nonexistent-file.js");

    const resolved = runWithPaths([], [], sessionScratch, () =>
      resolveScratchPath(realProjectPath, { redirectProjectRoot: true }),
    );

    assert.equal(resolved, realProjectPath);
  });

  // The redirect is bounded to ONE new level directly under BASE_DIR. A path
  // two levels deep whose grandparent ("lib") is real project structure reads
  // as genuine engineering work (a new subdirectory of an existing area), not
  // an invented one-off output folder, so it must NOT be redirected even
  // though its immediate parent doesn't exist yet.
  test("leaves a new subdirectory of an EXISTING project directory unchanged", () => {
    const sessionScratch = join(process.cwd(), "var", "scratch", "session-456");
    const newSubdirPath = join(process.cwd(), "lib", "aperio-test-invented-subdir", "new.js");

    const resolved = runWithPaths([], [], sessionScratch, () =>
      resolveScratchPath(newSubdirPath, { redirectProjectRoot: true }),
    );

    assert.equal(resolved, newSubdirPath);
  });
});
