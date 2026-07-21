// tests/lib/helpers/validateOutput.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  fixUnclosedFence,
  validateOutput,
  validateOutputSafe,
} from "../../lib/helpers/validateOutput.js";

// =============================================================================
describe("fixUnclosedFence", () => {

  test("returns text unchanged when fences are balanced", () => {
    const text = "hello\n```js\ncode\n```\nworld";
    assert.equal(fixUnclosedFence(text), text);
  });

  test("appends closing fence when one fence is open", () => {
    const text = "hello\n```js\ncode";
    const result = fixUnclosedFence(text);
    assert.ok(result.endsWith("```"));
  });

  test("returns text unchanged with no fences", () => {
    const text = "just plain text";
    assert.equal(fixUnclosedFence(text), text);
  });

  test("returns text unchanged when already ends with fence", () => {
    const text = "```js\ncode\n```";
    assert.equal(fixUnclosedFence(text), text);
  });

  test("handles multiple balanced fence pairs", () => {
    const text = "```a\ncode\n```\n```b\nmore\n```";
    assert.equal(fixUnclosedFence(text), text);
  });
});

// =============================================================================
describe("validateOutput", () => {

  test("returns empty string for empty input", () => {
    assert.equal(validateOutput(""), "");
  });

  test("returns empty string for null input", () => {
    assert.equal(validateOutput(null), "");
  });

  test("passes through clean markdown unchanged", () => {
    const text = "# Hello\n\nSome **bold** text.";
    assert.equal(validateOutput(text), text);
  });

  test("strips script tags outside code blocks", () => {
    const text = "Click here <script>alert(1)</script> to continue";
    const result = validateOutput(text);
    assert.ok(!result.includes("<script>"));
    assert.ok(!result.includes("</script>"));
  });

  test("strips iframe tags", () => {
    const result = validateOutput("before <iframe src='x'></iframe> after");
    assert.ok(!result.includes("<iframe"));
  });

  test("strips event handler attributes", () => {
    const result = validateOutput('<img src="x" onerror="alert(1)">');
    assert.ok(!result.includes("onerror"));
  });

  test("preserves code block content from XSS stripping", () => {
    const text = "```html\n<script>alert(1)</script>\n```";
    const result = validateOutput(text);
    assert.ok(result.includes("<script>"));
  });

  test("fixes unclosed fence in output", () => {
    const text = "Here is code:\n```js\nconst x = 1;";
    const result = validateOutput(text);
    assert.ok(result.endsWith("```"));
  });

  test("returns string for string input", () => {
    assert.equal(typeof validateOutput("text"), "string");
  });
});

// =============================================================================
describe("validateOutputSafe", () => {

  test("returns same result as validateOutput for clean text", () => {
    const text = "Clean markdown text with **bold**.";
    assert.equal(validateOutputSafe(text), validateOutput(text));
  });

  test("returns same result as validateOutput for dirty text", () => {
    const text = "bad <script>x</script> content";
    assert.equal(validateOutputSafe(text), validateOutput(text));
  });

  test("accepts a label parameter without throwing", () => {
    assert.doesNotThrow(() => validateOutputSafe("text", "myLabel"));
  });
});
