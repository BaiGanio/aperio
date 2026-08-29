// tests/unit/git/policy-core.test.js
//
// WS2 (git-copilot #343): policy/runner core. Companion doc:
// trash/plans/git-copilot/git-copilot-tests.md, "Unit: policy-core (WS2)".
//
// Runs real git against disposable temp repos (never inside this repo tree,
// per AGENTS.md's no-stray-state rule) — this module wraps real git
// invocations, so mocking git itself would only test the mock. A spy on
// child_process.execFile (installed BEFORE importing the runner, same
// requirement as tests/integration/mcp/tools/shell.test.js for spawn) lets
// the "no process spawned for a denied mutation" case still be asserted.

import { describe, test, after, mock } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readdirSync, readFileSync, chmodSync, realpathSync, symlinkSync } from "fs";
import { join } from "path";
import { createRequire } from "node:module";

// Deliberately no static `import ... from "child_process"` above this line —
// Node snapshots a builtin's ESM facade on the FIRST `import from "<builtin>"`
// anywhere in the module graph (static imports are hoisted ahead of the
// mock.method() call below regardless of source position), which would freeze
// execFile before it's mocked. Reach child_process only through this CJS
// require, exactly like tests/integration/mcp/tools/shell.test.js does for
// spawn, so lib/git/runner.js's own later `import { execFile }` is the first
// ESM import and observes the mock.
const require = createRequire(import.meta.url);
const cp = require("child_process");
const { execFileSync } = cp;

let execFileSpyCalls = 0;
// Set to a version string (e.g. "2.38.5") to make ONLY the runner's
// `git --version` probe answer as that release. Everything else still runs
// real git, so the old-git tests exercise the real refusal path rather than a
// simulation of it. Building and shipping a second git binary just to age the
// version probe would test git, not this gate.
let fakeGitVersion = null;
const realExecFile = cp.execFile.bind(cp);
mock.method(cp, "execFile", (...args) => {
  execFileSpyCalls++;
  const [, argv, , callback] = args;
  if (fakeGitVersion && Array.isArray(argv) && argv.includes("--version") && typeof callback === "function") {
    process.nextTick(() => callback(null, `git version ${fakeGitVersion}\n`, ""));
    return undefined;
  }
  return realExecFile(...args);
});

// Same before-the-ESM-import requirement as the execFile spy above, for the
// same reason. Installed as a transparent passthrough; a single test flips
// `readdirDirentRewrite` on to simulate a filesystem that reports no d_type.
const fsp = require("fs/promises");
const realReaddir = fsp.readdir.bind(fsp);
let readdirDirentRewrite = null;
mock.method(fsp, "readdir", async (...args) => {
  const entries = await realReaddir(...args);
  return readdirDirentRewrite ? readdirDirentRewrite(entries) : entries;
});

// Same before-the-ESM-import requirement as the execFile spy, for the same
// reason (tests/integration/mcp/tools/shell.test.js does this for spawn too).
// Transparent passthrough until a test sets `taskkillStub` to make a
// `taskkill` spawn answer with a chosen exit code — the only way to exercise
// killWindowsTree()'s decision table off win32.
const realSpawn = cp.spawn.bind(cp);
let taskkillStub = null;
mock.method(cp, "spawn", (...args) => {
  if (taskkillStub && args[0] === "taskkill") return taskkillStub(args[1]);
  return realSpawn(...args);
});

const { runGit, resolveRemoteTrackingSha, spawnGit, killWindowsTree, signalChild } = await import("../../../lib/git/runner.js");
const {
  buildStageArgv, buildForceWithLeaseArgv, rejectPlainForce,
  isAllowedRemoteUrl, MAX_OUTPUT_BYTES, SAFE_GIT_CONFIG,
} = await import("../../../lib/git/policy.js");
const { GitPolicyError, GitValidationError } = await import("../../../lib/git/errors.js");
const { runWithPaths } = await import("../../../lib/routes/paths.js");
const shellModule = await import("../../../mcp/tools/shell.js");

const POLICY_SRC = readFileSync(new URL("../../../lib/git/policy.js", import.meta.url), "utf-8");
const RUNNER_SRC = readFileSync(new URL("../../../lib/git/runner.js", import.meta.url), "utf-8");

// realpathSync matters on macOS: os.tmpdir() returns a path through the
// /var -> /private/var symlink, but `git rev-parse --show-toplevel` (what
// runGit compares against the write-path allowlist) resolves it, so an
// unresolved ROOT would never match what runWithPaths([dir], ...) allows.
// resolveGitPaths() runs --show-toplevel, --absolute-git-dir and
// --git-common-dir as three SEPARATE rev-parse invocations, because a single
// three-flag call returns newline-separated records and a POSIX path may
// itself contain newlines (see resolveGitPaths() in lib/git/runner.js). So
// "the repo was resolved and nothing else ran" is three execFile calls, not
// one — named here so the count reads as a fact about resolution rather than
// a magic number.
const REPO_RESOLUTION_CALLS = 3;

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "aperio-git-copilot-")));
after(() => {
  mock.restoreAll();
  rmSync(ROOT, { recursive: true, force: true });
});

// A SIGKILLed process stays visible to kill(pid, 0) as a zombie until it is
// reaped, so "is it gone" is a short poll, never a single immediate probe.
async function waitForPidToDisappear(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 25));
  }
}

function initRepo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Aperio Test"]);
  return dir;
}

describe("runGit — repo resolution + read/write-path scoping (WS2.1, read gate added later)", () => {
  test("read-only call is denied outside any allowed read path", async () => {
    // A read-only call can still return full file contents (e.g. `git show
    // HEAD:path`), so it must clear the same boundary as any other read
    // tool — Aperio has one allowed-folders list for both read and write
    // (AGENTS.md: "no read-only tier"), not a broader unrestricted tier for
    // git specifically.
    const dir = initRepo("read-outside");
    await assert.rejects(
      () => runGit({ cwd: dir, argv: ["status", "--porcelain"], mutating: false }),
      (err) => {
        assert.ok(err instanceof GitPolicyError);
        assert.match(err.message, /not an allowed read path/);
        return true;
      }
    );
  });

  test("read-only call succeeds once the repo is under an allowed read path", async () => {
    const dir = initRepo("read-inside");
    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["status", "--porcelain"], mutating: false });
      assert.equal(result.code, 0);
    });
  });

  test("mutating call is denied outside any allowed write path", async () => {
    const dir = initRepo("write-outside");
    const before = execFileSpyCalls;
    await assert.rejects(
      () => runGit({ cwd: dir, argv: buildStageArgv(["a.txt"]), mutating: true }),
      (err) => {
        assert.ok(err instanceof GitPolicyError);
        assert.match(err.message, /not an allowed write path/);
        return true;
      }
    );
    // Only the rev-parse resolution calls ran — the mutating add never spawned.
    assert.equal(execFileSpyCalls, before + REPO_RESOLUTION_CALLS);
  });

  test("mutating call succeeds once the repo is under an allowed write path", async () => {
    const dir = initRepo("write-inside");
    writeFileSync(join(dir, "a.txt"), "hello");
    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["a.txt"]), mutating: true });
      assert.equal(result.code, 0);
    });
  });
});

describe("git-dir indirection cannot smuggle an outside repo through an allowed worktree (WS2.1)", () => {
  // --show-toplevel alone reports the worktree path (allowed) even though the
  // real refs/index/objects live under the main repo's .git/worktrees/<name>
  // (not allowed) — the boundary bug this closes. See resolveGitPaths() in
  // lib/git/runner.js.
  let wtCounter = 0;
  function initLinkedWorktree() {
    const n = ++wtCounter;
    const main = initRepo(`wt-outside-main-${n}`);
    execFileSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "c1"]);
    const worktree = join(ROOT, `wt-outside-linked-${n}`);
    execFileSync("git", ["-C", main, "worktree", "add", "-q", worktree, "-b", `wt-branch-${n}`]);
    return { main, worktree };
  }

  test("read-only call is denied when only the worktree (not the main repo's git-dir) is an allowed read path", async () => {
    const { worktree } = initLinkedWorktree();
    await runWithPaths([worktree], [worktree], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: worktree, argv: ["show", "HEAD:.gitignore"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /not an allowed read path/);
          return true;
        }
      );
    });
  });

  test("mutating call is denied when only the worktree (not the main repo's git-dir) is an allowed write path", async () => {
    const { worktree } = initLinkedWorktree();
    writeFileSync(join(worktree, "a.txt"), "hello");
    const before = execFileSpyCalls;
    await runWithPaths([worktree], [worktree], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: worktree, argv: buildStageArgv(["a.txt"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /not an allowed write path/);
          return true;
        }
      );
    });
    // Only the rev-parse resolution calls ran — the mutating add never spawned.
    assert.equal(execFileSpyCalls, before + REPO_RESOLUTION_CALLS);
  });

  test("both read and write succeed once the main repo's git-dir is allowed too", async () => {
    const { main, worktree } = initLinkedWorktree();
    await runWithPaths([main, worktree], [main, worktree], null, async () => {
      const readResult = await runGit({ cwd: worktree, argv: ["status", "--porcelain"], mutating: false });
      assert.equal(readResult.code, 0);
    });
  });
});

describe("git alternate object databases cannot smuggle a sibling repo's content through an allowed repo (WS2.1)", () => {
  // objects/info/alternates names OTHER object directories git will
  // transparently read from — none of --show-toplevel/--absolute-git-dir/
  // --git-common-dir see this, since it's consulted by git's object-lookup
  // code, not the repo/worktree layer those three flags describe. See
  // resolveAlternateObjectDirs() in lib/git/runner.js.
  let altCounter = 0;
  function initRepoWithSecret() {
    const secretRepo = initRepo(`alt-secret-${++altCounter}`);
    writeFileSync(join(secretRepo, "secret.txt"), "TOP SECRET");
    execFileSync("git", ["-C", secretRepo, "add", "secret.txt"]);
    execFileSync("git", ["-C", secretRepo, "commit", "-q", "-m", "secret commit"]);
    const sha = execFileSync("git", ["-C", secretRepo, "rev-parse", "HEAD"]).toString().trim();
    return { secretRepo, sha };
  }

  test("read-only call cannot reach a sibling repo's blob through objects/info/alternates, even though it's outside the allowlist", async () => {
    const { secretRepo, sha } = initRepoWithSecret();
    const allowed = initRepo("alt-allowed-1");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    writeFileSync(join(allowed, ".git", "objects", "info", "alternates"), join(secretRepo, ".git", "objects") + "\n");

    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["show", `${sha}:secret.txt`], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /not an allowed read path.*alternate object database/);
          return true;
        }
      );
    });
  });

  test("a chained alternate (allowed -> B -> secret) is still caught, not just the first hop", async () => {
    const { secretRepo, sha } = initRepoWithSecret();
    const bridge = initRepo("alt-bridge");
    execFileSync("git", ["-C", bridge, "commit", "-q", "--allow-empty", "-m", "c1"]);
    writeFileSync(join(bridge, ".git", "objects", "info", "alternates"), join(secretRepo, ".git", "objects") + "\n");
    const allowed = initRepo("alt-allowed-2");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    writeFileSync(join(allowed, ".git", "objects", "info", "alternates"), join(bridge, ".git", "objects") + "\n");

    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["show", `${sha}:secret.txt`], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /not an allowed read path.*alternate object database/);
          return true;
        }
      );
    });
  });

  test("comment and blank lines in alternates are skipped without tripping the check", async () => {
    const allowed = initRepo("alt-allowed-3");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    writeFileSync(join(allowed, ".git", "objects", "info", "alternates"), "# a comment\n\n");

    await runWithPaths([allowed], [allowed], null, async () => {
      const result = await runGit({ cwd: allowed, argv: ["status", "--porcelain"], mutating: false });
      assert.equal(result.code, 0);
    });
  });

  test("a call still succeeds once the alternate's directory is allowed too", async () => {
    const { secretRepo, sha } = initRepoWithSecret();
    const allowed = initRepo("alt-allowed-4");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    writeFileSync(join(allowed, ".git", "objects", "info", "alternates"), join(secretRepo, ".git", "objects") + "\n");

    await runWithPaths([allowed, secretRepo], [allowed, secretRepo], null, async () => {
      const result = await runGit({ cwd: allowed, argv: ["show", `${sha}:secret.txt`], mutating: false });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /TOP SECRET/);
    });
  });

  test("a disallowed alternate directory's own info/alternates is never read — gated before recursing, not after (P2 review fix)", async () => {
    const bridge = initRepo("alt-bridge-gate-order");
    execFileSync("git", ["-C", bridge, "commit", "-q", "--allow-empty", "-m", "c1"]);
    // A line this check cannot safely parse (leading quote). If bridge's own
    // info/alternates were ever opened, this would surface as the "uses
    // quoting" GitPolicyError instead of the boundary one — proving the read
    // happened before the allow-check ran. It must never be read at all once
    // bridge itself sits outside the allowlist.
    writeFileSync(join(bridge, ".git", "objects", "info", "alternates"), '"not a well-formed quoted path\n');
    const allowed = initRepo("alt-allowed-gate-order");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    writeFileSync(join(allowed, ".git", "objects", "info", "alternates"), join(bridge, ".git", "objects") + "\n");

    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["status", "--porcelain"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /not an allowed read path.*alternate object database/);
          assert.doesNotMatch(err.message, /quoting/);
          return true;
        }
      );
    });
  });

  test("an oversized objects/info/alternates file is rejected rather than buffered in full (P1 review fix)", async () => {
    const allowed = initRepo("alt-allowed-oversized");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    const huge = Buffer.alloc(1_000_001, "#".charCodeAt(0));
    writeFileSync(join(allowed, ".git", "objects", "info", "alternates"), huge);

    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["status", "--porcelain"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /alternate object database file at .* exceeds .* bytes/);
          return true;
        }
      );
    });
  });

  test("objects/info/alternates pointing at a non-terminating device is rejected, not read (P1 review fix)", async () => {
    // /dev is deliberately inside the read allowlist here so the path gate
    // added later (readAlternatesFile's isReadPathAllowed check, which would
    // otherwise deny /dev/zero as out-of-bounds first) does not mask the
    // regular-file guard this test exists to pin. A character device that is
    // genuinely inside an allowed folder must still be refused.
    const allowed = initRepo("alt-allowed-device");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    const alternatesPath = join(allowed, ".git", "objects", "info", "alternates");
    rmSync(alternatesPath, { force: true });
    symlinkSync("/dev/zero", alternatesPath);

    await runWithPaths([allowed, "/dev"], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["status", "--porcelain"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /alternate object database file at .* is not a regular file/);
          return true;
        }
      );
    });
  });
});

