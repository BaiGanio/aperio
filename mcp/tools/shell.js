import { z }            from "zod";
import { spawn }         from "child_process";
import { dirname, resolve as resolvePath, extname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { isWritePathAllowed, isReadPathAllowed, getActivePaths, getActiveScratchDir } from "../../lib/routes/paths.js";
import { pythonInterpreter } from "../../lib/helpers/capabilities.js";
import logger from "../../lib/helpers/logger.js";

// Hard cap on captured stdout/stderr, applied per stream. Small-context local
// models drown in long logs (a 4B model can't use 24K tokens of build output),
// so the default is deliberately tight; raise it for cloud models via
// APERIO_SHELL_MAX_OUTPUT_BYTES. The cap is TAIL-BIASED — the head plus the LAST
// bytes survive and the middle is dropped — because a run's verdict/error lives
// at the end, which the old head-only cap discarded entirely once output grew.
const MAX_OUTPUT_BYTES = parseInt(process.env.APERIO_SHELL_MAX_OUTPUT_BYTES || "48000", 10);
const HEAD_BYTES       = Math.floor(MAX_OUTPUT_BYTES / 4);
const TAIL_BYTES       = MAX_OUTPUT_BYTES - HEAD_BYTES;
const TIMEOUT_MS       = 60_000;

// Streaming sink that retains the first HEAD_BYTES and the last TAIL_BYTES of a
// stream, dropping the middle, with bounded memory (it never holds more than
// HEAD_BYTES + TAIL_BYTES + one chunk). `bytes` is the full byte count seen so
// callers can still report how much arrived; `toString()` yields the head + an
// omission marker + tail, or the whole stream untouched when it fits.
export function makeTailBiasedSink(headMax = HEAD_BYTES, tailMax = TAIL_BYTES) {
  const head = [];
  const tail = [];
  let headBytes = 0, tailBytes = 0, total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      if (headBytes < headMax) {
        const room = headMax - headBytes;
        if (chunk.length <= room) { head.push(chunk); headBytes += chunk.length; return; }
        head.push(chunk.subarray(0, room)); headBytes += room;
        chunk = chunk.subarray(room);
      }
      tail.push(chunk); tailBytes += chunk.length;
      // Drop whole leading chunks while the rest still covers tailMax.
      while (tail.length > 1 && tailBytes - tail[0].length >= tailMax) {
        tailBytes -= tail.shift().length;
      }
    },
    get bytes() { return total; },
    toString() {
      if (total <= headMax + tailMax) return Buffer.concat([...head, ...tail]).toString("utf-8");
      let tb = Buffer.concat(tail);
      if (tb.length > tailMax) tb = tb.subarray(tb.length - tailMax);
      const omitted = total - headBytes - tb.length;
      const headStr = Buffer.concat(head).toString("utf-8");
      return `${headStr}\n\n… [${Math.round(omitted / 1024)}KB of output omitted to fit context — showing head + tail] …\n\n${tb.toString("utf-8")}`;
    },
  };
}

// The MCP runs as a shared subprocess with no per-session AsyncLocalStorage
// context, so getActiveScratchDir() is null here. The session id, however, is
// the scratch path segment (var/scratch/<sessionId>/…) — recover it from the
// script/cwd path so error logs are traceable to the chat session that triggered
// them, since the process-level banner cannot identify one.
// Returns {} or { sessionId } so callers can drop it straight into a log meta
// without ever emitting an empty/undefined field on non-session (CLI) runs.
function sessionMeta(p) {
  const m = typeof p === "string" ? p.match(/[/\\]var[/\\]scratch[/\\]([^/\\]+)/) : null;
  return m ? { sessionId: m[1] } : {};
}

// run_shell is off unless explicitly enabled. It widens the model's reach from
// node-only (.js files) to a fixed set of real binaries, so it is opt-in.
const SHELL_ENABLED = process.env.APERIO_ENABLE_SHELL === "1";

// Allowlist, not denylist. Only the program in command position is checked.
// These are the binaries the pptx/xlsx/code-fix workflows actually call for:
// generation/QA (node, python3), visual QA (soffice, pdftoppm), and inspection
// (git, grep, rg, find, ls, cat, head, tail). npm is included for the rare
// dependency install a deck/model genuinely needs.
const ALLOWED_CMDS = new Set([
  "node", "npm", "git", "ls", "cat", "grep", "rg", "find", "head", "tail", "wc",
  "python3", "soffice", "pdftoppm", "curl",
]);

