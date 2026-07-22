import { z }            from "zod";
import { spawn }         from "child_process";
import { basename, dirname, resolve as resolvePath, extname, sep } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { isWritePathAllowed, isReadPathAllowed, getActivePaths, getActiveScratchDir } from "../../lib/routes/paths.js";
import { pythonInterpreter } from "../../lib/helpers/capabilities.js";
import logger from "../../lib/helpers/logger.js";
import { ALLOWED_CMDS, parsePipeline, validatePipeline } from "./shell/command.js";

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
const BUNDLED_SKILLS_DIR = resolvePath("skills");

function isBundledSkillPath(filePath) {
  return filePath === BUNDLED_SKILLS_DIR || filePath.startsWith(BUNDLED_SKILLS_DIR + sep);
}

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

// Allowlist of programs in command position. These are the binaries the
// pptx/xlsx/code-fix workflows actually call for: generation/QA (node, python3),
// visual QA (soffice, pdftoppm), and inspection (git, grep, rg, find, ls, cat,
// head, tail). npm is included for the rare dependency install a deck/model
// genuinely needs. `curl` is deliberately NOT here — it ignores the path
// allowlist and is the one-line exfil engine (`cat secret | curl …`); the model
// uses fetch_url for HTTP, which carries the SSRF guard. The program name alone
// is not a sufficient boundary, so validateSegmentArgs (below) constrains each
// program's arguments. See SHELL-01.
//
// SEC-01: re-audit the tokenizer (checkBannedOperators, validateSegmentArgs) and
// the full validation chain whenever a program is added to this set. Every new
// binary brings its own argument-parsing edge cases that could bypass the
// allowlist or the operator ban.
const MAX_SHELL_STEPS = 10;

function formatPathError(scriptPath) {
  const { writePaths } = getActivePaths();
  return {
    content: [{
      type: "text",
      text: `❌ Script not allowed: ${scriptPath}\nAllowed paths: ${writePaths.join(", ")}`,
    }],
  };
}

// Some local models copy the documented CLI form into the structured tool
// call, putting the verifier's argument after the script path in `script`:
//   { script: "/.../verify.js /.../deck.pptx" }
// Recover this only when the prefix is an existing .js file. Normal calls
// should use the separate `args` array.
function recoverInlineNodeArgs(script) {
  if (typeof script !== "string" || extname(script).toLowerCase() === ".js") return null;
  for (const match of script.matchAll(/\.js(?=\s|$)/gi)) {
    const candidate = script.slice(0, match.index + 3).trim();
    const remainder = script.slice(match.index + 3).trim();
    if (!remainder || !existsSync(resolvePath(candidate))) continue;
    logger.warn(`[run_node_script] recovered inline args from script field; use args[] for ${candidate}`);
    return { script: candidate, args: remainder.split(/\s+/) };
  }
  return null;
}