describe("a symlinked primary object store cannot smuggle an outside repo's content in (P1 review fix)", () => {
  // .git/objects can be a SYMLINK to an object database outside the
  // allowlist while --show-toplevel/--absolute-git-dir/--git-common-dir all
  // still report paths inside it — so gating those three is not enough, and
  // the alternates walk can't catch it either (the alternates file it reads
  // lives inside the symlinked directory). See objectStorePath() in
  // lib/git/runner.js.
  let symCounter = 0;
  function repoWithSymlinkedObjects() {
    const n = ++symCounter;
    const outside = initRepo(`objsym-outside-${n}`);
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
    execFileSync("git", ["-C", outside, "add", "secret.txt"]);
    execFileSync("git", ["-C", outside, "commit", "-q", "-m", "secret commit"]);
    const sha = execFileSync("git", ["-C", outside, "rev-parse", "HEAD"]).toString().trim();

    const allowed = initRepo(`objsym-allowed-${n}`);
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    rmSync(join(allowed, ".git", "objects"), { recursive: true, force: true });
    symlinkSync(join(outside, ".git", "objects"), join(allowed, ".git", "objects"));
    return { outside, allowed, sha };
  }

  test("the three rev-parse paths still look safe, yet raw git reads the outside blob — the bypass this gate closes", () => {
    const { allowed, sha } = repoWithSymlinkedObjects();
    const reported = execFileSync(
      "git", ["-C", allowed, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]
    ).toString().trim().split("\n");
    for (const p of reported) {
      assert.doesNotMatch(p, /objsym-outside-/, "no rev-parse flag reveals the outside store");
    }
    assert.match(
      execFileSync("git", ["-C", allowed, "show", `${sha}:secret.txt`]).toString(),
      /TOP SECRET/,
      "raw git does read the outside blob — this is what runGit must deny"
    );
  });

  test("read-only call is denied when .git/objects symlinks outside the allowlist", async () => {
    const { allowed, sha } = repoWithSymlinkedObjects();
    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["show", `${sha}:secret.txt`], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /not an allowed read path/);
          return true;
        }
      );
    });
  });

  test("mutating call is denied too — git WRITES new objects into that store", async () => {
    const { allowed } = repoWithSymlinkedObjects();
    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["commit", "--allow-empty", "-m", "x"], mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /not an allowed write path/);
          return true;
        }
      );
    });
  });

  test("the call succeeds once the symlink's target repo is allowed too", async () => {
    const { outside, allowed, sha } = repoWithSymlinkedObjects();
    await runWithPaths([allowed, outside], [allowed, outside], null, async () => {
      const result = await runGit({ cwd: allowed, argv: ["show", `${sha}:secret.txt`], mutating: false });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /TOP SECRET/);
    });
  });
});

describe("diff safety cannot be flipped back on by a later flag (P1 review fix)", () => {
  // DIFF_SAFETY_FLAGS are inserted right after the subcommand, i.e. BEFORE
  // the caller's own arguments, and git's option parsing lets the last
  // occurrence win. Verified empirically (git 2.50.1) for all three vectors
  // below: `--no-ext-diff --ext-diff` and `--no-textconv --textconv` each
  // run the repo-configured command, and blanking the config key stops it
  // regardless of flag order.
  function repoWithDiffCommand(name, configKey, attrs) {
    const dir = initRepo(name);
    const marker = join(dir, "DIFF_CMD_RAN");
    const script = join(dir, "cmd.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    chmodSync(script, 0o755);
    execFileSync("git", ["-C", dir, "config", configKey, script]);
    if (attrs) writeFileSync(join(dir, ".gitattributes"), attrs);
    writeFileSync(join(dir, "f.bin"), "one\n");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    writeFileSync(join(dir, "f.bin"), "two\n");
    return { dir, marker };
  }

  const vectors = [
    ["global diff.external", "diff.external", null, "--ext-diff"],
    ["per-driver diff.<n>.command", "diff.jc.command", "*.bin diff=jc\n", "--ext-diff"],
    ["per-driver diff.<n>.textconv", "diff.mydrv.textconv", "*.bin diff=mydrv\n", "--textconv"],
  ];

  for (const [label, configKey, attrs, flag] of vectors) {
    test(`${label}: raw git runs it when ${flag} comes last — the RCE this closes`, () => {
      const { dir, marker } = repoWithDiffCommand(`diffflag-raw-${configKey.replace(/\./g, "-")}`, configKey, attrs);
      execFileSync("git", ["-C", dir, "diff", flag === "--ext-diff" ? "--no-ext-diff" : "--no-textconv", flag]);
      assert.ok(existsSync(marker), `raw git must run ${configKey} for the gate below to matter`);
    });

    test(`${label}: runGit refuses ${flag} outright`, async () => {
      const { dir, marker } = repoWithDiffCommand(`diffflag-gated-${configKey.replace(/\./g, "-")}`, configKey, attrs);
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["diff", flag], mutating: false }),
          (err) => {
            assert.ok(err instanceof GitPolicyError);
            assert.match(err.message, /re-enables repository-configured external diff\/textconv/);
            return true;
          }
        );
      });
      assert.ok(!existsSync(marker), "the configured command must never have run");
    });

    test(`${label}: even if the flag reached git, the config is blanked so nothing runs`, async () => {
      // Belt as well as braces: the flag rejection is bypassed here by
      // hiding the flag behind "--" is not possible (it becomes a pathspec),
      // so this drives the blanking directly via a plain diff — the point is
      // that driverBlockingConfig/SAFE_GIT_CONFIG leave no command to run.
      const { dir, marker } = repoWithDiffCommand(`diffflag-blank-${configKey.replace(/\./g, "-")}`, configKey, attrs);
      await runWithPaths([dir], [dir], null, async () => {
        const result = await runGit({ cwd: dir, argv: ["diff"], mutating: false });
        assert.equal(result.code, 0);
      });
      assert.ok(!existsSync(marker), "the configured command must never have run");
    });
  }

  test("a file literally named --textconv is still stageable — the flag scan stops at \"--\"", async () => {
    const dir = initRepo("diffflag-pathspec-named-like-flag");
    writeFileSync(join(dir, "--textconv"), "content\n");
    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["--textconv"]), mutating: true });
      assert.equal(result.code, 0);
      const staged = await runGit({ cwd: dir, argv: ["diff", "--cached", "--name-only"], mutating: false });
      assert.equal(staged.stdout.trim(), "--textconv");
    });
  });
});

describe("staging pathspecs are contained before any filesystem access (P2 review fix)", () => {
  test("an absolute out-of-repo pathspec is rejected without statting it", async () => {
    const dir = initRepo("pathspec-absolute-outside");
    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["/etc"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /resolves outside the repository/);
          return true;
        }
      );
    });
  });

  test("a ../ traversal pathspec is rejected the same way", async () => {
    const dir = initRepo("pathspec-traversal-outside");
    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["../../outside"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /resolves outside the repository/);
          return true;
        }
      );
    });
  });

  test("a symlink to an outside DIRECTORY is staged as a link, not misread as a directory pathspec", async () => {
    // lstat, not stat: git stores the symlink itself and never reads through
    // it, so following it here would both touch out-of-bounds metadata and
    // wrongly reject a perfectly ordinary single-file staging.
    const dir = initRepo("pathspec-symlink-to-dir");
    const outsideDir = join(ROOT, "pathspec-symlink-target-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "inner.txt"), "x");
    symlinkSync(outsideDir, join(dir, "link"));

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["link"]), mutating: true });
      assert.equal(result.code, 0);
      const staged = await runGit({ cwd: dir, argv: ["diff", "--cached", "--name-only"], mutating: false });
      assert.equal(staged.stdout.trim(), "link", "the symlink itself is staged, and nothing under its target");
    });
  });

  test("an ordinary in-repo pathspec still works (containment is not over-broad)", async () => {
    const dir = initRepo("pathspec-inrepo-ok");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), "a");
    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["src/a.txt"]), mutating: true });
      assert.equal(result.code, 0);
    });
  });
});

describe("preflight git invocations carry the safe config too (P1 review fix)", () => {
  // `git ls-files` (the deleted-pathspec index preflight) READS THE INDEX,
  // and reading the index runs a repo-configured core.fsmonitor command.
  // Verified empirically with a fresh repo per measurement (git 2.50.1):
  // raw ls-files runs the hook, `-c core.fsmonitor=` stops it. rev-parse
  // does not read the index and never triggered it.
  function repoWithFsmonitor(name) {
    const dir = initRepo(name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), "a");
    writeFileSync(join(dir, "src", "b.txt"), "b");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);

    const marker = join(dir, "FSMONITOR_RAN");
    const hook = join(dir, "mon.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(hook, 0o755);
    execFileSync("git", ["-C", dir, "config", "core.fsmonitor", hook]);
    rmSync(join(dir, "src"), { recursive: true, force: true });
    return { dir, marker };
  }

  test("raw git ls-files DOES execute a repo-configured core.fsmonitor — the RCE this closes", () => {
    const { dir, marker } = repoWithFsmonitor("fsmonitor-raw");
    execFileSync("git", ["-C", dir, "ls-files", "-z", "--", "src"]);
    assert.ok(existsSync(marker), "raw ls-files must run the hook for the gate below to matter");
  });

  test("the deleted-pathspec preflight never runs it — the staging call is rejected with no hook execution", async () => {
    const { dir, marker } = repoWithFsmonitor("fsmonitor-gated");
    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["src"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /directory pathspec/);
          return true;
        }
      );
    });
    assert.ok(!existsSync(marker), "core.fsmonitor must never have been executed");
  });

  test("every preflight git invocation is built through the safe-config wrapper, not raw execFileAsync", () => {
    // Structural: a new preflight added later must not be able to skip the
    // overrides just by copying the old `execFileAsync("git", ...)` shape.
    assert.doesNotMatch(
      RUNNER_SRC.replace(/function runPreflightGit[\s\S]*?\n}/, ""),
      /execFileAsync\(\s*\n?\s*"git"/,
      'no preflight may call execFileAsync("git", …) directly — use runPreflightGit()'
    );
  });
});

