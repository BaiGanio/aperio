// tests/lib/providers/schema.test.js
//
// jsonSchemaToZodShape rebuilds a Zod raw shape from the JSON Schema that
// mcp.listTools() returns over stdio. The claude-code provider feeds the result
// to the Agent SDK's tool() helper. Regression guard: this used to be an empty
// z.object({}), so every tool reached Claude with zero parameters (fetch_url with
// no `url`), which weaker models like Haiku could not call.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../../../lib/providers/schema.js";

// The exact JSON Schema the MCP wire produces for fetch_url (mcp/tools/web.js).
const FETCH_URL_SCHEMA = {
  type: "object",
  properties: {
    url:       { type: "string", format: "uri", description: "The URL to fetch" },
    max_chars: { type: "number", minimum: 500, maximum: 15000, description: "Max characters" },
    offset:    { type: "number", minimum: 0, description: "Character offset" },
  },
  required: ["url"],
  $schema: "http://json-schema.org/draft-07/schema#",
};

describe("jsonSchemaToZodShape", () => {
  test("rebuilds every property, not an empty shape", () => {
    const shape = jsonSchemaToZodShape(FETCH_URL_SCHEMA);
    assert.deepEqual(Object.keys(shape).sort(), ["max_chars", "offset", "url"]);
  });

  test("required vs optional is preserved", () => {
    const shape = jsonSchemaToZodShape(FETCH_URL_SCHEMA);
    // url is required → object rejects when it is missing
    assert.throws(() => z.object(shape).parse({ max_chars: 1000 }));
    // optional fields may be omitted
    assert.doesNotThrow(() => z.object(shape).parse({ url: "https://example.com" }));
  });

  test("types round-trip so the SDK advertises them", () => {
    const shape = jsonSchemaToZodShape(FETCH_URL_SCHEMA);
    const json = z.toJSONSchema(z.object(shape));
    assert.equal(json.properties.url.type, "string");
    assert.equal(json.properties.max_chars.type, "number");
    assert.deepEqual(json.required, ["url"]);
    assert.equal(json.properties.url.description, "The URL to fetch");
  });

  test("string enums become z.enum", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { order: { type: "string", enum: ["recent", "importance"] } },
      required: ["order"],
    });
    assert.doesNotThrow(() => z.object(shape).parse({ order: "recent" }));
    assert.throws(() => z.object(shape).parse({ order: "nope" }));
  });

  test("missing/empty schema yields an empty shape (no-arg tools)", () => {
    assert.deepEqual(jsonSchemaToZodShape(undefined), {});
    assert.deepEqual(jsonSchemaToZodShape({ type: "object" }), {});
    assert.deepEqual(jsonSchemaToZodShape({ type: "object", properties: {} }), {});
  });

  test("arrays carry their item type", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    });
    assert.doesNotThrow(() => z.object(shape).parse({ tags: ["a", "b"] }));
    assert.throws(() => z.object(shape).parse({ tags: "not-an-array" }));
  });
});
