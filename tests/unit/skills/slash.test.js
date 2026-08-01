// tests/skills/slash.test.js — parseSlashSkill: "/skill <names>" + direct "/<name>" forms
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSlashSkill } from "../../../lib/workers/skills.js";

const index = [
  { name: "pdf" },
  { name: "docx" },
  { name: "coding-examples" },
];

describe("parseSlashSkill — explicit /skill form", () => {
  test("single name", () => {
    const r = parseSlashSkill("/skill pdf extract this", index);
    assert.deepEqual(r.forcedNames, ["pdf"]);
    assert.deepEqual(r.notFound, []);
    assert.equal(r.cleanedText, "extract this");
  });

  test("comma-separated names", () => {
    const r = parseSlashSkill("/skill pdf,docx read both", index);
    assert.deepEqual(r.forcedNames, ["pdf", "docx"]);
    assert.equal(r.cleanedText, "read both");
  });

  test("repeated prefixes", () => {
    const r = parseSlashSkill("/skill pdf /skill docx read", index);
    assert.deepEqual(r.forcedNames, ["pdf", "docx"]);
    assert.equal(r.cleanedText, "read");
  });

  test("unknown name is stripped and reported", () => {
    const r = parseSlashSkill("/skill nosuch read", index);
    assert.deepEqual(r.forcedNames, []);
    assert.deepEqual(r.notFound, ["nosuch"]);
    assert.equal(r.cleanedText, "read");
  });

  test("hyphenated name matches", () => {
    const r = parseSlashSkill("/skill coding-examples show a loop", index);
    assert.deepEqual(r.forcedNames, ["coding-examples"]);
    assert.equal(r.cleanedText, "show a loop");
  });
});

describe("parseSlashSkill — direct /<name> form", () => {
  test("resolved name is forced and stripped", () => {
    const r = parseSlashSkill("/coding-examples show a loop", index);
    assert.deepEqual(r.forcedNames, ["coding-examples"]);
    assert.deepEqual(r.notFound, []);
    assert.equal(r.cleanedText, "show a loop");
  });

  test("bare /<name> with no message text", () => {
    const r = parseSlashSkill("/pdf", index);
    assert.deepEqual(r.forcedNames, ["pdf"]);
    assert.equal(r.cleanedText, "");
  });

  test("unknown name leaves the text untouched", () => {
    const r = parseSlashSkill("/nosuch show a loop", index);
    assert.deepEqual(r.forcedNames, []);
    assert.deepEqual(r.notFound, []);
    assert.equal(r.cleanedText, "/nosuch show a loop");
  });

  test("path-like text is never eaten", () => {
    const r = parseSlashSkill("/etc/hosts what is this file?", index);
    assert.deepEqual(r.forcedNames, []);
    assert.equal(r.cleanedText, "/etc/hosts what is this file?");
  });

  test("mixed with explicit form", () => {
    const r = parseSlashSkill("/pdf /skill docx read both", index);
    assert.deepEqual(r.forcedNames, ["pdf", "docx"]);
    assert.equal(r.cleanedText, "read both");
  });

  test("case-insensitive match keeps canonical name", () => {
    const r = parseSlashSkill("/PDF summarize", index);
    assert.deepEqual(r.forcedNames, ["pdf"]);
    assert.equal(r.cleanedText, "summarize");
  });
});

describe("parseSlashSkill — degenerate input", () => {
  test("empty / non-string input passes through", () => {
    assert.equal(parseSlashSkill("", index).cleanedText, "");
    assert.equal(parseSlashSkill(null, index).cleanedText, "");
  });

  test("no prefix at all", () => {
    const r = parseSlashSkill("just a normal message", index);
    assert.deepEqual(r.forcedNames, []);
    assert.equal(r.cleanedText, "just a normal message");
  });
});
