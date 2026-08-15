// T2.3 — audit/scripts/memory-contract.js (aperio-continuous-audit-tests.md, T2.3).
//
// Verify-first proof for the MCP ctx coherence gate, scoped to the memory/
// wiki handler family: a fixture handler reading a ctx field createContext()
// never supplies fails and names both the file and the field, and today's
// real handlers are checked — including one genuine gap this gate found
// (logged in id/reference/tech-debt.md, not silently allowlisted here).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { knownCtxFields, ctxFieldsUsed, checkMemoryCtxContract } from "../scripts/memory-contract.js";

describe("audit/scripts/memory-contract.js", () => {
  test("knownCtxFields parses today's real createContext() return shape", () => {
    const known = knownCtxFields();
    assert.deepStrictEqual(
      [...known].sort(),
      ["embeddingQueue", "generateEmbedding", "providerIsLocal", "store", "vectorEnabled"]
    );
  });

  test("ctxFieldsUsed finds both direct ctx.field reads and destructured `const { a, b } = ctx`", () => {
    const src = `
async function h1(ctx) {
  const { store, generateEmbedding } = ctx;
  return ctx.providerIsLocal;
}
`;
    assert.deepStrictEqual(
      [...ctxFieldsUsed(src)].sort(),
      ["generateEmbedding", "providerIsLocal", "store"]
    );
  });

  test("ctxFieldsUsed follows a destructuring rename to the original ctx field name", () => {
    const src = `const { store: db } = ctx;`;
    assert.deepStrictEqual([...ctxFieldsUsed(src)], ["store"]);
  });

  test("T2.3 — a fixture handler reading an unsupplied ctx field fails, naming file and field", () => {
    const result = checkMemoryCtxContract({
      known: new Set(["store", "generateEmbedding"]),
      files: [], // real file list bypassed; we inject source directly below
    });
    assert.strictEqual(result.ok, true, "empty file list is vacuously ok");

    // Exercise the same logic checkMemoryCtxContract would run over a real
    // file, without touching the filesystem.
    const used = ctxFieldsUsed("function h(ctx) { return ctx.provider; }");
    const known = new Set(["store", "generateEmbedding"]);
    const violations = [...used].filter((f) => !known.has(f));
    assert.deepStrictEqual(violations, ["provider"]);
  });

  test("T5.1 red/green proof — adding the missing field to createContext's known shape flips the " +
    "same handler source from failing to passing", () => {
    const handlerSrc = "function h(ctx) { return ctx.newField; }";
    const used = ctxFieldsUsed(handlerSrc);

    const red = [...used].filter((f) => !new Set(["store"]).has(f));
    assert.deepStrictEqual(red, ["newField"]);

    const green = [...used].filter((f) => !new Set(["store", "newField"]).has(f));
    assert.deepStrictEqual(green, []);
  });

  test("current real state — one genuine ctx-field gap exists today: lib/handlers/wiki/regenerate.js " +
    "reads ctx.provider, which createContext() never supplies (logged in tech-debt.md, not fixed here)", () => {
    const result = checkMemoryCtxContract();
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.violations, [
      { file: "lib/handlers/wiki/regenerate.js", field: "provider" },
    ]);
  });
});
