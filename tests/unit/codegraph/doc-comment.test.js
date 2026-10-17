// tests/unit/codegraph/doc-comment.test.js
//
// Doc-comment extraction, shared by extract-ts.js and extract-generic.js.
//
// The regression this guards: both extractors used to slice the whole file
// prefix per symbol and run $-anchored regexes over it. On a 160KB file the
// last symbols cost ~67ms EACH (and ~3.4s each at 400KB), so indexing a large
// file pinned the server's main thread and froze every HTTP request with it.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";

let docWindow, leadingBlockDoc, leadingLineDoc, DOC_WINDOW_CHARS, extract;

before(async () => {
  ({ docWindow, leadingBlockDoc, leadingLineDoc, DOC_WINDOW_CHARS } =
    await import("../../../lib/codegraph/doc-comment.js"));
  ({ extract } = await import("../../../lib/codegraph/extract-ts.js"));
});

const slash = (before) => leadingLineDoc(before, (l) => l.startsWith("//"), /^\/\/\s?/);

describe("leadingBlockDoc", () => {
  test("reads the block that ends immediately above the symbol", () => {
    assert.equal(leadingBlockDoc("/**\n * Hello.\n */\n"), "Hello.");
  });

  test("ignores trailing whitespace between the block and the symbol", () => {
    assert.equal(leadingBlockDoc("/** Hello. */\n\n   "), "Hello.");
  });

  test("returns null when code sits between the block and the symbol", () => {
    assert.equal(leadingBlockDoc("/** Hello. */\nconst x = 1;\n"), null);
  });

  // The old lazy regex matched from the FIRST `/**` to the LAST `*/`, so it
  // captured the first comment, the code between, and the second comment.
  test("picks only the nearest block when two are separated by code", () => {
    assert.equal(leadingBlockDoc("/** AAA */\nconst z = 1;\n/** BBB */\n"), "BBB");
  });

  test("returns null for a non-doc block comment", () => {
    assert.equal(leadingBlockDoc("/* plain */\n"), null);
  });
});

describe("leadingLineDoc", () => {
  test("collects a run of line comments", () => {
    assert.equal(slash("// one\n// two\n"), "one\ntwo");
  });

  test("skips blank lines inside the run, as the old pattern did", () => {
    assert.equal(slash("// one\n\n// two\n"), "one\ntwo");
  });

  test("stops at the first non-comment line", () => {
    assert.equal(slash("const a = 1;\n// two\n"), "two");
  });

  test("returns null when the symbol's own line already holds code", () => {
    assert.equal(slash("// doc\nfoo(); "), null);
  });

  test("returns null when there is no comment run", () => {
    assert.equal(slash("const a = 1;\n"), null);
  });
});

describe("docWindow", () => {
  test("never looks further back than DOC_WINDOW_CHARS", () => {
    const src = "x".repeat(50_000) + "/** Hi */\n";
    assert.equal(docWindow(src, src.length).length, DOC_WINDOW_CHARS);
  });

  test("handles a symbol at the start of the file", () => {
    assert.equal(docWindow("abc", 0), "");
  });
});

describe("performance regression (issue: indexing froze the server)", () => {
  test("a large file extracts in linear time, not quadratic", async () => {
    // 2000 documented helpers interleaved with 2000 undocumented functions.
    // The undocumented ones are the pathological case: with no doc directly
    // above, the old regex had to try every `/**` in the prefix.
    const src = Array.from({ length: 2000 }, (_, i) =>
      `/**\n * Helper ${i}.\n */\nfunction doc${i}(){}\n\nfunction plain${i}(){ return ${i}; }\n`
    ).join("\n");

    const started = Date.now();
    const out = await extract(src, "big.js");
    const elapsed = Date.now() - started;

    assert.equal(out.symbols.length, 4000);
    // Docs still land on the right symbols, including at the far end.
    assert.equal(out.symbols.find((s) => s.name === "doc1999").doc, "Helper 1999.");
    assert.equal(out.symbols.find((s) => s.name === "plain1999").doc, null);
    // The old code needed ~67ms for a SINGLE end-of-file symbol here. A generous
    // ceiling: the point is to fail loudly if the quadratic scan comes back.
    assert.ok(elapsed < 5000, `extract took ${elapsed}ms — doc lookup may be quadratic again`);
  });
});
