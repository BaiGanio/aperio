import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeCliEmitter } from "../../lib/emitters/cliEmitter.js";

/**
 * Drive the emitter through a full turn and capture everything written to
 * stdout. The answer is buffered from `token` events and rendered on `stream_end`.
 */
function renderAnswer(answer) {
  let buf = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { buf += s; return true; };
  try {
    const e = makeCliEmitter(() => {});
    e.send({ type: "stream_start" });
    e.send({ type: "token", text: answer });
    e.send({ type: "stream_end", usage: {} });
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

const GREEN = "\x1b[32m"; // hljs keyword
const BLUE  = "\x1b[34m"; // hljs title
const CYAN  = "\x1b[36m";

describe("cliEmitter code-block highlighting", () => {
  test("highlights a fenced block in a supported language", () => {
    const out = renderAnswer("```js\nconst x = 1; // hi\n```");
    // keyword + comment get hljs colors, not flat cyan
    assert.ok(out.includes(GREEN), "expected green keyword span");
    assert.ok(out.includes("┌─"), "expected code-block border");
    assert.ok(out.includes("│"), "expected gutter");
  });

  test("resolves hljs aliases (js, py, sh, html)", () => {
    for (const lang of ["js", "py", "sh", "html"]) {
      const out = renderAnswer(`\`\`\`${lang}\nx\n\`\`\``);
      assert.ok(out.includes("┌─"), `border for ${lang}`);
    }
  });

  test("falls back to flat cyan for unsupported languages", () => {
    const out = renderAnswer("```rust\nlet y = 2;\n```");
    assert.ok(out.includes(`${CYAN}let y = 2;`), "expected flat cyan line");
    assert.ok(!out.includes(BLUE), "no hljs title color in fallback");
  });

  test("falls back to flat cyan when no language is given", () => {
    const out = renderAnswer("```\nplain text\n```");
    assert.ok(out.includes(`${CYAN}plain text`), "expected flat cyan line");
  });

  test("preserves line count inside the gutter", () => {
    const out = renderAnswer("```python\ndef f(x):\n    return x + 1\n# end\n```");
    const gutterLines = out.split("\n").filter(l => l.includes("│"));
    assert.equal(gutterLines.length, 3, "three code lines wrapped in the gutter");
  });
});
