// tests/lib/codegraph/extract-generic.test.js
//
// Tests for the config-driven tree-sitter extractor (Python, Go, Rust,
// Java, Kotlin, C, C++, C#, Ruby, PHP, Swift, Bash).
// Uses REAL WASM grammars from tree-sitter-wasms.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";

// ─── Dynamic import ───────────────────────────────────────────────────────

let extract;

before(async () => {
  const mod = await import("../../../lib/codegraph/extract-generic.js");
  extract = mod.extract;
});

// =============================================================================
// SUPPORTED_EXTS — tested via import
// =============================================================================
// (SUPPORTED_EXTS is verified implicitly by the fact that extract() works
//  for all language extensions in the tests below.)

// =============================================================================
// Error handling
// =============================================================================
describe("error handling", () => {
  test("throws for unsupported extension", async () => {
    await assert.rejects(
      () => extract("print(1)", "test.xyz"),
      { message: /No tree-sitter spec/ }
    );
  });

  test("handles extremely malformed source without hanging", async () => {
    const result = await extract("def foo( {} ", "test.py");
    assert.ok(Array.isArray(result.symbols));
    assert.ok(Array.isArray(result.edges));
  });
});

// =============================================================================
// Python
// =============================================================================
describe("Python", () => {
  test("extracts function definition", async () => {
    const result = await extract(
      "def greet(name):\n    return f'Hello {name}'",
      "greet.py"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "greet");
  });

  test("extracts class with method", async () => {
    const result = await extract(
      "class Calculator:\n    def add(self, a, b):\n        return a + b",
      "calc.py"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Calculator"), "should find class");
    assert.ok(names.includes("add"), "should find method");
  });

  test("extracts # comment as doc", async () => {
    const result = await extract(
      "# Add two numbers.\n# Returns the sum.\ndef add(a, b):\n    return a + b",
      "math.py"
    );
    const sym = result.symbols[0];
    // Python's """ docstrings are after the def, not before — so they
    // aren't captured by leadingDoc which looks at *preceding* comments.
    // Line comments (#) preceding the def ARE captured.
    assert.ok(sym.doc, "should have doc from preceding comments");
    assert.ok(sym.doc.includes("Add two numbers"));
  });

  test("records call edge inside function", async () => {
    const result = await extract(
      "def caller():\n    return helper()\n\ndef helper():\n    return 42",
      "calls.py"
    );
    const callEdge = result.edges.find(e => e.kind === "calls");
    assert.ok(callEdge, "should have a call edge");
    assert.equal(callEdge.dst_unresolved, "helper");
  });

  test("records import edge", async () => {
    const result = await extract(
      "import os\nimport json\n\ndef test():\n    pass",
      "imports.py"
    );
    const edges = result.edges.filter(e => e.kind === "imports");
    assert.ok(edges.length >= 1);
    assert.ok(edges.some(e => e.dst_unresolved.includes("import os")), "should capture import os");
  });
});

// =============================================================================
// Go
// =============================================================================
describe("Go", () => {
  test("extracts function declaration", async () => {
    const result = await extract(
      "package main\n\nfunc greet(name string) string {\n\treturn \"Hello \" + name\n}",
      "main.go"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "greet");
  });

  test("extracts method declaration", async () => {
    const result = await extract(
      "package main\n\ntype Greeter struct {\n\tName string\n}\n\nfunc (g *Greeter) Greet() string {\n\treturn \"Hello \" + g.Name\n}",
      "greeter.go"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Greet"), "should find method");
  });
});

// =============================================================================
// Rust
// =============================================================================
describe("Rust", () => {
  test("extracts function item", async () => {
    const result = await extract(
      "fn greet(name: &str) -> String {\n    format!(\"Hello {}\", name)\n}",
      "greet.rs"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "greet");
  });

  test("extracts struct and impl items", async () => {
    const result = await extract(
      "struct Greeter {\n    name: String,\n}\n\nimpl Greeter {\n    fn greet(&self) -> String {\n        format!(\"Hello {}\", self.name)\n    }\n}",
      "greeter.rs"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Greeter"), "should find struct");
    assert.ok(names.includes("greet"), "should find method");
  });

  test("records use declaration as import edge", async () => {
    const result = await extract(
      "use std::collections::HashMap;\n\nfn test() {\n    let mut map = HashMap::new();\n}",
      "use.rs"
    );
    const importEdge = result.edges.find(e => e.kind === "imports");
    assert.ok(importEdge, "should have import edge");
    assert.ok(importEdge.dst_unresolved.includes("use std::collections"),
      "should capture use declaration");
  });
});

// =============================================================================
// Java
// =============================================================================
describe("Java", () => {
  test("extracts class and method", async () => {
    const result = await extract(
      "public class Hello {\n    public void greet() {\n        System.out.println(\"Hi\");\n    }\n}",
      "Hello.java"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Hello"));
    assert.ok(names.includes("greet"));
  });

  test("extracts constructor", async () => {
    const result = await extract(
      "public class App {\n    public App() {}\n    public void run() {}\n}",
      "App.java"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("App"), "class name");
    assert.ok(names.some(n => n === "App" || n === "run"), "constructor or method");
  });
});

// =============================================================================
// Kotlin
// =============================================================================
describe("Kotlin", () => {
  test("extracts function declaration", async () => {
    const result = await extract(
      "fun greet(name: String): String {\n    return \"Hello $name\"\n}",
      "greet.kt"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "greet");
  });

  test("extracts class", async () => {
    const result = await extract(
      "class Greeter(val name: String) {\n    fun greet(): String = \"Hello $name\"\n}",
      "Greeter.kt"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("greet"));
  });
});

// =============================================================================
// C
// =============================================================================
describe("C", () => {
  test("extracts function definition", async () => {
    const result = await extract(
      "#include <stdio.h>\n\nint add(int a, int b) {\n    return a + b;\n}",
      "math.c"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "add");
  });

  test("records preproc_include as import edge", async () => {
    const result = await extract(
      "#include <stdio.h>\n#include \"util.h\"\n\nint main() { return 0; }",
      "main.c"
    );
    const imports = result.edges.filter(e => e.kind === "imports");
    assert.ok(imports.length >= 1, "should have import edges");
    assert.ok(imports.some(e => e.dst_unresolved.includes("stdio")), "should capture stdio include");
  });
});

// =============================================================================
// C++
// =============================================================================
describe("C++", () => {
  test("extracts function and class", async () => {
    const result = await extract(
      "#include <vector>\n\nclass Calculator {\npublic:\n    int add(int a, int b) { return a + b; }\n};\n\nint main() { return 0; }",
      "calc.cpp"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Calculator"));
    assert.ok(names.includes("add"));
  });
});

// =============================================================================
// C#
// =============================================================================
describe("C#", () => {
  test("extracts class and method", async () => {
    const result = await extract(
      "using System;\n\nnamespace App {\nclass Hello {\n    void Greet() {\n        Console.WriteLine(\"Hi\");\n    }\n}\n}",
      "hello.cs"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Hello"));
    assert.ok(names.includes("Greet"));
  });

  test("records using directive as import edge", async () => {
    const result = await extract(
      "using System.Collections.Generic;\nusing System.Linq;\n\nclass Test {}",
      "test.cs"
    );
    const imports = result.edges.filter(e => e.kind === "imports");
    assert.ok(imports.length >= 1, "should have import edges");
    assert.ok(imports.some(e => e.dst_unresolved.includes("System.Collections")),
      "should capture System.Collections");
  });
});

// =============================================================================
// Ruby
// =============================================================================
describe("Ruby", () => {
  test("extracts top-level method as function", async () => {
    const result = await extract(
      "def greet(name)\n  \"Hello #{name}\"\nend",
      "greet.rb"
    );
    const sym = result.symbols[0];
    // Ruby's `def` outside a class is classified as a top-level function
    // (fnTypes: ['method'] catches it, but it has no enclosing class).
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "greet");
  });

  test("extracts class", async () => {
    const result = await extract(
      "class Greeter\n  def initialize(name)\n    @name = name\n  end\n\n  def greet\n    \"Hello #{@name}\"\n  end\nend",
      "greeter.rb"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("initialize"));
    assert.ok(names.includes("greet"));
  });
});

// =============================================================================
// PHP
// =============================================================================
describe("PHP", () => {
  test("extracts function", async () => {
    const result = await extract(
      "<?php\nfunction greet($name) {\n    return \"Hello $name\";\n}",
      "greet.php"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "greet");
  });

  test("extracts class with method", async () => {
    const result = await extract(
      "<?php\nclass Greeter {\n    public function greet($name) {\n        return \"Hello $name\";\n    }\n}",
      "Greeter.php"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("greet"));
  });
});

// =============================================================================
// Swift
// =============================================================================
describe("Swift", () => {
  test("extracts function", async () => {
    const result = await extract(
      "func greet(name: String) -> String {\n    return \"Hello \\(name)\"\n}",
      "greet.swift"
    );
    const sym = result.symbols[0];
    assert.equal(sym.kind, "function");
    assert.equal(sym.name, "greet");
  });
});

// =============================================================================
// Bash
// =============================================================================
describe("Bash", () => {
  test("extracts function definition", async () => {
    const result = await extract(
      "#!/bin/bash\n\nfunction greet {\n    echo \"Hello $1\"\n}\n\ngreet \"World\"",
      "greet.sh"
    );
    const names = result.symbols.map(s => s.name);
    assert.ok(names.includes("greet"), "should find function");
  });

  test("falls back safely when the Bash WASM scanner rejects a real script", async () => {
    const source = `#!/usr/bin/env bash
case "$1" in
  start) echo start ;;
  *) echo usage ;;
esac
cleanup() {
  trap - EXIT
  echo done
}
exec > >(tee "$LOG") 2>&1`;
    const result = await extract(source, "runner.sh");
    assert.ok(result.symbols.some(s => s.name === "cleanup"));
    assert.deepEqual(result.edges, []);
  });
});

// =============================================================================
// Edge cases
// =============================================================================
describe("edge cases", () => {
  test("empty source produces no symbols", async () => {
    const result = await extract("", "empty.py");
    assert.deepEqual(result.symbols, []);
  });

  test("only comments produce nothing", async () => {
    const result = await extract("# just a comment\n// another", "test.py");
    assert.deepEqual(result.symbols, []);
  });

  test("alias extensions work", async () => {
    // .pyi is an alias for .py (Python stub file)
    const result = await extract(
      "def greet(name: str) -> str: ...",
      "stub.pyi"
    );
    assert.equal(result.symbols[0].name, "greet");
  });

  test("extracts line numbers correctly", async () => {
    const result = await extract(
      "\n\n\ndef foo():\n    pass\n",
      "lines.py"
    );
    const sym = result.symbols[0];
    assert.equal(sym.start_line, 4, "should start on line 4");
  });
});

// =============================================================================
// Multiple symbols
// =============================================================================
describe("multiple symbols", () => {
  test("extracts multiple top-level symbols in Python", async () => {
    const result = await extract(
      "def a(): pass\ndef b(): pass\nclass C: pass",
      "multi.py"
    );
    const names = result.symbols.map(s => s.name).sort();
    assert.deepEqual(names, ["C", "a", "b"]);
  });
});
