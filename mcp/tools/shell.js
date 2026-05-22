import { z }            from "zod";
import { spawn }         from "child_process";
import { dirname, resolve as resolvePath, extname } from "path";
import { existsSync }    from "fs";
import { isWritePathAllowed, isReadPathAllowed, getActivePaths } from "../../lib/routes/paths.js";
import logger from "../../lib/helpers/logger.js";

const MAX_OUTPUT_BYTES = 200_000;
const TIMEOUT_MS       = 60_000;

function formatPathError(scriptPath) {
  const { writePaths } = getActivePaths();
  return {
    content: [{
      type: "text",
      text: `❌ Script not allowed: ${scriptPath}\nAllowed paths: ${writePaths.join(", ")}`,
    }],
  };
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
    return { content: [{ type: "text", text: `❌ Script not found: ${resolved}` }] };
  }

  const cwd = dirname(resolved);
  logger.info(`[run_node_script] start ${resolved} args=${JSON.stringify(args)}`);

  return new Promise((res) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    let child;
    try {
      child = spawn("node", [resolved, ...args.map(String)], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      logger.error(`[run_node_script] spawn threw: ${err.message}`);
      return res({ content: [{ type: "text", text: `❌ Failed to spawn node: ${err.message}` }] });
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderrChunks.push(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch (err) {
        logger.error(`[run_node_script] SIGTERM failed: ${err.message}`);
      }
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trimEnd();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trimEnd();

      if (timedOut) {
        logger.error(`[run_node_script] timeout ${resolved} after ${TIMEOUT_MS}ms`);
      } else if (code !== 0) {
        logger.error(`[run_node_script] non-zero exit ${code} ${resolved} stderr: ${stderr.slice(0, 1000)}`);
      } else if (stderr) {
        logger.warn(`[run_node_script] exit 0 with stderr ${resolved}: ${stderr.slice(0, 500)}`);
      } else {
        logger.info(`[run_node_script] ok ${resolved}`);
      }

      const text = buildResponseText({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        scriptPath: resolved,
      });

      res({ content: [{ type: "text", text }] });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      logger.error(`[run_node_script] child error: ${err.message}`);
      res({ content: [{ type: "text", text: `❌ Failed to start script: ${err.message}` }] });
    });
  });
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
      description: "Run a Node.js script file and return its output. The script must be within an allowed write path. Use this to run skill scripts (e.g. skills/pptx/scripts/read.js). Only .js files are allowed.",
      inputSchema: z.object({
        script: z.string().describe("Absolute path to the .js script to run"),
        args:   z.array(z.string()).optional().describe("Arguments to pass to the script"),
      }),
    },
    runNodeScriptHandler
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
}
