// tests/mcp/tools/shell.test.js
//
// Zero real disk access and zero real subprocesses. Strategy:
//   • In-memory fs (installMemfs) so existsSync / path checks operate on an
//     in-RAM map — no temp scripts are ever written to the machine.
//   • Mock child_process.spawn (same approach as validateWrittenFile.test.js)
//     to return a fake child that emits configurable stdout/stderr + exit code,
//     so the handlers' validation, output formatting, and exit handling are
//     exercised without launching node/python3/sh.
//
// IMPORTANT: install the fs + spawn mocks BEFORE importing paths.js / shell.js.
// Node creates a builtin module's ESM facade (snapshotting its named exports) on
// the first `import from "<builtin>"`; patching first makes the named imports in
// shell.js bind to our mocks.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { createRequire } from "node:module";
import { installMemfs } from "../../../helpers/memfs.js";

const mem = installMemfs({ root: "/mem/shell" });

// ─── Mocked spawn ─────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const cp = require("child_process");

function createMockChild({ exitCode = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

let _spawnImpl = () => createMockChild({ exitCode: 0 });
const { mock } = await import("node:test");
mock.method(cp, "spawn", (...args) => _spawnImpl(...args));

// ─── Setup: register the in-memory root as allowed, enable shell ─────────────
const { setAllowlist } = await import("../../../../lib/routes/paths.js");
await setAllowlist([mem.root]);
process.env.APERIO_ENABLE_SHELL = "1";

const shell = await import("../../../../mcp/tools/shell.js");

after(() => mem.restore());

// Temp helpers (in-memory)
function tmpPath(name) { return join(mem.root, name); }
function writeTmp(name, content) { return mem.writeFile(tmpPath(name), content); }

// =============================================================================
// runNodeScriptHandler
// =============================================================================

describe("runNodeScriptHandler", () => {
  const script = writeTmp("test.js", "console.log('hello from node');\n");

  test("rejects non-.js file", async () => {
    const r = await shell.runNodeScriptHandler({ script: "/nonexistent/script.py" });
    assert.ok(r.content[0].text.includes(".js"));
  });

  test("rejects path outside write allowlist", async () => {
    const r = await shell.runNodeScriptHandler({ script: "/etc/passwd.js" });
    assert.ok(r.content[0].text.includes("not allowed"));
  });

  test("rejects missing script", async () => {
    const r = await shell.runNodeScriptHandler({ script: tmpPath("ghost.js") });
    assert.ok(r.content[0].text.includes("not found"));
  });

  test("executes and returns output", async () => {
    _spawnImpl = () => createMockChild({ exitCode: 0, stdout: "hello from node" });
    const r = await shell.runNodeScriptHandler({ script, args: ["hello"] });
    assert.ok(r.content[0].text.includes("✅ Exit 0"));
    assert.ok(r.content[0].text.includes("hello from node"));
  });
});

// =============================================================================
// runPythonScriptHandler
// =============================================================================

describe("runPythonScriptHandler", () => {
  const script = writeTmp("test.py", "print('hello from python')\n");

  test("rejects non-.py file", async () => {
    const r = await shell.runPythonScriptHandler({ script: "/nonexistent/script.js" });
    assert.ok(r.content[0].text.includes(".py"));
  });

  test("rejects path outside write allowlist", async () => {
    const r = await shell.runPythonScriptHandler({ script: "/etc/passwd.py" });
    assert.ok(r.content[0].text.includes("not allowed"));
  });

  test("rejects missing script", async () => {
    const r = await shell.runPythonScriptHandler({ script: tmpPath("ghost.py") });
    assert.ok(r.content[0].text.includes("not found"));
  });

  test("executes and returns output", async () => {
    _spawnImpl = () => createMockChild({ exitCode: 0, stdout: "hello from python" });
    const r = await shell.runPythonScriptHandler({ script });
    assert.ok(r.content[0].text.includes("✅ Exit 0"));
    assert.ok(r.content[0].text.includes("hello from python"));
  });
});

// =============================================================================
// runShellHandler
// =============================================================================

describe("runShellHandler", () => {
  test("rejects empty command", async () => {
    const r = await shell.runShellHandler({ command: "" });
    assert.ok(r.content[0].text.includes("No command"));
  });

  test("rejects banned operator", async () => {
    const r = await shell.runShellHandler({ command: "ls; rm" });
    assert.ok(r.content[0].text.includes("Shell operator"));
  });

  test("rejects disallowed command", async () => {
    const r = await shell.runShellHandler({ command: "sudo rm" });
    assert.ok(r.content[0].text.includes("Command not allowed"));
  });

  test("rejects quoted program name", async () => {
    const r = await shell.runShellHandler({ command: "'node' --version" });
    assert.ok(r.content[0].text.includes("program name"));
  });

  test("rejects empty pipe segment", async () => {
    const r = await shell.runShellHandler({ command: "ls || rm" });
    assert.ok(r.content[0].text.includes("Empty command segment"));
  });

  test("rejects disallowed cwd", async () => {
    const r = await shell.runShellHandler({ command: "ls", cwd: "/etc" });
    assert.ok(r.content[0].text.includes("not allowed"));
  });

  test("executes allowed command", async () => {
    _spawnImpl = () => createMockChild({ exitCode: 0, stdout: "v26.0.0" });
    const r = await shell.runShellHandler({ command: "node --version", cwd: mem.root });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
  });

  test("allows wc in a pipe", async () => {
    _spawnImpl = () => createMockChild({ exitCode: 0, stdout: "0" });
    const r = await shell.runShellHandler({ command: "ls | wc -l", cwd: mem.root });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
  });
});

// =============================================================================
// runShellHandler — SHELL-01 argument boundary
// =============================================================================

describe("runShellHandler SHELL-01 boundary", () => {
  const ok = () => { _spawnImpl = () => createMockChild({ exitCode: 0, stdout: "ok" }); };

  // ── Rejected: the documented bypasses ──────────────────────────────────────
  test("rejects node inline eval (-e)", async () => {
    const r = await shell.runShellHandler({ command: 'node -e "process.exit(0)"', cwd: mem.root });
    assert.ok(r.content[0].text.includes("inline-code flag"), r.content[0].text);
  });

  test("rejects node combined -pe", async () => {
    const r = await shell.runShellHandler({ command: 'node -pe "1+1"', cwd: mem.root });
    assert.ok(r.content[0].text.includes("inline-code flag"), r.content[0].text);
  });

  test("rejects python3 inline eval (-c)", async () => {
    const r = await shell.runShellHandler({ command: 'python3 -c "import os"', cwd: mem.root });
    assert.ok(r.content[0].text.includes("inline-code flag"), r.content[0].text);
  });

  test("rejects find -exec", async () => {
    const r = await shell.runShellHandler({ command: "find . -type f -exec rm {} +", cwd: mem.root });
    assert.ok(r.content[0].text.includes('find "-exec"'), r.content[0].text);
  });

  test("rejects git -c config override", async () => {
    const r = await shell.runShellHandler({ command: "git -c core.pager=evil log", cwd: mem.root });
    assert.ok(r.content[0].text.includes('git "-c"'), r.content[0].text);
  });

  test("rejects non-read-only git subcommand", async () => {
    const r = await shell.runShellHandler({ command: "git push origin main", cwd: mem.root });
    assert.ok(r.content[0].text.includes("only read-only git"), r.content[0].text);
  });

  test("rejects cat of a file outside the allowlist", async () => {
    const r = await shell.runShellHandler({ command: "cat /etc/passwd", cwd: mem.root });
    assert.ok(r.content[0].text.includes("not in an allowed read path"), r.content[0].text);
  });

  test("rejects reading a tilde path outside the allowlist", async () => {
    const r = await shell.runShellHandler({ command: "cat ~/.ssh/id_rsa", cwd: mem.root });
    assert.ok(r.content[0].text.includes("not in an allowed read path"), r.content[0].text);
  });

  test("rejects node script outside the allowlist", async () => {
    const r = await shell.runShellHandler({ command: "node /tmp/evil.js", cwd: mem.root });
    assert.ok(r.content[0].text.includes("not in an allowed path"), r.content[0].text);
  });

  test("curl is no longer allowlisted", async () => {
    const r = await shell.runShellHandler({ command: "curl http://attacker.tld", cwd: mem.root });
    assert.ok(r.content[0].text.includes("Command not allowed"), r.content[0].text);
  });

  // ── Still permitted: the legitimate workflows ──────────────────────────────
  test("allows running a script file inside the allowlist", async () => {
    ok();
    const r = await shell.runShellHandler({ command: `node ${join(mem.root, "script.js")}`, cwd: mem.root });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
  });

  test("allows grep of a file inside the allowlist", async () => {
    ok();
    const r = await shell.runShellHandler({ command: `grep foo ${join(mem.root, "file.txt")}`, cwd: mem.root });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
  });

  test("allows a read-only git subcommand", async () => {
    ok();
    const r = await shell.runShellHandler({ command: "git log --oneline", cwd: mem.root });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
  });

  test("allows the skill workflow: node script piped to a quoted grep pattern", async () => {
    ok();
    const r = await shell.runShellHandler({
      command: `node ${join(mem.root, "read.js")} out.pptx | grep -iE "lorem|ipsum" out.pptx`,
      cwd: mem.root,
    });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
  });

  test("allows node --version (no script arg, no eval)", async () => {
    ok();
    const r = await shell.runShellHandler({ command: "node --version", cwd: mem.root });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
  });
});

// =============================================================================
// makeTailBiasedSink (#3 — tail-biased output cap)
// =============================================================================

describe("makeTailBiasedSink", () => {
  test("returns the whole stream untouched when it fits", () => {
    const s = shell.makeTailBiasedSink(10, 20);
    s.push(Buffer.from("hello world")); // 11 bytes <= 30
    assert.equal(s.toString(), "hello world");
    assert.equal(s.bytes, 11);
  });

  test("keeps head + tail and drops the middle once over cap", () => {
    const s = shell.makeTailBiasedSink(8, 12); // cap = 20
    s.push(Buffer.from("HEADHEAD" + "x".repeat(100) + "TAILTAILTAIL"));
    const out = s.toString();
    assert.match(out, /^HEADHEAD/, "keeps the head");
    assert.match(out, /TAILTAILTAIL$/, "keeps the tail verdict");
    assert.match(out, /omitted to fit context/, "marks the omission");
    assert.ok(!out.includes("x".repeat(50)), "drops the middle");
    assert.equal(s.bytes, 8 + 100 + 12);
  });

  test("tail survives across many small chunks with bounded memory", () => {
    const s = shell.makeTailBiasedSink(8, 12);
    for (let i = 0; i < 1000; i++) s.push(Buffer.from("ab"));
    s.push(Buffer.from("VERDICT_END!"));
    const out = s.toString();
    assert.match(out, /^abababab/, "head is the first bytes seen");
    assert.match(out, /VERDICT_END!$/, "tail is the last bytes seen");
    assert.match(out, /omitted to fit context/);
  });

  test("a single oversized chunk is still tail-trimmed", () => {
    const s = shell.makeTailBiasedSink(4, 6);
    s.push(Buffer.from("HEAD" + "z".repeat(1000) + "ENDEND"));
    const out = s.toString();
    assert.match(out, /^HEAD/);
    assert.match(out, /ENDEND$/);
  });
});

// =============================================================================
// runShellHandler output capping (#3 — verdict at the tail survives)
// =============================================================================

describe("runShellHandler tail-biased output", () => {
  test("keeps the tail verdict when stdout exceeds the cap", async () => {
    const big = "BUILD_START\n" + "noise\n".repeat(60000) + "BUILD FAILED: 3 errors\n";
    _spawnImpl = () => createMockChild({ exitCode: 1, stdout: big });
    const r = await shell.runShellHandler({ command: "node build.js", cwd: mem.root });
    const text = r.content[0].text;
    assert.match(text, /BUILD_START/, "head retained");
    assert.match(text, /BUILD FAILED: 3 errors/, "tail verdict reaches the model");
    assert.match(text, /omitted to fit context/, "omission marked");
  });
});

// =============================================================================
// syntaxCheckHandler
// =============================================================================

describe("syntaxCheckHandler", () => {
  const goodScript = writeTmp("good.js", "const x = 42;\nmodule.exports = x;\n");
  const badScript  = writeTmp("bad.js", "const x = ;\n");

  test("rejects non-JS file", async () => {
    const r = await shell.syntaxCheckHandler({ path: "/nonexistent/file.py" });
    assert.ok(r.content[0].text.includes(".js"));
  });

  test("rejects disallowed read path", async () => {
    const r = await shell.syntaxCheckHandler({ path: "/nonexistent/no-access-file.js" });
    assert.ok(r.content[0].text.includes("not in allowed read path"), `Got: ${r.content[0].text}`);
  });

  test("rejects missing file", async () => {
    const r = await shell.syntaxCheckHandler({ path: tmpPath("ghost.js") });
    assert.ok(r.content[0].text.includes("not found"));
  });

  test("valid syntax", async () => {
    _spawnImpl = () => createMockChild({ exitCode: 0 });
    const r = await shell.syntaxCheckHandler({ path: goodScript });
    assert.ok(r.content[0].text.includes("✅ Syntax OK"));
  });

  test("invalid syntax", async () => {
    _spawnImpl = () => createMockChild({ exitCode: 1, stderr: "SyntaxError: Unexpected token ';'" });
    const r = await shell.syntaxCheckHandler({ path: badScript });
    assert.ok(r.content[0].text.includes("❌ Syntax errors"));
  });
});
