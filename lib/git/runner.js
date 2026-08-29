// lib/git/runner.js
//
// Shared repo-resolution + argv-safe runner for the git_* tools (#343, WS2).
// Every git_* tool call — read or write — funnels through runGit() so
// path-scope gating, the safe -c config overrides, and the output cap are
// enforced in exactly one place instead of once per tool.
//
// No mutation queue, no HEAD/index/worktree compare-and-swap (plan §6,
// WS2.4) — two concurrent mutating calls against the same repo serialize
// through Git's own .git/index.lock; whichever loses gets git's native
// lock error surfaced up as-is, not a custom Aperio error.

import { execFile, spawn } from "child_process";
import { lstat, readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "path";
import { isReadPathAllowed, isWritePathAllowed, realpathSafe } from "../routes/paths.js";
import { makeTailBiasedSink } from "../../mcp/tools/shell.js";
import { SAFE_GIT_CONFIG, DIFF_FAMILY_COMMANDS, DIFF_SAFETY_FLAGS, DIFF_SAFETY_OVERRIDE_FLAGS, LITERAL_PATHSPEC_FLAG, isAllowedRemoteUrl } from "./policy.js";
import { GitPolicyError } from "./errors.js";

const TIMEOUT_MS = 30_000;
// How long each rung of the timeout teardown waits before escalating:
// SIGTERM → (grace) → SIGKILL → (grace) → settle regardless. Short, because
// by this point the command has already blown its whole 30s budget.
const KILL_GRACE_MS = 2_000;
const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

// Signal git AND everything it forked. spawnGit makes the child a
// process-group leader (PGID == its PID) on POSIX, so a negative PID reaches
// the group; the PGID outlives the leader, so a lingering helper is still
// reachable after git itself is gone. Mirrors killByPid()'s group teardown in
// lib/helpers/startLlamaCpp.js. Falls back to the single child on any failure
// (and on Windows, where there is no group), and treats an already-exited
// target as success — it is exactly the outcome we wanted.
function signalChild(child, sig) {
  if (SUPPORTS_PROCESS_GROUPS && child.pid) {
    try { process.kill(-child.pid, sig); return; }
    catch { /* ESRCH (already gone) or not a group leader — fall through */ }
  }
  try { child.kill(sig); } catch { /* best effort */ }
}

// Calls the live `execFile` import binding at invocation time (rather than
// pre-binding it once via util.promisify at module load) so tests can spy
// on/replace child_process.execFile the same way tests/integration/mcp/tools
// /shell.test.js already does for spawn — a promisify() snapshot taken at
// import time would miss a mock installed afterward.
function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// Every preflight git invocation — the ones runGit makes to DECIDE whether
// the real command may run — goes through here, so none of them can forget
// the safe -c overrides the real command gets.
//
// This is not theoretical: the `git ls-files` index preflight used to run
// raw, and a repo-configured core.fsmonitor is an arbitrary command git
// executes when it reads the index. Verified empirically (git 2.50.1, fresh
// repo per measurement): raw `git ls-files -z -- <path>` runs the repo's
// fsmonitor hook, and `-c core.fsmonitor=` stops it — so a git_stage call
// naming a deleted path executed repo-controlled code as the Aperio process
// before the protected `git add` ever started. The other preflights
// (rev-parse, config --get-regexp, remote) do not read the index and were
// verified not to trigger it, but they run through here too: the guarantee
// should hold by construction, not by each caller's own analysis of what
// today's git happens to touch.
function runPreflightGit(args, options) {
  return execFileAsync("git", [...SAFE_GIT_CONFIG, ...args], options);
}

// Resolved fresh on every call — never cached across calls. The caller's
// cwd could point at a repo that changed, or a different repo entirely,
// between two tool invocations (the TOCTOU risk the plan's Risks table
// calls out); resolving once per call is the accepted mitigation.
export async function resolveRepoRoot(cwd) {
  try {
    const { stdout } = await runPreflightGit(["rev-parse", "--show-toplevel"], {
      cwd, timeout: TIMEOUT_MS, shell: false,
    });
    return stdout.trim();
  } catch {
    throw new GitPolicyError(`not a git repository: ${cwd}`);
  }
}

// --show-toplevel alone is not the whole boundary: an allowed directory can
// contain a .git FILE (not a directory) pointing at a git-dir elsewhere —
// most commonly a linked worktree (`git worktree add`), where --show-toplevel
// still reports the allowed worktree path, but the actual refs/index/objects
// live under the main repo's .git/worktrees/<name>, which can sit outside the
// allowlist entirely. Verified empirically: from inside such a worktree,
// --show-toplevel reports the allowed dir while --absolute-git-dir and
// --git-common-dir resolve to the outside repo's .git — `git show HEAD:path`
// then reads objects from there, and a mutating command writes its refs/index
// there, regardless of what --show-toplevel said. Resolving all three in one
// call (git evaluates each flag independently and prints one line per flag,
// in the order given) and gating on all three is what closes this.
//
// --git-common-dir (unlike --absolute-git-dir) is not guaranteed absolute —
// verified empirically it can print a path relative to `cwd` (e.g. "../.git")
// — so it's resolved against `cwd`, the same directory git was invoked in,
// before comparison.
async function resolveGitPaths(cwd) {
  try {
    const { stdout } = await runPreflightGit(
      ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
      { cwd, timeout: TIMEOUT_MS, shell: false }
    );
    const [repoRoot, gitDir, gitCommonDirRaw] = stdout.trim().split("\n");
    const gitCommonDir = isAbsolute(gitCommonDirRaw) ? gitCommonDirRaw : resolvePath(cwd, gitCommonDirRaw);
    return { repoRoot, gitDir, gitCommonDir };
  } catch {
    throw new GitPolicyError(`not a git repository: ${cwd}`);
  }
}

// A repo's objects/info/alternates file names OTHER object directories git
// will transparently read blobs/commits from — `git show`/`log`/`diff` (even
// a read-only call) resolve objects through it exactly as if they were local,
// and it chains: an alternate can itself have its own info/alternates
// pointing further out. Verified empirically: an allowed repo whose
// objects/info/alternates names a sibling repo's objects dir returns that
// sibling's file contents through `git show <sha>:path`, entirely outside the
// allowlist — none of --show-toplevel/--absolute-git-dir/--git-common-dir see
// this, since the alternate is consulted by git's object-lookup code, not the
// repo/worktree layer those three flags describe. There is no git config or
// env var that disables reading this file for one invocation (unlike
// protocol.allow or submodule.recurse), so the only correct fix is to resolve
// it ourselves and gate every directory it names — recursively, since a
// chain of three repos (A's alternate -> B, B's alternate -> C) was verified
// to reach C's content from A alone.
//
// Format, verified empirically against real git (2.50.1): one entry per
// line; blank lines and lines starting with "#" are comments, both skipped
// without error even when they'd otherwise be an invalid path; a relative
// entry resolves against the objects dir the alternates file lives in (NOT
// the file's own "info" parent) — confirmed by needing exactly enough ".."
// segments to reach <repo>/.git/objects, not <repo>/.git/objects/info. A
// leading '"' introduces git's C-style quoting for exotic paths (rare in
// practice); rather than reimplement that escape grammar and risk a subtly
// wrong unquote letting a path slip through unchecked, such a line fails the
// whole call closed — consistent with discoverConfiguredDrivers()'s
// fail-closed-on-anything-we-can't-confidently-parse stance below.
const MAX_ALTERNATE_CHAIN = 64;

// A real alternates file is a handful of path lines; this is generous
// headroom while still bounding what the server will buffer in memory.
const MAX_ALTERNATES_FILE_BYTES = 1_000_000;

// Bounded, regular-file-only read: an allowed repo can name (or symlink)
// objects/info/alternates at an arbitrary target, and readFile()'s
// unbounded buffering would let a huge file — or a non-terminating device
// like /dev/zero — exhaust server memory before Git's own timeout ever
// applies. stat().isFile() rejects device/fifo/socket targets outright
// (verified: a character device is never "regular"); the streamed byte cap
// bounds a large-but-regular file even under a stat/read TOCTOU race.
async function readAlternatesFile(path) {
  // The alternates FILE is its own boundary, not covered by gating the
  // objects directory that holds it: an allowed repo can make
  // objects/info/alternates a symlink to any regular file on disk, and both
  // stat() and createReadStream() follow it. Without this gate the server
  // reads an arbitrary out-of-bounds file, and its first line comes back to
  // the caller inside the "not an allowed read path" error the parse loop
  // then raises — a read escape AND a content leak. isReadPathAllowed
  // resolves symlinks (paths.js isUnder -> realpathSafe), so it catches the
  // link target; a file that simply doesn't exist resolves to its real
  // parent + basename, so the common no-alternates case still passes here
  // and returns null below.
  if (!isReadPathAllowed(path)) {
    throw new GitPolicyError(`${path} is not an allowed read path (git alternate object database list)`);
  }
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new GitPolicyError(`could not verify this repo's git alternate object databases, refusing to proceed: ${err.message}`);
  }
  if (!st.isFile()) {
    throw new GitPolicyError(`git alternate object database file at ${path} is not a regular file, refusing to proceed`);
  }
  if (st.size > MAX_ALTERNATES_FILE_BYTES) {
    throw new GitPolicyError(`git alternate object database file at ${path} exceeds ${MAX_ALTERNATES_FILE_BYTES} bytes, refusing to proceed`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const rs = createReadStream(path, { highWaterMark: 64 * 1024 });
    rs.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_ALTERNATES_FILE_BYTES) {
        rs.destroy();
        reject(new GitPolicyError(`git alternate object database file at ${path} exceeds ${MAX_ALTERNATES_FILE_BYTES} bytes, refusing to proceed`));
        return;
      }
      chunks.push(chunk);
    });
    rs.on("error", (err) => reject(new GitPolicyError(`could not verify this repo's git alternate object databases, refusing to proceed: ${err.message}`)));
    rs.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function resolveAlternateObjectDirs(objectsDir, visited = new Set(), depth = 0) {
  if (visited.has(objectsDir)) return [];
  visited.add(objectsDir);
  if (depth > MAX_ALTERNATE_CHAIN) {
    throw new GitPolicyError("git alternate object database chain exceeds the depth this check will verify, refusing to proceed");
  }

  const content = await readAlternatesFile(join(objectsDir, "info", "alternates"));
  if (content === null) return [];

  const dirs = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith('"')) {
      throw new GitPolicyError(`git alternate object database entry in ${objectsDir}/info/alternates uses quoting this check cannot safely verify, refusing to proceed`);
    }
    dirs.push(isAbsolute(line) ? line : resolvePath(objectsDir, line));
  }

  // Gate each resolved directory BEFORE recursing into it — recursing first
  // and checking the returned list afterward (the old order) would already
  // have opened and read a disallowed alternate's own info/alternates file
  // by the time the caller ever sees it, reading outside the permitted
  // boundary regardless of the eventual deny.
  const nested = [];
  for (const dir of dirs) {
    if (!isReadPathAllowed(dir)) {
      throw new GitPolicyError(`${dir} is not an allowed read path (reachable via git alternate object database)`);
    }
    nested.push(...await resolveAlternateObjectDirs(dir, visited, depth + 1));
  }
  return [...dirs, ...nested];
}

