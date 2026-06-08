// tests/mcp/tools/shell.test.js
//
// Integration-style tests: creates real temp files so fs.existsSync, path
// resolution, and node --check work naturally.  The shell.js handlers
// control programs via spawn() which runs real node/python3 — scripts
// are designed to exit 0 quickly.
//
// Node.js v26 uses internal slots (not module.exports) for ESM → CJS
// built-in module bindings, which makes mock.method() on fs/child_process
// invisible to ESM imports.  Integration testing is the reliable approach.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setAllowlist } from "../../../lib/routes/paths.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "aperio-shell-"));

// Temp helpers
function tmpPath(name) { return join(tmpRoot, name); }
function writeTmp(name, content) { writeFileSync(tmpPath(name), content, "utf-8"); return tmpPath(name); }

// ─── Setup: register /tmp as allowed, enable shell ───────────────────────────
await setAllowlist([tmpRoot]);
process.env.APERIO_ENABLE_SHELL = "1";

const shell = await import("../../../mcp/tools/shell.js");

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

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
    const r = await shell.runShellHandler({ command: "node --version", cwd: tmpRoot });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
  });

  test("allows wc in a pipe", async () => {
    const r = await shell.runShellHandler({ command: "ls | wc -l", cwd: tmpRoot });
    assert.ok(r.content[0].text.includes("✅ Exit 0"), r.content[0].text);
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
    const r = await shell.syntaxCheckHandler({ path: goodScript });
    assert.ok(r.content[0].text.includes("✅ Syntax OK"));
  });

  test("invalid syntax", async () => {
    const r = await shell.syntaxCheckHandler({ path: badScript });
    assert.ok(r.content[0].text.includes("❌ Syntax errors"));
  });
});
