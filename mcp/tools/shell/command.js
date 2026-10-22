import { isAbsolute, resolve as resolvePath } from "path";
import { isReadPathAllowed, isWritePathAllowed } from "../../../lib/routes/paths.js";

// Keep command grammar deliberately smaller than POSIX shell grammar. The
// executor consumes argv arrays directly (shell:false); this parser exists only
// for the backwards-compatible `command` string and supports quoting + pipes.
export const ALLOWED_CMDS = new Set([
  "node", "npm", "git", "mkdir", "ls", "cat", "grep", "rg", "find", "head", "tail", "wc",
  "python3", "soffice", "pdftoppm",
]);

const READ_UTILS   = new Set(["cat", "head", "tail", "grep", "rg", "wc", "ls"]);
const GIT_READONLY = new Set(["log", "status", "diff", "show", "remote", "branch", "rev-parse", "ls-files", "describe", "blame"]);
// "init" is the one git write subcommand allowed via run_shell — it only ever
// creates a repo at a path, which the write-path check below still gates.
const GIT_INIT       = "init";
// add/commit only ever touch the repo at cwd (already write-path-gated by
// run_shell's cwd check), so they carry no remote/network risk.
const GIT_CWD_WRITE   = new Set(["add", "commit"]);
// push/pull/fetch/clone are allowed ONLY against a literal local filesystem
// path — never a URL, an ssh shorthand (user@host:path), or a named remote
// like "origin" (which resolves to whatever the repo's config points at).
// This is the same anti-exfiltration line that keeps curl off ALLOWED_CMDS:
// a network destination cannot be constrained by the path allowlist.
const GIT_LOCAL_REMOTE = new Set(["push", "pull", "fetch", "clone"]);

function isLocalGitPath(value) {
  return looksLikePath(value) && !/:\/\//.test(value) && !/^[^\s@]+@[^\s:]+:/.test(value);
}

// GITHUB_TOKEN being set IS the opt-in — no separate on/off flag. Read live,
// never cached at module load — .env is loaded by mcp/index.js's module body,
// which can run after this module is first evaluated (see mcp/tools/github.js's
// resolveToken for the same load-order note).
function githubRemoteEnabled() {
  return Boolean(process.env.GITHUB_TOKEN);
}

// Real URL parsing, not a substring test: "https://github.com@evil.com/x" has
// hostname "evil.com" and must be rejected, not matched on "github.com"
// appearing anywhere in the string. Credentials must be absent — the caller
// passes a bare URL and the trusted spawn layer adds the token, so the model
// (or anything that tricked it) never gets to embed its own auth in argv where
// it would end up in logs.
function isGithubRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" &&
    !url.username && !url.password;
}

function looksLikeGithubUrl(value) {
  return /^https?:\/\//i.test(value) && /(^|[./@])github\.com([/:]|$)/i.test(value);
}
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
    const subcommandIndex = args.indexOf(subcommand);

    if (subcommand === GIT_INIT) {
      const target = args.find(value => value !== GIT_INIT && !value.startsWith("-"));
      if (target) {
        const error = pathError(program, target, "write", cwd);
        if (error) return error;
      }
      return null;
    }

    if (GIT_CWD_WRITE.has(subcommand)) {
      for (const [i, value] of args.entries()) {
        if (i === subcommandIndex || value.startsWith("-") || !looksLikePath(value)) continue;
        const error = pathError(program, value, "write", cwd);
        if (error) return error;
      }
      return null;
    }

    if (GIT_LOCAL_REMOTE.has(subcommand)) {
      const positionals = args.filter((value, i) => i !== subcommandIndex && !value.startsWith("-"));
      const remoteHelp = githubRemoteEnabled() ? "a local filesystem path, or a bare https://github.com/<owner>/<repo>.git URL (no embedded credentials — the token is added automatically)" : "a local filesystem path";
      if (!positionals.length) {
        return `git "${subcommand}" needs an explicit target via run_shell — bare invocations and named remotes (e.g. "origin") are not allowed because they can resolve to an unexpected address. Pass ${remoteHelp}.`;
      }

      const target = positionals[0];
      if (isLocalGitPath(target)) {
        const remoteCapability = subcommand === "push" ? "write" : "read";
        const error = pathError(program, target, remoteCapability, cwd);
        if (error) return error;
      } else if (githubRemoteEnabled() && isGithubRemoteUrl(target)) {
        // allowed — token presence already confirmed by githubRemoteEnabled()
      } else if (looksLikeGithubUrl(target)) {
        return githubRemoteEnabled()
          ? `git "${subcommand}" target "${target}" is not a valid bare GitHub URL — use exactly https://github.com/<owner>/<repo>.git with no embedded credentials; the token is added automatically.`
          : `git "${subcommand}" to github.com needs GITHUB_TOKEN set in .env.`;
      } else {
        return `git "${subcommand}" target "${target}" must be ${remoteHelp} — ssh remotes and named remotes are not allowed (they can send this repo's contents to an unexpected destination).`;
      }

      if (subcommand === "clone" && positionals[1]) {
        const error = pathError(program, positionals[1], "write", cwd);
        if (error) return error;
      }
      return null;
    }

    if (!subcommand || !GIT_READONLY.has(subcommand)) {
      return `git "${subcommand ?? "(no subcommand)"}" is not allowed via run_shell — allowed: read-only (${[...GIT_READONLY].join(", ")}), "${GIT_INIT}", ${[...GIT_CWD_WRITE].join(", ")}, and ${[...GIT_LOCAL_REMOTE].join(", ")} (local paths, or github.com if enabled).`;
    }
    return null;
  }

  if (program === "mkdir") {
    for (const value of args) {
      if (value.startsWith("-")) continue;
      const error = pathError(program, value, "write", cwd);
      if (error) return error;
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

// Called only by the spawn layer, never during validation/logging: takes an
// already-validated argv and, if it targets a bare github.com URL, returns a
// NEW argv with the token embedded as userinfo. The model's own argv (and
// every log line built from it) never contains the token — this is the one
// place it gets added, right before the child process starts.
export function withGithubToken(argv, token) {
  if (argv[0] !== "git" || !token) return argv;
  const args = argv.slice(1);
  const subcommand = args.find(value => !value.startsWith("-"));
  if (!GIT_LOCAL_REMOTE.has(subcommand)) return argv;
  const subcommandIndex = args.indexOf(subcommand);
  const targetIndex = args.findIndex((value, i) => i !== subcommandIndex && !value.startsWith("-"));
  if (targetIndex === -1 || !isGithubRemoteUrl(args[targetIndex])) return argv;
  const url = new URL(args[targetIndex]);
  url.username = "x-access-token";
  url.password = token;
  const next = [...argv];
  next[targetIndex + 1] = url.toString(); // args[targetIndex] === argv[targetIndex + 1]
  return next;
}

export function validatePipeline(pipeline, cwd) {
  for (const argv of pipeline) {
    if (!Array.isArray(argv) || !argv.length) return "Empty command segment — check your pipes";
    const error = validateCommand(argv[0], argv.slice(1), cwd);
    if (error) return error;
  }
  return null;
}
