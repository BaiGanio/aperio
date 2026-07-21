// tests/lib/codegraph/extract-ts.test.js
//
// Tests for the tree-sitter based JS/TS extractor using REAL WASM grammars.
// The test environment has access to tree-sitter-wasms, so we parse real
// source code and verify the extracted symbols and edges.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";

// ─── Dynamic import ───────────────────────────────────────────────────────

let extract;

before(async () => {
  const mod = await import("../../lib/codegraph/extract-ts.js");
  extract = mod.extract;
});

// =============================================================================
// Error handling
// =============================================================================
describe("error handling", () => {
  test("throws for unsupported extension", async () => {
    await assert.rejects(
      () => extract("print(1)", "test.py"),
      { message: /No tree-sitter grammar/ }
    );
  });

  test("throws descriptive error for unsupported extension", async () => {
    await assert.rejects(
      () => extract("x = 1", "test.rb"),
      { message: /No tree-sitter grammar for .rb/ }
    );
  });

  test("handles extremely malformed source without hanging", async () => {
    // Tree-sitter is resilient to syntax errors — it returns a partial
    // tree rather than throwing. The extractor should handle this cleanly.
    const result = await extract("function foo( {} ", "broken.ts");
    // At minimum, no crash — result is well-formed
    assert.ok(Array.isArray(result.symbols));
    assert.ok(Array.isArray(result.edges));
  });
});

// =============================================================================
// Function declarations
// =============================================================================
describe("function declarations", () => {
  test("extracts a simple function", async () => {
    const result = await extract(
      "function greet(name) {\n  return `Hello ${name}`;\n}",
      "greet.js"
    );
    assert.equal(result.symbols.length, 1);
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "greet");
    assert.equal(sym.qualified, "greet.js::greet");
    assert.equal(sym.start_line, 1);
    assert.equal(sym.end_line, 3);
    // Signature is the first line of the node text
    assert.ok(sym.signature.includes("function greet"));
    // No doc comment
    assert.equal(sym.doc, null);
  });

  test("extracts generator function", async () => {
    const result = await extract(
      "function* idMaker() {\n  let i = 0;\n  while (true) yield i++;\n}",
      "gen.js"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "idMaker");
  });

  test("extracts function with JSDoc", async () => {
    const result = await extract(
      "/**\n * Adds two numbers.\n * @param {number} a\n * @returns {number}\n */\nfunction add(a, b) {\n  return a + b;\n}",
      "math.ts"
    );
    const sym = result.symbols[0];
    assert.ok(sym.doc, "should have doc string");
    assert.ok(sym.doc.includes("Adds two numbers"));
    assert.ok(sym.doc.includes("@param"));
  });

  test("extracts function with line comments", async () => {
    const result = await extract(
      "// Helper utility\n// For internal use\nfunction process() {}",
      "util.ts"
    );
    const sym = result.symbols[0];
    assert.ok(sym.doc);
    assert.ok(sym.doc.includes("Helper utility"));
  });

  test("truncates long signatures", async () => {
    const result = await extract(
      "\n\nfunction veryLongFunction(param1, param2, param3, param4, param5, param6, param7, param8, param9, param10, param11) {\n  return;\n}",
      "long.ts"
    );
    const sym = result.symbols[0];
    // The signature is extracted from the function's node text, which may
    // span multiple lines. firstLine() takes the first line and checks if
    // it's > 200 chars before truncating. The exact length depends on the
    // tree-sitter node text.
    assert.ok(sym.signature.length > 0, "signature should not be empty");
    assert.ok(sym.signature.length <= 210, `signature should be reasonably bounded`);
  });
});

// =============================================================================
// Class declarations
// =============================================================================
describe("class declarations", () => {
  test("extracts a class", async () => {
    const result = await extract(
      "class Animal {\n  constructor(name) { this.name = name; }\n}",
      "animal.ts"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "class");
    assert.equal(sym.name, "Animal");
  });

  test("records extends edge", async () => {
    const result = await extract(
      "class Dog extends Animal {\n  bark() { return 'Woof!'; }\n}",
      "dog.ts"
    );
    const extendsEdge = result.edges.find(e => e.kind === "extends");
    assert.ok(extendsEdge, "should have an extends edge");
    assert.equal(extendsEdge.dst_unresolved, "Animal");
  });

  test("extracts methods inside class", async () => {
    const result = await extract(
      "class Calculator {\n  add(a, b) { return a + b; }\n  subtract(a, b) { return a - b; }\n}",
      "calc.ts"
    );
    const methods = result.symbols.filter(s => s.kind === "method");
    // There might also be a class symbol (kind="class")
    assert.ok(methods.length >= 2, `expected at least 2 methods, got ${methods.length}`);
    const methodNames = methods.map(m => m.name);
    assert.ok(methodNames.includes("add"));
    assert.ok(methodNames.includes("subtract"));
  });
});