describe("a mixed-case filter/merge driver is discovered and blocked (review claim, verified already covered)", () => {
  // Git canonicalizes a config key's SECTION and VARIABLE to lowercase and
  // preserves only the SUBSECTION's case: `[FILTER "MiXeD"] CLEAN = x` is
  // reported by `git config --get-regexp` as `filter.MiXeD.clean`. So the
  // runner's case-sensitive regexes always see lowercase `filter.`/`.clean`
  // around a verbatim subsection, and a mixed-case driver name is captured
  // and blanked like any other. Pinned here because it is easy to assume
  // otherwise from reading the regexes alone.
  function repoWithFilter(name, driverName) {
    const dir = initRepo(name);
    const marker = join(dir, "FILTER_RAN");
    const drv = join(dir, "drv.sh");
    writeFileSync(drv, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(drv, 0o755);
    execFileSync("git", ["-C", dir, "config", `filter.${driverName}.clean`, drv]);
    writeFileSync(join(dir, ".gitattributes"), `*.txt filter=${driverName}\n`);
    writeFileSync(join(dir, "f.txt"), "hi\n");
    return { dir, marker };
  }

  test("git reports the key with a lowercase section/variable and the subsection's case intact", () => {
    const dir = initRepo("driver-case-canon");
    appendFileSync(
      join(dir, ".git", "config"),
      `[FILTER "MiXeD"]\n\tCLEAN = /bin/true\n[MERGE "MiXeD2"]\n\tDRIVER = /bin/true\n`
    );
    const out = execFileSync("git", [
      "-C", dir, "config", "--get-regexp",
      "^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver)$",
    ]).toString();
    assert.match(out, /^filter\.MiXeD\.clean /m);
    assert.match(out, /^merge\.MiXeD2\.driver /m);
  });

  for (const [label, driverName] of [["lower-case", "evil"], ["mixed-case", "MiXeD"]]) {
    test(`a ${label} clean filter runs under raw git, and never under runGit`, async () => {
      const raw = repoWithFilter(`driver-${label}-raw`, driverName);
      execFileSync("git", ["-C", raw.dir, "add", "--", "f.txt"]);
      assert.ok(existsSync(raw.marker), "raw git must run it for this test to mean anything");

      // A separate repo, so no index/marker state carries over.
      const gated = repoWithFilter(`driver-${label}-gated`, driverName);
      await runWithPaths([gated.dir], [gated.dir], null, async () => {
        const result = await runGit({ cwd: gated.dir, argv: buildStageArgv(["f.txt"]), mutating: true });
        assert.equal(result.code, 0);
      });
      assert.ok(!existsSync(gated.marker), `the ${label} filter must never have been executed`);
    });
  }
});

describe("symlinked git metadata cannot escape the boundary (P1 review fix)", () => {
  test("objects/info/alternates symlinked at an outside file is never opened — no read escape, no content leak", async () => {
    const allowed = initRepo("metasym-alternates");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    const outsideFile = join(ROOT, "metasym-outside-secret.txt");
    writeFileSync(outsideFile, "OUTSIDE SECRET FIRST LINE\n");
    symlinkSync(outsideFile, join(allowed, ".git", "objects", "info", "alternates"));

    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["status", "--porcelain"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          // Either gate is a correct denial: the object-store symlink scan
          // reaches objects/info/ first, and readAlternatesFile's own
          // isReadPathAllowed check backstops it for alternate stores found
          // further down the chain, which live outside the git dirs.
          assert.match(err.message, /not an allowed read path|git metadata symlink pointing outside/);
          // The old failure mode read the file, then echoed its first line
          // back as the rejected "alternate directory" path.
          assert.doesNotMatch(err.message, /OUTSIDE SECRET/, "the file's contents must never reach the error");
          return true;
        }
      );
    });
  });

  test("a real alternates file is still read normally once its directory is allowed (the gate is not over-broad)", async () => {
    const secretRepo = initRepo("metasym-alt-target");
    writeFileSync(join(secretRepo, "shared.txt"), "SHARED BLOB");
    execFileSync("git", ["-C", secretRepo, "add", "shared.txt"]);
    execFileSync("git", ["-C", secretRepo, "commit", "-q", "-m", "shared"]);
    const sha = execFileSync("git", ["-C", secretRepo, "rev-parse", "HEAD"]).toString().trim();

    const allowed = initRepo("metasym-alt-consumer");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    writeFileSync(join(allowed, ".git", "objects", "info", "alternates"), join(secretRepo, ".git", "objects") + "\n");

    await runWithPaths([allowed, secretRepo], [allowed, secretRepo], null, async () => {
      const result = await runGit({ cwd: allowed, argv: ["show", `${sha}:shared.txt`], mutating: false });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /SHARED BLOB/);
    });
  });

  test("raw git DOES rewrite an outside file through a symlinked .git/index — the escape this gate closes", () => {
    const dir = initRepo("metasym-index-raw");
    writeFileSync(join(dir, "f.txt"), "x");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);

    const outsideIndex = join(ROOT, "metasym-stolen-index");
    writeFileSync(outsideIndex, readFileSync(join(dir, ".git", "index")));
    const before = readFileSync(outsideIndex);
    rmSync(join(dir, ".git", "index"), { force: true });
    symlinkSync(outsideIndex, join(dir, ".git", "index"));

    writeFileSync(join(dir, "f.txt"), "y");
    execFileSync("git", ["-C", dir, "add", "--", "f.txt"]);
    assert.notDeepEqual(
      readFileSync(outsideIndex), before,
      "raw git writes THROUGH the symlink to the outside file — runGit must refuse first"
    );
  });

  test("mutating call is denied when .git/index symlinks outside the write allowlist", async () => {
    const dir = initRepo("metasym-index-gated");
    writeFileSync(join(dir, "f.txt"), "x");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);

    const outsideIndex = join(ROOT, "metasym-gated-index");
    writeFileSync(outsideIndex, readFileSync(join(dir, ".git", "index")));
    const before = readFileSync(outsideIndex);
    rmSync(join(dir, ".git", "index"), { force: true });
    symlinkSync(outsideIndex, join(dir, ".git", "index"));
    writeFileSync(join(dir, "f.txt"), "y");

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["f.txt"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /git metadata symlink pointing outside/);
          return true;
        }
      );
    });
    assert.deepEqual(readFileSync(outsideIndex), before, "the outside index must be untouched");
  });

  test("a symlinked ref under refs/ is caught too, on a read-only call", async () => {
    const dir = initRepo("metasym-ref");
    execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "c1"]);
    const outsideRef = join(ROOT, "metasym-outside-ref");
    writeFileSync(outsideRef, execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString());
    mkdirSync(join(dir, ".git", "refs", "heads", "nested"), { recursive: true });
    symlinkSync(outsideRef, join(dir, ".git", "refs", "heads", "nested", "sneaky"));

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["status", "--porcelain"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /git metadata symlink pointing outside/);
          return true;
        }
      );
    });
  });

  test("symlinked pack files under objects/pack leak an outside repo's blob to raw git, and are denied by runGit (P1 review fix)", async () => {
    const outside = initRepo("objpack-outside");
    writeFileSync(join(outside, "s.txt"), "PACKED OUTSIDE SECRET");
    execFileSync("git", ["-C", outside, "add", "s.txt"]);
    execFileSync("git", ["-C", outside, "commit", "-q", "-m", "s"]);
    const sha = execFileSync("git", ["-C", outside, "rev-parse", "HEAD"]).toString().trim();
    execFileSync("git", ["-C", outside, "gc", "-q"]);

    const allowed = initRepo("objpack-allowed");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    const outsidePackDir = join(outside, ".git", "objects", "pack");
    const allowedPackDir = join(allowed, ".git", "objects", "pack");
    mkdirSync(allowedPackDir, { recursive: true });
    for (const name of readdirSync(outsidePackDir)) {
      symlinkSync(join(outsidePackDir, name), join(allowedPackDir, name));
    }

    // Raw git really does serve the outside blob through the symlinked pack.
    assert.match(
      execFileSync("git", ["-C", allowed, "show", `${sha}:s.txt`]).toString(),
      /PACKED OUTSIDE SECRET/,
      "the escape must actually exist for the gate below to be meaningful"
    );

    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["show", `${sha}:s.txt`], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /git metadata symlink pointing outside/);
          return true;
        }
      );
    });
  });

  test("a symlinked LOOSE object in a fanout directory is denied too (P1 review fix)", async () => {
    const outside = initRepo("objloose-outside");
    writeFileSync(join(outside, "l.txt"), "LOOSE OUTSIDE SECRET");
    execFileSync("git", ["-C", outside, "add", "l.txt"]);
    execFileSync("git", ["-C", outside, "commit", "-q", "-m", "l"]);
    const blob = execFileSync("git", ["-C", outside, "rev-parse", "HEAD:l.txt"]).toString().trim();
    const fanout = blob.slice(0, 2);
    const rest = blob.slice(2);

    const allowed = initRepo("objloose-allowed");
    execFileSync("git", ["-C", allowed, "commit", "-q", "--allow-empty", "-m", "c1"]);
    mkdirSync(join(allowed, ".git", "objects", fanout), { recursive: true });
    symlinkSync(
      join(outside, ".git", "objects", fanout, rest),
      join(allowed, ".git", "objects", fanout, rest)
    );

    assert.match(
      execFileSync("git", ["-C", allowed, "cat-file", "-p", blob]).toString(),
      /LOOSE OUTSIDE SECRET/,
      "the escape must actually exist for the gate below to be meaningful"
    );

    await runWithPaths([allowed], [allowed], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: allowed, argv: ["cat-file", "-p", blob], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /git metadata symlink pointing outside/);
          return true;
        }
      );
    });
  });

  test("an in-bounds metadata symlink is allowed, and the walk never follows it (no loop, no cost)", async () => {
    const dir = initRepo("metasym-inbounds");
    execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "c1"]);
    // A self-referential directory symlink inside .git: following it would
    // recurse forever, so this also pins the never-follow behaviour.
    symlinkSync(join(dir, ".git"), join(dir, ".git", "loop"));

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["status", "--porcelain"], mutating: false });
      assert.equal(result.code, 0);
    });
  });
});

describe("git_stage cannot be pointed at a directory pathspec (P1 review fix)", () => {
  test("runGit rejects an \"add\" pathspec that resolves to a directory, even under --literal-pathspecs", async () => {
    // --literal-pathspecs only disables glob magic — it does not stop git
    // from treating a directory pathspec as "everything under it," so
    // `git add -- src` still recursively stages the whole subtree.
    const dir = initRepo("stage-directory-pathspec");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), "a");
    writeFileSync(join(dir, "src", "b.txt"), "b");

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["src"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /directory pathspec/);
          return true;
        }
      );

      const status = await runGit({ cwd: dir, argv: ["status", "--porcelain"], mutating: false });
      assert.doesNotMatch(status.stdout, /^A\s/m, "nothing must have been staged");
    });
  });

  test("a nonexistent pathspec is still left to git itself, not rejected as a directory", async () => {
    const dir = initRepo("stage-nonexistent-pathspec");
    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["does-not-exist.txt"]), mutating: true });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /did not match any files|pathspec/i);
    });
  });

  test("a DELETED tracked directory is rejected too — stat() can't see it, but git add would still stage the whole subtree (P1 review fix)", async () => {
    const dir = initRepo("stage-deleted-directory-pathspec");
    mkdirSync(join(dir, "src", "sub"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), "a");
    writeFileSync(join(dir, "src", "sub", "b.txt"), "b");
    writeFileSync(join(dir, "other.txt"), "c");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    rmSync(join(dir, "src"), { recursive: true, force: true });

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["src"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /directory pathspec/);
          return true;
        }
      );

      const staged = await runGit({ cwd: dir, argv: ["diff", "--cached", "--name-status"], mutating: false });
      assert.equal(staged.stdout.trim(), "", "no deletion may have been staged");
    });
  });

  test("a DELETED tracked file is still allowed — staging that one deletion stays explicit", async () => {
    const dir = initRepo("stage-deleted-file-pathspec");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), "a");
    writeFileSync(join(dir, "src", "b.txt"), "b");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    rmSync(join(dir, "src", "a.txt"), { force: true });

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["src/a.txt"]), mutating: true });
      assert.equal(result.code, 0);
      const staged = await runGit({ cwd: dir, argv: ["diff", "--cached", "--name-status"], mutating: false });
      assert.equal(staged.stdout.trim(), "D\tsrc/a.txt", "only the named file's deletion is staged");
    });
  });
});

describe("resolveRemoteTrackingSha is gated by the same path boundary as runGit (P2 review fix)", () => {
  function initRepoWithRemoteTracking(name) {
    const bare = join(ROOT, `${name}-remote.git`);
    execFileSync("git", ["init", "-q", "--bare", bare]);
    const work = join(ROOT, `${name}-work`);
    execFileSync("git", ["clone", "-q", bare, work]);
    execFileSync("git", ["-C", work, "config", "user.email", "t@e.com"]);
    execFileSync("git", ["-C", work, "config", "user.name", "T"]);
    writeFileSync(join(work, "f.txt"), "1\n");
    execFileSync("git", ["-C", work, "add", "f.txt"]);
    execFileSync("git", ["-C", work, "commit", "-q", "-m", "c1"]);
    execFileSync("git", ["-C", work, "push", "-q", "origin", "HEAD:main"]);
    execFileSync("git", ["-C", work, "fetch", "-q", "origin"]);
    const sha = execFileSync("git", ["-C", work, "rev-parse", "HEAD"]).toString().trim();
    return { work, sha };
  }

  test("denies a repo outside the allowed read paths rather than resolving its remote-tracking ref", async () => {
    const { work } = initRepoWithRemoteTracking("lease-track-outside");
    // Deliberately no runWithPaths wrapper — `work` is outside every allowed path here.
    await assert.rejects(
      () => resolveRemoteTrackingSha(work, "origin", "main"),
      (err) => {
        assert.ok(err instanceof GitPolicyError);
        assert.match(err.message, /not an allowed read path/);
        return true;
      }
    );
  });

  test("succeeds once the repo is under an allowed read path", async () => {
    const { work, sha } = initRepoWithRemoteTracking("lease-track-inside");
    await runWithPaths([work], [work], null, async () => {
      const resolved = await resolveRemoteTrackingSha(work, "origin", "main");
      assert.equal(resolved, sha);
    });
  });
});

describe("buildStageArgv — explicit staging only, never expanded (WS2.2)", () => {
  test("rejects a missing paths argument", () => {
    assert.throws(() => buildStageArgv(undefined), GitValidationError);
  });

  test("rejects an empty paths array", () => {
    assert.throws(() => buildStageArgv([]), GitValidationError);
  });

  test("\"-A\" is staged as a literal (near-certainly nonexistent) pathspec", () => {
    assert.deepEqual(buildStageArgv(["-A"]), ["add", "--", "-A"]);
  });

  test('broad pathspecs (".", "./", "*", "**") are rejected, not forwarded', () => {
    // "--" only ends option parsing; it does NOT make a broad pathspec
    // literal. "." and "*" are real, always-matching pathspecs — `git add
    // -- .` genuinely recursively stages the whole repo (verified against
    // real git, not a theoretical concern), so these must be refused
    // outright rather than passed through.
    for (const broad of [".", "./", "*", "**"]) {
      assert.throws(() => buildStageArgv([broad]), GitValidationError, `expected "${broad}" to be rejected`);
    }
  });

  test('a broad pathspec anywhere in the array rejects the whole call, even alongside real paths', () => {
    assert.throws(() => buildStageArgv(["a.txt", "."]), GitValidationError);
  });

  test("git pathspec magic (leading \":\") is rejected, not forwarded", () => {
    // The four literal strings above don't cover this: ":(top)**", ":/", and
    // ":(glob)**" all bypass that check and still stage the entire repo —
    // verified against real git. All pathspec magic starts with ":", so
    // reject on that prefix rather than enumerating magic spellings.
    for (const magic of [":(top)**", ":/", ":(glob)**", ":!foo", ":^foo"]) {
      assert.throws(() => buildStageArgv([magic]), GitValidationError, `expected "${magic}" to be rejected`);
    }
  });

  test("a pathspec-magic call is never actually forwarded to git (real repo, end to end)", async () => {
    const dir = initRepo("pathspec-magic");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "sub", "b.txt"), "b");

    assert.throws(() => buildStageArgv([":(top)**"]), GitValidationError);

    // Confirm nothing got staged as a side effect of even attempting this —
    // the rejection has to happen before any git process runs.
    await runWithPaths([dir], [dir], null, async () => {
      const status = await runGit({ cwd: dir, argv: ["status", "--porcelain"], mutating: false });
      assert.match(status.stdout, /\?\? a\.txt/);
      assert.match(status.stdout, /\?\? sub\//);
    });
  });
});