// The primary object store is its own boundary, separate from the three
// paths resolveGitPaths() reports: `.git/objects` can be a SYMLINK to an
// object database outside the allowlist while --show-toplevel,
// --absolute-git-dir and --git-common-dir all still report paths safely
// inside it. Verified empirically (git 2.50.1): replacing an allowed repo's
// .git/objects with a symlink to an outside repo's object store leaves all
// three flags unchanged, yet `git show <sha>:path` returns the OUTSIDE
// repo's file contents. Checking the alternates chain is not enough — the
// alternates file itself lives inside that symlinked directory, so reading
// it is already a read outside the boundary. isReadPathAllowed/
// isWritePathAllowed resolve symlinks (paths.js isUnder -> realpathSafe),
// so gating this path is what catches it.
function objectStorePath(gitCommonDir) {
  return join(gitCommonDir, "objects");
}

// Gating the git DIRECTORIES is not the whole boundary either: git resolves
// symlinks for the metadata files it locks and rewrites (lockfile.c's
// resolve_symlink), so an allowed repo whose .git/index is a symlink to a
// file outside the allowlist has that OUTSIDE file rewritten by `git add` —
// verified empirically (git 2.50.1): the symlink survives the write and the
// external target's contents change. The same lockfile path writes HEAD,
// config, packed-refs and everything under refs/ and logs/, and on a
// read-only call a symlinked HEAD/ref reads out of bounds just as easily,
// so this walks the git dirs and gates every symlink it finds, in both
// directions.
//
// Symlinks are never FOLLOWED by the walk — an in-bounds symlink is checked
// and skipped — so a loop or a link to a huge tree cannot make this recurse
// forever.
//
// The object store is walked in FULL, subdirectories included. Stopping at
// objects/ (an earlier version of this check, on the theory that only the
// store's own path mattered) left the escape wide open, verified empirically
// both ways against git 2.50.1:
//   - symlinking another repo's pack-*.pack/.idx into objects/pack/ makes
//     `git show <sha>:path` return that repo's file contents;
//   - symlinking a single loose object into a fanout dir (objects/ab/cdef…)
//     makes `git cat-file -p <blob>` print it.
// Both are ordinary object lookups — nothing at the directory level sees
// them, so every entry under the store has to be gated individually.
//
// Cost, measured on this machine with readdir({ withFileTypes: true }) (one
// syscall per directory, no per-entry lstat): 15ms for this repo's whole
// .git (1952 entries), 82ms for a synthetic store with 102400 loose
// objects. The budget below therefore sits well above any healthy repo —
// a store past it has not been packed in a very long time, and failing
// closed there beats silently skipping the scan.
const MAX_METADATA_ENTRIES = 200_000;