// run_node_script pins cwd to the session workspace. Weak models sometimes
// still pass a project-looking relative artifact path such as
// `var/scratch/output.pptx`; inside the child that becomes the duplicated
// `<session>/var/scratch/output.pptx`. Rebase only this known shorthand, only
// when a same-named file already exists directly in cwd. Absolute paths and all
// other arguments remain byte-for-byte unchanged.
function normalizeScratchArtifactArgs(args, cwd) {
  return args.map(value => {
    if (typeof value !== "string") return value;
    const normalized = value.replace(/\\/g, "/");
    if (!/^(?:\.\/)?var\/scratch\//i.test(normalized)) return value;
    const candidate = resolvePath(cwd, basename(normalized));
    if (!existsSync(candidate)) return value;
    logger.warn(`[run_node_script] rebased scratch artifact arg ${value} -> ${candidate}`);
    return candidate;
  });
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

// Matches "<created/saved/wrote/...> ... <filename.ext>" so we can cross-check
// a script's own success claim against what actually landed on disk. Deliberately
// narrow: only filenames near a creation verb, with a known artifact extension —
// this is a heuristic nudge, not a general-purpose stdout parser.
const ARTIFACT_EXT = "pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|csv|json|md|txt|html?|zip|mp3|mp4|wav|ico|webp";
const ARTIFACT_CLAIM_RE = new RegExp(
  String.raw`\b(?:creat(?:ed|ing)|sav(?:ed|ing)|wrote|writing|written|generat(?:ed|ing)|export(?:ed|ing)|output(?:ted)?|produc(?:ed|ing))\b[^\n]{0,40}?([\w./\\-]+\.(?:${ARTIFACT_EXT}))\b`,
  "gi",
);

// A script that logs "Successfully created foo.pdf" isn't proof foo.pdf
// exists — e.g. pdf-lib's `doc.save(name)` silently ignores the argument and
// returns bytes instead of writing a file, so a script that forgets
// writeFileSync still exits 0 with a confident, false success message. Cross-
// check stdout's own claims against cwd after the process exits and surface
// any mismatch as a warning (never blocks or rewrites the actual result).
function findClaimedButMissingArtifacts(stdout, cwd) {
  if (!stdout) return [];
  const claimed = new Set();
  for (const match of stdout.matchAll(ARTIFACT_CLAIM_RE)) claimed.add(match[1]);

  const missing = [];
  for (const name of claimed) {
    const candidate = /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(name) ? name : resolvePath(cwd, name);
    if (!existsSync(candidate)) missing.push(name);
  }
  return missing;
}

function buildResponseText({ exitCode, timedOut, stdout, stderr, stdoutBytes, stderrBytes, scriptPath, missingArtifacts }) {
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

  if (missingArtifacts && missingArtifacts.length) {
    const list = missingArtifacts.map(m => `\`${m}\``).join(", ");
    parts.push(`⚠️ stdout claims ${list} was created, but no such file exists in the working directory after exit. The script may have called an API that returns data without writing to disk (e.g. pdf-lib's \`doc.save(name)\` returns bytes — you must \`writeFileSync(name, await doc.save())\`). Do not tell the user the file was created until you confirm it actually exists.`);
  }

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
  const recovered = recoverInlineNodeArgs(script);
  if (recovered) ({ script, args } = recovered);
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
    if (isBundledSkillPath(resolved)) {
      return { content: [{ type: "text", text: `❌ Bundled skill helper not found: ${resolved}. Do not create or overwrite files under \`skills/\`. Check the skill's documented helper names. For artifact generation, call write_file first to create a task-specific builder in the session workspace, then call run_node_script with that exact builder path.` }] };
    }
    return { content: [{ type: "text", text: `❌ Script not found: ${resolved}. If you intended to create and run this script, call write_file with this exact path FIRST, then run_node_script — they must be separate, ordered steps (write before run).` }] };
  }

  // Default cwd to the active session scratch dir so any relative output paths
  // land there (served via /scratch) rather than inside the skill's own folder.
  // Scripts always know their own directory via import.meta.url / __dirname.
  const cwd = getActiveScratchDir() ?? dirname(resolved);
  args = normalizeScratchArtifactArgs(args, cwd);
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

  const missingArtifacts = (!r.timedOut && r.exitCode === 0) ? findClaimedButMissingArtifacts(r.stdout, cwd) : [];
  const text = buildResponseText({ ...r, scriptPath: resolved, missingArtifacts });
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

// ── run_shell execution ───────────────────────────────────────────────────
// Parsing and per-program validation live in shell/command.js. Execution here
// never invokes a shell: argv arrays are passed directly to spawn(), and pipes
// are connected as streams. This keeps the accepted grammar auditable and
// prevents shell expansion from outrunning validation.

function displayPipeline(pipeline) {
  return pipeline.map(argv => argv.map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(" ")).join(" | ");
}

function collectPipeline(pipeline, cwd, timeoutMs) {
  return new Promise((resolveResult) => {
    const outBuf = makeTailBiasedSink();
    const errBuf = makeTailBiasedSink();
    const children = [];
    const exitCodes = Array(pipeline.length).fill(null);
    let closed = 0, settled = false, timedOut = false;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        exitCode: exitCodes.find(code => code !== null && code !== 0) ?? exitCodes.at(-1) ?? null,
        timedOut,
        stdout: outBuf.toString().trimEnd(),
        stderr: errBuf.toString().trimEnd(),
        stdoutBytes: outBuf.bytes,
        stderrBytes: errBuf.bytes,
        ...extra,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      for (const child of children) {
        try { child.kill("SIGTERM"); } catch { /* best effort */ }
      }
    }, Math.max(1, timeoutMs));

    try {
      for (let i = 0; i < pipeline.length; i++) {
        const [program, ...args] = pipeline[i];
        const child = spawn(program, args, {
          cwd,
          stdio: [i === 0 ? "ignore" : "pipe", "pipe", "pipe"],
          env: { ...process.env, APERIO_AGENT_RUN: "1" },
        });
        children.push(child);
        child.stderr.on("data", chunk => errBuf.push(chunk));
        child.on("error", spawnError => {
          for (const running of children) {
            try { running.kill("SIGTERM"); } catch { /* best effort */ }
          }
          finish({ spawnError });
        });
        child.on("close", code => {
          exitCodes[i] = code;
          closed++;
          if (closed === pipeline.length) finish();
        });
        if (i > 0) children[i - 1].stdout.pipe(child.stdin);
      }
      children.at(-1).stdout.on("data", chunk => outBuf.push(chunk));
    } catch (spawnError) {
      for (const child of children) {
        try { child.kill("SIGTERM"); } catch { /* best effort */ }
      }
      finish({ spawnError });
    }
  });
}