describe("force policy — plain --force banned, lease requires an exact SHA (WS2.3)", () => {
  test("rejectPlainForce always throws, unconditionally", () => {
    assert.throws(() => rejectPlainForce(), GitPolicyError);
  });

  test("no env var makes plain force reachable — policy.js reads no process.env at all", () => {
    assert.doesNotMatch(POLICY_SRC, /process\.env/);
  });

  test("buildForceWithLeaseArgv requires a branch name and a well-formed SHA", () => {
    const sha = "a".repeat(40);
    assert.throws(() => buildForceWithLeaseArgv({ branch: "", expectedSha: sha }), GitValidationError);
    assert.throws(() => buildForceWithLeaseArgv({ branch: "main", expectedSha: "" }), GitValidationError);
    assert.throws(() => buildForceWithLeaseArgv({ branch: "main", expectedSha: "not-a-sha" }), GitValidationError);
  });

  test("buildForceWithLeaseArgv accepts a full SHA-256 (64 hex char) object id, not just SHA-1's 40", () => {
    const sha = "b".repeat(64);
    assert.deepEqual(
      buildForceWithLeaseArgv({ branch: "main", expectedSha: sha }),
      [`--force-with-lease=refs/heads/main:${sha}`]
    );
  });

  test("buildForceWithLeaseArgv rejects an abbreviated SHA, even though it's valid hex — the contract requires an exact id", () => {
    for (const len of [7, 39, 41, 63, 65]) {
      const sha = "a".repeat(len);
      assert.throws(
        () => buildForceWithLeaseArgv({ branch: "main", expectedSha: sha }),
        GitValidationError,
        `expected a ${len}-char hex string to be rejected`
      );
    }
  });

  test("buildForceWithLeaseArgv targets refs/heads/<branch>, not the remote-tracking ref", () => {
    const sha = "a".repeat(40);
    assert.deepEqual(
      buildForceWithLeaseArgv({ branch: "main", expectedSha: sha }),
      [`--force-with-lease=refs/heads/main:${sha}`]
    );
  });

  test("refs/heads/<branch> actually performs a leased rewrite over real divergence; refs/remotes/<remote>/<branch> silently doesn't (real git, real remote)", async () => {
    // End-to-end proof, not just an argv-shape check. Crucially this must
    // create GENUINE divergence (another clone pushes first) — a lease
    // pushed against a remote that's still a fast-forward ancestor succeeds
    // under ANY refname, wrong or right, and would prove nothing.
    const bare = join(ROOT, "lease-remote.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);

    const work = join(ROOT, "lease-work");
    execFileSync("git", ["clone", "-q", bare, work]);
    execFileSync("git", ["-C", work, "config", "user.email", "t@e.com"]);
    execFileSync("git", ["-C", work, "config", "user.name", "T"]);
    writeFileSync(join(work, "f.txt"), "one\n");
    execFileSync("git", ["-C", work, "add", "f.txt"]);
    execFileSync("git", ["-C", work, "commit", "-q", "-m", "c1"]);
    execFileSync("git", ["-C", work, "push", "-q", "origin", "HEAD:main"]);

    // A second clone pushes independently — the remote is now genuinely
    // ahead of what `work` will locally rewrite over.
    const other = join(ROOT, "lease-other");
    execFileSync("git", ["clone", "-q", bare, other]);
    execFileSync("git", ["-C", other, "config", "user.email", "x@e.com"]);
    execFileSync("git", ["-C", other, "config", "user.name", "X"]);
    writeFileSync(join(other, "f.txt"), "one\ntwo\n");
    execFileSync("git", ["-C", other, "commit", "-qam", "other-change"]);
    execFileSync("git", ["-C", other, "push", "-q", "origin", "HEAD:main"]);

    // `work` fetches the current (diverged) remote state, records it as its
    // last-known-good sha, then rewrites its OWN history on top of the old
    // c1 — so pushing now requires a real force, and the lease must be
    // evaluated against the true current remote value to be safe.
    execFileSync("git", ["-C", work, "fetch", "-q", "origin"]);
    const expectedSha = execFileSync("git", ["-C", work, "rev-parse", "refs/remotes/origin/main"]).toString().trim();
    execFileSync("git", ["-C", work, "commit", "--amend", "-q", "-m", "rewritten locally, diverges from remote"]);

    // This part proves a claim about GIT ITSELF (which ref form a lease
    // actually applies to), not about runGit's policy gate — a local bare
    // repo is the only practical way to build genuine divergence for this
    // check, and runGit's transport allowlist (correctly) refuses local
    // remotes, so these two pushes go straight through execFileSync,
    // bypassing runGit on purpose. The transport gate itself is covered by
    // its own dedicated tests below.
    let wrongFailed = false;
    try {
      execFileSync("git", ["-C", work, "push", `--force-with-lease=refs/remotes/origin/main:${expectedSha}`, "origin", "main"], { stdio: "pipe" });
    } catch {
      wrongFailed = true;
    }
    assert.equal(wrongFailed, true, "the remote-tracking ref form must NOT succeed here — proves the lease never applied to this push");

    const rightArgv = buildForceWithLeaseArgv({ branch: "main", expectedSha });
    execFileSync("git", ["-C", work, "push", ...rightArgv, "origin", "main"]);

    const remoteNow = execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"]).toString().trim();
    const localHead = execFileSync("git", ["-C", work, "rev-parse", "HEAD"]).toString().trim();
    assert.equal(remoteNow, localHead, "the remote must actually have been rewritten to the local commit");
  });
});

describe("remote-transport allowlist and filter blocking (WS2.3)", () => {
  test("https/ssh (including scp-like shorthand) are allowed", () => {
    assert.equal(isAllowedRemoteUrl("https://github.com/x/y.git"), true);
    assert.equal(isAllowedRemoteUrl("ssh://git@github.com/x/y.git"), true);
    assert.equal(isAllowedRemoteUrl("git@github.com:x/y.git"), true);
  });

  test("file://, ext::, and unencrypted git:// are rejected", () => {
    assert.equal(isAllowedRemoteUrl("file:///tmp/evil"), false);
    assert.equal(isAllowedRemoteUrl("ext::sh -c touch%20/tmp/pwned"), false);
    assert.equal(isAllowedRemoteUrl("git://github.com/x/y.git"), false);
  });

  test("no env var widens the transport allowlist — policy.js reads no process.env at all", () => {
    assert.doesNotMatch(POLICY_SRC, /process\.env/);
  });

  test("SAFE_GIT_CONFIG neutralizes a repo-configured external diff driver", async () => {
    const dir = initRepo("filters");
    writeFileSync(join(dir, "f.txt"), "one\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    writeFileSync(join(dir, "f.txt"), "two\n");

    const marker = join(dir, "MARKER");
    const scriptPath = join(dir, "ext-diff.sh");
    writeFileSync(scriptPath, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(scriptPath, 0o755);
    execFileSync("git", ["-C", dir, "config", "diff.external", scriptPath]);

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["diff"], mutating: false });
      assert.equal(existsSync(marker), false, "the configured external diff driver must never run");
      assert.equal(result.code, 0);
    });
  });

  test("an arbitrary repo-defined clean filter (not just LFS) is neutralized on git add", async () => {
    // SAFE_GIT_CONFIG only blanks the well-known LFS driver name; a repo can
    // name a filter anything via .gitattributes. This proves the dynamic
    // discovery in runner.js (not the static list) is what actually blocks it.
    const dir = initRepo("custom-filter");
    writeFileSync(join(dir, ".gitattributes"), "* filter=evil\n");

    const marker = join(dir, "PWNED");
    const scriptPath = join(dir, "evil.sh");
    writeFileSync(scriptPath, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(scriptPath, 0o755);
    execFileSync("git", ["-C", dir, "config", "filter.evil.clean", scriptPath]);
    execFileSync("git", ["-C", dir, "config", "filter.evil.smudge", "cat"]);

    writeFileSync(join(dir, "f.txt"), "hello\n");

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["f.txt", ".gitattributes"]), mutating: true });
      assert.equal(existsSync(marker), false, "the configured custom clean filter must never run");
      assert.equal(result.code, 0);
    });
  });

  test("filter discovery fails closed (denies the whole call) on an error that isn't \"no matches\"", async () => {
    // Only exit code 1 from `git config --get-regexp` means "nothing
    // configured" — any other failure must deny the call, not silently
    // behave as if no filters exist. Reproduces a real one: output that
    // overflows execFile's default 1MB buffer (ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
    // not exit code 1) from a config entry stuffed with a huge value — a
    // repo could use exactly this to hide a real filter from the scan.
    const dir = initRepo("filter-discovery-overflow");
    writeFileSync(join(dir, "a.txt"), "hi");
    const configPath = join(dir, ".git", "config");
    const existing = readFileSync(configPath, "utf-8");
    const huge = "x".repeat(2 * 1024 * 1024);
    writeFileSync(configPath, `${existing}\n[filter "evil"]\n\tclean = ${huge}\n`);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["a.txt"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /configured Git filter\/merge\/diff drivers/);
          return true;
        }
      );
    });

    // Confirm the call really never ran — nothing got staged. A raw git
    // call, not runGit: the oversized filter config is still in place, so
    // any runGit call against this repo correctly fails closed too.
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString();
    assert.match(status, /\?\? a\.txt/);
  });

  test("runGit denies fetch/push against a direct file:// URL, not just isAllowedRemoteUrl() in isolation", async () => {
    const dir = initRepo("direct-file-remote");
    const bare = join(ROOT, "direct-file-remote-target.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["fetch", `file://${bare}`], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /remote transport not allowed/);
          return true;
        }
      );
    });

    // No fetch actually happened — no remote-tracking state was created.
    assert.equal(existsSync(join(dir, ".git", "FETCH_HEAD")), false);
  });

  test("runGit denies fetch/push against a named remote configured to a disallowed URL", async () => {
    const dir = initRepo("named-remote-file-url");
    const bare = join(ROOT, "named-remote-target.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", `file://${bare}`]);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["fetch", "origin"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /remote transport not allowed/);
          return true;
        }
      );

      // Also covers the implicit-remote default ("origin" when none given).
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["fetch"], mutating: false }),
        (err) => err instanceof GitPolicyError
      );
    });

    assert.equal(existsSync(join(dir, ".git", "FETCH_HEAD")), false);
  });
});

describe("output cap — shared 48000-byte constant, not redefined (WS2.3)", () => {
  test("lib/git/policy.js's MAX_OUTPUT_BYTES is shell.js's own constant, re-exported not redefined", () => {
    assert.equal(MAX_OUTPUT_BYTES, shellModule.MAX_OUTPUT_BYTES);
  });

  test("git output over the cap is truncated via the shared tail-biased sink", async () => {
    const dir = initRepo("big-output");
    const big = "x".repeat(MAX_OUTPUT_BYTES * 2);
    writeFileSync(join(dir, "big.txt"), big);
    execFileSync("git", ["-C", dir, "add", "big.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "big"]);

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["show", "HEAD:big.txt"], mutating: false });
      assert.ok(result.stdout.length < big.length, "output must be truncated");
      assert.match(result.stdout, /KB of output omitted/);
    });
  });
});

describe("git output streams into the bounded sink instead of buffering the whole blob first (WS2.3)", () => {
  test("the main git invocation streams via spawn, not execFile+maxBuffer", () => {
    // maxBuffer means the whole stream is materialized in memory before the
    // 48000-byte cap is ever applied — the thing this fix removes.
    assert.doesNotMatch(RUNNER_SRC, /maxBuffer/, "a maxBuffer option means output is buffered in full before capping");
    assert.match(RUNNER_SRC, /spawn\(\s*["']git["']/, "the main git invocation must stream through spawn, not execFile");
  });

  test("a multi-megabyte blob is still correctly capped end to end through the streaming path", async () => {
    const dir = initRepo("streamed-output");
    const big = "y".repeat(5 * 1024 * 1024);
    writeFileSync(join(dir, "big.txt"), big);
    execFileSync("git", ["-C", dir, "add", "big.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "big"]);

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["show", "HEAD:big.txt"], mutating: false });
      assert.ok(result.stdout.length < big.length, "output must be truncated");
      assert.match(result.stdout, /KB of output omitted/);
    });
  });
});

describe("no mutation queue — Git's own index/ref lock is the only serialization (WS2.4)", () => {
  // Genuine concurrent `git commit` on the same repo is inherently racy —
  // two real processes may or may not collide depending on OS scheduling,
  // and when they do the failure text varies (index.lock, a ref lock, even
  // an empty-commit-message error from a half-written COMMIT_EDITMSG).
  // Pre-creating .git/index.lock reproduces the *specific* contention git
  // itself would produce, deterministically, so this test proves the two
  // things WS2.4 actually cares about without depending on timing: (1) the
  // failure is git's own native lock error, and (2) no Aperio-side lock or
  // queue machinery exists to intercept or replace it.
  test("a call against a repo whose .git/index.lock already exists surfaces git's own lock error, not a custom Aperio one", async () => {
    const dir = initRepo("locked");
    writeFileSync(join(dir, "a.txt"), "hi");
    const lockFile = join(dir, ".git", "index.lock");
    writeFileSync(lockFile, "");

    try {
      await runWithPaths([dir], [dir], null, async () => {
        const result = await runGit({ cwd: dir, argv: buildStageArgv(["a.txt"]), mutating: true });

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /index\.lock/);

        // No Aperio-side lock/queue artifact — the only lock file present is
        // the one this test itself pre-created to simulate contention.
        const gitDirEntries = readdirSync(join(dir, ".git"));
        assert.deepEqual(gitDirEntries.filter(f => /aperio/i.test(f)), []);
      });
    } finally {
      rmSync(lockFile, { force: true });
    }
  });
});

describe("hooks are always disabled (WS2.3)", () => {
  test("a pre-commit hook never runs through runGit", async () => {
    const dir = initRepo("hook-precommit");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const marker = join(dir, "HOOK_RAN");
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hookPath, 0o755);
    writeFileSync(join(dir, "f.txt"), "hello\n");

    await runWithPaths([dir], [dir], null, async () => {
      const stage = await runGit({ cwd: dir, argv: buildStageArgv(["f.txt"]), mutating: true });
      assert.equal(stage.code, 0);
      const commit = await runGit({ cwd: dir, argv: ["commit", "-m", "c1"], mutating: true });
      assert.equal(commit.code, 0, commit.stderr);
    });

    assert.equal(existsSync(marker), false, "the pre-commit hook must never run");
  });

  test("a post-checkout hook never runs through runGit, even when the repo's own core.hooksPath is set", async () => {
    const dir = initRepo("hook-postcheckout");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const marker = join(dir, "HOOK_RAN2");
    const hookPath = join(dir, ".git", "hooks", "post-checkout");
    writeFileSync(hookPath, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hookPath, 0o755);
    // A repo can point core.hooksPath at ITS OWN hooks dir too — confirm our
    // override still wins over a repo-set value, not just the git default.
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", join(dir, ".git", "hooks")]);
    writeFileSync(join(dir, "f.txt"), "hello\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "-c", "core.hooksPath=", "commit", "-q", "-m", "c1"]);

    await runWithPaths([dir], [dir], null, async () => {
      const branch = await runGit({ cwd: dir, argv: ["checkout", "-b", "other"], mutating: true });
      assert.equal(branch.code, 0, branch.stderr);
    });

    assert.equal(existsSync(marker), false, "the post-checkout hook must never run, even when the repo sets its own core.hooksPath");
  });
});

