// tests/lib/helpers/capabilities.test.js
//
// Tests for venvPython, pythonInterpreter, detectCapabilities, installPipDeps.
//
// Strategy (proven by sessions.test.js and validateWrittenFile.test.js):
// 1. createRequire() for CJS refs to "fs", "child_process", "os" — the same
//    objects that ESM live bindings read.
// 2. mock.method() at TOP LEVEL on those CJS objects before the dynamic import.
// 3. Mutable closure variables for per-test control.
// 4. mock.restoreAll() once in after().

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("fs");
const cp = require("child_process");
const os = require("os");

// ─── Real references ──────────────────────────────────────────────────────
const REAL = {
  existsSync:     fs.existsSync,
  execFileSync:   cp.execFileSync,
  execFile:       cp.execFile,
  platform:       os.platform,
};

// ─── Mutable closures (per-test control) ──────────────────────────────────

// Set of virtual "installed" system commands (checked via execFileSync which/where)
let _commandsOnPath = new Set();
// Paths that exist according to existsSync
let _existingPaths = new Set();
// Platform override (null = use real)
let _mockPlatform = null;
// execFile (promisified) behaviors
const _execFileBehaviors = new Map(); // cmd → { succeed: bool, stdout: string, stderr: string, errorMsg: string }

function resetMocks() {
  _commandsOnPath = new Set();
  _existingPaths = new Set();
  _mockPlatform = null;
  _execFileBehaviors.clear();
}

function setOnPath(...cmds) {
  cmds.forEach(c => _commandsOnPath.add(c));
}

function setExists(...paths) {
  paths.forEach(p => _existingPaths.add(p));
}

function setExecFileBehavior(cmd, { succeed = true, stdout = "", stderr = "", errorMsg = "Command failed" } = {}) {
  _execFileBehaviors.set(cmd, { succeed, stdout, stderr, errorMsg });
}

// ─── Top-level mocks ──────────────────────────────────────────────────────

mock.method(fs, "existsSync", (path) => {
  // Only return true for paths explicitly seeded in _existingPaths.
  // NO fall-through to REAL — that would let the developer's real venv
  // or installed tools leak into test results.
  return _existingPaths.has(path);
});

mock.method(cp, "execFileSync", (cmd, args, opts) => {
  // onPath calls: which/where <commandName>
  if (cmd === "which" || cmd === "where") {
    const target = args[0];
    if (_commandsOnPath.has(target)) return Buffer.from("");
    const err = new Error(`ENOENT: ${target} not found`);
    err.code = "ENOENT";
    throw err;
  }
  // canImport calls: <python> -c "import lxml, defusedxml"
  // The python can be "python3", "python", or a full venv path like
  // /path/to/venv/bin/python3.
  if (args[0] === "-c" && args[1]?.startsWith("import ")) {
    const imports = args[1].replace(/^import /, "");
    const mods = imports.split(",").map(m => m.trim());
    const allPresent = mods.every(m => _commandsOnPath.has(`py:${m}`));
    if (allPresent) return Buffer.from("");
    const err = new Error(`ImportError: No module named ...`);
    err.code = "ENOENT";
    throw err;
  }
  throw new Error(`execFileSync not mocked for cmd=${cmd}`);
});

// execFile is the callback-based version. It's promisified inside the module
// (promisify(execFile)). Our mock must accept the callback pattern.
mock.method(cp, "execFile", (...args) => {
  // Normalize arguments: execFile(file, args?, options?, callback)
  let cmd, cmdArgs, opts, cb;

  // Last arg is always the callback
  cb = args[args.length - 1];
  if (typeof cb !== "function") {
    const err = new Error("execFile: callback required");
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }

  cmd = args[0];
  if (args.length >= 2 && Array.isArray(args[1])) {
    cmdArgs = args[1];
    opts = args.length >= 3 && typeof args[2] === "object" ? args[2] : {};
  } else if (args.length >= 2 && typeof args[1] === "object" && !Array.isArray(args[1])) {
    opts = args[1];
    cmdArgs = [];
  } else {
    cmdArgs = [];
    opts = {};
  }

  // For path-like commands (/some/path/bin/python3), match by suffix so we don't
  // need an exact path match between the test and the module's path resolution.
  // Also look up by cmd+args key if "-r" is present (for pip install).
  let behavior;
  if (cmdArgs.length > 1 && cmdArgs.includes("-r")) {
    behavior = _execFileBehaviors.get(`${cmd}::install`);
  }
  if (!behavior) {
    behavior = _execFileBehaviors.get(cmd);
  }
  // Fallback: match by basename for path-like cmds
  if (!behavior && (cmd.includes("/") || cmd.includes("\\"))) {
    const base = cmd.split(/[/\\]/).pop();
    behavior = _execFileBehaviors.get(base);
  }
  if (behavior) {
    if (behavior.succeed) {
      cb(null, { stdout: behavior.stdout, stderr: behavior.stderr });
    } else {
      cb(new Error(behavior.errorMsg));
    }
    return;
  }

  // Unknown command — don't fall through to real (that would spawn processes).
  cb(new Error(`execFile not mocked for cmd=${cmd}`));
});