// readdir({ withFileTypes: true }) is one syscall per directory instead of one
// lstat per entry — but only because the kernel returns a d_type with each
// entry, and not every filesystem does. Where it returns DT_UNKNOWN (NFS, SMB,
// some FUSE mounts, XFS without ftype), libuv passes that straight through and
// Node's Dirent answers FALSE to every is*() predicate — verified: a
// `new Dirent("x", 0, "/tmp")` reports false for isSymbolicLink, isDirectory,
// isFile, isFIFO, isSocket, isCharacterDevice AND isBlockDevice. The walk below
// keys off exactly those two predicates, so on such a mount every entry looks
// like "not a symlink, not a directory": escaping metadata symlinks go ungated
// and whole subdirectories (the object store's fanout dirs included) go
// unvisited, silently. Node exposes no isUnknown(), so "no predicate is true"
// is the test, and only those entries pay for a per-entry lstat — a normal
// ext4/APFS repo does none.
function direntTypeIsKnown(entry) {
  return entry.isSymbolicLink() || entry.isDirectory() || entry.isFile()
    || entry.isFIFO() || entry.isSocket()
    || entry.isCharacterDevice() || entry.isBlockDevice();
}

// lstat(), never stat(): the point is to classify the ENTRY, and following a
// symlink here would both defeat the gate and read out of bounds to do it.
async function classifyEntry(entry, full) {
  if (direntTypeIsKnown(entry)) {
    return { isSymlink: entry.isSymbolicLink(), isDir: entry.isDirectory() };
  }
  try {
    const st = await lstat(full);
    return { isSymlink: st.isSymbolicLink(), isDir: st.isDirectory() };
  } catch (err) {
    // A racing delete leaves nothing to gate. Anything else fails closed, the
    // same way an unreadable directory does below — an entry we cannot
    // classify must never be waved through as "not a symlink".
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return { isSymlink: false, isDir: false };
    throw new GitPolicyError(`could not verify the git metadata entry ${full}, refusing to proceed: ${err.message}`);
  }
}

