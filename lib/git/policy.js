// lib/git/policy.js
//
// Fixed, non-configurable Git safety policy for the git_* tool surface
// (#343, WS2). Per the git-copilot plan §4, none of this is a setting —
// no env var flips any of it. Consumed by lib/git/runner.js and, once
// WS3-6 build the actual tools, by their argv builders.

import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { MAX_OUTPUT_BYTES } from "../../mcp/tools/shell.js";
import { GitPolicyError, GitValidationError } from "./errors.js";

// Reuse run_shell's output cap rather than defining a Git-specific one
// (plan §4 — APERIO_GIT_MAX_OUTPUT_BYTES was cut, this constant stands in
// for it everywhere in the git_* surface).
export { MAX_OUTPUT_BYTES };

// -c overrides prepended to every git invocation the runner makes. A
// repo's own .git/config cannot opt back into any of these — that's the
// point: "filters ... are always blocked" (plan §4) has to hold regardless
// of what the target repo has configured.
//   - protocol.ext.allow=never  — refuses the ext:: transport outright.
//   - core.fsmonitor=           — never invokes a configured fsmonitor hook.
//   - core.pager=cat            — no interactive pager on a non-interactive caller.
//   - filter.lfs.*=             — LFS smudge/clean/process blanked as a static
//     defense-in-depth belt-and-suspenders for the common case, in addition to
//     (not instead of) the dynamic discovery below — LFS can be wired up via
//     `.lfsconfig`, a file `git config --get-regexp` does not read, so the
//     dynamic pass alone isn't guaranteed to catch it.
//
// This list alone does NOT cover an arbitrary repo-defined filter (e.g.
// `.gitattributes` declaring `path filter=evil` plus a matching
// `filter.evil.clean` command) — git has no -c wildcard for "block every
// filter driver, whatever it's named." lib/git/runner.js's
// discoverConfiguredFilterDrivers() reads the target repo's own config on
// every call and blanks whatever driver names it actually finds; that
// dynamic pass, not this static list, is what makes "filters are always
// blocked" true for the general case. Verified empirically: an unblanked
// custom filter runs as the Aperio process on `git add`.
//
// NOTE: external diff/textconv are deliberately NOT handled here — `-c
// diff.external=` sets the value to the empty string, which git then tries
// to execute as a command (`cannot run : No such file or directory`), not
// "disabled". Those are blocked per-invocation instead, via DIFF_SAFETY_FLAGS
// below, only on the diff-family subcommands that understand the flag.
//
// core.hooksPath points every invocation at a directory that never contains
// any hook script — the standard way to fully disable git hooks — so a
// repo's own committed pre-commit/post-checkout/etc. hooks, or a repo-set
// core.hooksPath override, can never execute as the Aperio process. Verified
// empirically: an unblocked pre-commit hook runs, and post-checkout runs on
// `git checkout -b` (branch switch); pointing hooksPath at this directory
// blocks both while the underlying command still succeeds normally. Applied
// on EVERY invocation, not just mutating ones — the plan's carried-over
// out-of-scope list bans hooks outright (git-copilot.md §7), not just for
// some subset of commands. /dev/null itself isn't used because it's not a
// directory on every OS (breaks on Windows).
//
// The path is never created on disk — verified empirically that git treats a
// core.hooksPath pointing at a directory that does not exist exactly like an
// empty one: it finds no hook file, so nothing runs, and the underlying
// command still succeeds. An earlier version used mkdtempSync to create a
// real directory, but nothing ever removed it — every process that imported
// this module (including every test worker) leaked one
// aperio-git-noop-hooks-* directory into the OS temp root for good. Since
// git never needs the directory to actually exist, not creating it removes
// the leak instead of adding shutdown-hook cleanup for it.
// A fixed, predictable path would let another local process pre-create it
// (or a hooks/ subdir inside it) before Aperio starts, so a repo-issued
// commit/checkout would run whatever that process planted; a random,
// unguessable suffix (128 bits, well beyond mkdtemp's old 6-char one) closes
// that the same way the old directory's random suffix did, without needing
// the create-then-verify-ownership dance a real directory required.
function privateHooksPath() {
  return join(tmpdir(), `aperio-git-noop-hooks-${randomBytes(16).toString("hex")}`);
}
const NOOP_HOOKS_DIR = privateHooksPath();