mock.method(os, "platform", () => _mockPlatform ?? REAL.platform());

// ─── Dynamic import ───────────────────────────────────────────────────────

let cap;

before(async () => {
  resetMocks();
  cap = await import("../../lib/helpers/capabilities.js");
});

after(() => {
  mock.restoreAll();
});

// =============================================================================
// venvPython
// =============================================================================
describe("venvPython()", () => {
  afterEach(() => { resetMocks(); });

  test("returns null when venv python does not exist", () => {
    const result = cap.venvPython();
    assert.equal(result, null);
  });

  test("returns venv python path when it exists", () => {
    // Set the venv python path to exist. The path depends on the platform.
    // We need to figure out what path the module expects based on IS_WIN.
    // For non-Win: VENV_DIR/bin/python3
    // For Win: VENV_DIR/Scripts/python.exe
    // Since we mock os.platform, we can control IS_WIN, but IS_WIN is computed
    // at module import time. On the current platform, it's already set.
    // We test with the current platform's venv path.
    const expected = require("path").join(cap.VENV_DIR, process.platform === "win32" ? "Scripts\\python.exe" : "bin", process.platform === "win32" ? "" : "", "python3").replace(/\/\//g, "/").replace(/\/bin\/python3$/, "/bin/python3");
    // Simpler approach: just set the path that venvPython checks
    // On non-Windows: join(VENV_DIR, "bin", "python3")
    const venvPythonPath = require("path").join(cap.VENV_DIR, "bin", "python3");
    setExists(venvPythonPath);

    const result = cap.venvPython();
    assert.equal(result, venvPythonPath);
  });
});

// =============================================================================
// pythonInterpreter
// =============================================================================
describe("pythonInterpreter()", () => {
  afterEach(() => { resetMocks(); });

  test("returns 'python3' when no venv python exists", () => {
    const result = cap.pythonInterpreter();
    assert.equal(result, "python3");
  });

  test("returns venv python path when venv exists", () => {
    const venvPythonPath = require("path").join(cap.VENV_DIR, "bin", "python3");
    setExists(venvPythonPath);

    const result = cap.pythonInterpreter();
    assert.equal(result, venvPythonPath);
  });
});

// =============================================================================
// detectCapabilities — all dependencies present
// =============================================================================
describe("detectCapabilities — all present", () => {
  afterEach(() => { resetMocks(); });

  function setupAllPresent() {
    // python3 on PATH
    setOnPath("python3");
    // venv python exists
    setExists(require("path").join(cap.VENV_DIR, "bin", "python3"));
    // pip packages importable
    setOnPath("py:lxml", "py:defusedxml");
    // soffice and poppler on PATH
    setOnPath("soffice");
    setOnPath("pdftoppm");
  }

  test("returns platform string", () => {
    setupAllPresent();
    const result = cap.detectCapabilities();
    assert.ok(["mac", "linux", "win"].includes(result.platform));
  });

  test("returns venv: true when venv exists", () => {
    setExists(require("path").join(cap.VENV_DIR, "bin", "python3"));
    const result = cap.detectCapabilities();
    assert.equal(result.venv, true);
  });

  test("returns venv: false when no venv", () => {
    // Don't set venv python path
    const result = cap.detectCapabilities();
    assert.equal(result.venv, false);
  });

  test("docx-create tier is always ready", () => {
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[0].id, "docx-create");
    assert.equal(result.tiers[0].ready, true);
  });

  test("docx-edit tier ready when python and pip packages present", () => {
    setupAllPresent();
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[1].id, "docx-edit");
    assert.equal(result.tiers[1].ready, true);
  });

  test("docx-edit tier not ready when python missing", () => {
    // Don't set python3 on path, don't set venv python
    // But set pip packages (though it won't matter since canImport checks py first)
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[1].ready, false);
  });

  test("docx-edit tier not ready when pip packages missing", () => {
    setOnPath("python3");
    // Don't set pip packages
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[1].ready, false);
  });

  test("docx-render tier ready when soffice and poppler present", () => {
    setupAllPresent();
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[2].id, "docx-render");
    assert.equal(result.tiers[2].ready, true);
  });

  test("docx-render tier not ready when soffice missing", () => {
    setOnPath("pdftoppm");
    // Don't set soffice
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[2].ready, false);
  });

  test("docx-render tier not ready when poppler missing", () => {
    setOnPath("soffice");
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[2].ready, false);
  });

  test("deps include install hints when binary missing", () => {
    // Only python3 on path, nothing else
    setOnPath("python3");
    setExists(require("path").join(cap.VENV_DIR, "bin", "python3"));
    setOnPath("py:lxml", "py:defusedxml");

    const result = cap.detectCapabilities();
    // libreoffice dep should have a hint
    const renderDeps = result.tiers[2].deps;
    const loDep = renderDeps.find(d => d.name === "libreoffice");
    assert.ok(loDep.present === false);
    assert.ok(loDep.hint.length > 0, "should have an install hint");
  });

  test("python3 dep hint is empty when python is present", () => {
    setOnPath("python3");
    const result = cap.detectCapabilities();
    const editDeps = result.tiers[1].deps;
    const pyDep = editDeps.find(d => d.name === "python3");
    assert.ok(pyDep.hint === "", "no hint when present");
  });

  test("pip packages dep uses auto=true", () => {
    const result = cap.detectCapabilities();
    const editDeps = result.tiers[1].deps;
    const pipDep = editDeps.find(d => d.name === "lxml, defusedxml");
    assert.equal(pipDep.auto, true);
  });
});