async function assertNoEscapingMetadataSymlinks(gitDirs, mutating) {
  const isAllowed = mutating ? isWritePathAllowed : isReadPathAllowed;
  const walked = new Set();
  let budget = MAX_METADATA_ENTRIES;

  async function walk(dir) {
    if (walked.has(dir)) return;
    walked.add(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return;
      // Fail closed — an unreadable git dir must not pass as "no symlinks".
      throw new GitPolicyError(`could not verify this repo's git metadata for out-of-bounds symlinks, refusing to proceed: ${err.message}`);
    }

    for (const entry of entries) {
      if (--budget < 0) {
        throw new GitPolicyError(`this repo's git metadata has more entries than this check will verify (${MAX_METADATA_ENTRIES}), refusing to proceed — run "git gc" to pack loose objects`);
      }
      const full = join(dir, entry.name);
      const { isSymlink, isDir } = await classifyEntry(entry, full);
      if (isSymlink) {
        if (!isAllowed(full)) {
          throw new GitPolicyError(`${full} is a git metadata symlink pointing outside the allowed ${mutating ? "write" : "read"} paths`);
        }
        continue;
      }
      if (isDir) {
        await walk(full);
      }
    }
  }

  for (const gitDir of gitDirs) {
    await walk(gitDir);
  }
}

// Shared by runGit and resolveRemoteTrackingSha — every exported entry
// point that resolves a repo path must gate the worktree AND both git-dir
// paths (see resolveGitPaths()) plus the object store above, before doing
// anything with them, not just runGit's own main path.
function assertPathBoundary(paths, mutating) {
  const isAllowed = mutating ? isWritePathAllowed : isReadPathAllowed;
  for (const p of paths) {
    if (!isAllowed(p)) {
      throw new GitPolicyError(`${p} is not an allowed ${mutating ? "write" : "read"} path`);
    }
  }
}

// The expectedSha half of buildForceWithLeaseArgv (lib/git/policy.js) —
// resolves this repo's LOCAL view of a remote-tracking branch, i.e. what it
// last saw at refs/remotes/<remote>/<branch> (normally right after a
// fetch). This is ONLY where that ref belongs in the force-with-lease flow:
// as the source of expectedSha, never as the lease's own refname (policy.js
// explains why passing it as the refname silently no-ops the lease).
export async function resolveRemoteTrackingSha(cwd, remote, branch) {
  const { repoRoot, gitDir, gitCommonDir } = await resolveGitPaths(cwd);
  assertPathBoundary([repoRoot, gitDir, gitCommonDir, objectStorePath(gitCommonDir)], false);
  await assertNoEscapingMetadataSymlinks([gitDir, gitCommonDir], false);
  try {
    const { stdout } = await runPreflightGit(["rev-parse", `refs/remotes/${remote}/${branch}`], {
      cwd: repoRoot, timeout: TIMEOUT_MS, shell: false,
    });
    return stdout.trim();
  } catch {
    throw new GitPolicyError(`no local remote-tracking ref for ${remote}/${branch} — fetch first`);
  }
}

// diff/log/show/blame get --no-ext-diff/--no-textconv inserted right after
// the subcommand, unconditionally — the repo's own diff.external/textconv
// config can never re-enable them (see policy.js's DIFF_SAFETY_FLAGS note).
//
// These flags are inserted BEFORE the caller's own arguments, and git's
// option parsing lets the last occurrence win, so they are a floor only as
// long as nothing later flips them back. rejectDiffSafetyOverrides() below
// refuses exactly those flags, and SAFE_GIT_CONFIG's `diff.external=` plus
// driverBlockingConfig()'s per-driver blanking mean there is no configured
// command left to run even if one ever slipped through.
function withDiffSafety(argv) {
  if (!DIFF_FAMILY_COMMANDS.has(argv[0])) return argv;
  return [argv[0], ...DIFF_SAFETY_FLAGS, ...argv.slice(1)];
}

// Verified empirically (git 2.50.1): `git diff --no-ext-diff --ext-diff`
// runs the repo's configured diff.external, and the same later-wins
// ordering re-enables textconv — so a caller-supplied --ext-diff/--textconv
// turned a read-only git_* call into arbitrary host command execution.
// Scanned only up to a "--" separator: past that, an identically named
// token is a pathspec (a real file may be named "--textconv"), not a flag.
function rejectDiffSafetyOverrides(argv) {
  const dashIndex = argv.indexOf("--");
  const flags = dashIndex === -1 ? argv : argv.slice(0, dashIndex);
  for (const arg of flags) {
    if (DIFF_SAFETY_OVERRIDE_FLAGS.has(arg)) {
      throw new GitPolicyError(`"${arg}" is not allowed — it re-enables repository-configured external diff/textconv commands`);
    }
  }
}

