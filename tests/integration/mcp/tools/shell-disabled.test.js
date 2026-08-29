// tests/integration/mcp/tools/shell-disabled.test.js
//
// run_node_script and run_python_script must refuse on the very first line
// of their handler when APERIO_ENABLE_SHELL is unset — same boundary
// run_shell already enforces, closing the host-execution bypass where a
// script could run even with shell access fully disabled. Kept in its own
// file/process: shell.js reads APERIO_ENABLE_SHELL into a module-level
// const at import time, so the enabled-path tests in shell.test.js must not
// share a process with this disabled-path check.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { installMemfs } from "../../../helpers/memfs.js";

const mem = installMemfs({ root: "/mem/shell-disabled" });

delete process.env.APERIO_ENABLE_SHELL;

const { setAllowlist } = await import("../../../../lib/routes/paths.js");
await setAllowlist([mem.root]);

const shell = await import("../../../../mcp/tools/shell.js");

after(() => mem.restore());

describe("run_node_script / run_python_script with APERIO_ENABLE_SHELL unset", () => {
  test("runNodeScriptHandler refuses before touching the filesystem", async () => {
    const r = await shell.runNodeScriptHandler({ script: "/mem/shell-disabled/nonexistent.js" });
    assert.match(r.content[0].text, /run_node_script is disabled.*APERIO_ENABLE_SHELL=1/);
  });

  test("runPythonScriptHandler refuses before touching the filesystem", async () => {
    const r = await shell.runPythonScriptHandler({ script: "/mem/shell-disabled/nonexistent.py" });
    assert.match(r.content[0].text, /run_python_script is disabled.*APERIO_ENABLE_SHELL=1/);
  });
});