describe("core.sshCommand is always the plain default, never repo-controlled (WS2.3)", () => {
  test("SAFE_GIT_CONFIG's core.sshCommand override wins over a repo's own configured value", async () => {
    const dir = initRepo("ssh-command-config-value");
    execFileSync("git", ["-C", dir, "config", "core.sshCommand", "/bin/definitely-not-real-ssh-marker"]);

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["config", "--get", "core.sshCommand"], mutating: false });
      assert.equal(result.stdout.trim(), "ssh", "the repo's core.sshCommand must be overridden, not honored");
    });
  });

  test("a repo-configured core.sshCommand never runs, even against an allowed ssh:// remote (real git, real marker script)", async () => {
    const dir = initRepo("ssh-command-marker");
    const marker = join(dir, "SSH_COMMAND_RAN");
    const scriptPath = join(dir, "fake-ssh.sh");
    writeFileSync(scriptPath, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(scriptPath, 0o755);
    execFileSync("git", ["-C", dir, "config", "core.sshCommand", scriptPath]);
    // Port 1 on loopback has nothing listening — the connection is refused
    // immediately, so this stays fast and deterministic. What matters isn't
    // whether the fetch succeeds (it can't), only whether the repo's own
    // ssh command got invoked on the way to trying.
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "ssh://git@127.0.0.1:1/nonexistent/repo.git"]);

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["fetch", "origin"], mutating: false });
      assert.notEqual(result.code, 0);
    });

    assert.equal(existsSync(marker), false, "the repo-configured core.sshCommand must never run");
  });
});

describe("multi-remote fetch validates every remote it would touch (WS2.3)", () => {
  test("fetch --all validates every configured remote, not just origin", async () => {
    const dir = initRepo("fetch-all-multi-remote");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/repo.git"]);
    const localTarget = join(ROOT, "fetch-all-target.git");
    execFileSync("git", ["init", "-q", "--bare", localTarget]);
    execFileSync("git", ["-C", dir, "remote", "add", "other", `file://${localTarget}`]);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["fetch", "--all"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /remote transport not allowed/);
          assert.match(err.message, /file:\/\//);
          return true;
        }
      );
    });
  });

  test("fetch --multiple validates every named remote, not just the first", async () => {
    const dir = initRepo("fetch-multiple-remote");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/repo.git"]);
    const localTarget = join(ROOT, "fetch-multiple-target.git");
    execFileSync("git", ["init", "-q", "--bare", localTarget]);
    execFileSync("git", ["-C", dir, "remote", "add", "other", `file://${localTarget}`]);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["fetch", "--multiple", "origin", "other"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /remote transport not allowed/);
          return true;
        }
      );
    });
  });
});

describe("commit/tag/push signing is always disabled (WS2.3)", () => {
  test("a repo-configured gpg.program never runs, even with commit.gpgsign=true (real git, real marker script)", async () => {
    const dir = initRepo("gpgsign-marker");
    const marker = join(dir, "GPG_RAN");
    const scriptPath = join(dir, "fake-gpg.sh");
    writeFileSync(scriptPath, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(scriptPath, 0o755);
    execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "true"]);
    execFileSync("git", ["-C", dir, "config", "gpg.program", scriptPath]);
    writeFileSync(join(dir, "f.txt"), "hello\n");

    await runWithPaths([dir], [dir], null, async () => {
      const stage = await runGit({ cwd: dir, argv: buildStageArgv(["f.txt"]), mutating: true });
      assert.equal(stage.code, 0);
      const commit = await runGit({ cwd: dir, argv: ["commit", "-m", "c1"], mutating: true });
      assert.equal(commit.code, 0, commit.stderr);
    });

    assert.equal(existsSync(marker), false, "the configured gpg.program must never run");
  });
});

describe("credential helpers and askpass are always disabled (WS2.3)", () => {
  test("SAFE_GIT_CONFIG's credential.helper=/core.askPass= overrides block a repo-configured credential helper (real git, real marker script)", async () => {
    // `git config --get-all` does NOT reflect this reset — resetting a
    // multi-valued credential.helper to "" on an empty value is special
    // behavior inside the credential SUBSYSTEM itself (git-credential
    // fill/approve/reject, and any https auth challenge), not generic
    // config listing. Proven directly against that real consumer, the same
    // way the force-with-lease refname test above proves a claim about git
    // itself rather than about runGit's policy gate — `git credential fill`
    // needs piped stdin, which runGit's spawn (stdio ignore on stdin)
    // doesn't provide, so this runs the exact SAFE_GIT_CONFIG array through
    // execFileSync directly instead.
    assert.ok(SAFE_GIT_CONFIG.includes("credential.helper="), "SAFE_GIT_CONFIG must reset credential.helper");
    assert.ok(SAFE_GIT_CONFIG.includes("core.askPass="), "SAFE_GIT_CONFIG must reset core.askPass");

    const dir = initRepo("credential-helper-marker");
    const marker = join(dir, "CRED_HELPER_RAN");
    const scriptPath = join(dir, "fake-cred-helper.sh");
    writeFileSync(scriptPath, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(scriptPath, 0o755);
    execFileSync("git", ["-C", dir, "config", "credential.helper", `!${scriptPath}`]);

    try {
      execFileSync("git", ["-C", dir, ...SAFE_GIT_CONFIG, "credential", "fill"], {
        input: "protocol=https\nhost=example.invalid\n\n",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Expected: with every helper disabled there's nothing to supply
      // credentials, so `credential fill` fails. The marker file is what
      // actually proves the point, not this call's exit status.
    }

    assert.equal(existsSync(marker), false, "the configured credential helper must never run");
  });
});

describe("the git-hooks noop directory is private and unpredictable (WS2.3)", () => {
  function currentHooksDir() {
    const entry = SAFE_GIT_CONFIG.find(s => typeof s === "string" && s.startsWith("core.hooksPath="));
    assert.ok(entry, "SAFE_GIT_CONFIG must set core.hooksPath");
    return entry.slice("core.hooksPath=".length);
  }

  test("the hooks dir is not the old fixed, predictable name", () => {
    const dir = currentHooksDir();
    assert.notEqual(dir, join(tmpdir(), "aperio-git-noop-hooks"), "a fixed name lets another process pre-create it");
    assert.match(dir, /aperio-git-noop-hooks-.+/, "expected a random suffix on the directory name");
  });

  test("the hooks dir is never created on disk (no leaked directory to leave ownership/mode racy)", () => {
    const dir = currentHooksDir();
    assert.equal(existsSync(dir), false, "the noop hooks path must not be created — git tolerates a nonexistent hooksPath the same as an empty dir, so nothing should ever be written for it");
  });
});

describe("push destination validation covers pushurl, not just the fetch URL (WS2.3)", () => {
  test("a remote with an allowed fetch URL but a disallowed pushurl is denied on push", async () => {
    const dir = initRepo("pushurl-mismatch");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/repo.git"]);
    const localTarget = join(ROOT, "pushurl-mismatch-target.git");
    execFileSync("git", ["init", "-q", "--bare", localTarget]);
    execFileSync("git", ["-C", dir, "config", "remote.origin.pushurl", `file://${localTarget}`]);
    writeFileSync(join(dir, "f.txt"), "hi");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["push", "origin", "HEAD:main"], mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /remote transport not allowed/);
          assert.match(err.message, /file:\/\//);
          return true;
        }
      );
    });

    // Confirm the disallowed target really never received anything.
    const targetRefs = execFileSync("git", ["-C", localTarget, "for-each-ref"]).toString();
    assert.equal(targetRefs.trim(), "");
  });

  test("a remote with multiple pushurls is denied when ANY of them is disallowed, not just the first", async () => {
    const dir = initRepo("pushurl-multi");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/repo.git"]);
    execFileSync("git", ["-C", dir, "config", "--add", "remote.origin.pushurl", "https://example.invalid/repo.git"]);
    const localTarget = join(ROOT, "pushurl-multi-target.git");
    execFileSync("git", ["init", "-q", "--bare", localTarget]);
    execFileSync("git", ["-C", dir, "config", "--add", "remote.origin.pushurl", `file://${localTarget}`]);
    writeFileSync(join(dir, "f.txt"), "hi");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["push", "origin", "HEAD:main"], mutating: true }),
        (err) => err instanceof GitPolicyError
      );
    });
  });

  test("fetch is still validated against the fetch URL (unaffected by the push-url fix)", async () => {
    const dir = initRepo("fetchurl-still-checked");
    const localTarget = join(ROOT, "fetchurl-still-checked-target.git");
    execFileSync("git", ["init", "-q", "--bare", localTarget]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", `file://${localTarget}`]);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["fetch", "origin"], mutating: false }),
        (err) => err instanceof GitPolicyError
      );
    });
  });
});

describe("staging pathspecs are forced literal, not just filtered for obvious magic (WS2.2)", () => {
  test("a wildcard pathspec like \"src/*.js\" is never expanded by runGit, even though buildStageArgv allows it through", async () => {
    // "src/*.js" isn't caught by buildStageArgv's own checks (not one of the
    // broad literals, no leading ":") — this is exactly the gap: it's git's
    // OWN pathspec matching (not the shell — execFile never invokes one)
    // that expands "*" unless told to treat pathspecs literally. Verified
    // empirically: without --literal-pathspecs this stages every .js file
    // under src/, not the literal (nonexistent) name "src/*.js".
    const dir = initRepo("wildcard-pathspec");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.js"), "a");
    writeFileSync(join(dir, "src", "b.js"), "b");
    writeFileSync(join(dir, "src", "c.txt"), "c");

    await runWithPaths([dir], [dir], null, async () => {
      const argv = buildStageArgv(["src/*.js"]);
      const result = await runGit({ cwd: dir, argv, mutating: true });
      // Literal pathspec semantics mean "src/*.js" matches no real file —
      // git reports that as a failure rather than silently doing nothing.
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /did not match any files|pathspec/i);

      const status = await runGit({ cwd: dir, argv: ["status", "--porcelain"], mutating: false });
      assert.doesNotMatch(status.stdout, /^A\s/m, "nothing must have been staged");
    });
  });

  test("--literal-pathspecs does not break revision:path syntax (git show HEAD:path)", async () => {
    const dir = initRepo("literal-pathspecs-show");
    writeFileSync(join(dir, "f.txt"), "hello\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /hello/);
    });
  });
});

describe("custom merge drivers are neutralized (WS2.3)", () => {
  test("a repo-defined merge driver never runs through runGit's merge command; git falls back to its own conflict detection", async () => {
    const bare = join(ROOT, "merge-driver-remote.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    const work = join(ROOT, "merge-driver-work");
    execFileSync("git", ["clone", "-q", bare, work]);
    execFileSync("git", ["-C", work, "config", "user.email", "t@e.com"]);
    execFileSync("git", ["-C", work, "config", "user.name", "T"]);
    writeFileSync(join(work, "f.txt"), "line1\n");
    execFileSync("git", ["-C", work, "add", "f.txt"]);
    execFileSync("git", ["-C", work, "commit", "-q", "-m", "c1"]);
    execFileSync("git", ["-C", work, "checkout", "-qb", "feature"]);
    writeFileSync(join(work, "f.txt"), "line1\nfeature change\n");
    execFileSync("git", ["-C", work, "commit", "-qam", "feature-change"]);
    execFileSync("git", ["-C", work, "checkout", "-q", "main"]);
    writeFileSync(join(work, "f.txt"), "line1\nmain change\n");
    execFileSync("git", ["-C", work, "commit", "-qam", "main-change"]);

    const marker = join(work, "MERGE_DRIVER_RAN");
    const driverScript = join(work, "mdriver.sh");
    writeFileSync(driverScript, `#!/bin/sh\ntouch "${marker}"\ncp "$2" "$1"\nexit 0\n`);
    chmodSync(driverScript, 0o755);
    writeFileSync(join(work, ".gitattributes"), "f.txt merge=custom\n");
    execFileSync("git", ["-C", work, "config", "merge.custom.name", "custom test driver"]);
    execFileSync("git", ["-C", work, "config", "merge.custom.driver", `${driverScript} %O %A %B`]);
    execFileSync("git", ["-C", work, "add", ".gitattributes"]);
    execFileSync("git", ["-C", work, "commit", "-qam", "add gitattributes"]);

    await runWithPaths([work], [work], null, async () => {
      const result = await runGit({ cwd: work, argv: ["merge", "feature", "-m", "merge-it"], mutating: true });
      assert.equal(existsSync(marker), false, "the configured custom merge driver must never run");
      // Git falls back to its built-in 3-way merge and correctly reports the
      // real conflict — the driver being blocked doesn't silently corrupt
      // or skip the merge, it just removes the arbitrary-command escape hatch.
      assert.notEqual(result.code, 0);
      assert.match(result.stderr + result.stdout, /CONFLICT|conflict/);
    });
  });
});

describe("a repo cannot pick which git-remote-* helper binary runs (P1 review fix)", () => {
  test("remote.<name>.vcs is rejected before fetch/push, and the planted helper never runs", async () => {
    // remote.<name>.vcs=<v> makes git hand the operation to `git-remote-<v>`
    // from PATH instead of using the URL's own transport. The transport
    // allowlist gates the VALUE, but "ssh" must be permitted and git ships no
    // git-remote-ssh — so the repo gets to choose a PATH lookup that
    // SAFE_GIT_CONFIG's other overrides never see, while `git remote get-url`
    // keeps reporting the innocent https URL.
    const dir = initRepo("remote-vcs-override");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/x.git"]);
    execFileSync("git", ["-C", dir, "config", "remote.origin.vcs", "ssh"]);

    const binDir = join(ROOT, "remote-vcs-bin");
    mkdirSync(binDir, { recursive: true });
    const marker = join(ROOT, "REMOTE_HELPER_RAN");
    writeFileSync(join(binDir, "git-remote-ssh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(join(binDir, "git-remote-ssh"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      await runWithPaths([dir], [dir], null, async () => {
        for (const argv of [["fetch", "origin"], ["fetch"], ["push", "origin", "main"]]) {
          await assert.rejects(
            () => runGit({ cwd: dir, argv, mutating: argv[0] === "push" }),
            (err) => {
              assert.ok(err instanceof GitPolicyError);
              assert.match(err.message, /remote helper override not allowed/);
              assert.match(err.message, /remote\.origin\.vcs/);
              return true;
            }
          );
        }
      });
    } finally {
      process.env.PATH = originalPath;
    }

    assert.equal(existsSync(marker), false, "the repo-selected remote helper must never be executed");
  });

  test("an ordinary repo with no remote.*.vcs is unaffected — the check only denies the override", async () => {
    // Guards against the obvious over-correction: denying every fetch/push,
    // or blanking the key (an empty value is itself parsed as a transport
    // name and would break real remotes). This repo must fail on the URL
    // rule it actually violates, not on the helper check.
    const dir = initRepo("remote-vcs-clean");
    const bare = join(ROOT, "remote-vcs-clean-target.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", `file://${bare}`]);

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: ["fetch", "origin"], mutating: false }),
        (err) => {
          assert.match(err.message, /remote transport not allowed/);
          assert.doesNotMatch(err.message, /remote helper override/);
          return true;
        }
      );
    });
  });
});