// SAFE_GIT_CONFIG only blanks the well-known LFS filter name. A repo can
// define ANY filter via .gitattributes (`path filter=evil`) plus matching
// `filter.evil.clean`/`smudge`/`process` config, and separately, ANY custom
// merge driver via `path merge=evil` plus `merge.evil.driver` — git has no
// -c wildcard for "disable every filter/merge driver, whatever it's named,"
// so the only correct fix is to read the repo's own config first and blank
// whatever driver names it actually defines, on EVERY call: filters can run
// on read operations too (smudge), and merge drivers matter for more than
// just `merge`/`rebase` — cherry-pick and revert invoke them on conflict
// too, so this isn't scoped to a "merge-family command" allowlist.
//
// The same shape applies to DIFF drivers: `.gitattributes` `path diff=evil`
// plus `diff.evil.textconv` or `diff.evil.command` names an arbitrary
// command git runs to render or diff that path. SAFE_GIT_CONFIG's blanket
// `diff.external=` only covers the global external-diff hook, not these
// per-driver ones, so they are discovered and blanked here alongside the
// filter/merge drivers — verified empirically that a configured
// diff.<name>.textconv and diff.<name>.command both run under
// `git diff --no-textconv --textconv` / `--no-ext-diff --ext-diff`, and
// neither runs once its config key is blanked.
//
// `git config --get-regexp` exits 1 (not an error for us) when nothing
// matches — that's the common case of a repo with no custom filters/drivers.
// Any OTHER failure (a corrupt config, a timeout, or output overflowing
// execFile's default 1MB buffer from a repo stuffed with junk config
// entries — a real way to hide a driver from this exact scan) must NOT be
// treated as "nothing found": that would run the real command with no
// blocking overrides at all. Fail closed — deny the whole git_* call —
// rather than silently degrading to an empty set for anything but the one
// exit code that actually means "empty".
async function discoverConfiguredDrivers(repoRoot) {
  let stdout;
  try {
    ({ stdout } = await runPreflightGit(
      ["config", "--get-regexp", "^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver|diff\\..*\\.(textconv|command))$"],
      { cwd: repoRoot, timeout: TIMEOUT_MS, shell: false }
    ));
  } catch (err) {
    if (err.code === 1) return { filterDrivers: new Set(), mergeDrivers: new Set(), diffDrivers: new Set() };
    throw new GitPolicyError(`could not verify this repo's configured Git filter/merge/diff drivers, refusing to proceed: ${err.message}`);
  }
  const filterDrivers = new Set();
  const mergeDrivers = new Set();
  const diffDrivers = new Set();
  for (const line of stdout.split("\n")) {
    const key = line.split(" ")[0];
    const filterMatch = key.match(/^filter\.(.+)\.(clean|smudge|process|required)$/);
    if (filterMatch) { filterDrivers.add(filterMatch[1]); continue; }
    const mergeMatch = key.match(/^merge\.(.+)\.driver$/);
    if (mergeMatch) { mergeDrivers.add(mergeMatch[1]); continue; }
    const diffMatch = key.match(/^diff\.(.+)\.(textconv|command)$/);
    if (diffMatch) diffDrivers.add(diffMatch[1]);
  }
  return { filterDrivers, mergeDrivers, diffDrivers };
}

// fetch/push are the only git_* subcommands that talk to a remote (per plan
// §7 — no compound "pull", no arbitrary refspecs beyond what WS5's tools
// build). isAllowedRemoteUrl() on its own only defines the rule; nothing
// consulted it before executing, so a call naming a file:// remote (direct,
// or via a locally-configured remote name pointing at one) ran unchecked.
// This resolves the EFFECTIVE URL — following a named remote to what it's
// actually configured to — right before the command runs, and denies it.
const REMOTE_TOUCHING_COMMANDS = new Set(["fetch", "push"]);

// The remote name(s) an invocation actually touches:
//   - `fetch --all` fetches EVERY remote configured in the repo, not just
//     "origin" — a single-token scan finds no non-flag argument here and
//     falls back to "origin," leaving any other (possibly disallowed)
//     remote unvalidated. Resolve the real list via `git remote`.
//   - `fetch --multiple <a> <b> ...` fetches every named remote, not just
//     the first — validate all of them, not one.
//   - otherwise, the single first non-flag token is the target, defaulting
//     to "origin" exactly as git itself does when none is given.
async function extractRemoteTokens(repoRoot, argv) {
  if (argv.includes("--all")) {
    const { stdout } = await runPreflightGit(["remote"], {
      cwd: repoRoot, timeout: TIMEOUT_MS, shell: false,
    });
    const remotes = stdout.split("\n").map(s => s.trim()).filter(Boolean);
    return remotes.length ? remotes : ["origin"];
  }
  const tokens = argv.slice(1).filter(a => !a.startsWith("-"));
  if (argv.includes("--multiple")) {
    return tokens.length ? tokens : ["origin"];
  }
  return [tokens[0] ?? "origin"];
}

// `git remote get-url <name>` returns the FETCH url. Git prefers
// remote.<name>.pushurl for an actual push when one is configured, so a
// remote with an allowed https fetch URL and a separate, disallowed
// pushurl (e.g. file://) passed the old fetch-only check while still
// pushing to the local target — verified empirically. `--push` asks for
// the push URL instead; a remote can also configure MULTIPLE pushurls
// (git pushes to all of them), so `--push --all` is required too — `--push`
// alone silently returns only the first one, verified empirically to miss
// a second, disallowed pushurl entirely.
async function resolveEffectiveRemoteUrls(repoRoot, remoteToken, { forPush }) {
  const args = forPush ? ["remote", "get-url", "--push", "--all", remoteToken] : ["remote", "get-url", remoteToken];
  try {
    const { stdout } = await runPreflightGit(args, {
      cwd: repoRoot, timeout: TIMEOUT_MS, shell: false,
    });
    return stdout.split("\n").map(s => s.trim()).filter(Boolean);
  } catch {
    // Not a configured remote name in this repo — the token itself is the
    // URL/spec being pushed/fetched directly.
    return [remoteToken];
  }
}

