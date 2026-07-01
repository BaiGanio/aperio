// tests/lib/routes/paths.test.js
// PATH-01 — `~` expansion. Only a bare `~` or `~/...` expands to the home dir;
// `~user/...` is left intact rather than mangled into `<home>user/...`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "os";
import { expandTilde } from "../../../lib/routes/paths.js";

describe("expandTilde", () => {
  const home = homedir();

  test("expands a bare ~", () => assert.equal(expandTilde("~"), home));
  test("expands ~/path", () => assert.equal(expandTilde("~/projects/x"), `${home}/projects/x`));

  test("leaves ~user untouched", () => assert.equal(expandTilde("~bob/secret"), "~bob/secret"));
  test("leaves an embedded ~ untouched", () => assert.equal(expandTilde("/a/~/b"), "/a/~/b"));
  test("leaves absolute paths untouched", () => assert.equal(expandTilde("/etc/passwd"), "/etc/passwd"));
});