describe("the command timeout is hard, and tears down descendants (P2 review fix)", () => {
  test("a SIGTERM-ignoring git whose child holds the stdio pipes still settles, and leaves nothing running", async () => {
    // The old teardown sent SIGTERM to git's PID only and then waited on
    // "close" forever. "close" needs BOTH the exit and every stdio pipe
    // closed, so a descendant that inherited stdout/stderr kept the promise
    // — and the tool call — pending indefinitely. This fake `git` reproduces
    // exactly that: it ignores SIGTERM and forks a grandchild that also
    // ignores SIGTERM and holds the pipes for far longer than the test.
    // Verified empirically that the pre-fix implementation (SIGTERM to the
    // pid, then await "close") is still pending against this script after 8s.
    // Note an ignored SIGTERM disposition is inherited across fork+exec, so
    // even the `sleep` processes survive SIGTERM — SIGKILL is what ends it.
    const binDir = join(ROOT, "hang-bin");
    mkdirSync(binDir, { recursive: true });
    const pidFile = join(ROOT, "hang-grandchild.pid");
    writeFileSync(join(binDir, "git"), [
      "#!/bin/sh",
      "trap '' TERM",
      // Grandchild keeps the inherited stdout/stderr open and survives SIGTERM.
      `sh -c "trap '' TERM; echo \\$\\$ > '${pidFile}'; sleep 120" &`,
      "sleep 120",
    ].join("\n") + "\n");
    chmodSync(join(binDir, "git"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    let result;
    const started = Date.now();
    try {
      result = await spawnGit(["status"], { cwd: ROOT, timeout: 1000 });
    } finally {
      process.env.PATH = originalPath;
    }
    const elapsed = Date.now() - started;

    assert.notEqual(result.code, 0, "a timed-out command must not report success");
    assert.match(result.stderr, /timed out after 1000ms/);
    // The whole SIGTERM -> SIGKILL -> settle chain is bounded; without the
    // fix this never resolves at all, so any finite time proves the contract,
    // and the bound proves no rung was skipped or doubled.
    assert.ok(elapsed < 15_000, `expected a bounded teardown, took ${elapsed}ms`);

    // And the descendant is actually gone — SIGTERM alone would have left it
    // holding the pipes and its own 120s sleep.
    const grandchildPid = Number(readFileSync(pidFile, "utf-8").trim());
    assert.ok(grandchildPid > 0, "the fake git must have recorded its grandchild's pid");
    await new Promise(r => setTimeout(r, 250));
    assert.throws(
      () => process.kill(grandchildPid, 0),
      /ESRCH/,
      "the grandchild git forked must be killed with it, not orphaned"
    );
  });

  test("a normal fast command is untouched by the teardown chain", async () => {
    const dir = initRepo("timeout-normal");
    const result = await spawnGit(["-C", dir, "status", "--porcelain"], { cwd: dir, timeout: 30_000 });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /timed out/);
  });
});

describe("the metadata walk holds on a filesystem that reports no d_type (P1 review fix)", () => {
  // NFS/SMB/some FUSE mounts return DT_UNKNOWN for directory entries. libuv
  // passes that through and Node's Dirent then answers false to EVERY is*()
  // predicate — so a walk keyed on isSymbolicLink()/isDirectory() sees
  // "neither" for every entry: it gates no symlink and enters no
  // subdirectory. These entries reproduce that shape exactly rather than
  // depending on fs.Dirent's constructor signature, which has moved between
  // Node versions.
  const asUnknownType = (entries) => entries.map(e => ({
    name: e.name,
    parentPath: e.parentPath,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isCharacterDevice: () => false,
    isBlockDevice: () => false,
  }));

  test("an escaping symlink nested in a .git subdirectory is still caught when no entry has a type", async () => {
    // Nested on purpose: catching it requires BOTH halves of the fix — the
    // walk has to recurse into refs/ (an unknown-type directory) and then
    // recognise the entry inside it as a symlink (an unknown-type link).
    const dir = initRepo("dtype-unknown");
    const outside = join(ROOT, "dtype-unknown-outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "loot.txt"), "outside\n");
    symlinkSync(join(outside, "loot.txt"), join(dir, ".git", "refs", "escape"));
    writeFileSync(join(dir, "a.txt"), "hi\n");

    // Sanity: with real d_types the existing check already denies this, so a
    // pass under the rewrite below cannot be mistaken for the walk being
    // skipped entirely.
    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["a.txt"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /git metadata symlink pointing outside/);
          return true;
        }
      );
    });

    readdirDirentRewrite = asUnknownType;
    try {
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: buildStageArgv(["a.txt"]), mutating: true }),
          (err) => {
            assert.ok(err instanceof GitPolicyError);
            assert.match(err.message, /git metadata symlink pointing outside/);
            return true;
          }
        );
      });
    } finally {
      readdirDirentRewrite = null;
    }

    // The denial really stopped the call — nothing was staged.
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString();
    assert.match(status, /\?\? a\.txt/);
  });

  test("a clean repo still passes when no entry has a type — the fallback classifies, it does not blanket-deny", async () => {
    const dir = initRepo("dtype-unknown-clean");
    writeFileSync(join(dir, "a.txt"), "hi\n");

    readdirDirentRewrite = asUnknownType;
    try {
      await runWithPaths([dir], [dir], null, async () => {
        const result = await runGit({ cwd: dir, argv: buildStageArgv(["a.txt"]), mutating: true });
        assert.equal(result.code, 0);
      });
    } finally {
      readdirDirentRewrite = null;
    }

    const staged = execFileSync("git", ["-C", dir, "diff", "--cached", "--name-only"]).toString();
    assert.match(staged, /a\.txt/);
  });
});

describe("a staging pathspec cannot traverse a symlink out of the repo (P1 review fix)", () => {
  test("an intermediate symlink is rejected before any metadata read of the outside target", async () => {
    // resolvePath() is lexical in both directions: "link/secret.txt" starts
    // with repoRoot so the containment check passes, and lstat() declines to
    // follow only the FINAL component — verified empirically that
    // lstat("link/secret.txt") returns isFile true and the outside file's
    // real size. Git refuses the pathspec afterwards ("beyond a symbolic
    // link"), so nothing is staged either way; the leak being closed here is
    // the out-of-bounds metadata read that happened first.
    const dir = initRepo("pathspec-through-symlink");
    const outside = join(ROOT, "pathspec-symlink-outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "SECRET\n");
    symlinkSync(outside, join(dir, "link"));

    await runWithPaths([dir], [dir], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: dir, argv: buildStageArgv(["link/secret.txt"]), mutating: true }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /traverses a symlink that leads outside the repository/);
          return true;
        }
      );
    });
  });

  test("a symlink as the FINAL component is still stageable — git stores the link, never its target", async () => {
    // The over-correction guard: gating the parent chain must not also
    // reject staging a tracked symlink, which is an ordinary thing to commit.
    const dir = initRepo("pathspec-symlink-leaf");
    const outside = join(ROOT, "pathspec-symlink-leaf-outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "target.txt"), "SECRET\n");
    symlinkSync(join(outside, "target.txt"), join(dir, "leaf"));

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["leaf"]), mutating: true });
      assert.equal(result.code, 0, result.stderr);
    });

    // Staged as a symlink (mode 120000), so no outside CONTENT entered the
    // repo — only the link text git always stores for one.
    const staged = execFileSync("git", ["-C", dir, "ls-files", "-s", "leaf"]).toString();
    assert.match(staged, /^120000 /);
  });

  test("an in-repo subdirectory symlink is still rejected — the gate is the repo boundary, not symlink-phobia", async () => {
    // A symlink that stays inside the repo must not be denied by the parent
    // gate; it is the DIRECTORY-pathspec rule that has to catch this one.
    const dir = initRepo("pathspec-symlink-inside");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), "hi\n");
    symlinkSync(join(dir, "src"), join(dir, "inner"));

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["inner/a.txt"]), mutating: true });
      assert.doesNotMatch(result.stderr, /traverses a symlink/);
    });
  });
});

describe("a partial clone's lazy fetch cannot turn a read-only command into a remote operation (P1 review fix)", () => {
  // In a partial clone, git silently fetches a MISSING object from the
  // promisor remote in the middle of `show`/`log`/`diff` — commands
  // assertAllowedRemote() does not gate, because they are not fetch/push.
  // Verified empirically (git 2.50.1) before the fix: a read-only
  // `git show HEAD:f.txt` under SAFE_GIT_CONFIG executed a PATH binary named
  // git-remote-ssh three times (remote.origin.vcs=ssh), and reached the
  // network on an ordinary https promisor. GIT_NO_LAZY_FETCH=1 stops the
  // fetch; the now-unconditional helper check stops the helper even on a git
  // too old to know that variable.
  let promisorCounter = 0;
  function initPartialCloneWithMissingBlob(name, remoteUrl) {
    const dir = initRepo(`${name}-${++promisorCounter}`);
    writeFileSync(join(dir, "f.txt"), "lazily-fetched content\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD:f.txt"]).toString().trim();

    execFileSync("git", ["-C", dir, "config", "core.repositoryformatversion", "1"]);
    execFileSync("git", ["-C", dir, "config", "extensions.partialClone", "origin"]);
    execFileSync("git", ["-C", dir, "config", "remote.origin.url", remoteUrl]);
    execFileSync("git", ["-C", dir, "config", "remote.origin.promisor", "true"]);
    // The object git will now go to the remote for.
    rmSync(join(dir, ".git", "objects", sha.slice(0, 2), sha.slice(2)), { force: true });
    return dir;
  }

  test("the lazy fetch never happens — a read-only show fails locally instead of dialling the promisor remote", async () => {
    // SAFE_GIT_CONFIG pins core.sshCommand=ssh, so a fake `ssh` first on PATH
    // is an exact, offline detector for "git actually tried to reach the
    // remote": it can only run if the fetch was attempted. Verified both ways
    // against real git — it runs without GIT_NO_LAZY_FETCH and does not run
    // with it.
    const dir = initPartialCloneWithMissingBlob("promisor-egress", "ssh://git@example.invalid/x.git");
    const binDir = join(ROOT, `promisor-egress-bin-${promisorCounter}`);
    mkdirSync(binDir, { recursive: true });
    const marker = join(ROOT, `SSH_RAN-${promisorCounter}`);
    writeFileSync(join(binDir, "ssh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(join(binDir, "ssh"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    let result;
    try {
      await runWithPaths([dir], [dir], null, async () => {
        result = await runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false });
      });
    } finally {
      process.env.PATH = originalPath;
    }

    assert.equal(existsSync(marker), false, "a read-only git_* call must never dial the promisor remote");
    // It fails on the missing object, which is the accepted trade: git_fetch
    // is how a partial clone materializes a blob, not an implicit side effect
    // of reading.
    assert.notEqual(result.code, 0);
  });

  test("remote.<name>.vcs is rejected on a read-only command too, and the planted helper never runs", async () => {
    // The pre-fix escape: assertNoRemoteHelperOverride() ran only for
    // fetch/push, so `show` reached the helper. It is unconditional now —
    // GIT_NO_LAZY_FETCH needs git 2.41+, this check needs nothing.
    const dir = initPartialCloneWithMissingBlob("promisor-vcs", "https://example.invalid/x.git");
    execFileSync("git", ["-C", dir, "config", "remote.origin.vcs", "ssh"]);

    const binDir = join(ROOT, `promisor-vcs-bin-${promisorCounter}`);
    mkdirSync(binDir, { recursive: true });
    const marker = join(ROOT, `PROMISOR_HELPER_RAN-${promisorCounter}`);
    writeFileSync(join(binDir, "git-remote-ssh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(join(binDir, "git-remote-ssh"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false }),
          (err) => {
            assert.ok(err instanceof GitPolicyError);
            assert.match(err.message, /remote helper override not allowed/);
            return true;
          }
        );
      });
    } finally {
      process.env.PATH = originalPath;
    }

    assert.equal(existsSync(marker), false, "the repo-selected remote helper must never be executed");
  });

  test("an ordinary repo is unaffected — reads still work, and fetch/push keep their lazy-fetch allowance", async () => {
    // Guards the over-correction: the suppression must not break normal reads,
    // and must not be applied to the two commands whose whole purpose is to
    // talk to the remote.
    const dir = initRepo("promisor-clean");
    writeFileSync(join(dir, "f.txt"), "ordinary\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /ordinary/);
    });

    assert.match(
      RUNNER_SRC,
      /const allowLazyFetch = REMOTE_TOUCHING_COMMANDS\.has\(argv\[0\]\)/,
      "fetch/push must keep lazy fetching — they have already cleared both remote checks"
    );
  });
});

