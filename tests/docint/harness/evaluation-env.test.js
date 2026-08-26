import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupEvaluationExtraction,
  includeEvaluationModelInCapableModels,
} from "./evaluation-env.mjs";

test("live llama.cpp evaluation always capability-enables its selected model", () => {
  assert.equal(
    includeEvaluationModelInCapableModels("gemma:test", "ornith:test"),
    "gemma:test,ornith:test",
  );
});

test("capability setup preserves an existing model without case-duplicate entries", () => {
  assert.equal(
    includeEvaluationModelInCapableModels("gemma:test, ORNITH:TEST ", "ornith:test"),
    "gemma:test,ORNITH:TEST",
  );
});

test("capability setup fails fast when the llama.cpp model is missing", () => {
  assert.throws(
    () => includeEvaluationModelInCapableModels("gemma:test", " "),
    /evaluation model is required/,
  );
});

test("live evaluation cleanup deletes the extraction DB derived from its scratch store", async () => {
  const store = { id: "scratch-store" };
  const deleted = [];
  const logged = [];
  const result = await cleanupEvaluationExtraction(store, {
    extractionDbPath: value => `/repo/var/extraction/${value.id}.db`,
    deleteExtractionFile: async file => { deleted.push(file); },
    log: file => { logged.push(file); },
  });
  assert.equal(result, "/repo/var/extraction/scratch-store.db");
  assert.deepEqual(deleted, [result]);
  assert.deepEqual(logged, [result]);
});

test("live evaluation cleanup is a no-op when boot never produced a store", async () => {
  assert.equal(await cleanupEvaluationExtraction(null, {
    extractionDbPath: () => { throw new Error("must not resolve"); },
    deleteExtractionFile: async () => { throw new Error("must not delete"); },
  }), null);
});
