// tests/lib/helpers/validateOutput.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  cleanAndParse,
  callWithValidation,
  validateRaw,
} from "../../../lib/helpers/validateOutput.js";

// ─── Shared schemas ────────────────────────────────────────────────────────────
const PersonSchema = z.object({
  name: z.string(),
  age:  z.number(),
});

const TagsSchema = z.object({
  tags: z.array(z.string()),
});

// =============================================================================
describe("cleanAndParse", () => {

  test("parses plain JSON object", () => {
    const result = cleanAndParse('{"name":"Alice","age":30}');
    assert.deepEqual(result, { name: "Alice", age: 30 });
  });

  test("parses plain JSON array", () => {
    const result = cleanAndParse('[1,2,3]');
    assert.deepEqual(result, [1, 2, 3]);
  });

  test("strips ```json ... ``` fences", () => {
    const raw = '```json\n{"name":"Bob","age":25}\n```';
    assert.deepEqual(cleanAndParse(raw), { name: "Bob", age: 25 });
  });

  test("strips bare ``` ... ``` fences", () => {
    const raw = '```\n{"name":"Carol","age":40}\n```';
    assert.deepEqual(cleanAndParse(raw), { name: "Carol", age: 40 });
  });

  test("strips ```JSON (uppercase) fences", () => {
    const raw = '```JSON\n{"name":"Dan","age":50}\n```';
    assert.deepEqual(cleanAndParse(raw), { name: "Dan", age: 50 });
  });

  test("strips preamble text before first {", () => {
    const raw = 'Here is the JSON:\n{"name":"Eve","age":22}';
    assert.deepEqual(cleanAndParse(raw), { name: "Eve", age: 22 });
  });

  test("strips preamble text before first [", () => {
    const raw = 'Sure, here is your list: [1, 2, 3]';
    assert.deepEqual(cleanAndParse(raw), [1, 2, 3]);
  });

  test("handles fences and preamble combined", () => {
    const raw = 'Of course!\n```json\n{"name":"Frank","age":35}\n```';
    assert.deepEqual(cleanAndParse(raw), { name: "Frank", age: 35 });
  });

  test("handles extra whitespace around fences", () => {
    const raw = '  ```json\n{"x":1}\n```  ';
    assert.deepEqual(cleanAndParse(raw), { x: 1 });
  });

  test("throws SyntaxError on invalid JSON", () => {
    assert.throws(() => cleanAndParse("{invalid}"), SyntaxError);
  });

  test("throws SyntaxError on truncated JSON", () => {
    assert.throws(() => cleanAndParse('{"name": "Alice"'), SyntaxError);
  });

  test("throws SyntaxError on empty fenced block", () => {
    assert.throws(() => cleanAndParse("```json\n```"), SyntaxError);
  });
});

// =============================================================================
describe("validateRaw", () => {

  test("returns success:true with parsed data on valid input", () => {
    const raw = '{"name":"Alice","age":30}';
    const result = validateRaw(raw, PersonSchema);
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { name: "Alice", age: 30 });
  });

  test("returns success:true for valid fenced input", () => {
    const raw = '```json\n{"name":"Bob","age":25}\n```';
    const result = validateRaw(raw, PersonSchema);
    assert.equal(result.success, true);
    assert.equal(result.data.name, "Bob");
  });

  test("returns success:false with error string on invalid JSON", () => {
    const result = validateRaw("not json at all", PersonSchema);
    assert.equal(result.success, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  });

  test("returns success:false with error string on schema mismatch", () => {
    const raw = '{"name":"Alice"}'; // missing 'age'
    const result = validateRaw(raw, PersonSchema);
    assert.equal(result.success, false);
    assert.ok(result.error.includes("age") || result.error.includes("Required") || result.error.length > 0);
  });

  test("returns success:false when field has wrong type", () => {
    const raw = '{"name":"Alice","age":"not-a-number"}';
    const result = validateRaw(raw, PersonSchema);
    assert.equal(result.success, false);
    assert.ok(result.error.length > 0);
  });

  test("handles nested schema validation failure", () => {
    const raw = '{"tags":"not-an-array"}';
    const result = validateRaw(raw, TagsSchema);
    assert.equal(result.success, false);
    assert.ok(result.error.length > 0);
  });

  test("success result has no error field and failure has no data field", () => {
    const ok  = validateRaw('{"name":"X","age":1}', PersonSchema);
    const err = validateRaw("bad", PersonSchema);
    assert.equal("error" in ok,  false);
    assert.equal("data"  in err, false);
  });
});