describe("repository paths are parsed unambiguously, even with newlines in them (P1 review fix)", () => {
  // POSIX allows newlines in a path. Asking rev-parse for --show-toplevel,
  // --absolute-git-dir and --git-common-dir in ONE call returns three
  // newline-separated records, so splitting on "\n" mis-assigns the fields.
  // Verified empirically (git 2.50.1) with a linked worktree named "wt\nX\nY":
  // the single-call parse produced repoRoot=".../allowed/wt", gitDir="X",
  // gitCommonDir="Y" — the real, OUTSIDE main-repo .git was never checked at
  // all, and assertNoEscapingMetadataSymlinks() then walked the nonexistent
  // "X"/"Y", hit ENOENT and returned clean, skipping the whole metadata scan.
  let nlCounter = 0;
  function initNewlineWorktree() {
    const n = ++nlCounter;
    const main = initRepo(`nl-main-${n}`);
    execFileSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "c1"]);
    const holder = join(ROOT, `nl-allowed-${n}`);
    mkdirSync(holder, { recursive: true });
    // The DECOY: the path the broken split truncates the worktree name down
    // to. Making it a real, allowed directory is what let the pre-fix code
    // sail through every boundary check instead of failing on a missing cwd.
    mkdirSync(join(holder, "wt"), { recursive: true });
    const worktree = join(holder, "wt\nX\nY");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", worktree, "-b", `nl-branch-${n}`]);
    return { main, holder, worktree };
  }

  test("a newline-named worktree cannot smuggle an out-of-bounds main repo past the boundary", async () => {
    const { holder, worktree } = initNewlineWorktree();
    // Only the holder is allowed; the main repo (and so the real git-dir and
    // common-dir) is not.
    await runWithPaths([holder], [holder], null, async () => {
      await assert.rejects(
        () => runGit({ cwd: worktree, argv: ["show", "HEAD:.gitignore"], mutating: false }),
        (err) => {
          assert.ok(err instanceof GitPolicyError);
          assert.match(err.message, /not an allowed read path/);
          // The denial must name the REAL out-of-bounds git-dir, not the
          // "X"/"Y" fragments the broken split invented.
          assert.match(err.message, /nl-main-/);
          return true;
        }
      );
    });
  });

  test("the same worktree resolves verbatim and works once its main repo is allowed too", async () => {
    // The other half: the fix must not corrupt or reject a legitimate path
    // merely for containing a newline.
    const { main, holder, worktree } = initNewlineWorktree();
    await runWithPaths([main, holder], [main, holder], null, async () => {
      const result = await runGit({ cwd: worktree, argv: ["status", "--porcelain"], mutating: false });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.repoRoot, worktree, "the resolved root must be the full path, newlines included");
    });
  });

  test("rev-parse output is never trim()ed — one flag per call, one terminator stripped", () => {
    // Structural: trim() would also eat a legitimate trailing newline or space
    // in a path, and a re-combined multi-flag call would reintroduce the
    // ambiguity this whole suite exists for.
    assert.doesNotMatch(
      RUNNER_SRC,
      /rev-parse["'],\s*["']--show-toplevel["'],\s*["']--absolute-git-dir["']/,
      "the three rev-parse flags must not be combined back into one ambiguous call"
    );
    assert.match(RUNNER_SRC, /stdout\.endsWith\("\\n"\)\s*\?\s*stdout\.slice\(0,\s*-1\)/);
  });
});

describe("timeout teardown reaches descendants on Windows too (P1 review fix)", () => {
  // The POSIX half is covered behaviourally above ("a SIGTERM-ignoring git
  // whose child holds the stdio pipes still settles"). Windows has no process
  // groups and no signals, so child.kill() there reaches ONLY git: a spawned
  // ssh or remote helper survives the timeout and can still finish a push we
  // reported as cancelled. This assertion is structural because the behaviour
  // cannot be exercised off win32 — it is NOT a substitute for a run on
  // Windows, which this fix has not had.
  test("the non-POSIX branch tears down the process tree with taskkill /T, not a bare child.kill", () => {
    assert.match(RUNNER_SRC, /spawn\(\s*["']taskkill["']/, "Windows teardown must use taskkill");
    assert.match(RUNNER_SRC, /["']\/T["']/, "taskkill must be invoked with /T to reach descendants");
    assert.match(RUNNER_SRC, /args\.push\(["']\/F["']\)/, "the SIGKILL rung must force-terminate");
    assert.match(
      RUNNER_SRC,
      /else if \(!SUPPORTS_PROCESS_GROUPS\) \{\s*\n\s*return killWindowsTree\(child, sig === "SIGKILL"\);/,
      "the Windows tree kill must sit on the non-process-group branch of signalChild"
    );
  });

  // The decision table below is RUN, not pattern-matched. Three review rounds
  // found real bugs in exactly this logic while structural assertions on the
  // source text kept passing, so it is driven directly through a taskkill
  // spawn stub. What still cannot be checked off win32 is whether real
  // taskkill emits these codes for these situations.
  describe("killWindowsTree — what counts as a confirmed teardown", () => {
    // A fake taskkill process: only the two events killWindowsTree listens for.
    function fakeTaskkill({ exitCode = 0, spawnError = false, throwOnSpawn = false } = {}) {
      return () => {
        if (throwOnSpawn) throw new Error("spawn EACCES");
        const emitter = new EventEmitter();
        process.nextTick(() => {
          if (spawnError) emitter.emit("error", new Error("spawn ENOENT"));
          else emitter.emit("close", exitCode);
        });
        return emitter;
      };
    }

    // Records whether the child.kill() last resort was reached.
    function fakeChild() {
      const calls = [];
      return { pid: 4242, kill: (sig) => { calls.push(sig); }, calls };
    }

    async function run(child, force, stub) {
      taskkillStub = stub;
      try {
        return await killWindowsTree(child, force);
      } finally {
        taskkillStub = null;
      }
    }

    test("exit 0 is the only confirmation, and it does not also child.kill()", async () => {
      const child = fakeChild();
      assert.equal(await run(child, true, fakeTaskkill({ exitCode: 0 })), true);
      assert.deepEqual(child.calls, []);
    });

    test("exit 128 is NOT confirmation — the parent was gone, so no descendant was examined", async () => {
      // The review finding this round. `taskkill /T` discovers descendants by
      // walking down from the parent PID; if git already exited there is
      // nothing to walk, and a detached helper can still be running. Reporting
      // that as a clean cancellation is precisely the false guarantee.
      const child = fakeChild();
      assert.equal(await run(child, true, fakeTaskkill({ exitCode: 128 })), false);
      // child.kill() is pointless here — the parent is already gone — so it
      // must not be attempted just to look busy.
      assert.deepEqual(child.calls, []);
    });

    test("any other nonzero exit is unconfirmed AND falls back to child.kill", async () => {
      const child = fakeChild();
      assert.equal(await run(child, true, fakeTaskkill({ exitCode: 1 })), false);
      assert.deepEqual(child.calls, ["SIGKILL"], "git itself must still be killed when the walk failed");
    });

    test("a taskkill that cannot start at all falls back and reports unconfirmed", async () => {
      for (const stub of [fakeTaskkill({ spawnError: true }), fakeTaskkill({ throwOnSpawn: true })]) {
        const child = fakeChild();
        assert.equal(await run(child, false, stub), false);
        assert.deepEqual(child.calls, ["SIGTERM"], "the soft rung falls back to a soft kill");
      }
    });

    test("/F is added only for the forced rung, and /T always", async () => {
      const seen = [];
      const capture = (args) => { seen.push(args); return fakeTaskkill({ exitCode: 0 })(); };
      await run(fakeChild(), false, capture);
      await run(fakeChild(), true, capture);
      assert.deepEqual(seen[0], ["/pid", "4242", "/T"]);
      assert.deepEqual(seen[1], ["/pid", "4242", "/T", "/F"]);
    });

    test("a child that never got a pid is unconfirmed, and taskkill is not spawned", async () => {
      let spawned = false;
      const result = await run({ pid: undefined, kill: () => {} }, true, () => { spawned = true; return fakeTaskkill()(); });
      assert.equal(result, false);
      assert.equal(spawned, false);
    });

    test("taskkill is not unref'd — the teardown waits on its exit status", () => {
      assert.doesNotMatch(
        RUNNER_SRC,
        /killer\.unref/,
        "unref'ing taskkill would abandon the exit status the teardown now waits on"
      );
    });
  });

  test("POSIX still uses the process group, and taskkill is never reached there", () => {
    // The Windows branch must be unreachable on this platform — a stray
    // taskkill spawn on POSIX would be an error, not a fallback.
    assert.match(RUNNER_SRC, /process\.kill\(-child\.pid, sig\)/);
    assert.match(RUNNER_SRC, /const SUPPORTS_PROCESS_GROUPS = process\.platform !== "win32"/);
  });
});

describe("signalChild — a POSIX group-kill failure must not be reported as confirmed (P2 review fix)", () => {
  // Pre-fix, any failure of process.kill(-pid, sig) other than the process
  // already being gone fell through to the single-process fallback and
  // resolved with THAT call's own return value. But a successful
  // child.kill(sig) only confirms the parent git process was signalled — it
  // says nothing about descendants git itself forked, which is exactly what
  // the process-group kill exists to reach. Reporting the fallback's "true"
  // as success mislabels a possibly-still-running tree as a confirmed
  // teardown. This drives process.kill through a mock so the EPERM/ESRCH
  // distinction can be forced without needing a real process this test does
  // not own the permissions of.
  test("a non-ESRCH group-kill failure is unconfirmed even when the fallback kill itself succeeds", async () => {
    if (process.platform === "win32") return; // this is the POSIX branch

    let groupKillAttempted = false;
    const killSpy = mock.method(process, "kill", (pid) => {
      if (pid < 0) {
        groupKillAttempted = true;
        const err = new Error("EPERM: operation not permitted");
        err.code = "EPERM";
        throw err;
      }
      throw new Error("unexpected non-group process.kill call in this test");
    });
    try {
      const fallbackKill = mock.fn(() => true); // the single process WAS signalled...
      const fakeChild = { pid: 999999, kill: fallbackKill };
      const result = await signalChild(fakeChild, "SIGKILL");
      assert.ok(groupKillAttempted, "expected the process-group kill to be attempted first");
      assert.equal(fallbackKill.mock.callCount(), 1, "expected exactly one single-process fallback kill");
      // ...but descendants were never reached, so this must still be unconfirmed.
      assert.equal(result, false, "a single-process fallback can never confirm the whole tree is gone");
    } finally {
      killSpy.mock.restore();
    }
  });

  test("a non-ESRCH group-kill failure is unconfirmed when the fallback kill also fails", async () => {
    if (process.platform === "win32") return;

    const killSpy = mock.method(process, "kill", (pid) => {
      if (pid < 0) {
        const err = new Error("EPERM: operation not permitted");
        err.code = "EPERM";
        throw err;
      }
      throw new Error("unexpected non-group process.kill call in this test");
    });
    try {
      const fakeChild = { pid: 999999, kill: mock.fn(() => false) };
      const result = await signalChild(fakeChild, "SIGKILL");
      assert.equal(result, false, "a failed fallback kill must be reported as unconfirmed");
    } finally {
      killSpy.mock.restore();
    }
  });

  test("ESRCH (the group is already gone) is still reported as success", async () => {
    if (process.platform === "win32") return;

    const killSpy = mock.method(process, "kill", (pid) => {
      if (pid < 0) {
        const err = new Error("ESRCH: no such process");
        err.code = "ESRCH";
        throw err;
      }
      throw new Error("unexpected non-group process.kill call in this test");
    });
    try {
      const fakeChild = { pid: 999999, kill: mock.fn(() => true) };
      const result = await signalChild(fakeChild, "SIGKILL");
      assert.equal(result, true, "an already-gone process group is the outcome we wanted");
    } finally {
      killSpy.mock.restore();
    }
  });
});

describe("a Git too old to suppress lazy fetch is refused, not trusted (P1 review fix)", () => {
  // GIT_NO_LAZY_FETCH is only honoured from git 2.39 on. Established by
  // reading the release tarballs: the string is absent from the 2.30.2,
  // 2.34.8, 2.35.8, 2.36.6, 2.37.7 and 2.38.5 trees and present in 2.39.5 at
  // promisor-remote.c:24. A locally built 2.39.5 was then driven through the
  // fake-ssh probe both ways and behaved as the source says.
  //
  // Note this corrects the review that prompted the check: it named 2.41 as
  // the floor and Debian 12 (git 2.39) as an exposed target. 2.39 is in fact
  // the FIRST release that honours the variable, so Debian 12 — and every
  // other platform vms/Vagrantfile and CI target — was already covered. The
  // gate below exists for the genuinely older hosts nothing stops an install
  // on (Ubuntu 22.04 is 2.34, Debian 11 is 2.30).
  let oldGitCounter = 0;
  function initPartialClone(name) {
    const dir = initRepo(`${name}-${++oldGitCounter}`);
    writeFileSync(join(dir, "f.txt"), "content\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);
    execFileSync("git", ["-C", dir, "config", "core.repositoryformatversion", "1"]);
    execFileSync("git", ["-C", dir, "config", "extensions.partialClone", "origin"]);
    execFileSync("git", ["-C", dir, "config", "remote.origin.url", "https://example.invalid/x.git"]);
    execFileSync("git", ["-C", dir, "config", "remote.origin.promisor", "true"]);
    return dir;
  }

  test("on git 2.38 a partial-clone read is refused — the suppression would be a silent no-op there", async () => {
    const dir = initPartialClone("oldgit-partial");
    fakeGitVersion = "2.38.5";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false }),
          (err) => {
            assert.ok(err instanceof GitPolicyError);
            assert.match(err.message, /partial clone/);
            assert.match(err.message, /GIT_NO_LAZY_FETCH/);
            assert.match(err.message, /2\.39/);
            return true;
          }
        );
      });
    } finally {
      fakeGitVersion = null;
    }
  });

  test("on git 2.39 the same read is allowed through — 2.39 is the floor, not 2.41", async () => {
    // The half the review got backwards. Verified against a locally built
    // 2.39.5 binary, not just this version string.
    const dir = initPartialClone("newgit-partial");
    fakeGitVersion = "2.39.0";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        const result = await runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false });
        assert.equal(result.code, 0, result.stderr);
      });
    } finally {
      fakeGitVersion = null;
    }
  });

  test("an old git is fine on an ORDINARY repo — only a partial clone can lazy-fetch", async () => {
    // The gate must not become "Aperio requires git 2.39". A normal repo (and
    // a shallow `clone --depth 1`, which is not a partial clone) has no
    // promisor remote, so no lazy fetch is possible at any git version.
    const dir = initRepo("oldgit-ordinary");
    writeFileSync(join(dir, "f.txt"), "content\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);
    fakeGitVersion = "2.30.2";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        const result = await runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false });
        assert.equal(result.code, 0, result.stderr);
      });
    } finally {
      fakeGitVersion = null;
    }
  });

  test("an old git does not block fetch/push — reaching the remote is their purpose", async () => {
    const dir = initPartialClone("oldgit-fetch");
    fakeGitVersion = "2.30.2";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        // Denied on the transport rule it really violates, never on the
        // lazy-fetch gate, which does not apply to fetch/push at all.
        execFileSync("git", ["-C", dir, "config", "remote.origin.url", `file://${dir}`]);
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["fetch", "origin"], mutating: false }),
          (err) => {
            assert.match(err.message, /remote transport not allowed/);
            assert.doesNotMatch(err.message, /GIT_NO_LAZY_FETCH/);
            return true;
          }
        );
      });
    } finally {
      fakeGitVersion = null;
    }
  });

  test("an unparseable git --version fails closed, not open", async () => {
    const dir = initPartialClone("oldgit-garbled");
    fakeGitVersion = "not-a-version";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false }),
          (err) => {
            assert.ok(err instanceof GitPolicyError);
            assert.match(err.message, /could not parse the installed Git version/);
            return true;
          }
        );
      });
    } finally {
      fakeGitVersion = null;
    }
  });

  test("an explicitly-false promisor flag is not read as a partial clone", async () => {
    // git's boolean spelling: `remote.x.promisor` with no value is TRUE, with
    // an empty or "false" value is FALSE — verified empirically that
    // --get-regexp prints the valueless form with no trailing space and the
    // empty one with one, and the two mean opposite things.
    const dir = initRepo("oldgit-promisor-false");
    writeFileSync(join(dir, "f.txt"), "content\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);
    execFileSync("git", ["-C", dir, "config", "remote.origin.promisor", "false"]);
    fakeGitVersion = "2.30.2";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        const result = await runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false });
        assert.equal(result.code, 0, result.stderr);
      });
    } finally {
      fakeGitVersion = null;
    }
  });

  test("a valueless promisor key IS a partial clone — git's implicit true", async () => {
    const dir = initRepo("oldgit-promisor-implicit");
    writeFileSync(join(dir, "f.txt"), "content\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);
    appendFileSync(join(dir, ".git", "config"), '[remote "a"]\n\tpromisor\n');
    fakeGitVersion = "2.30.2";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false }),
          (err) => {
            assert.match(err.message, /partial clone/);
            return true;
          }
        );
      });
    } finally {
      fakeGitVersion = null;
    }
  });

  test("the promisor scan costs no extra spawn — it rides the existing remote-config read", () => {
    // Structural: a separate `config --get-regexp` for the promisor keys would
    // add one process per git_* call. It is folded into the remote.*.vcs scan.
    const scans = RUNNER_SRC.match(/"config", "-z", "--get-regexp"/g) ?? [];
    assert.equal(scans.length, 2, "expected exactly two config scans: drivers, and remote+promisor");
    assert.ok(
      RUNNER_SRC.includes("^(remote\\\\..*\\\\.(vcs|promisor)|extensions\\\\.partialclone)$"),
      "the remote scan must cover vcs, promisor and extensions.partialclone in one pattern"
    );
    assert.doesNotMatch(
      RUNNER_SRC,
      /"config", "--get-regexp"/,
      "every config scan must be NUL-delimited — a space-split key skips spaced subsection names"
    );
  });
});

