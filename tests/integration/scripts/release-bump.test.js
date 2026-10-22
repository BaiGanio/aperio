// tests/integration/scripts/release-bump.test.js
// Test group T0.3 of the Aperio Reset plan: the release bump is computed from
// EVERY commit since the last version tag, not just the head commit of the
// push. The old inline shell read `git log -1` and so skipped a release when a
// `chore:` landed on top of a `fix:` — that ate the 2026-10-17 release.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBump } from "../../../scripts/release-bump.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "release-bump.js");

// `git log` hands subjects over newest first; the fixtures keep that order.
const runCli = (subjects, args = [], env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    input: `${subjects.join("\n")}\n`,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", ...env },
  });

const parseOutput = (stdout) =>
  Object.fromEntries(
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );

describe("release-bump: the four plan cases", () => {
  // The exact lists named in the plan's T0.3.
  const cases = [
    { subjects: ["fix: a", "chore: b"], bump: "patch", launchers: false },
    { subjects: ["chore: a", "feat: b"], bump: "minor", launchers: false },
    { subjects: ["chore: a"], bump: "skip", launchers: false },
    { subjects: ["feat(launchers): a"], bump: "minor", launchers: true },
  ];

  for (const c of cases) {
    test(`[${c.subjects.join(", ")}] → ${c.bump}${c.launchers ? " + launchers" : ""}`, () => {
      const got = computeBump(c.subjects);
      assert.equal(got.bump, c.bump);
      assert.equal(got.withLaunchers, c.launchers);
    });
  }

  test("the CLI prints the same verdict it computes", () => {
    for (const c of cases) {
      const res = runCli(c.subjects);
      assert.equal(res.status, 0, res.stderr);
      const out = parseOutput(res.stdout);
      assert.equal(out.bump, c.bump);
      assert.equal(out.with_launchers, String(c.launchers));
    }
  });
});

describe("release-bump: ordering does not change the verdict", () => {
  // The bug being fixed was positional: whichever commit happened to be last
  // decided everything. Both orders must now agree.
  test("a chore on top of a fix still releases a patch", () => {
    assert.equal(computeBump(["chore: b", "fix: a"]).bump, "patch");
    assert.equal(computeBump(["fix: a", "chore: b"]).bump, "patch");
  });

  test("a feat anywhere in the range wins over fixes", () => {
    assert.equal(computeBump(["fix: a", "feat: b", "fix: c"]).bump, "minor");
    assert.equal(computeBump(["feat: b", "fix: a"]).bump, "minor");
  });
});

describe("release-bump: skip-ci commits never count", () => {
  test("the bot's own release commit alone is a skip", () => {
    assert.equal(computeBump(["chore: release v0.70.0 [skip ci]"]).bump, "skip");
  });

  test("a skip-ci feat cannot trigger a release", () => {
    // Otherwise a release commit could drive the next release, forever.
    assert.equal(computeBump(["feat: sneaky [skip ci]"]).bump, "skip");
  });

  test("a skip-ci commit does not mask a real one next to it", () => {
    const got = computeBump(["chore: release v0.69.1 [skip ci]", "fix: real"]);
    assert.equal(got.bump, "patch");
    assert.equal(got.counted.length, 1);
  });
});

describe("release-bump: scopes", () => {
  test("a non-launchers scope bumps but asks for no binaries", () => {
    const got = computeBump(["feat(mcp): a"]);
    assert.equal(got.bump, "minor");
    assert.equal(got.withLaunchers, false);
  });

  test("fix(launchers) is a patch plus binaries", () => {
    const got = computeBump(["fix(launchers): a"]);
    assert.equal(got.bump, "patch");
    assert.equal(got.withLaunchers, true);
  });

  test("launchers anywhere in the range opts in", () => {
    assert.equal(computeBump(["chore: x", "fix(launchers): a"]).withLaunchers, true);
  });

  test("a launchers scope on an uncounted type opts nothing in", () => {
    const got = computeBump(["chore(launchers): a"]);
    assert.equal(got.bump, "skip");
    assert.equal(got.withLaunchers, false);
  });

  test("a scope merely containing 'launchers' does not opt in", () => {
    assert.equal(computeBump(["feat(launchers-ui): a"]).withLaunchers, false);
  });

  test("a breaking marker is read as its base type", () => {
    // The old inline `case` matched neither `feat!:` nor `fix!:` and skipped
    // them outright. Major bumps stay manual, but the change must not vanish.
    assert.equal(computeBump(["feat!: a"]).bump, "minor");
    assert.equal(computeBump(["fix!: a"]).bump, "patch");
  });
});

describe("release-bump: edge cases", () => {
  test("an empty range is a skip", () => {
    assert.equal(computeBump([]).bump, "skip");
    assert.equal(computeBump(["", "  "]).bump, "skip");
  });

  test("a type that merely starts with feat is not a feat", () => {
    assert.equal(computeBump(["feature: a"]).bump, "skip");
    assert.equal(computeBump(["fixup: a"]).bump, "skip");
  });

  test("the headline is the newest commit of the winning type", () => {
    const got = computeBump(["fix: newest fix", "feat: newest feat", "feat: older feat"]);
    assert.equal(got.headline, "newest feat");
  });

  test("a skip range has an empty headline", () => {
    assert.equal(computeBump(["chore: a"]).headline, "");
  });
});

describe("release-bump: release notes file", () => {
  test("--notes-file lists every counted commit, newest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "aperio-bump-"));
    const notes = join(dir, "notes.md");
    const res = runCli(
      ["fix: second thing", "chore: release v0.69.1 [skip ci]", "fix: first thing"],
      ["--notes-file", notes],
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(notes, "utf8"), "- second thing\n- first thing\n");
  });

  test("a skip range writes an empty notes file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aperio-bump-"));
    const notes = join(dir, "notes.md");
    const res = runCli(["chore: a"], ["--notes-file", notes]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(notes, "utf8"), "");
  });
});