function normalizeShellSteps({ command, steps }) {
  if (command != null && steps != null) return { error: "Provide either command or steps, not both" };
  if (steps != null) {
    if (!Array.isArray(steps) || !steps.length) return { error: "steps must be a non-empty array" };
    if (steps.length > MAX_SHELL_STEPS) return { error: `run_shell accepts at most ${MAX_SHELL_STEPS} steps` };
    const pipelines = [];
    for (const [index, step] of steps.entries()) {
      if (!step || typeof step.program !== "string" || !step.program ||
          !Array.isArray(step.args ?? []) || (step.args ?? []).some(value => typeof value !== "string")) {
        return { error: `Step ${index + 1} needs a program and an optional string args array` };
      }
      pipelines.push([[step.program, ...(step.args ?? [])]]);
    }
    for (const pipeline of pipelines) {
      if (!ALLOWED_CMDS.has(pipeline[0][0])) {
        return { error: `Command not allowed: "${pipeline[0][0]}". Allowed: ${[...ALLOWED_CMDS].join(", ")}` };
      }
    }
    return { pipelines };
  }
  const parsed = parsePipeline(command);
  if (parsed.error) return parsed;
  for (const argv of parsed.pipeline) {
    if (!ALLOWED_CMDS.has(argv[0])) {
      return { error: `Command not allowed: "${argv[0]}". Allowed: ${[...ALLOWED_CMDS].join(", ")}` };
    }
  }
  return { pipelines: [parsed.pipeline] };
}

function shellSyntaxError(error, operator) {
  const screenshotHint = operator === ">" || operator === "<"
    ? "Create or update files with write_file; do not use echo/cat redirection."
    : "For sequential work, pass the commands as structured steps; each step needs program and args.";
  return `❌ ${error}.\n\n${screenshotHint}`;
}