export const SAFE_GIT_CONFIG = [
  // Transport allowlist enforced by Git ITSELF at the moment it actually
  // dials out, not by Aperio pre-checking a URL string. This matters because
  // a repo can set url.<base>.insteadOf / pushInsteadOf to silently rewrite
  // an approved https:// remote into something else (e.g. file://) right
  // before fetch/push uses it — assertAllowedRemote()'s `git remote get-url`
  // check in runner.js reads the pre-rewrite value and would miss that.
  // protocol.allow=never denies every transport by default; the two
  // protocol.<name>.allow=always lines re-permit only https and ssh. This is
  // the same mechanism git.protocol.allow (GIT_ALLOW_PROTOCOL) was added
  // for upstream, and it holds regardless of insteadOf rewriting, a
  // submodule's own remote config, or a bare local-path remote (git treats
  // that as the "file" protocol too, and protocol.file.allow is denied
  // here) — verified empirically.
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.ssh.allow=always",
  // Belt-and-suspenders: already covered by protocol.allow=never above, kept
  // explicit since ext:: was the first transport identified as a risk.
  "-c", "protocol.ext.allow=never",
  // A repo (or a submodule's .gitmodules) can set submodule.recurse=true, so
  // an ordinary checkout/merge/pull recursively updates initialized
  // submodules — running any smudge/clean filter or merge driver THAT
  // submodule defines, which discoverConfiguredDrivers() never sees because
  // it only scans the parent repo's config. Submodule operations are out of
  // scope entirely (git-copilot plan §7); forcing this off here means no
  // git_* call ever recurses into one, no matter what the repo configures.
  "-c", "submodule.recurse=false",
  "-c", "core.fsmonitor=",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=" + NOOP_HOOKS_DIR,
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.clean=",
  "-c", "filter.lfs.smudge=",
  // A repo can set core.sshCommand to an arbitrary command, which fetch/push
  // over an allowed ssh:// URL would then execute as the Aperio process.
  // Forcing plain "ssh" here overrides any repo-configured value (-c wins
  // over repo config) while leaving normal ssh (and the caller's own
  // GIT_SSH_COMMAND env, which outranks -c) untouched. Verified empirically.
  "-c", "core.sshCommand=ssh",
  // A repo can set commit.gpgsign/tag.gpgsign plus a custom gpg.program to
  // run an arbitrary command on every tool-issued commit/tag. Forcing these
  // false means git never consults gpg.program at all — verified empirically
  // that a configured marker program is not invoked once gpgsign is false.
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "push.gpgsign=false",
  // A repo can set credential.helper to "!<script>" (the "!" shell-escape
  // form), which git runs as a command whenever an https:// operation hits
  // an auth challenge. Setting it to the empty string here CLEARS the whole
  // accumulated helper list (repo, global, and system) for this invocation
  // rather than adding an entry — the documented way to fully disable
  // credential helpers — since nothing after it in this array re-adds one.
  // core.askPass is the same class of risk for the interactive-prompt path.
  "-c", "credential.helper=",
  "-c", "core.askPass=",
  // diff.external is an arbitrary command git runs INSTEAD of its own diff.
  // DIFF_SAFETY_FLAGS' --no-ext-diff alone does not hold: git's option
  // parsing lets a LATER --ext-diff win, and those flags are inserted before
  // the caller's own arguments. Verified empirically (git 2.50.1):
  // `git diff --no-ext-diff --ext-diff` runs the configured diff.external,
  // while `-c diff.external=` keeps it from running even with --ext-diff
  // present. Blanking the config is the part no argument order can undo;
  // rejectDiffSafetyOverrides() in runner.js refuses the flags as well.
  "-c", "diff.external=",
];

// Flags that switch a DIFF_SAFETY_FLAGS protection back on. These are
// refused outright rather than merely counter-flagged, because the counter
// would have to come last to win and the caller's arguments always come
// last. Only meaningful before a "--" separator — after it, an identically
// named token is a pathspec, not a flag.
export const DIFF_SAFETY_OVERRIDE_FLAGS = new Set(["--ext-diff", "--textconv"]);

// Every pathspec argument the runner passes to git is forced literal — no
// wildcard expansion at all, even without pathspec magic. `--` only ends
// option parsing; git still treats "*"/"?"/"[...]" inside a pathspec as a
// glob unless told otherwise. Verified empirically: `git add -- src/*.js`
// (invoked via execFile, no shell involved) stages every .js file under
// src/, not the literal (nonexistent) filename "src/*.js" — the explicit-
// paths guarantee in buildStageArgv means nothing without this. This is a
// GLOBAL flag (like SAFE_GIT_CONFIG's -c options, prepended before the
// subcommand), safe to apply on every invocation: it only changes how
// pathspec arguments are interpreted, and does not affect revision syntax
// like `git show HEAD:path` (verified) or any command that takes none.
export const LITERAL_PATHSPEC_FLAG = "--literal-pathspecs";

// `--no-ext-diff`/`--no-textconv` are diff-family flags, not global -c
// settings — passing them to a non-diff subcommand (e.g. `git commit
// --no-ext-diff`) is a git usage error, so the runner only appends these
// after one of the subcommands below, never blanket-prepended like
// SAFE_GIT_CONFIG.
export const DIFF_FAMILY_COMMANDS = new Set(["diff", "log", "show", "blame"]);
export const DIFF_SAFETY_FLAGS = ["--no-ext-diff", "--no-textconv"];

