// tests/unit/public/mermaid-labels.test.js
//
// A plan's architecture diagram rendered as raw source instead of a picture.
// The cause was not our renderer: the model wrote
// `C[Message Queue (e.g., RabbitMQ/SQS)]`, and mermaid's flowchart grammar
// rejects a bracket inside a BARE node label. Quoting the label parses.
//
// The breaking set — ( ) [ ] { } | — and the fact that quoting rescues all of
// them were measured against mermaid 11.12.0 in a real browser, in every node
// shape. These tests pin the repair and, just as importantly, the shapes the
// repair must leave alone: [(cylinder)], ((circle)) and {{hexagon}} are shapes,
// and quoting one would flatten it back to a plain box.
//
// markdown.js is a plain browser script with no exports, so it is evaluated in
// a vm context with a stub window rather than imported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../../public/scripts/markdown.js"), "utf8");

const sandbox = {
  window: { addEventListener() {}, Prism: null, mermaid: null },
  document: { addEventListener() {}, querySelectorAll: () => [] },
  console,
  queueMicrotask,
  setTimeout,
};
const ctx = createContext(sandbox);
runInContext(source, ctx);
const normalize = ctx.normalizeMermaidSource;

test("a bracket inside a bare label is quoted so mermaid can parse it", () => {
  const out = normalize("flowchart TD\n  B --> C[Message Queue (e.g., RabbitMQ/SQS)];");
  assert.match(out, /C\["Message Queue \(e\.g\., RabbitMQ\/SQS\)"\];/);
});

test("a pipe inside a bare label is quoted too", () => {
  assert.match(normalize("flowchart LR\n  A[Read | Write] --> B[Done]"), /A\["Read \| Write"\]/);
});

test("every node shape gets the same repair", () => {
  assert.match(normalize("flowchart TD\n  A(Call foo(x)) --> B[Two]"), /A\("Call foo\(x\)"\)/);
  assert.match(normalize("flowchart TD\n  A{Ready (yes)} --> B[Two]"), /A\{"Ready \(yes\)"\}/);
});

test("a label with nothing mermaid chokes on is left exactly as written", () => {
  const plain = "flowchart TD\n  A[User Sends Email] --> B[Worker Service]";
  assert.equal(normalize(plain), plain);
});

test("an already-quoted label is not quoted twice", () => {
  const quoted = 'flowchart TD\n  A["Queue (x)"] --> B[Two]';
  assert.equal(normalize(quoted), quoted);
});

test("cylinder, circle and hexagon stay shapes rather than becoming boxes", () => {
  for (const shape of ["A[(User DB)] --> B[App]", "A((Start)) --> B[App]", "A{{Decide}} --> B[App]"]) {
    const diagram = `flowchart TD\n  ${shape}`;
    assert.equal(normalize(diagram), diagram, shape);
  }
});

test("edge labels and subgraphs are untouched", () => {
  const edges = "flowchart TD\n  A -->|yes| B\n  A -->|no| C";
  assert.equal(normalize(edges), edges);
  const sub = 'flowchart TD\n  subgraph S["My Group"]\n    A[One] --> B[Two]\n  end';
  assert.equal(normalize(sub), sub);
});

test("only flowcharts are touched — other diagram types have their own grammar", () => {
  const seq = "sequenceDiagram\n  Alice->>John: Hello John, how are you?\n  John-->>Alice: Great!";
  assert.equal(normalize(seq), seq);
  const cls = "classDiagram\n  class Bank {\n    +deposit(amount)\n  }";
  assert.equal(normalize(cls), cls);
});

test("the `graph` keyword is repaired as well as `flowchart`", () => {
  assert.match(normalize("graph TD\n  A[Call foo(bar)] --> B[Two]"), /A\["Call foo\(bar\)"\]/);
});

test("a quote inside a label cannot break out of the quoting", () => {
  const out = normalize('flowchart TD\n  A[Say "hi" (now)] --> B[Two]');
  assert.match(out, /A\["Say &quot;hi&quot; \(now\)"\]/);
});