// remote.<name>.vcs makes git ignore the URL's scheme and hand the whole
// operation to the remote helper `git-remote-<value>` found on PATH. The
// transport allowlist does gate the VALUE (verified empirically, git 2.50.1:
// remote.origin.vcs=bogus and =ext both die with "transport not allowed"
// under SAFE_GIT_CONFIG) — but "ssh" is one of the two names we must permit,
// and git ships no git-remote-ssh. So a repo setting remote.origin.vcs=ssh
// turns an ordinary fetch/push into "execute whatever binary named
// git-remote-ssh is first on this process's PATH", while
// assertAllowedRemote's `git remote get-url` still reports the innocuous
// https URL. Verified empirically: with a marker script named git-remote-ssh
// on PATH, `git ... fetch origin` ran it and passed it the https URL.
//
// Blanking the key (-c remote.<name>.vcs=) is NOT the fix — an empty value
// is itself parsed as a transport name ("fatal: transport '' not allowed"),
// which would break every legitimate fetch/push. Detection + denial is.
// Every remote is checked, not just the one being touched: rejecting the
// key's mere presence needs no name-matching logic to get right, and no
// git_* operation (https/ssh only, plan §4) has any legitimate use for a
// foreign-VCS helper. Fails closed on any error but exit 1 ("no matches"),
// exactly like discoverConfiguredDrivers().
async function assertNoRemoteHelperOverride(repoRoot) {
  let stdout;
  try {
    ({ stdout } = await runPreflightGit(
      ["config", "--get-regexp", "^remote\\..*\\.vcs$"],
      { cwd: repoRoot, timeout: TIMEOUT_MS, shell: false }
    ));
  } catch (err) {
    if (err.code === 1) return; // no remote.*.vcs configured — the normal case
    throw new GitPolicyError(`could not verify this repo's remote helper configuration, refusing to proceed: ${err.message}`);
  }
  const keys = stdout.split("\n").map(l => l.split(" ")[0]).filter(Boolean);
  if (keys.length) {
    throw new GitPolicyError(`remote helper override not allowed: this repo configures ${keys.join(", ")}, which would run an external git-remote-* helper instead of git's own https/ssh transport`);
  }
}

async function assertAllowedRemote(repoRoot, argv) {
  if (!REMOTE_TOUCHING_COMMANDS.has(argv[0])) return;
  await assertNoRemoteHelperOverride(repoRoot);
  const tokens = await extractRemoteTokens(repoRoot, argv);
  for (const token of tokens) {
    const urls = await resolveEffectiveRemoteUrls(repoRoot, token, { forPush: argv[0] === "push" });
    for (const url of urls) {
      if (!isAllowedRemoteUrl(url)) {
        throw new GitPolicyError(`remote transport not allowed: "${url}" (only https/ssh)`);
      }
    }
  }
}

// buildStageArgv's (policy.js) explicit-file-only guarantee means nothing
// if a directory pathspec still reaches `git add`: --literal-pathspecs only
// turns off glob magic ("*", "?", "[...]"), not git's ordinary
// directory-matching — `git add -- src` still recursively stages every
// change under src/ even with that flag set, verified empirically. Checked
// here rather than in buildStageArgv because only the runner resolves a
// repo root to stat pathspecs against.
//
// Containment is checked LEXICALLY, before any filesystem call: a pathspec
// like "/etc" or "../../outside" would otherwise be handed straight to
// stat(), reading metadata outside the allowed boundary (and revealing
// whether the target is a directory) for a path git was going to reject
// anyway. resolvePath() does no I/O, so the deny happens with no access at
// all. Testing against repoRoot rather than the allowlist directly is the
// stricter check here — repoRoot has already cleared the write gate, and a
// pathspec must be inside the repo for git to accept it regardless.
//
// The lexical check alone is not the whole boundary, because resolvePath()
// is lexical in BOTH directions: it also fails to notice a symlink in the
// middle of the pathspec. For "link/secret.txt", where "link" is an in-repo
// symlink to an outside directory, the string still starts with repoRoot and
// passes — and lstat() only declines to follow the FINAL component, so it
// happily walks through "link" and stats the outside file. Verified
// empirically: lstat("link/secret.txt") returns isFile true and the real
// size of a file outside the repo. Git itself then refuses the pathspec
// ("fatal: ... is beyond a symbolic link"), so nothing gets staged — but the
// out-of-bounds metadata read has already happened, which is exactly the
// zero-I/O-outside-the-boundary guarantee this function claims above.
//
// So the PARENT chain is resolved through realpathSafe (the shared path
// primitive) and re-checked. Only the parent: the final component is allowed
// to be a symlink, because git stages such a path as the link itself and
// never reads its target — rejecting it would break legitimate staging of a
// tracked symlink. repoRoot needs resolving too, since it is the comparison
// baseline (git's --show-toplevel does resolve symlinks — verified — but
// realpathSafe is idempotent and costs one call per git_stage).
//
// The metadata call itself is lstat(), not stat(): a symlink in the worktree
// is staged by git as the LINK (its target is never read), so following it
// would both read out-of-bounds metadata and misjudge a symlink-to-directory
// as a directory pathspec when git would treat it as a single file.
async function assertNoDirectoryPathspecs(repoRoot, argv) {
  if (argv[0] !== "add") return;
  const dashIndex = argv.indexOf("--");
  const paths = dashIndex === -1 ? argv.slice(1) : argv.slice(dashIndex + 1);
  const realRoot = realpathSafe(repoRoot);
  for (const p of paths) {
    const full = resolvePath(repoRoot, p);
    if (full !== repoRoot && !full.startsWith(repoRoot + sep)) {
      throw new GitPolicyError(`git_stage rejects the pathspec "${p}" — it resolves outside the repository at ${repoRoot}`);
    }
    const realParent = realpathSafe(dirname(full));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
      throw new GitPolicyError(`git_stage rejects the pathspec "${p}" — it traverses a symlink that leads outside the repository at ${repoRoot}`);
    }
    let st = null;
    try {
      st = await lstat(full);
    } catch { /* not on disk — the index check below decides, not lstat */ }
    if (st?.isDirectory()) {
      throw new GitPolicyError(`git_stage rejects the directory pathspec "${p}" — pass explicit file paths, not a directory`);
    }
    if (!st) await assertPathspecIsNotTrackedDirectory(repoRoot, p);
  }
}

