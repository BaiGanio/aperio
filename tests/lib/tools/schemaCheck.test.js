// tests/lib/tools/schemaCheck.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkArgs, hintFromIssues } from "../../../lib/tools/schemaCheck.js";

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
});