function formatPathError(scriptPath) {
  const { writePaths } = getActivePaths();
  return {
    content: [{
      type: "text",
      text: `❌ Script not allowed: ${scriptPath}\nAllowed paths: ${writePaths.join(", ")}`,
    }],
  };
}

// Aperio's project root is `"type": "module"`, so Node treats every `.js` file
// under it (including the scratch workspace) as ESM. Weaker models routinely
// generate CommonJS scripts (`require('pdf-lib')`, `module.exports`), which then
// die with "require is not defined in ES module scope". Node ALWAYS treats a
// `.cjs` file as CommonJS regardless of the nearest package.json `type`, so when
// a `.js` script is plainly CommonJS (require/exports markers, no static
// import/export) we run a temporary `.cjs` copy of it. node_modules and relative
// requires still resolve because the copy sits in the same directory; the copy is
// always deleted after the run (via cleanup) so it never pollutes the workspace
// or a real project directory.
//
// Returns { runTarget, cleanup }. runTarget is the path to actually spawn;
// cleanup() removes any temp copy and is safe to call exactly once.
//
// IMPORTANT: a script that mixes `require()` with TOP-LEVEL `await` (await at
// column 0, not nested in a function) is self-contradictory — top-level await is
// ESM-only, require is CJS-only, so NO module mode can run it. We do NOT redirect
// those to `.cjs` (that yields a confusing "await is only valid…" syntax error);
// instead we leave them as ESM so Node emits its own clear "require is not
// defined … use import" message, which the model can act on.
function prepareNodeTarget(resolved) {
  const noop = { runTarget: resolved, cleanup: () => {} };
  if (extname(resolved).toLowerCase() !== ".js") return noop;
  let src;
  try { src = readFileSync(resolved, "utf-8"); } catch { return noop; }
  const hasCjs = /(^|[^.\w])require\s*\(/m.test(src) || /\bmodule\.exports\b/.test(src) || /\bexports\.\w/.test(src);
  const hasEsm = /^\s*import\s.+\bfrom\b/m.test(src) || /^\s*import\s*['"]/m.test(src) || /^\s*export\s/m.test(src);
  // Heuristic for top-level await: an unindented line that uses `await` and is
  // NOT a function/arrow declaration. Awaits nested in a function body are
  // indented (so `^\S` excludes them); the `function`/`=>` lookaheads also drop
  // single-line bodies like `async function f(){ await x() }` that sit at column 0.
  const hasTopLevelAwait = /^(?!.*\bfunction\b)(?!.*=>)\S[^\n]*\bawait\b/m.test(src);
  if (!hasCjs || hasEsm || hasTopLevelAwait) return noop;
  const cjsPath = resolved.replace(/\.js$/i, ".cjs");
  try {
    writeFileSync(cjsPath, src);
    logger.info(`[run_node_script] CommonJS detected; running a temporary .cjs copy of ${resolved}`);
    return { runTarget: cjsPath, cleanup: () => { try { unlinkSync(cjsPath); } catch {} } };
  } catch (err) {
    logger.warn(`[run_node_script] could not write .cjs copy (${err.message}); running original`);
    return noop;
  }
}

function buildResponseText({ exitCode, timedOut, stdout, stderr, stdoutBytes, stderrBytes, scriptPath }) {
  const parts = [];

  if (timedOut) parts.push(`❌ Script timed out after ${TIMEOUT_MS / 1000}s: ${scriptPath}`);
  else if (exitCode === 0) parts.push(`✅ Exit 0 — ${scriptPath}`);
  else parts.push(`❌ Exit ${exitCode} — ${scriptPath}`);

  if (stdout) parts.push(`--- stdout ---\n${stdout}`);
  if (stderr) parts.push(`--- stderr ---\n${stderr}`);
  if (!stdout && !stderr) parts.push(`(no output)`);

  const truncNotes = [];
  if (stdoutBytes > MAX_OUTPUT_BYTES) truncNotes.push(`stdout truncated (${Math.round(stdoutBytes / 1024)}KB > ${MAX_OUTPUT_BYTES / 1024}KB)`);
  if (stderrBytes > MAX_OUTPUT_BYTES) truncNotes.push(`stderr truncated (${Math.round(stderrBytes / 1024)}KB > ${MAX_OUTPUT_BYTES / 1024}KB)`);
  if (truncNotes.length) parts.push(`⚠️ ${truncNotes.join("; ")}`);

  return parts.join("\n\n");
}

// Spawn a child, capture stdout/stderr (capped), enforce a hard timeout, and
// resolve with a structured result. Shared by run_node_script and run_shell so
// both get identical output limits, timeout, and SIGTERM handling.
function collectOutput(child, label) {
  return new Promise((res) => {
    const outBuf = makeTailBiasedSink();
    const errBuf = makeTailBiasedSink();
    let timedOut = false;

    child.stdout.on("data", (chunk) => outBuf.push(chunk));
    child.stderr.on("data", (chunk) => errBuf.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch (err) {
        logger.error(`[${label}] SIGTERM failed: ${err.message}`);
      }
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      res({
        exitCode: code,
        timedOut,
        stdout: outBuf.toString().trimEnd(),
        stderr: errBuf.toString().trimEnd(),
        stdoutBytes: outBuf.bytes,
        stderrBytes: errBuf.bytes,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      res({ spawnError: err });
    });
  });
}

export async function runNodeScriptHandler({ script, args = [] }) {
  if (extname(script).toLowerCase() !== ".js") {
    logger.warn(`[run_node_script] rejected non-.js path: ${script}`);
    return { content: [{ type: "text", text: `❌ Only .js scripts are allowed` }] };
  }

  const resolved = resolvePath(script);

  if (!isWritePathAllowed(resolved)) {
    logger.warn(`[run_node_script] path not allowed: ${resolved}`);
    return formatPathError(resolved);
  }

  if (!existsSync(resolved)) {
    logger.warn(`[run_node_script] script not found: ${resolved}`);
    return { content: [{ type: "text", text: `❌ Script not found: ${resolved}. If you intended to create and run this script, call write_file with this exact path FIRST, then run_node_script — they must be separate, ordered steps (write before run).` }] };
  }

  // Default cwd to the active session scratch dir so any relative output paths
  // land there (served via /scratch) rather than inside the skill's own folder.
  // Scripts always know their own directory via import.meta.url / __dirname.
  const cwd = getActiveScratchDir() ?? dirname(resolved);
  const { runTarget, cleanup } = prepareNodeTarget(resolved);
  logger.info(`[run_node_script] start ${resolved} cwd=${cwd} args=${JSON.stringify(args)}`);

  let child;
  try {
    child = spawn("node", [runTarget, ...args.map(String)], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    cleanup();
    logger.error(`[run_node_script] spawn threw: ${err.message}`);
    return { content: [{ type: "text", text: `❌ Failed to spawn node: ${err.message}` }] };
  }

  const r = await collectOutput(child, "run_node_script");
  cleanup();
  if (r.spawnError) {
    logger.error(`[run_node_script] child error: ${r.spawnError.message}`);
    return { content: [{ type: "text", text: `❌ Failed to start script: ${r.spawnError.message}` }] };
  }

  const meta = sessionMeta(resolved);
  if (r.timedOut) {
    logger.error(`[run_node_script] timeout ${resolved} after ${TIMEOUT_MS}ms`, meta);
  } else if (r.exitCode !== 0) {
    logger.error(`[run_node_script] non-zero exit ${r.exitCode} ${resolved} stderr: ${r.stderr.slice(0, 1000)}`, meta);
  } else if (r.stderr) {
    logger.warn(`[run_node_script] exit 0 with stderr ${resolved}: ${r.stderr.slice(0, 500)}`, meta);
  } else {
    logger.info(`[run_node_script] ok ${resolved}`);
  }

  const text = buildResponseText({ ...r, scriptPath: resolved });
  return { content: [{ type: "text", text }] };
}

// Mirror of run_node_script for Python. Same write-path guard, scratch-dir cwd,
// timeout and output caps — but spawns python3 and only accepts .py files. This
// keeps Python on the same tight, sandboxed footing as Node WITHOUT opening the
// broader run_shell surface. Used by skills whose toolchain is Python (e.g.
// docx office/unpack.py, pack.py, validate.py). If python3 is absent the spawn
// fails with a clear, actionable hint rather than a cryptic error.
export async function runPythonScriptHandler({ script, args = [] }) {
  if (script.includes(" ")) {
    logger.warn(`[run_python_script] script path contains spaces (args mixed in): ${script}`);
    return { content: [{ type: "text", text: `❌ run_python_script: the "script" param must be the file path only — put arguments in the "args" array, not in the path.\n\nIf you are trying to read a .docx file, use the read_docx tool instead — it is faster and does not need a Python script.` }] };
  }
  if (extname(script).toLowerCase() !== ".py") {
    logger.warn(`[run_python_script] rejected non-.py path: ${script}`);
    return { content: [{ type: "text", text: `❌ run_python_script only runs .py files. If you are trying to read a .docx file, use the read_docx tool instead.` }] };
  }

  const resolved = resolvePath(script);

  if (!isWritePathAllowed(resolved)) {
    logger.warn(`[run_python_script] path not allowed: ${resolved}`);
    return formatPathError(resolved);
  }

  if (!existsSync(resolved)) {
    logger.warn(`[run_python_script] script not found: ${resolved}`);
    return { content: [{ type: "text", text: `❌ Script not found: ${resolved}. If you intended to create and run this script, call write_file with this exact path FIRST, then run_python_script — they must be separate, ordered steps (write before run).` }] };
  }

  const cwd = getActiveScratchDir() ?? dirname(resolved);
  logger.info(`[run_python_script] start ${resolved} cwd=${cwd} args=${JSON.stringify(args)}`);

  // Prefer the project venv interpreter so pip deps installed via the Extras
  // panel are visible; fall back to system python3.
  const interpreter = pythonInterpreter();

  let child;
  try {
    child = spawn(interpreter, [resolved, ...args.map(String)], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    logger.error(`[run_python_script] spawn threw: ${err.message}`);
    return { content: [{ type: "text", text: `❌ Failed to spawn python3: ${err.message}` }] };
  }

  const r = await collectOutput(child, "run_python_script");
  if (r.spawnError) {
    logger.error(`[run_python_script] child error: ${r.spawnError.message}`);
    const hint = r.spawnError.code === "ENOENT"
      ? `\n\n⚠️ python3 is not installed on this host. This skill's advanced (Python) features need Python 3 — install it from the web UI's "Extras" panel or via your package manager (e.g. \`brew install python\`). The Node-based features of this skill still work without it.`
      : "";
    return { content: [{ type: "text", text: `❌ Failed to start script: ${r.spawnError.message}${hint}` }] };
  }

  const meta = sessionMeta(resolved);
  if (r.timedOut) {
    logger.error(`[run_python_script] timeout ${resolved} after ${TIMEOUT_MS}ms`, meta);
  } else if (r.exitCode !== 0) {
    logger.error(`[run_python_script] non-zero exit ${r.exitCode} ${resolved} stderr: ${r.stderr.slice(0, 1000)}`, meta);
  } else if (r.stderr) {
    logger.warn(`[run_python_script] exit 0 with stderr ${resolved}: ${r.stderr.slice(0, 500)}`, meta);
  } else {
    logger.info(`[run_python_script] ok ${resolved}`);
  }

  const text = buildResponseText({ ...r, scriptPath: resolved });
  return { content: [{ type: "text", text }] };
}

// ── run_shell validation ──────────────────────────────────────────────────
// Quote-aware checks so a grep alternation pattern (e.g. "lorem|ipsum") inside
// quotes is never mistaken for a shell pipe or operator.

// Scan for banned unquoted operators that could chain commands past the
// allowlist or redirect I/O. A single unquoted "|" pipe is permitted (handled
// by splitOnPipes), so it is not banned here.
function checkBannedOperators(command) {
  let inS = false, inD = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (inS) { if (c === "'") inS = false; continue; }
    if (inD) { if (c === '"') inD = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === ";" || c === "&" || c === "<" || c === ">" || c === "`") return c;
    if (c === "$" && command[i + 1] === "(") return "$(";
  }
  return null;
}

// Split on unquoted "|" only. A "||" yields an empty segment, which the caller
// rejects — logical-OR chaining is therefore blocked.
function splitOnPipes(command) {
  const segs = [];
  let cur = "", inS = false, inD = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (inS) { cur += c; if (c === "'") inS = false; continue; }
    if (inD) { cur += c; if (c === '"') inD = false; continue; }
    if (c === "'") { inS = true; cur += c; continue; }
    if (c === '"') { inD = true; cur += c; continue; }
    if (c === "|") { segs.push(cur); cur = ""; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

export async function runShellHandler({ command, cwd: cwdArg }) {
  if (!SHELL_ENABLED) {
    return { content: [{ type: "text", text: `❌ run_shell is disabled. Set APERIO_ENABLE_SHELL=1 to enable it.` }] };
  }
  if (typeof command !== "string" || !command.trim()) {
    return { content: [{ type: "text", text: `❌ No command provided` }] };
  }

  const banned = checkBannedOperators(command);
  if (banned) {
    logger.warn(`[run_shell] rejected operator "${banned}": ${command}`);
    return { content: [{ type: "text", text:
      `❌ Shell operator "${banned}" is not allowed.\n\n` +
      `Common mistakes:\n` +
      `  • 2>&1  — do not use stderr redirection; run_node_script captures both streams automatically\n` +
      `  • &&, ||, ; — chain commands in a .js script instead (see below)\n` +
      `  • > or <  — write output in a script; use fetch_url (not curl) to download URLs\n\n` +
      `For multi-step operations: write a .js script to the session scratch workspace ` +
      `(the path is in your system prompt under "Session scratch workspace"), ` +
      `then run it with run_node_script. It captures stdout+stderr, enforces the same timeout, ` +
      `and the file is cleaned up automatically when the session expires.`
    }] };
  }

  // Validate the program in each pipe segment against the allowlist.
  for (const seg of splitOnPipes(command)) {
    const t = seg.trim();
    if (!t) {
      return { content: [{ type: "text", text: `❌ Empty command segment — check your pipes.` }] };
    }
    const prog = t.match(/^(\S+)/)[1];
    if (prog.startsWith("'") || prog.startsWith('"')) {
      return { content: [{ type: "text", text: `❌ Each command must start with a program name, not a quote.` }] };
    }
    if (!ALLOWED_CMDS.has(prog)) {
      logger.warn(`[run_shell] command not allowed: ${prog}`);
      return { content: [{ type: "text", text: `❌ Command not allowed: "${prog}".\nAllowed: ${[...ALLOWED_CMDS].join(", ")}` }] };
    }
  }

  // Pin cwd to the session workspace (same boundary write_file uses). An
  // explicit cwd is accepted only if it falls within an allowed write path —
  // this keeps CLI usage (no session) working without widening scope.
  let cwd = getActiveScratchDir();
  if (cwdArg) {
    const resolved = resolvePath(cwdArg);
    if (!isWritePathAllowed(resolved)) {
      logger.warn(`[run_shell] cwd not allowed: ${resolved}`);
      return formatPathError(resolved);
    }
    cwd = resolved;
  }
  if (!cwd) {
    return { content: [{ type: "text", text: `❌ No working directory: run_shell needs an active session workspace, or pass a cwd within an allowed write path.` }] };
  }

  // Scratch dirs are created lazily on first write_file; ensure cwd exists so
  // spawn doesn't throw ENOENT when the directory hasn't been created yet.
  try { mkdirSync(cwd, { recursive: true }); } catch { /* non-fatal */ }

  logger.info(`[run_shell] start: ${command} (cwd=${cwd})`);

  // A shell is required to wire the optional pipe and parse quoted args. The
  // allowlist + operator checks above bound what `sh -c` can actually run.
  let child;
  try {
    // Tag every command the model runs so scripts can lighten their output for a
    // local model's small, slow context — e.g. package.json's test:ci drops
    // --experimental-test-coverage when APERIO_AGENT_RUN is set, sparing a slow
    // model the ~12k-token coverage table it can't use anyway. CI leaves the var
    // unset, so it still gets full coverage.
    child = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, APERIO_AGENT_RUN: "1" },
    });
  } catch (err) {
    logger.error(`[run_shell] spawn threw: ${err.message}`);
    return { content: [{ type: "text", text: `❌ Failed to spawn shell: ${err.message}` }] };
  }

  const r = await collectOutput(child, "run_shell");
  if (r.spawnError) {
    logger.error(`[run_shell] child error: ${r.spawnError.message}`);
    return { content: [{ type: "text", text: `❌ Failed to start command: ${r.spawnError.message}` }] };
  }

  // Missing binary → skip, not failure. Preserves the soffice/pdftoppm visual
  // QA semantics: an absent optional binary must not be reported as a failure.
  if (r.exitCode === 127 || /not found|No such file|command not found/i.test(r.stderr)) {
    logger.warn(`[run_shell] command not found: ${command}`);
    return { content: [{ type: "text", text:
      `⚠️ Command not found while running: ${command}\n${r.stderr}\n\n` +
      `The program is not installed on this machine. If this was an optional QA binary (soffice / pdftoppm), ` +
      `treat visual QA as skipped — that is NOT a failure — and rely on verify.js + read.js. The deck/file itself is unaffected.`
    }] };
  }

  const meta = sessionMeta(cwd);
  if (r.timedOut) {
    logger.error(`[run_shell] timeout after ${TIMEOUT_MS}ms: ${command}`, meta);
  } else if (r.exitCode !== 0) {
    logger.error(`[run_shell] exit ${r.exitCode}: ${command} stderr: ${r.stderr.slice(0, 1000)}`, meta);
  } else if (r.stderr) {
    logger.warn(`[run_shell] exit 0 with stderr: ${command} stderr: ${r.stderr.slice(0, 500)}`, meta);
  } else {
    logger.info(`[run_shell] ok: ${command}`);
  }

  const text = buildResponseText({ ...r, scriptPath: command });
  return { content: [{ type: "text", text }] };
}

export async function syntaxCheckHandler({ path: filePath }) {
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs")
    return { content: [{ type: "text", text: `❌ Only .js/.mjs/.cjs files are supported` }] };

  const resolved = resolvePath(filePath);

  if (!isReadPathAllowed(resolved)) {
    const { readPaths } = getActivePaths();
    return { content: [{ type: "text", text: `❌ File not in allowed read path: ${resolved}\nAllowed paths: ${readPaths.join(", ")}` }] };
  }

  if (!existsSync(resolved))
    return { content: [{ type: "text", text: `❌ File not found: ${resolved}` }] };

  return new Promise((res) => {
    const chunks = [];

    let child;
    try {
      child = spawn("node", ["--check", resolved], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      logger.error(`[syntax_check] spawn threw: ${err.message}`);
      return res({ content: [{ type: "text", text: `❌ Failed to spawn node --check: ${err.message}` }] });
    }

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf-8").trimEnd();
      if (code === 0) {
        res({ content: [{ type: "text", text: `✅ Syntax OK: ${resolved}` }] });
      } else {
        logger.warn(`[syntax_check] failed ${resolved}: ${output.slice(0, 500)}`);
        res({ content: [{ type: "text", text: `❌ Syntax errors in ${resolved}:\n\n${output}\n\nFix using edit_file (targeted replacement), not write_file (full rewrite).` }] });
      }
    });

    child.on("error", (err) => {
      logger.error(`[syntax_check] child error: ${err.message}`);
      res({ content: [{ type: "text", text: `❌ Failed to run node --check: ${err.message}` }] });
    });
  });
}

export function register(server) {
  server.registerTool(
    "run_node_script",
    {
      description: "Run a Node.js script file and return its output. The script must be within an allowed write path. Use this to run skill scripts (e.g. skills/pptx/scripts/read.js). Only .js files are allowed. Scripts execute as ES modules (the project is `type: module`): use `import x from 'pkg'`, not `require()`.",
      inputSchema: z.object({
        script: z.string().describe("Absolute path to the .js script to run"),
        args:   z.array(z.string()).optional().describe("Arguments to pass to the script"),
      }),
    },
    runNodeScriptHandler
  );

  server.registerTool(
    "run_python_script",
    {
      description: "Run a Python 3 script file and return its output. The script must be within an allowed write path. Use for skill toolchains written in Python (e.g. skills/docx/scripts/office/unpack.py, pack.py, validate.py). Only .py files are allowed. Requires python3 on the host; if it is missing the call returns a clear hint and the skill's Node features still work.",
      inputSchema: z.object({
        script: z.string().describe("Absolute path to the .py script to run"),
        args:   z.array(z.string()).optional().describe("Arguments to pass to the script"),
      }),
    },
    runPythonScriptHandler
  );

  server.registerTool(
    "syntax_check",
    {
      description: "Check a JavaScript file for syntax errors without executing it. Call this immediately after write_file on any .js file. On error, fix with edit_file (targeted replacement) — never rewrite the whole file.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the .js/.mjs/.cjs file to check"),
      }),
    },
    syntaxCheckHandler
  );

  server.registerTool(
    "run_shell",
    {
      description: "Run a shell command and return its stdout/stderr. Pipes ('|') between allowlisted programs are permitted. Disabled unless APERIO_ENABLE_SHELL=1. Only allowlisted programs run: node, npm, git, ls, cat, grep, rg, find, head, tail, wc, python3, soffice, pdftoppm, curl. No ; && || & < > backticks or $(). For multi-step operations write a .js script to the session scratch workspace (see system prompt) and run it with run_node_script — those files are cleaned up with the session.",
      inputSchema: z.object({
        command: z.string().describe('The command to run, e.g. node /abs/path/scripts/read.js out.pptx | grep -iE "lorem|ipsum"'),
        cwd: z.string().optional().describe("Working directory (must be within an allowed write path). Defaults to the project root, or the session scratch workspace once files have been generated there."),
      }),
    },
    runShellHandler
  );
}
