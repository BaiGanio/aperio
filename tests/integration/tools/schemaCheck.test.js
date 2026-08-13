// tests/lib/tools/schemaCheck.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { checkArgs, hintFromIssues, isTestRuntime, logToolCallFailure } from "../../../lib/tools/schemaCheck.js";

// Normalized schema shape produced by zodToJsonSchema: { type, properties, required }.
const schema = {
  type: "object",
  properties: {
    path:      { type: "string" },
    max_lines: { type: "number" },
    paths:     { type: "array" },
    recursive: { type: "boolean" },
  },
  required: ["path"],
};

describe("checkArgs", () => {
  test("clean args produce no issues", () => {
    assert.deepEqual(checkArgs({ path: "/a", max_lines: 10 }, schema), []);
  });

  test("missing required param is flagged", () => {
    const issues = checkArgs({ max_lines: 10 }, schema);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "missing_required");
    assert.equal(issues[0].param, "path");
  });

  test("type mismatch: string where array expected", () => {
    const issues = checkArgs({ path: "/a", paths: "/b" }, schema);
    assert.deepEqual(issues, [{ kind: "type_mismatch", param: "paths", expected: "array", received: "string" }]);
  });

  test("type mismatch: string where number expected", () => {
    const issues = checkArgs({ path: "/a", max_lines: "10" }, schema);
    assert.equal(issues[0].kind, "type_mismatch");
    assert.equal(issues[0].expected, "number");
    assert.equal(issues[0].received, "string");
  });

  test("null/empty on an optional param is flagged as null_optional", () => {
    const issues = checkArgs({ path: "/a", max_lines: null, recursive: "" }, schema);
    assert.deepEqual(issues.map(i => i.kind).sort(), ["null_optional", "null_optional"]);
  });

  test("unknown (hallucinated) param is flagged", () => {
    const issues = checkArgs({ path: "/a", flavor: "spicy" }, schema);
    assert.deepEqual(issues, [{ kind: "unknown_param", param: "flavor", expected: undefined, received: "string" }]);
  });

  test("empty string on a REQUIRED param is not a null_optional", () => {
    const issues = checkArgs({ path: "" }, schema);
    assert.ok(!issues.some(i => i.kind === "null_optional"));
  });

  test("number satisfies a number-typed param", () => {
    assert.deepEqual(checkArgs({ path: "/a", max_lines: 5 }, schema), []);
  });

  test("loose schema (no properties) is not judged", () => {
    assert.deepEqual(checkArgs({ anything: 1 }, { type: "object" }), []);
  });

  test("non-object args are ignored", () => {
    assert.deepEqual(checkArgs("nope", schema), []);
    assert.deepEqual(checkArgs(["a"], schema), []);
  });

  test("__parse_error__ sentinel is skipped", () => {
    const issues = checkArgs({ path: "/a", __parse_error__: "x" }, schema);
    assert.deepEqual(issues, []);
  });

  // A lost-sync parse folds argument VALUES into a key. Reporting that as
  // `unknown_param` was misleading and wrote kilobytes per row into the ledger:
  // the 2026-08-13 db_execute run logged four such rows and no record that
  // `sql` had gone missing, because `sql` was inside the key.
  describe("mangled argument keys", () => {
    test("a key carrying JSON structure is mangled, not a hallucinated param", () => {
      const key = '"a","b"],["c","d"],sql';
      const issues = checkArgs({ path: "/a", [key]: 1 }, schema);
      assert.deepEqual(issues, [{ kind: "mangled_args", param: `«mangled:${key.length}ch»`, expected: undefined, received: `${key.length}ch` }]);
    });

    test("an over-long key is mangled even without JSON punctuation", () => {
      const key = "x".repeat(65);
      const issues = checkArgs({ path: "/a", [key]: 1 }, schema);
      assert.equal(issues[0].kind, "mangled_args");
    });

    test("the key itself never reaches the issue — only its length", () => {
      const key = `${"sql text ".repeat(400)},[`;
      const issues = checkArgs({ path: "/a", [key]: 1 }, schema);
      assert.equal(issues.length, 1);
      assert.ok(!JSON.stringify(issues).includes("sql text"), "the payload must not be echoed into the ledger or the model's context");
      assert.match(issues[0].received, /^\d+ch$/);
    });

    test("short debris alongside a mangled key is debris too", () => {
      // Round 12's `Operator`: 8 chars, from a colon inside a receipt
      // description re-read as an object entry. Indistinguishable from a made-up
      // param alone, obvious in company.
      const issues = checkArgs({ path: "/a", Operator: 0, 'rows"],[more': 1 }, schema);
      assert.deepEqual(issues.map(i => i.kind), ["mangled_args", "mangled_args"]);
    });

    test("a hallucinated param on a CLEAN parse is still unknown_param", () => {
      const issues = checkArgs({ path: "/a", flavor: "spicy" }, schema);
      assert.deepEqual(issues.map(i => i.kind), ["unknown_param"]);
    });
  });
});