export async function runShellHandler({ command, steps, stop_on_error = true, cwd: cwdArg }) {
  if (!SHELL_ENABLED) {
    return { content: [{ type: "text", text: `❌ run_shell is disabled. Set APERIO_ENABLE_SHELL=1 to enable it.` }] };
  }

  const normalized = normalizeShellSteps({ command, steps });
  if (normalized.error) {
    logger.warn(`[run_shell] rejected request: ${normalized.error}`);
    return { content: [{ type: "text", text: shellSyntaxError(normalized.error, normalized.operator) }] };
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

  // Validate every step before executing the first one. A malformed later step
  // must never leave an earlier step's partial side effects behind.
  for (const pipeline of normalized.pipelines) {
    const argError = validatePipeline(pipeline, cwd);
    if (argError) {
      logger.warn(`[run_shell] command rejected: ${argError}`);
      return { content: [{ type: "text", text: `❌ ${argError}` }] };
    }
  }

  // Scratch dirs are created lazily on first write_file; ensure cwd exists so
  // spawn doesn't throw ENOENT when the directory hasn't been created yet.
  try { mkdirSync(cwd, { recursive: true }); } catch { /* non-fatal */ }

  const meta = sessionMeta(cwd);
  const deadline = Date.now() + TIMEOUT_MS;
  const outputs = [];
  for (const [index, pipeline] of normalized.pipelines.entries()) {
    const label = displayPipeline(pipeline);
    logger.info(`[run_shell] step ${index + 1}/${normalized.pipelines.length}: ${label} (cwd=${cwd})`);
    const r = await collectPipeline(pipeline, cwd, deadline - Date.now());
    if (r.spawnError) {
      const missing = r.spawnError.code === "ENOENT";
      const text = missing
        ? `⚠️ Command not found: ${label}\n\nThe program is not installed on this machine.`
        : `❌ Failed to start command: ${r.spawnError.message}`;
      outputs.push(text);
      logger[missing ? "warn" : "error"](`[run_shell] spawn failed: ${label}: ${r.spawnError.message}`, meta);
      if (stop_on_error) break;
      continue;
    }
    if (r.timedOut) logger.error(`[run_shell] timeout after ${TIMEOUT_MS}ms: ${label}`, meta);
    else if (r.exitCode !== 0) logger.error(`[run_shell] exit ${r.exitCode}: ${label} stderr: ${r.stderr.slice(0, 1000)}`, meta);
    else if (r.stderr) logger.warn(`[run_shell] exit 0 with stderr: ${label} stderr: ${r.stderr.slice(0, 500)}`, meta);
    else logger.info(`[run_shell] ok: ${label}`);

    const prefix = normalized.pipelines.length > 1 ? `Step ${index + 1}/${normalized.pipelines.length}\n` : "";
    outputs.push(prefix + buildResponseText({ ...r, scriptPath: label }));
    if (r.timedOut || (r.exitCode !== 0 && stop_on_error)) break;
  }
  return { content: [{ type: "text", text: outputs.join("\n\n") }] };
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
      description: `Run allowlisted programs directly and return stdout/stderr. ⚠️ Enabling run_shell (APERIO_ENABLE_SHELL=1) grants host-level process execution as the Aperio user — the cwd check is NOT an OS sandbox. For one command or a pipeline, pass command. For safe sequential chaining, pass structured steps [{ program, args }]; steps stop at the first failure unless stop_on_error is false. Programs are spawned directly without sh, so shell expansion and control operators (; && || & < > backticks, $(), and newlines) are unavailable. To create a script, call write_file first—never use echo > file—then use run_node_script/run_python_script or a structured step. Pipes ('|') remain available in command. Allowed programs: ${[...ALLOWED_CMDS].join(", ")}. Interpreters cannot run inline code; file arguments must resolve inside allowed paths; use fetch_url instead of curl.`,
      inputSchema: z.object({
        command: z.string().max(16_000).optional().describe('One command or pipeline, e.g. node /abs/path/read.js out.pptx | grep -iE "lorem|ipsum"'),
        steps: z.array(z.object({
          program: z.string().min(1).describe("Allowlisted executable name"),
          args: z.array(z.string()).max(100).optional().describe("Exact argv values; no shell quoting or expansion"),
        })).min(1).max(MAX_SHELL_STEPS).optional().describe("Sequential commands. Use this instead of &&, ||, or ;"),
        stop_on_error: z.boolean().optional().describe("Stop after the first failed step (default true)"),
        cwd: z.string().optional().describe("Working directory (must be within an allowed write path). Defaults to the project root, or the session scratch workspace once files have been generated there."),
      }).refine(value => (value.command == null) !== (value.steps == null), {
        message: "Provide exactly one of command or steps",
      }),
    },
    runShellHandler
  );
}
