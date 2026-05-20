import { z }            from "zod";
import { spawn }         from "child_process";
import { dirname, resolve as resolvePath, extname } from "path";
import { existsSync }    from "fs";
import { isWritePathAllowed, isReadPathAllowed, getActivePaths } from "../../lib/routes/paths.js";

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

export async function runNodeScriptHandler({ script, args = [] }) {
  if (extname(script).toLowerCase() !== ".js")
    return { content: [{ type: "text", text: `❌ Only .js scripts are allowed` }] };

  const resolved = resolvePath(script);

  if (!isWritePathAllowed(resolved))
    return formatPathError(resolved);

  if (!existsSync(resolved))
    return { content: [{ type: "text", text: `❌ Script not found: ${resolved}` }] };

  const cwd = dirname(resolved);

  return new Promise((res) => {
    const chunks = [];
    let totalBytes = 0;
    let timedOut = false;

    const child = spawn("node", [resolved, ...args.map(String)], { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const onData = (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf-8").trimEnd();
      const truncNote = totalBytes > MAX_OUTPUT_BYTES
        ? `\n\n⚠️ Output truncated (${Math.round(totalBytes / 1024)}KB > ${MAX_OUTPUT_BYTES / 1024}KB limit)`
        : "";

      if (timedOut)
        return res({ content: [{ type: "text", text: `❌ Script timed out after ${TIMEOUT_MS / 1000}s\n${output}${truncNote}` }] });

      const prefix = code === 0 ? `✅ Exit 0\n` : `❌ Exit ${code}\n`;
      res({ content: [{ type: "text", text: `${prefix}${output}${truncNote}` }] });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
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

    const child = spawn("node", ["--check", resolved], { stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf-8").trimEnd();
      if (code === 0) {
        res({ content: [{ type: "text", text: `✅ Syntax OK: ${resolved}` }] });
      } else {
        res({ content: [{ type: "text", text: `❌ Syntax errors in ${resolved}:\n\n${output}\n\nFix using edit_file (targeted replacement), not write_file (full rewrite).` }] });
      }
    });

    child.on("error", (err) => {
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
