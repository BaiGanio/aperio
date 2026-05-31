// tests/lib/handlers/attatchments/textHandler.test.js
// Tests for handleText in lib/handlers/attachments/textHandler.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleText } from "../../../../lib/handlers/attachments/textHandler.js";

function makeAtt(content) {
  return { data: Buffer.from(content).toString("base64") };
}

describe("handleText", () => {
  test("returns a single text block with fenced code", async () => {
    const result = await handleText(makeAtt("console.log('hi')"), "app.js", ".js");
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].type, "text");
  });

  test("fenced code block uses extension as language tag", async () => {
    const result = await handleText(makeAtt("{}"), "config.json", ".json");
    assert.ok(result.blocks[0].text.includes("```json\n"));
  });

  test("hint includes filename", async () => {
    const result = await handleText(makeAtt("# readme"), "README.md", ".md");
    assert.ok(result.hint.includes("README.md"));
  });

  test("file content is preserved inside the code fence", async () => {
    const content = "line1\nline2\nline3";
    const result = await handleText(makeAtt(content), "notes.txt", ".txt");
    assert.ok(result.blocks[0].text.includes(content));
  });

  test("block text wraps filename in Attached file label", async () => {
    const result = await handleText(makeAtt("x"), "script.py", ".py");
    assert.ok(result.blocks[0].text.includes("[Attached file: script.py]"));
  });

  test("empty file still produces a text block", async () => {
    const result = await handleText(makeAtt(""), "empty.ts", ".ts");
    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].text.includes("```ts"));
  });

  test("extension without dot is used as language (dot stripped)", async () => {
    const result = await handleText(makeAtt("SELECT 1"), "query.sql", ".sql");
    assert.ok(result.blocks[0].text.includes("```sql\n"));
    assert.ok(!result.blocks[0].text.includes("```.sql"));
  });

  test("hint is a non-empty string", async () => {
    const result = await handleText(makeAtt("data"), "data.csv", ".csv");
    assert.equal(typeof result.hint, "string");
    assert.ok(result.hint.length > 0);
  });
});