// A pathspec missing from disk is NOT automatically harmless. When a tracked
// directory has been deleted from the worktree, stat() throws ENOENT while
// `git add -- <dir>` still stages every tracked deletion beneath it —
// verified empirically: after `rm -rf src`, `git add -- src` exits 0 having
// staged `D src/a.txt` and `D src/sub/b.txt`. That is exactly the recursive,
// multi-file staging buildStageArgv's explicit-file-only guarantee exists to
// prevent, and a live way to sweep a concurrent session's deletions into
// this session's commit (AGENTS.md's don't-touch-another-session's-work
// rule). The worktree can't answer for a path that isn't there, so the index
// is the remaining source of truth: `git ls-files` lists the tracked entries
// a pathspec matches whether or not they still exist on disk.
//
// Exactly one entry equal to the pathspec itself means a deleted FILE —
// allowed, since staging that single deletion is still explicit. No entries
// means git doesn't know the path at all; that stays git's own error to
// report, not a policy denial. Anything else means the pathspec names a
// directory in the index. `--literal-pathspecs` mirrors the real invocation
// so this check reads the pathspec exactly the way `git add` will.
async function assertPathspecIsNotTrackedDirectory(repoRoot, pathspec) {
  let stdout;
  try {
    ({ stdout } = await runPreflightGit(
      [LITERAL_PATHSPEC_FLAG, "ls-files", "-z", "--", pathspec],
      { cwd: repoRoot, timeout: TIMEOUT_MS, shell: false }
    ));
  } catch (err) {
    // Fail closed: an unreadable index must never be read as "matches nothing".
    throw new GitPolicyError(`could not verify the pathspec "${pathspec}" against this repo's index, refusing to proceed: ${err.message}`);
  }
  const entries = stdout.split("\0").filter(Boolean);
  if (entries.length === 0) return;
  if (entries.length === 1 && resolvePath(repoRoot, entries[0]) === resolvePath(repoRoot, pathspec)) return;
  throw new GitPolicyError(`git_stage rejects the directory pathspec "${pathspec}" — it matches ${entries.length} tracked paths in the index; pass explicit file paths, not a directory`);
}

