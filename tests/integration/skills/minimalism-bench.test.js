// tests/integration/skills/minimalism-bench.test.js — WS2 of epic #285.
// Groups E1 (arm construction), E3 (fixtures), E4 (dry-run runner + ledger),
// and E6 (hygiene) of trash/plans/ponytail-borrow/ponytail-borrow-ws2-tests.md.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { loadSkillIndex, matchSkills } from "../../../lib/workers/skills.js";
import { buildSandbox, REPO_ROOT, LEDGER_COLUMNS, sha256File } from "../../../lib/helpers/minimalismBench.js";
import { loadFixtures } from "../../../scripts/minimalism-bench.js";

const FIXTURES_DIR = resolve(REPO_ROOT, "tests/fixtures/minimalism-tasks");
const RUNNER_SCRIPT = resolve(REPO_ROOT, "scripts/minimalism-bench.js");
const LEDGER_PATH = resolve(REPO_ROOT, "var/autotune/minimalism.tsv");
const fixtures = loadFixtures(null);

// ── E1 — Arm construction (offline, no model) ────────────────────────────
describe("E1 — arm construction", () => {
  test("arm A indexes code-minimalism, arm B does not — by name, not by keyword emptiness", () => {
    const armA = buildSandbox({ arm: "A" });
    const armB = buildSandbox({ arm: "B" });
    try {
      const indexA = loadSkillIndex(armA.skillsDir, join(armA.root, "var", "skills"), []);
      const indexB = loadSkillIndex(armB.skillsDir, join(armB.root, "var", "skills"), []);
      assert.equal(indexA.length - indexB.length, 1);
      assert.ok(indexA.some(s => s.name === "code-minimalism"));
      assert.ok(!indexB.some(s => s.name === "code-minimalism"));
      const namesA = new Set(indexA.map(s => s.name).filter(n => n !== "code-minimalism"));
      const namesB = new Set(indexB.map(s => s.name));
      assert.deepEqual([...namesA].sort(), [...namesB].sort());
    } finally {
      armA.cleanup();
      armB.cleanup();
    }
  });

  test("every fixture prompt loads the skill in A and never in B", () => {
    const armA = buildSandbox({ arm: "A" });
    const armB = buildSandbox({ arm: "B" });
    try {
      const indexA = loadSkillIndex(armA.skillsDir, join(armA.root, "var", "skills"), []);
      const indexB = loadSkillIndex(armB.skillsDir, join(armB.root, "var", "skills"), []);
      for (const fixture of fixtures) {
        const gotA = matchSkills(fixture.prompt, indexA, { limit: 3 }).map(s => s.name);
        const gotB = matchSkills(fixture.prompt, indexB, { limit: 3 }).map(s => s.name);
        assert.ok(gotA.includes("code-minimalism"), `fixture "${fixture.id}" did not load the skill in arm A: [${gotA.join(", ")}]`);
        assert.ok(!gotB.includes("code-minimalism"), `fixture "${fixture.id}" leaked the skill into arm B: [${gotB.join(", ")}]`);
      }
    } finally {
      armA.cleanup();
      armB.cleanup();
    }
  });

  test("the sandbox assembles the real system prompt", () => {
    const sandbox = buildSandbox({ arm: "A" });
    try {
      for (const file of ["whoami.md", "capabilities.md", "self-nature.md"]) {
        const p = join(sandbox.root, "id", file);
        assert.ok(existsSync(p), `missing ${p}`);
        assert.ok(readFileSync(p, "utf8").length > 0, `${p} is empty`);
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

// ── E3 — Task fixtures ────────────────────────────────────────────────────
describe("E3 — task fixtures", () => {
  test("every fixture's reference solution passes its own tests", async () => {
    const { runFixtureTests } = await import("../../../lib/helpers/minimalismBench.js");
    for (const fixture of fixtures) {
      const ok = runFixtureTests({ testsDir: fixture.testsDir, solutionDir: fixture.referenceDir });
      assert.ok(ok, `fixture "${fixture.id}" reference solution failed its own tests`);
    }
  });

  test("non-negotiable fixtures ship a reference test file with real assertions", () => {
    for (const id of ["divide-with-validation", "parse-config-value", "cache-entry-ttl"]) {
      const testFile = readdirSync(join(FIXTURES_DIR, id, "tests")).find(f => f.endsWith(".test.js"));
      const body = readFileSync(join(FIXTURES_DIR, id, "tests", testFile), "utf8");
      assert.ok(/assert\.(equal|throws|deepEqual)/.test(body), `${id}'s reference tests have no real assertions`);
    }
  });

  test("corner-cutting anti-solutions fail the non-negotiable tasks", async () => {
    const { runFixtureTests } = await import("../../../lib/helpers/minimalismBench.js");
    for (const id of ["divide-with-validation", "parse-config-value", "cache-entry-ttl"]) {
      const fixture = fixtures.find(f => f.id === id);
      const antiDir = join(fixture.dir, "anti-solution");
      assert.ok(existsSync(antiDir), `${id} is missing anti-solution/`);
      const ok = runFixtureTests({ testsDir: fixture.testsDir, solutionDir: antiDir });
      assert.equal(ok, false, `${id}'s anti-solution unexpectedly passed — the fixture is decorative`);
    }
  });

  test("fixture prompts are held out from the autotune eval set", () => {
    const norm = (s) => s.toLowerCase().trim();
    const evalSet = JSON.parse(readFileSync(resolve(REPO_ROOT, "skills/autotune/eval.json"), "utf8"));
    const holdout = JSON.parse(readFileSync(resolve(REPO_ROOT, "skills/autotune/eval.holdout.json"), "utf8"));
    const known = new Set([...evalSet.cases, ...(holdout.cases ?? [])].map(c => norm(c.prompt ?? "")));
    for (const fixture of fixtures) {
      assert.ok(!known.has(norm(fixture.prompt)), `fixture "${fixture.id}" duplicates an autotune eval prompt`);
    }
  });
});

// ── E4 — Runner + ledger (dry-run, CI-safe) ──────────────────────────────
describe("E4 — dry-run runner + ledger", () => {
  test("--dry-run reproduces the eval end-to-end with no live model", () => {
    rmSync(LEDGER_PATH, { force: true });
    const result = spawnSync(process.execPath, [RUNNER_SCRIPT, "--dry-run", "--tasks=slug-helper,debounce-stdlib", "--repeats=1"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(LEDGER_PATH), "ledger was not written");
    const lines = readFileSync(LEDGER_PATH, "utf8").trim().split("\n");
    // header + 2 tasks x 2 arms x 1 repeat = 5 lines
    assert.equal(lines.length, 5, `expected 1 header + 4 rows, got:\n${lines.join("\n")}`);
    rmSync(LEDGER_PATH, { force: true });
  });

  test("without NODE_ENV pre-set, --dry-run still works (sets it itself rather than failing loudly)", () => {
    rmSync(LEDGER_PATH, { force: true });
    const env = { ...process.env };
    delete env.NODE_ENV;
    const result = spawnSync(process.execPath, [RUNNER_SCRIPT, "--dry-run", "--tasks=slug-helper", "--repeats=1"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    rmSync(LEDGER_PATH, { force: true });
  });

  test("ledger rows are complete and typed", () => {
    rmSync(LEDGER_PATH, { force: true });
    const result = spawnSync(process.execPath, [RUNNER_SCRIPT, "--dry-run", "--tasks=slug-helper,divide-with-validation", "--repeats=1"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(LEDGER_PATH, "utf8").trim().split("\n");
    const header = lines[0].split("\t");
    assert.deepEqual(header, LEDGER_COLUMNS);
    // exactly one header line, at file creation only
    assert.equal(lines.filter(l => l === lines[0]).length, 1);

    const expectedSha = sha256File(resolve(REPO_ROOT, "skills/code-minimalism/SKILL.md"));
    const rows = lines.slice(1).map(line => Object.fromEntries(LEDGER_COLUMNS.map((c, i) => [c, line.split("\t")[i]])));
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.ok(["A", "B"].includes(row.arm), `bad arm: ${row.arm}`);
      assert.ok(["0", "1"].includes(row.correct), `correct must be 0 or 1, got ${row.correct}`);
      assert.equal(Number(row.net_tokens), Number(row.input_tokens) + Number(row.output_tokens));
      assert.equal(row.skill_sha, expectedSha);
    }
    // skill_sha identical across the whole run
    assert.equal(new Set(rows.map(r => r.skill_sha)).size, 1);
    rmSync(LEDGER_PATH, { force: true });
  });
});

// ── E6 — Hygiene ──────────────────────────────────────────────────────────
describe("E6 — hygiene", () => {
  test("no stray state after a dry run", () => {
    rmSync(LEDGER_PATH, { force: true });
    const gitBefore = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout;

    const result = spawnSync(process.execPath, [RUNNER_SCRIPT, "--dry-run", "--tasks=slug-helper", "--repeats=1"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const gitAfter = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout;
    // var/ is gitignored, so the ledger never shows up in git status at all —
    // the porcelain output must be byte-identical before and after.
    assert.equal(gitAfter, gitBefore);
    assert.ok(existsSync(LEDGER_PATH), "the one expected write (the ledger) did not happen");
    rmSync(LEDGER_PATH, { force: true });
  });

  test("teardown survives a forced throw mid-run", () => {
    // sandbox.cleanup() is the exact primitive scripts/minimalism-bench.js's
    // runOneCell wraps in a finally{} — this exercises that primitive directly
    // under a thrown error, the same shape the real per-cell try/finally sees.
    const sandbox = buildSandbox({ arm: "A" });
    assert.ok(existsSync(sandbox.root));
    assert.throws(() => {
      try {
        throw new Error("forced failure mid-run");
      } finally {
        sandbox.cleanup();
      }
    }, /forced failure/);
    assert.ok(!existsSync(sandbox.root), "sandbox root must be removed even when the run throws");
  });

  test("SIGINT mid-run removes every sandbox the run had already created", async () => {
    rmSync(LEDGER_PATH, { force: true });
    const before = new Set(readdirSync(tmpdir()).filter(n => n.startsWith("aperio-minimalism-")));

    const child = spawn(process.execPath, [RUNNER_SCRIPT, "--dry-run", "--tasks=slug-helper,debounce-stdlib,reuse-query-parser,includes-wrapper,divide-with-validation,parse-config-value", "--repeats=3"], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });

    const exited = new Promise(res => child.on("exit", (code, signal) => res({ code, signal })));
    await new Promise(res => setTimeout(res, 150));
    child.kill("SIGINT");
    const { signal, code } = await exited;
    assert.ok(signal === "SIGINT" || code === 130, `expected SIGINT/130 exit, got code=${code} signal=${signal}`);

    const after = readdirSync(tmpdir()).filter(n => n.startsWith("aperio-minimalism-") && !before.has(n));
    assert.deepEqual(after, [], `orphaned sandbox dirs after SIGINT: ${after.join(", ")}`);
    rmSync(LEDGER_PATH, { force: true });
  });
});