describe("hintFromIssues", () => {
  test("returns null for no issues", () => {
    assert.equal(hintFromIssues("read_file", []), null);
  });

  test("array mismatch hint suggests wrapping", () => {
    const hint = hintFromIssues("read_file", [{ kind: "type_mismatch", param: "paths", expected: "array", received: "string" }]);
    assert.match(hint, /paths/);
    assert.match(hint, /\[/);
  });

  test("combines multiple issues into one line", () => {
    const hint = hintFromIssues("read_file", [
      { kind: "missing_required", param: "path", expected: "string" },
      { kind: "unknown_param", param: "flavor" },
    ]);
    assert.match(hint, /path/);
    assert.match(hint, /flavor/);
    assert.match(hint, /read_file/);
  });

  test("the mangled hint names the real parameters and collapses to one line", () => {
    // The whole value of this hint: the model already knows the call failed
    // (`sql` is required), it does not know its arguments arrived as one key.
    const hint = hintFromIssues(
      "db_execute",
      [
        { kind: "mangled_args", param: "«mangled:2773ch»", received: "2773ch" },
        { kind: "mangled_args", param: "«mangled:314ch»", received: "314ch" },
      ],
      ["connection", "sql", "params"],
    );
    assert.match(hint, /2 argument keys were/);
    assert.match(hint, /did not parse as JSON/);
    assert.match(hint, /`connection`, `sql`, `params`/);
    assert.equal(hint.split("did not parse as JSON").length, 2, "advice appears once, not once per stray key");
  });

  test("the mangled hint degrades gracefully with no param names", () => {
    const hint = hintFromIssues("db_execute", [{ kind: "mangled_args", param: "«mangled:99ch»", received: "99ch" }]);
    assert.match(hint, /one argument key was/);
    assert.match(hint, /the documented parameters/);
  });
});

describe("logToolCallFailure", () => {
  // The ledger is silenced under both NODE_ENV=test and the Node test runner.
  // Exercise the writing path in a plain child process rooted at a throwaway cwd.
  function withWritableEnv(fn) {
    const dir = mkdtempSync(join(tmpdir(), "aperio-fail-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("recognizes NODE_ENV and direct node --test contexts", () => {
    assert.equal(isTestRuntime({ env: { NODE_ENV: "test" }, execArgv: [] }), true);
    assert.equal(isTestRuntime({ env: { NODE_ENV: "development", NODE_TEST_CONTEXT: "child-v8" }, execArgv: [] }), true);
    assert.equal(isTestRuntime({ env: { NODE_ENV: "development" }, execArgv: ["--test"] }), true);
    assert.equal(isTestRuntime({ env: { NODE_ENV: "development" }, execArgv: [] }), false);
  });

  test("silent under a direct Node test run even when NODE_ENV is development", () => {
    const prevEnv = process.env.NODE_ENV;
    const prevCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "aperio-fail-"));
    process.env.NODE_ENV = "development";
    process.chdir(dir);
    try {
      logToolCallFailure({ model: "m", kind: "leak", persisted: true, detail: "x" });
      assert.equal(existsSync(join(dir, "var/toolrepair/failures.tsv")), false);
    } finally {
      process.chdir(prevCwd);
      process.env.NODE_ENV = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends a header + one row per failure, whitespace-collapsed and capped", () => {
    withWritableEnv((dir) => {
      const moduleUrl = pathToFileURL(resolve("lib/tools/schemaCheck.js")).href;
      const script = [
        `import { logToolCallFailure } from ${JSON.stringify(moduleUrl)};`,
        `logToolCallFailure({ model: "qwen3.5:9b", kind: "leak", persisted: true, detail: "<execute_tool>\\n  name=recall" });`,
        `logToolCallFailure({ model: "gemma", kind: "corrupt_name", persisted: false, detail: "${"x".repeat(500)}" });`,
      ].join("\n");
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: dir,
        env: { ...process.env, NODE_ENV: "development", NODE_TEST_CONTEXT: "" },
      });
      const rows = readFileSync(join(dir, "var/toolrepair/failures.tsv"), "utf8").trim().split("\n");
      assert.equal(rows[0], ["ts", "model", "kind", "persisted", "detail"].join("\t"));
      assert.equal(rows.length, 3); // header + 2 events
      const leak = rows[1].split("\t");
      assert.equal(leak[1], "qwen3.5:9b");
      assert.equal(leak[2], "leak");
      assert.equal(leak[3], "1");
      assert.equal(leak[4], "<execute_tool> name=recall"); // newline + double-space collapsed
      const corrupt = rows[2].split("\t");
      assert.equal(corrupt[3], "0");
      assert.equal(corrupt[4].length, 200); // detail capped at 200 chars
    });
  });

  test("never throws on a bad detail value", () => {
    assert.doesNotThrow(() => logToolCallFailure({ model: "m", kind: "echo", detail: undefined }));
  });
});