// =============================================================================
// Arrow functions & variable declarations
// =============================================================================
describe("arrow functions / lexical declarations", () => {
  test("extracts const arrow function", async () => {
    const result = await extract(
      "const greet = (name) => `Hello ${name}`;",
      "greet.js"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "const");
    assert.equal(sym.name, "greet");
  });

  test("extracts const with function expression", async () => {
    const result = await extract(
      "const handler = function(req, res) {\n  res.send('ok');\n};",
      "handler.js"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "const");
    assert.equal(sym.name, "handler");
  });

  test("skips const with non-function value", async () => {
    const result = await extract(
      "const name = 'hello';\nconst count = 42;",
      "vars.js"
    );
    // Neither 'hello' nor 42 are functions — no symbols expected
    assert.equal(result.symbols.length, 0);
  });

  test("captures let and var with function initializers", async () => {
    // Tree-sitter JavaScript grammar: both `let` and `var` declarations
    // produce named children that the extractor handles.
    const result = await extract(
      "let x = () => 1;\nvar y = function() {};",
      "letvar.js"
    );
    // Both should produce symbols since they have function initializers
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("x"), `expected 'x' in [${names}]`);
    assert.ok(names.includes("y"), `expected 'y' in [${names}]`);
  });
});

// =============================================================================
// Import edges
// =============================================================================
describe("import edges", () => {
  test("records import statement as edge", async () => {
    const result = await extract(
      "import { readFile } from 'fs/promises';\nfunction test() {}",
      "importer.ts"
    );
    const importEdge = result.edges.find(e => e.kind === "imports");
    assert.ok(importEdge, "should have an import edge");
    assert.equal(importEdge.dst_unresolved, "fs/promises");
  });

  test("records default import", async () => {
    const result = await extract(
      "import React from 'react';\nconst App = () => <div/>;",
      "app.tsx"
    );
    const importEdge = result.edges.find(e => e.kind === "imports");
    assert.ok(importEdge);
    assert.equal(importEdge.dst_unresolved, "react");
  });
});

// =============================================================================
// Call edges
// =============================================================================
describe("call edges", () => {
  test("records a call expression inside a function", async () => {
    const result = await extract(
      "function caller() { return helper(); }\nfunction helper() { return 42; }",
      "calls.js"
    );
    const callEdge = result.edges.find(e => e.kind === "calls");
    assert.ok(callEdge, "should have a call edge");
    assert.equal(callEdge.dst_unresolved, "helper");
  });

  test("records method call via member expression", async () => {
    const result = await extract(
      "function test() { const x = obj.method(); }",
      "test.js"
    );
    const callEdge = result.edges.find(e => e.kind === "calls");
    // In member expressions like obj.method(), the callee is 'method'
    assert.ok(callEdge);
    assert.equal(callEdge.dst_unresolved, "method");
  });
});

// =============================================================================
// Edge cases
// =============================================================================
describe("edge cases", () => {
  test("empty source produces no symbols or edges", async () => {
    const result = await extract("", "empty.ts");
    assert.deepEqual(result.symbols, []);
    assert.deepEqual(result.edges, []);
  });

  test("only comments produce nothing", async () => {
    const result = await extract("// just a comment\n/* another */", "comment.js");
    assert.deepEqual(result.symbols, []);
    assert.deepEqual(result.edges, []);
  });

  test("async function", async () => {
    const result = await extract(
      "async function fetchData(url) {\n  const resp = await fetch(url);\n  return resp.json();\n}",
      "async.ts"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "fetchData");
  });

  test("anonymous function does not create symbol", async () => {
    const result = await extract(
      "export default function() { return 1; }",
      "anon.js"
    );
    // The anonymous function has no name, so no symbol is extracted
    assert.equal(result.symbols.length, 0);
  });

  test("nested function creates separate symbols", async () => {
    const result = await extract(
      "function outer() {\n  function inner() {\n    return 1;\n  }\n  return inner();\n}",
      "nested.js"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("outer"));
    assert.ok(names.includes("inner"));
  });
});

// =============================================================================
// TypeScript variants
// =============================================================================
describe("TypeScript", () => {
  test("extracts from .tsx file", async () => {
    const result = await extract(
      "const App: React.FC = () => <div>Hello</div>;",
      "app.tsx"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "const");
    assert.equal(sym.name, "App");
  });

  test("extracts from .mjs file", async () => {
    const result = await extract(
      "export async function load() { return import('./mod.js'); }",
      "module.mjs"
    );
    const sym = result.symbols[0];
    assert.equal(sym.name, "load");
  });
});

// =============================================================================
// Multiple symbols
// =============================================================================
describe("multiple symbols", () => {
  test("extracts all top-level symbols", async () => {
    const result = await extract(
      "function a() {}\nconst b = () => 1;\nclass C {}\nfunction* d() {}",
      "multi.js"
    );
    const names = result.symbols.map(s => s.name).sort();
    assert.deepEqual(names, ["C", "a", "b", "d"]);
  });

  test("extracts line numbers correctly", async () => {
    const result = await extract(
      "\n\nfunction foo() {\n  return 1;\n}\n",
      "lines.ts"
    );
    const sym = result.symbols[0];
    assert.equal(sym.start_line, 3, "should be on line 3");
    assert.equal(sym.end_line, 5, "should end on line 5");
  });
});

// =============================================================================
// findOwner (tested indirectly through call edges)
// =============================================================================
describe("call edge ownership", () => {
  test("call inside function is attributed to that function", async () => {
    const result = await extract(
      "function caller() { return helper(); }\nfunction helper() { return 42; }",
      "ownership.js"
    );
    const callEdges = result.edges.filter(e => e.kind === "calls");
    assert.ok(callEdges.length > 0, "should have call edges");
    // The caller() function contains helper() call
    const srcLocalIds = callEdges.map(e => e.srcLocalId);
    // All calls should have a non-null owner
    assert.ok(srcLocalIds.every(id => id !== null));
  });
});