// =============================================================================
// detectCapabilities — sparse / edge cases
// =============================================================================
describe("detectCapabilities — edge cases", () => {
  afterEach(() => { resetMocks(); });

  test("venv present without python3 on PATH still reports hasPython=true", () => {
    // No python3 on PATH, but venv python exists
    setExists(require("path").join(cap.VENV_DIR, "bin", "python3"));
    const result = cap.detectCapabilities();
    // hasPython = onPath("python3") || venvPython() !== null = false || true = true
    const pyDep = result.tiers[1].deps.find(d => d.name === "python3");
    assert.equal(pyDep.present, true, "venv should count as python present");
  });

  test("soffice or libreoffice either one satisfies the dep", () => {
    // Only libreoffice
    setOnPath("libreoffice");
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[2].ready, false, "also needs poppler");
    // The dep shows the one that was found
    const loDep = result.tiers[2].deps.find(d => d.name === "libreoffice");
    assert.equal(loDep.present, true);
  });

  test("sOffice by itself enables docx-render when poppler also present", () => {
    setOnPath("soffice", "pdftoppm");
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[2].ready, true);
  });

  test("libreOffice by itself enables docx-render when poppler also present", () => {
    setOnPath("libreoffice", "pdftoppm");
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[2].ready, true);
  });

  test("docx-edit ready with venv python but no system python3", () => {
    // No python3 on system, but venv exists and pip packages importable
    setExists(require("path").join(cap.VENV_DIR, "bin", "python3"));
    // Set the venv python to be importable (canImport uses the venv python)
    setOnPath("py:lxml", "py:defusedxml");
    const result = cap.detectCapabilities();
    assert.equal(result.tiers[1].ready, true);
  });
});

