import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBackgroundJobToolCatalog,
  validateBackgroundJobSteps,
} from "../../../lib/workers/background-job-tools.js";

const tools = [
  {
    name: "backfill_embeddings",
    description: "Model-facing backfill copy",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 100 } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "deduplicate_memories",
    inputSchema: {
      type: "object",
      properties: {
        threshold: { type: "number", minimum: 0.5, maximum: 1 },
        dry_run: { type: "boolean" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "recall",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
  },
];

describe("background-job tool catalog", () => {
  test("uses live schemas while exposing only the curated builder subset", () => {
    const catalog = buildBackgroundJobToolCatalog(tools);
    assert.deepEqual(catalog.map(tool => tool.name), [
      "backfill_embeddings",
      "deduplicate_memories",
    ]);
    assert.equal(catalog[0].label, "Generate missing embeddings");
    assert.equal(catalog[0].description, "Create search embeddings for memories that do not have one yet.");
    assert.equal(catalog[0].inputSchema.properties.limit.maximum, 100);
  });
});

describe("background-job step validation", () => {
  test("accepts any registered tool, including one outside the visual subset", () => {
    assert.deepEqual(
      validateBackgroundJobSteps([{ tool: "recall", input: { query: "project" } }], tools),
      [],
    );
  });

  test("rejects unknown tools and malformed inputs with step paths", () => {
    const errors = validateBackgroundJobSteps([
      { tool: "not_real", input: {} },
      { tool: "backfill_embeddings", input: { limit: 101, surprise: true } },
      { tool: "deduplicate_memories", input: { dry_run: "yes" } },
    ], tools);
    assert.deepEqual(errors, [
      'steps[0].tool "not_real" is not registered',
      "steps[1].input.limit must be at most 100",
      "steps[1].input.surprise is not a recognized input",
      "steps[2].input.dry_run must be boolean, received string",
    ]);
  });
});
