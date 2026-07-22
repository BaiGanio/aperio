import { test } from "node:test";
import assert from "node:assert/strict";

await import("../../../public/scripts/stream-prefix-guard.js");

const { shouldHoldLeadingContent } = globalThis.AperioStreamPrefixGuard;

test("holds a short prefix until it can be classified", () => {
  assert.equal(shouldHoldLeadingContent("Here is the result"), true);
  assert.equal(shouldHoldLeadingContent("Here is the result you requested, with enough text to stream safely."), false);
});

test("releases ordinary content as soon as the first line is complete", () => {
  assert.equal(shouldHoldLeadingContent("Here is the result:\n- first item"), false);
});

test("holds markup, narrated calls, and bare snake-case tool lines", () => {
  assert.equal(shouldHoldLeadingContent("<execute_tool>\nname=recall"), true);
  assert.equal(shouldHoldLeadingContent("Calling fetch_github_issue for the URL."), true);
  assert.equal(shouldHoldLeadingContent("run_shell\nfetch_url https://example.com"), true);
});

test("does not hold normal prose that merely starts with a snake-case name", () => {
  assert.equal(shouldHoldLeadingContent("run_shell is disabled unless shell access is enabled.\n"), false);
});