// =============================================================================
describe("callWithValidation", () => {

  test("returns parsed data on first successful attempt", async () => {
    const modelFn = async () => '{"name":"Alice","age":30}';
    const result = await callWithValidation("prompt", modelFn, PersonSchema);
    assert.deepEqual(result, { name: "Alice", age: 30 });
  });

  test("parses fenced JSON on first attempt", async () => {
    const modelFn = async () => '```json\n{"name":"Bob","age":25}\n```';
    const result = await callWithValidation("prompt", modelFn, PersonSchema);
    assert.equal(result.name, "Bob");
  });

  test("retries on schema validation failure and succeeds on second attempt", async () => {
    let call = 0;
    const modelFn = async () => {
      call++;
      if (call === 1) return '{"name":"Alice"}'; // missing age
      return '{"name":"Alice","age":30}';
    };
    const result = await callWithValidation("prompt", modelFn, PersonSchema, { maxRetries: 3 });
    assert.equal(call, 2);
    assert.deepEqual(result, { name: "Alice", age: 30 });
  });

  test("retries on invalid JSON and succeeds on second attempt", async () => {
    let call = 0;
    const modelFn = async () => {
      call++;
      if (call === 1) return "sorry, here is the data";
      return '{"name":"Carol","age":40}';
    };
    const result = await callWithValidation("initial", modelFn, PersonSchema, { maxRetries: 2 });
    assert.equal(call, 2);
    assert.equal(result.name, "Carol");
  });

  test("throws after exhausting all retries", async () => {
    const modelFn = async () => "always bad json !!!";
    await assert.rejects(
      () => callWithValidation("prompt", modelFn, PersonSchema, { maxRetries: 2, label: "test" }),
      (err) => {
        assert.ok(err.message.includes("test"));
        assert.ok(err.message.includes("2 attempts"));
        return true;
      }
    );
  });

  test("throws after 3 retries by default", async () => {
    let calls = 0;
    const modelFn = async () => { calls++; return "invalid"; };
    await assert.rejects(
      () => callWithValidation("prompt", modelFn, PersonSchema)
    );
    assert.equal(calls, 3);
  });

  test("uses maxRetries option", async () => {
    let calls = 0;
    const modelFn = async () => { calls++; return "bad"; };
    await assert.rejects(
      () => callWithValidation("prompt", modelFn, PersonSchema, { maxRetries: 5 })
    );
    assert.equal(calls, 5);
  });

  test("passes repair prompt on retry (prompt changes after failure)", async () => {
    const seenPrompts = [];
    const modelFn = async (prompt) => {
      seenPrompts.push(prompt);
      if (seenPrompts.length === 1) return "bad json";
      return '{"name":"X","age":1}';
    };
    await callWithValidation("initial-prompt", modelFn, PersonSchema, { maxRetries: 2 });
    assert.equal(seenPrompts[0], "initial-prompt");
    assert.notEqual(seenPrompts[1], "initial-prompt");
    assert.ok(seenPrompts[1].includes("Fix it") || seenPrompts[1].includes("broken") || seenPrompts[1].length > 0);
  });

  test("error message includes last raw output on exhaustion", async () => {
    const modelFn = async () => "THE_BROKEN_OUTPUT";
    await assert.rejects(
      () => callWithValidation("p", modelFn, PersonSchema, { maxRetries: 1 }),
      (err) => {
        assert.ok(err.message.includes("THE_BROKEN_OUTPUT"));
        return true;
      }
    );
  });

  test("succeeds on attempt 1 without logging retry message", async () => {
    const modelFn = async () => '{"name":"Alice","age":30}';
    // Should not throw, no retry needed
    const result = await callWithValidation("prompt", modelFn, PersonSchema, { maxRetries: 1 });
    assert.ok(result);
  });
});