function driverBlockingConfig({ filterDrivers, mergeDrivers, diffDrivers }) {
  const argv = [];
  for (const name of filterDrivers) {
    argv.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`);
  }
  for (const name of mergeDrivers) {
    argv.push("-c", `merge.${name}.driver=`);
  }
  for (const name of diffDrivers) {
    argv.push("-c", `diff.${name}.textconv=`, "-c", `diff.${name}.command=`);
  }
  return argv;
}

// Streams stdout/stderr directly into the tail-biased sinks as chunks arrive,
// rather than letting execFile materialize up to MAX_BUFFER (64MB) of each
// before the cap is applied afterward — a large blob (git show/log -p) or
// several concurrent calls could otherwise spike memory well past the
// 48000-byte output the caller ever actually sees. Never throws on a
// non-zero exit (unlike execFile) — the exit code is read straight off the
// "close" event, so runGit's caller-facing shape ({ code, stdout, stderr })
// needs no separate success/failure branch here.
// Exported only so the timeout/teardown contract can be exercised directly
// with a short deadline — driving it through runGit() would mean waiting out
// the real 30s TIMEOUT_MS on every run. Not part of the git_* tool surface.
export function spawnGit(argv, { cwd, timeout }) {
  return new Promise((resolve) => {
    const outBuf = makeTailBiasedSink();
    const errBuf = makeTailBiasedSink();
    let child;
    try {
      child = spawn("git", argv, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group (POSIX), so teardown can reach descendants git
        // forked — a remote helper or ssh that outlives git still holds the
        // inherited stdout/stderr pipes open, and signaling git's PID alone
        // leaves them running. Windows has no equivalent; child.kill() there
        // is the best available.
        detached: SUPPORTS_PROCESS_GROUPS,
      });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: err.message });
      return;
    }

    let timedOut = false;
    let settled = false;
    const timers = [];
    // The promise must settle exactly once and never outlive the deadline
    // chain below, even if "close" never arrives.
    const finish = (code, extraStderr) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      const tail = [errBuf.toString(), extraStderr].filter(Boolean).join("\n").trim();
      resolve({ code, stdout: outBuf.toString(), stderr: tail });
      // Nothing reads these after settling; dropping them releases the pipes
      // rather than accumulating chunks from a child we've given up on.
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    timers.push(setTimeout(() => {
      timedOut = true;
      signalChild(child, "SIGTERM");
      // Escalate for anything that ignores (or is blocked from handling)
      // SIGTERM, then give up on "close" entirely. Without this last step a
      // descendant holding the stdio pipes open keeps the promise — and the
      // tool call — pending forever, so the advertised timeout is not hard.
      timers.push(setTimeout(() => {
        signalChild(child, "SIGKILL");
        timers.push(setTimeout(() => {
          finish(1, `[aperio] git command timed out after ${timeout}ms and did not exit after SIGTERM/SIGKILL`);
        }, KILL_GRACE_MS));
      }, KILL_GRACE_MS));
    }, timeout));

    child.stdout.on("data", (chunk) => outBuf.push(chunk));
    child.stderr.on("data", (chunk) => errBuf.push(chunk));

    child.on("error", (err) => finish(1, err.message));

    child.on("close", (code) => {
      finish(
        typeof code === "number" ? code : 1,
        timedOut ? `[aperio] git command timed out after ${timeout}ms` : ""
      );
    });
  });
}

/**
 * Run one git command through the shared policy gate.
 *
 * @param {string} cwd - any path inside the target repo (or a worktree).
 * @param {string[]} argv - git subcommand + args, WITHOUT the safe -c
 *   overrides (those are prepended here, always).
 * @param {boolean} mutating - true requires the resolved repo root to pass
 *   isWritePathAllowed; false (read-only) requires isReadPathAllowed. Aperio
 *   has one allowed-folders list for both (AGENTS.md: "no read-only tier") —
 *   a read-only git call (status/diff/log/show) can still return full file
 *   contents (e.g. `git show HEAD:path`), so it must clear the same
 *   boundary every other read tool does, not run unrestricted against any
 *   resolvable repo on disk. Supersedes plan WS2.1's original "read-only is
 *   allowed on any resolvable repo" call.
 */
export async function runGit({ cwd, argv, mutating }) {
  const { repoRoot, gitDir, gitCommonDir } = await resolveGitPaths(cwd);

  // Gate the worktree AND both git-dir paths — see resolveGitPaths() for why
  // --show-toplevel alone (the old check) isn't the real boundary. A read-only
  // call still needs the gitCommonDir check: `git show`/`log`/`diff` read
  // objects straight out of it, not just the worktree.
  //
  // The primary object store is gated here too (see objectStorePath()) —
  // BEFORE the alternates walk below, which would otherwise open a file
  // inside an out-of-bounds directory to do its own checking. It's gated
  // with `mutating`, not read-only like the alternates: git only ever reads
  // an alternate, but it WRITES new objects into the primary store, so a
  // mutating call must clear the write boundary for it.
  const objectsDir = objectStorePath(gitCommonDir);
  assertPathBoundary([repoRoot, gitDir, gitCommonDir, objectsDir], mutating);

  // Directory-level gating is not enough on its own — see
  // assertNoEscapingMetadataSymlinks() for the symlinked-.git/index write
  // escape and the symlinked-pack/loose-object read escape it closes.
  // objectsDir is scanned explicitly as well as via gitCommonDir: when
  // objects/ is ITSELF an (allowed) symlink, the walk gates that link and
  // stops rather than following it, so the store behind it would otherwise
  // go unscanned.
  await assertNoEscapingMetadataSymlinks([gitDir, gitCommonDir, objectsDir], mutating);

  // Alternate object databases are consulted for every invocation, mutating
  // or not (git never writes into one, only reads). resolveAlternateObjectDirs
  // itself gates every directory it finds — against the READ allowlist,
  // regardless of `mutating`, since that's the only capability an alternate
  // can actually expose — before ever reading into it, so nothing further
  // is needed here; see its own comments for why the gate has to happen
  // before, not after, that read.
  //
  // The dirs it returns still need the symlink scan of their own: an
  // alternate that clears the boundary can hold a symlinked pack or loose
  // object pointing back out of it, the exact escape the scan closes for the
  // primary store. Read-only regardless of `mutating` — git never writes
  // into an alternate.
  const alternateDirs = await resolveAlternateObjectDirs(objectsDir);
  if (alternateDirs.length) {
    await assertNoEscapingMetadataSymlinks(alternateDirs, false);
  }

  rejectDiffSafetyOverrides(argv);

  await assertNoDirectoryPathspecs(repoRoot, argv);

  await assertAllowedRemote(repoRoot, argv);

  const drivers = await discoverConfiguredDrivers(repoRoot);

  const result = await spawnGit(
    [...SAFE_GIT_CONFIG, LITERAL_PATHSPEC_FLAG, ...driverBlockingConfig(drivers), ...withDiffSafety(argv)],
    { cwd: repoRoot, timeout: TIMEOUT_MS }
  );
  // A git_* tool decides for itself what a given exit code/stderr means
  // (e.g. "index.lock" vs. a real conflict) — never throw on non-zero here.
  return { repoRoot, ...result };
}