// Transport allowlist (plan §4): only https/ssh remotes. No file://, ext::,
// unencrypted git://, or bare local paths — those bypass the safe-config
// overrides above by never going through a network transport at all.
const ALLOWED_REMOTE_PROTOCOLS = new Set(["https:", "ssh:"]);
// scp-like shorthand (e.g. git@github.com:org/repo.git) is ssh without a
// scheme prefix — URL can't parse it, so it needs its own check.
const SCP_LIKE_REMOTE = /^[\w.-]+@[\w.-]+:.+$/;

export function isAllowedRemoteUrl(url) {
  if (typeof url !== "string" || !url) return false;
  if (SCP_LIKE_REMOTE.test(url)) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ALLOWED_REMOTE_PROTOCOLS.has(parsed.protocol);
}

// Explicit staging only (#348, #533's "commits another session's work"
// guard) — no "." / "-A" / empty-means-everything anywhere in the argv
// builder. `--` only ends option parsing; it does NOT make a broad
// pathspec literal. "." and "*" are real, always-matching pathspecs (the
// cwd, and "everything in the cwd" respectively — git's default pathspec
// matching is not anchored to one directory level, so "*" matches
// recursively too) — `git add -- .` genuinely stages the whole repo,
// verified empirically, not merely a theoretical concern. Reject them
// outright rather than forwarding them.
const BROAD_PATHSPECS = new Set([".", "./", "*", "**"]);

// Every git pathspec "magic" form — short (:!, :^, :/, ...) and long
// (:(top)..., :(glob)..., :(icase)..., ...) — is signaled by a leading ":"
// (gitglossary(7), "pathspec"). Blocking the four literal strings above is
// not enough: ":(top)**", ":/", and ":(glob)**" all bypass that check and
// still stage the entire repo, verified empirically. A plain relative file
// path never legitimately starts with ":", so this closes the whole class
// at once instead of chasing individual magic spellings.
const PATHSPEC_MAGIC_PREFIX = ":";

export function buildStageArgv(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new GitValidationError("git_stage requires a non-empty `paths` array");
  }
  for (const p of paths) {
    if (typeof p !== "string" || !p) {
      throw new GitValidationError("git_stage paths must be non-empty strings");
    }
    if (BROAD_PATHSPECS.has(p)) {
      throw new GitValidationError(`git_stage rejects the broad pathspec "${p}" — pass explicit file paths`);
    }
    if (p.startsWith(PATHSPEC_MAGIC_PREFIX)) {
      throw new GitValidationError(`git_stage rejects pathspec magic "${p}" — pass plain literal file paths`);
    }
  }
  return ["add", "--", ...paths];
}

// force-with-lease with an exact expected SHA is the only history-rewrite
// path (plan §4/§7).
//
// `--force-with-lease=<refname>:<expect>` checks <expect> against the
// DESTINATION ref on the remote, so <refname> must be the branch being
// pushed (refs/heads/<branch>) — NOT the local remote-tracking ref
// (refs/remotes/<remote>/<branch>). Verified empirically: passing the
// remote-tracking ref as <refname> makes git silently fail to match the
// lease to the push at all, so it falls back to an ordinary non-force
// rejection ("fetch first"/"non-fast-forward") even when the expected SHA
// is correct and the rewrite is legitimate — the lease never actually
// applies. `refs/heads/<branch>` is the form that works.
//
// The remote-tracking ref still has a role: use it (via
// runner.js#resolveRemoteTrackingSha) ONLY to obtain expectedSha — the
// last value this repo observed the remote at — never as the refname here.
export function buildForceWithLeaseArgv({ branch, expectedSha }) {
  if (!branch || typeof branch !== "string") {
    throw new GitValidationError("force-with-lease requires the destination branch name");
  }
  // Full object ID only — SHA-1 repos use 40 hex chars, SHA-256 repos use
  // 64; nothing shorter is accepted, since an abbreviated SHA doesn't meet
  // the "exact expected SHA" contract the lease depends on.
  if (!expectedSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedSha)) {
    throw new GitValidationError("force-with-lease requires a full 40 or 64 character expected SHA");
  }
  return [`--force-with-lease=refs/heads/${branch}:${expectedSha}`];
}

// Plain --force has no builder — by design. Any caller reaching for
// history rewrite is directed at buildForceWithLeaseArgv above; this
// exists so "is plain force ever reachable" has one obvious, greppable
// answer: no.
export function rejectPlainForce() {
  throw new GitPolicyError("plain --force is never allowed; use force-with-lease with an expected SHA");
}
