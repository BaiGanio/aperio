import { isAbsolute, resolve as resolvePath } from "path";
import { isReadPathAllowed, isWritePathAllowed } from "../../../lib/routes/paths.js";

// Keep command grammar deliberately smaller than POSIX shell grammar. The
// executor consumes argv arrays directly (shell:false); this parser exists only
// for the backwards-compatible `command` string and supports quoting + pipes.
export const ALLOWED_CMDS = new Set([
  "node", "npm", "git", "ls", "cat", "grep", "rg", "find", "head", "tail", "wc",
  "python3", "soffice", "pdftoppm",
]);

const READ_UTILS   = new Set(["cat", "head", "tail", "grep", "rg", "wc", "ls"]);
const GIT_READONLY = new Set(["log", "status", "diff", "show", "remote", "branch", "rev-parse", "ls-files", "describe", "blame"]);
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprintf", "-fprint", "-fls"]);

function syntaxError(message, operator = null) {
  return { error: message, operator };
}

/**
 * Parse one backwards-compatible command string into an argv pipeline.
 * No shell expansion is performed. Newlines and shell control operators are
 * rejected even inside double quotes; single quotes are the only fully literal
 * quoting form, matching the security expectations in the tool description.
 */
export function parsePipeline(command) {
  if (typeof command !== "string" || !command.trim()) return syntaxError("No command provided");
  if (/[\0\r\n]/.test(command)) return syntaxError("Newlines and NUL bytes are not allowed in shell commands", "newline");

  const pipeline = [[]];
  let token = "", started = false, quote = null, escaped = false;
  const pushToken = () => {
    if (!started) return;
    pipeline.at(-1).push(token);
    token = "";
    started = false;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) {
      token += c;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      else token += c;
      started = true;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? null : '"';
      started = true;
      continue;
    }
    if (c === "'") {
      if (quote === '"') token += c;
      else quote = "'";
      started = true;
      continue;
    }

    // These constructs are meaningful to sh, including inside double quotes.
    // We never invoke sh, but rejecting them gives attempted redirection and
    // substitution an actionable error instead of silently passing literals.
    if (c === ";" || c === "&" || c === "<" || c === ">" || c === "`" ||
        (c === "$" && command[i + 1] === "(")) {
      return syntaxError(`Shell operator "${c === "$" ? "$(" : c}" is not allowed`, c === "$" ? "$(" : c);
    }
    if (c === "|" && quote !== '"') {
      pushToken();
      if (!pipeline.at(-1).length) return syntaxError("Empty command segment — check your pipes", "|");
      pipeline.push([]);
      continue;
    }
    if (/\s/.test(c) && quote !== '"') {
      pushToken();
      continue;
    }
    token += c;
    started = true;
  }

  if (escaped) return syntaxError("Command ends with an incomplete escape");
  if (quote) return syntaxError("Command contains an unmatched quote");
  pushToken();
  if (!pipeline.at(-1).length) return syntaxError("Empty command segment — check your pipes", "|");
  return { pipeline };
}

function looksLikePath(value) {
  return value.startsWith("/") || value.startsWith("~") || value.includes("/");
}

function resolveArg(value, cwd) {
  if (value.startsWith("~") || isAbsolute(value)) return value;
  return resolvePath(cwd, value);
}

function pathError(program, value, capability, cwd) {
  const allowed = capability === "write"
    ? isWritePathAllowed(resolveArg(value, cwd))
    : isReadPathAllowed(resolveArg(value, cwd));
  if (allowed) return null;
  return capability === "read"
    ? `${program}: file is not in an allowed read path: ${value}`
    : `${program}: script path is not in an allowed path: ${value}`;
}

function isNodeEvalFlag(value) {
  return /^-[ep]+$/.test(value) || /^--(eval|print)(=|$)/.test(value) || /^-(e|p)=/.test(value) || value === "-";
}

function isPyEvalFlag(value) {
  return value === "-c" || /^-c=/.test(value) || value === "-";
}

export function validateCommand(program, args, cwd) {
  if (!ALLOWED_CMDS.has(program)) {
    return `Command not allowed: "${program}". Allowed: ${[...ALLOWED_CMDS].join(", ")}`;
  }
  if (!Array.isArray(args) || args.some(value => typeof value !== "string")) {
    return `${program}: args must be an array of strings`;
  }

  if (program === "node" || program === "python3") {
    const isEval = program === "node" ? isNodeEvalFlag : isPyEvalFlag;
    for (const value of args) {
      if (isEval(value)) return `${program} inline-code flag "${value}" is not allowed — create the script with write_file, then run it by path.`;
      if (!value.startsWith("-") && looksLikePath(value)) {
        const error = pathError(program, value, "write", cwd);
        if (error) return error;
      }
    }
    return null;
  }

  if (program === "git") {
    for (const value of args) {
      if (value === "-c" || /^--exec-path=/.test(value)) return `git "${value}" is not allowed — it can execute arbitrary commands.`;
    }
    const subcommand = args.find(value => !value.startsWith("-"));
    if (!subcommand || !GIT_READONLY.has(subcommand)) {
      return `git "${subcommand ?? "(no subcommand)"}" is not allowed via run_shell — only read-only git: ${[...GIT_READONLY].join(", ")}.`;
    }
    return null;
  }

  if (program === "find") {
    for (const value of args) {
      if (FIND_ACTIONS.has(value)) return `find "${value}" is not allowed — it runs arbitrary programs or mutates files.`;
      if (!value.startsWith("-") && looksLikePath(value)) {
        const error = pathError(program, value, "read", cwd);
        if (error) return error;
      }
    }
    return null;
  }

  if (READ_UTILS.has(program)) {
    for (const value of args) {
      if (value.startsWith("-") || !looksLikePath(value)) continue;
      const error = pathError(program, value, "read", cwd);
      if (error) return error;
    }
    return null;
  }

  if (program === "soffice") {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--outdir" && args[i + 1]) {
        const error = pathError(program, args[++i], "write", cwd);
        if (error) return error;
      } else if (!args[i].startsWith("-") && looksLikePath(args[i])) {
        const error = pathError(program, args[i], "read", cwd);
        if (error) return error;
      }
    }
  }

  if (program === "pdftoppm" && args.length) {
    const positional = args.filter(value => !value.startsWith("-"));
    if (positional[0] && looksLikePath(positional[0])) {
      const error = pathError(program, positional[0], "read", cwd);
      if (error) return error;
    }
    if (positional[1] && looksLikePath(positional[1])) {
      const error = pathError(program, positional[1], "write", cwd);
      if (error) return error;
    }
  }

  // npm executes project-controlled scripts and remains part of the explicitly
  // trusted, host-level run_shell surface. Its filesystem reach cannot be
  // contained by argument inspection; cwd is still pinned by the caller.
  return null;
}

export function validatePipeline(pipeline, cwd) {
  for (const argv of pipeline) {
    if (!Array.isArray(argv) || !argv.length) return "Empty command segment — check your pipes";
    const error = validateCommand(argv[0], argv.slice(1), cwd);
    if (error) return error;
  }
  return null;
}