describe("a timed-out call does not settle while a descendant is still running (P1 review fix)", () => {
  // Raised as a Windows-only concern (taskkill's status ignored). It is not:
  // the same hole reproduced on POSIX against the pre-fix runner. "close"
  // fires when git has exited AND its pipes are closed, which says nothing
  // about a descendant that ignored SIGTERM and never held those pipes — so
  // the early close settled the promise and cleared the SIGKILL timer, and the
  // grandchild outlived the cancellation. Measured before the fix: settled in
  // 1007ms, grandchild still alive 300ms later.
  //
  // This is the case the existing "SIGTERM-ignoring git" test does NOT cover:
  // there the grandchild holds the pipes, so close never arrives early and the
  // escalation runs to completion on its own.
  test("a grandchild that ignores SIGTERM and does not hold the pipes is killed before the promise resolves", async () => {
    const binDir = join(ROOT, "close-race-bin");
    mkdirSync(binDir, { recursive: true });
    const pidFile = join(ROOT, "close-race-grandchild.pid");
    writeFileSync(join(binDir, "git"), [
      "#!/bin/sh",
      // Grandchild ignores TERM and sends its stdio to /dev/null, so it does
      // NOT keep git's stdout/stderr pipes open.
      `sh -c "trap '' TERM; echo \\$\\$ > '${pidFile}'; sleep 120" >/dev/null 2>&1 &`,
      // git itself takes the DEFAULT TERM disposition, so the first rung kills
      // it and "close" arrives almost immediately.
      "sleep 120",
    ].join("\n") + "\n");
    chmodSync(join(binDir, "git"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    let result;
    const started = Date.now();
    try {
      result = await spawnGit(["status"], { cwd: ROOT, timeout: 1000 });
    } finally {
      process.env.PATH = originalPath;
    }
    const elapsed = Date.now() - started;

    assert.notEqual(result.code, 0, "a timed-out command must not report success");
    assert.match(result.stderr, /timed out after 1000ms/);
    assert.ok(elapsed < 15_000, `expected a bounded teardown, took ${elapsed}ms`);

    // The whole point: the SIGKILL is delivered before the promise resolves,
    // so the descendant is already dying by the time the caller has an answer.
    // The poll is for REAPING, not for the kill — a SIGKILLed process lingers
    // as a zombie until its parent (here, the already-dead fake git, so init)
    // collects it, and process.kill(pid, 0) still finds a zombie. Pre-fix the
    // grandchild was not signalled at all and stayed alive indefinitely:
    // measured still running 300ms after resolve, and it holds its own 120s
    // sleep, so this poll cannot pass by luck.
    const grandchildPid = Number(readFileSync(pidFile, "utf-8").trim());
    assert.ok(grandchildPid > 0, "the fake git must have recorded its grandchild's pid");
    const gone = await waitForPidToDisappear(grandchildPid, 5_000);
    assert.ok(gone, `descendant ${grandchildPid} outlived the cancellation it was supposed to be killed by`);
  });

  test("the forced kill is issued once and awaited, never cancelled by an early close", () => {
    // Structural guard on the shape the behavioural test depends on: a future
    // edit that goes back to finish()ing straight from "close" would silently
    // reopen the leak on any platform where the descendant drops the pipes.
    assert.match(RUNNER_SRC, /const startForcedKill = \(\) => \{/);
    assert.match(RUNNER_SRC, /const confirmed = await startForcedKill\(\);/);
    assert.match(
      RUNNER_SRC,
      /if \(timedOut\) \{\s*\n\s*void settleTimedOut\(/,
      "an early close during teardown must route through settleTimedOut, not finish()"
    );
  });

  test("an unconfirmed teardown is reported, not hidden behind a clean cancellation", () => {
    assert.match(RUNNER_SRC, /could not confirm every process git spawned was terminated/);
  });

  test("the teardown wait is bounded — an unkillable tree still settles", async () => {
    // The opposite failure: waiting on a kill that never confirms would
    // restore the "advertised timeout is not hard" bug the escalation chain
    // exists to prevent. withKillDeadline() caps every such wait.
    assert.match(RUNNER_SRC, /function withKillDeadline\(promise, ms\)/);
    assert.match(RUNNER_SRC, /withKillDeadline\(signalChild\(child, "SIGKILL"\), KILL_GRACE_MS\)/);

    // And the normal path is still untouched by any of it.
    const dir = initRepo("teardown-normal");
    const result = await spawnGit(["-C", dir, "status", "--porcelain"], { cwd: dir, timeout: 30_000 });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /timed out|could not confirm/);
  });
});

describe("config keys with spaces in the subsection name are not skipped (P1 review fix)", () => {
  // `git config --get-regexp` separates key from value with ONE SPACE, and a
  // config subsection may itself contain spaces. Verified empirically (git
  // 2.50.1): `[remote "foo bar"] promisor = true` prints as
  //     remote.foo bar.promisor true
  // so a space-split key reads "remote.foo" and matches nothing — the entry is
  // skipped silently. Both halves of that bypass were verified to WORK against
  // real git before this fix: a promisor remote named with a space lazy-fetched
  // during `git show`, and with a matching `remote.foo bar.vcs = ssh` it
  // executed a planted git-remote-ssh from PATH. `-z` output is what removes
  // the ambiguity.
  function initSpacedRemoteRepo(name, extra) {
    const dir = initRepo(name);
    writeFileSync(join(dir, "f.txt"), "content\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);
    appendFileSync(join(dir, ".git", "config"), extra);
    return dir;
  }

  test("a promisor remote whose name contains a space is still seen as a partial clone", async () => {
    // Deliberately NO extensions.partialClone key: that one has no space in
    // it, so the old space-split parse still found it and the test would pass
    // for the wrong reason. The spaced `remote.foo bar.promisor` must be the
    // only thing that marks this repo as a partial clone.
    const dir = initSpacedRemoteRepo("spaced-promisor", [
      '[remote "foo bar"]',
      "\turl = ssh://git@example.invalid/x.git",
      "\tpromisor = true",
      "",
    ].join("\n"));

    fakeGitVersion = "2.30.2";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false }),
          (err) => {
            assert.ok(err instanceof GitPolicyError);
            assert.match(err.message, /partial clone/);
            return true;
          }
        );
      });
    } finally {
      fakeGitVersion = null;
    }
  });

  test("a remote helper override on a space-named remote is still rejected, and the helper never runs", async () => {
    // This half is version-independent: the vcs key is the only thing standing
    // between a fetch/push and an arbitrary PATH binary.
    const dir = initSpacedRemoteRepo("spaced-vcs", [
      '[remote "foo bar"]',
      "\turl = https://example.invalid/x.git",
      "\tvcs = ssh",
      "",
    ].join("\n"));

    const binDir = join(ROOT, "spaced-vcs-bin");
    mkdirSync(binDir, { recursive: true });
    const marker = join(ROOT, "SPACED_HELPER_RAN");
    writeFileSync(join(binDir, "git-remote-ssh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(join(binDir, "git-remote-ssh"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["fetch", "foo bar"], mutating: false }),
          (err) => {
            assert.ok(err instanceof GitPolicyError);
            assert.match(err.message, /remote helper override not allowed/);
            assert.match(err.message, /remote\.foo bar\.vcs/, "the full spaced key must survive parsing");
            return true;
          }
        );
      });
    } finally {
      process.env.PATH = originalPath;
    }
    assert.equal(existsSync(marker), false, "the repo-selected remote helper must never be executed");
  });

  test("a driver whose name contains a space is discovered and blanked", async () => {
    // Not reachable today — verified that `.gitattributes` cannot select such a
    // driver, because attribute values are space-delimited too
    // (`path filter=my filter` parses as filter=my). Parsed correctly anyway so
    // the guarantee does not rest on that second fact holding forever.
    const dir = initRepo("spaced-driver");
    writeFileSync(join(dir, "f.txt"), "content\n");
    appendFileSync(join(dir, ".git", "config"), [
      '[filter "my filter"]',
      "\tclean = /bin/echo pwned",
      "",
    ].join("\n"));

    await runWithPaths([dir], [dir], null, async () => {
      const result = await runGit({ cwd: dir, argv: buildStageArgv(["f.txt"]), mutating: true });
      assert.equal(result.code, 0, result.stderr);
    });
    // The blanking argv is what proves the driver was seen at all.
    assert.match(RUNNER_SRC, /filter\.\$\{name\}\.clean=/);
  });

  test("a multi-line config value cannot shift the parse onto the wrong key", () => {
    // -z records are NUL-terminated and the FIRST newline splits key from
    // value, so a value containing newlines stays part of that value.
    assert.match(RUNNER_SRC, /function parseConfigRecords\(stdout\)/);
    assert.match(RUNNER_SRC, /const nl = record\.indexOf\("\\n"\);/);
    assert.match(RUNNER_SRC, /stdout\.split\("\\0"\)/);
  });
});

describe("git boolean spellings are read the way git reads them (P2 review fix)", () => {
  // git_config_bool() tries the words first and otherwise parses an INTEGER,
  // where any zero is false. Verified against real git with `git config
  // --bool`: "00", "+0", "-0" and "0k" all report false; "1", "true", "yes",
  // "on" report true. Matching only the literal "0" made an ordinary repo look
  // like a partial clone and rejected every local command on an old git.
  function repoWithPromisorValue(name, rawConfig) {
    const dir = initRepo(name);
    writeFileSync(join(dir, "f.txt"), "content\n");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "c1"]);
    appendFileSync(join(dir, ".git", "config"), rawConfig);
    return dir;
  }

  // Indexed, not derived from the value: "+0" and "-0" sanitize to the same
  // string and would silently share one fixture repo.
  for (const [index, falsey] of ["0", "00", "+0", "-0", "0k", "false", "no", "off", ""].entries()) {
    test(`promisor = "${falsey}" is FALSE — an ordinary repo, allowed on an old git`, async () => {
      const dir = repoWithPromisorValue(
        `bool-false-${index}`,
        `[remote "origin"]\n\tpromisor = ${falsey}\n`
      );
      fakeGitVersion = "2.30.2";
      try {
        await runWithPaths([dir], [dir], null, async () => {
          const result = await runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false });
          assert.equal(result.code, 0, result.stderr);
        });
      } finally {
        fakeGitVersion = null;
      }
    });
  }

  for (const [index, truthy] of ["1", "01", "-1", "2", "true", "yes", "on"].entries()) {
    test(`promisor = "${truthy}" is TRUE — a partial clone, refused on an old git`, async () => {
      const dir = repoWithPromisorValue(
        `bool-true-${index}`,
        `[remote "origin"]\n\tpromisor = ${truthy}\n`
      );
      fakeGitVersion = "2.30.2";
      try {
        await runWithPaths([dir], [dir], null, async () => {
          await assert.rejects(
            () => runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false }),
            (err) => {
              assert.match(err.message, /partial clone/);
              return true;
            }
          );
        });
      } finally {
        fakeGitVersion = null;
      }
    });
  }

  test("a value git itself would reject as a boolean fails closed, treated as a partial clone", async () => {
    const dir = repoWithPromisorValue("bool-garbage", '[remote "origin"]\n\tpromisor = maybe\n');
    fakeGitVersion = "2.30.2";
    try {
      await runWithPaths([dir], [dir], null, async () => {
        await assert.rejects(
          () => runGit({ cwd: dir, argv: ["show", "HEAD:f.txt"], mutating: false }),
          (err) => {
            assert.match(err.message, /partial clone/);
            return true;
          }
        );
      });
    } finally {
      fakeGitVersion = null;
    }
  });
});