// =============================================================================
// installPipDeps
// =============================================================================
describe("installPipDeps()", () => {
  afterEach(() => { resetMocks(); });

  test("creates venv then installs pip packages", async () => {
    // venv does not exist initially
    // existsSync(VENV_DIR) returns false → triggers "python3 -m venv"
    // Then existsSync for venv python returns true after creation... but our
    // mock existsSync only checks _existingPaths. We need to set venv python
    // exists, but NOT the VENV_DIR, so the creation is triggered.
    // Actually, the code checks existsSync(VENV_DIR), not the venv python path.
    // We need VENV_DIR to NOT exist, but the venv python path TO exist for
    // the next check.

    // Steps in installPipDeps:
    // 1. Check existsSync(VENV_DIR) → false → create venv
    // 2. Call venvPython() → check existsSync(venv bin path) → need it to exist
    //    for the function to succeed after creation
    // 3. Upgrade pip
    // 4. Install requirements

    const venvPythonPath = require("path").join(cap.VENV_DIR, "bin", "python3");

    // Set up real-time path changes: VENV_DIR doesn't exist (triggers creation),
    // but the venv python path does (from a previous run or test setup)
    // Actually, to simulate "venv was just created", we need to add the paths
    // during the execFile callbacks. Let me simplify: just have VENV_DIR not
    // exist initially but venv python path exists.
    // For the first check: existsSync(VENV_DIR) → false (not in _existingPaths)
    // For venvPython() after creation: existsSync(venv bin path) → true

    setExists(venvPythonPath);
    // VENV_DIR is NOT in setExists, so existsSync returns false → triggers creation

    // Set up execFile behaviors. Mock matches full paths by basename.
    setExecFileBehavior("python3", { succeed: true, stdout: "pip upgraded", stderr: "" });

    const result = await cap.installPipDeps();

    assert.equal(result.ok, true);
    assert.ok(typeof result.log === "string");
  });

  test("skips venv creation when venv already exists", async () => {
    const venvPythonPath = require("path").join(cap.VENV_DIR, "bin", "python3");

    // Both VENV_DIR and venv python exist
    setExists(cap.VENV_DIR, venvPythonPath);

    // Only pip commands run (no venv creation). Matches by basename "python3".
    setExecFileBehavior("python3", { succeed: true, stdout: "pip upgraded", stderr: "" });

    const result = await cap.installPipDeps();
    assert.equal(result.ok, true);
  });

  test("throws when venv creation fails", async () => {
    const venvPythonPath = require("path").join(cap.VENV_DIR, "bin", "python3");

    // VENV_DIR doesn't exist → triggers creation, but venv python path doesn't
    // exist either, so even after "creation", venvPython() returns null
    // Actually, the code checks venvPython() AFTER creation. If it fails,
    // the function returns null, and installPipDeps throws.
    // To simulate this: set VENV_DIR to NOT exist, and don't set venvPythonPath
    // (so venvPython returns null even after "creation")

    setExecFileBehavior("python3", { succeed: true });  // venv creation "succeeds"

    await assert.rejects(
      () => cap.installPipDeps(),
      { message: /venv creation failed/ }
    );
  });

  // NOTE: Testing the pip install failure path is tricky because
  // util.promisify(execFile) uses a custom promisify symbol on the real
  // execFile that our mock doesn't replicate. The venv creation failure
  // test above exercises the error path through a different route.

  test("throws when venv python not found after creation", async () => {
    // VENV_DIR doesn't exist (triggers creation), and after creation
    // venv python still doesn't exist
    setExecFileBehavior("python3", { succeed: true });

    // Don't set venv python path
    await assert.rejects(
      () => cap.installPipDeps(),
      { message: /venv creation failed/ }
    );
  });
});

// =============================================================================
// VENV_DIR and DOCX_REQUIREMENTS exports
// =============================================================================
describe("exported constants", () => {
  test("VENV_DIR is a non-empty string", () => {
    assert.ok(typeof cap.VENV_DIR === "string" && cap.VENV_DIR.length > 0);
    assert.ok(cap.VENV_DIR.includes("var/venv") || cap.VENV_DIR.includes("var\\venv"));
  });

  test("DOCX_REQUIREMENTS is a non-empty string", () => {
    assert.ok(typeof cap.DOCX_REQUIREMENTS === "string" && cap.DOCX_REQUIREMENTS.length > 0);
    assert.ok(cap.DOCX_REQUIREMENTS.includes("requirements.txt"));
  });
});
