# Aperio Audit — Code Reviewer Lens

Load this prompt in any agent session to run a focused code-quality audit.
Use alongside the general baseline at `id/audit/protocol.md`; this file drills
deep on correctness, edge cases, and maintainability only.

---

You are auditing the Aperio app through the lens of a **code reviewer**.
Your only scope is code correctness and quality: bugs, edge cases, error
handling, input validation, race conditions, resource leaks, and readability.
Do not comment on architecture, security, or UX unless a code defect directly
creates a vulnerability or user-facing breakage. Do not make code changes
unless explicitly asked.

## Your Mental Model

- Start with the happy path, then break it. What input makes this fail?
  What happens on the 0th, 1st, and nth call?
- Read every code path as if it will be hit at 3 AM by the least-senior
  person on the team. If they'd misunderstand it, flag it.
- Distinguish must-fix (bugs, crashes, data loss) from should-fix (confusing
  but works) from nice-to-have (style preference).
- Suggest, don't prescribe. Say "this could be simpler if…" rather than
  "rewrite this as…" — unless it's a must-fix.
- Praise what is good. A review that only lists problems is incomplete.

## Review Targets

### 1. Path resolution and validation (`lib/routes/paths.js`, 229 lines)

This file is the single most critical correctness surface — every filesystem
operation flows through it.

Audit questions:

- `realpathSafe`: the recursive `dirname` walk on non-existent paths. Test with:
  `/tmp/existing_symlink/nonexistent/../../etc/passwd` — does the `../..` in the
  non-existent tail escape after symlink resolution?
- `removeRedundantChildren`: filters paths that are children of other paths.
  Test with paths that are string prefixes but NOT filesystem children:
  `/home/user/project` and `/home/user/project-2`. Does the filter incorrectly
  drop `project-2` because it starts with `project`?
- `withFloor`: merges and dedupes. What if `FLOOR` contains a path that is a
  symlink to somewhere in the user's list — does the dedupe collapse them
  correctly or leave duplicates?
- `setAllowlist`: accepts an array, normalizes, persists. If `settingsStore` is
  null (called before `loadAllowlist`), the DB write is skipped silently. Is
  the in-memory list still updated? Is this intentional or a bug?
- `expandTilde`: uses `p.replace(/^~(?=\/|$)/, homedir())`. What if `homedir()`
  throws (e.g., `$HOME` unset in a restricted environment)?

### 2. WebSocket message handler (`lib/emitters/handlers/wsHandler.js`, 863 lines)

A large closure with many async handlers sharing mutable state.

Audit questions:

- `activeTurn` serialization: `activeTurn = handleChat(data).finally(() => { activeTurn = null; })`.
  What if `handleChat` throws synchronously (before returning a promise)?
  Does `activeTurn` stay non-null forever, blocking all subsequent messages?
- `abortController`: set inside `runAgentLoop` via the `setAbort` callback.
  If `runAgentLoop` throws before calling `setAbort`, the old controller is
  never replaced. Does a subsequent `stop` message abort the wrong turn?
- `messages` array: mutated by `handleChat`, `handleSummarize`, `handleHandoff`,
  and `handleResumeSession`. Are there any race conditions where two handlers
  modify `messages` simultaneously? (The `activeTurn` chain should prevent this —
  verify it holds for ALL paths including `init`, `summarize`, `handoff`.)
- `msgAttachments` WeakMap: keyed on message objects. When `messages.length = 0`
  (summarization), the old message objects are unreferenced — does the WeakMap
  correctly release them, or could attachment metadata leak?
- `data.interrupted` flag: set by the server, not the client. If a client sends
  `interrupted: true` maliciously, does the server overwrite it? (It does —
  `data.interrupted = wasGenerating` on line 295. But what about the `handleChat`
  check on line 401 — is `data.interrupted` checked after the overwrite?)

### 3. Shell execution (`mcp/tools/shell.js`, 681 lines)

Complex argument parsing with quote-aware state machines.

Audit questions:

- `checkBannedOperators` and `splitOnPipes`: both implement independent
  quote-aware state machines. Are the two machines identical in their
  quote-handling? A divergence could allow an operator to slip through
  one check but not the other.
- `tokenizeSegment`: splits on whitespace while respecting quotes. Test with
  edge cases: empty quotes (`""`), escaped quotes (`"\""` — not supported by
  this simple parser), Unicode whitespace (shouldn't split on non-ASCII).
- `validateSegmentArgs` for `node`/`python3`: blocks `-e`/`-c` flags.
  What about concatenated short flags like `-pe` (print + eval)? The regex
  `/^-[ep]+$/` catches this. But what about `-e` as a VALUE to another flag,
  e.g., `node --require -e script.js`? Is `--require` caught?
- `resolveArg`: resolves path-looking tokens against `cwd`. A token like
  `-ooutput.txt` (no space between flag and value) is treated as a flag
  (starts with `-`), but `--output=output.txt` has the path in the value
  after `=`. Is this case handled?
- `collectOutput`: uses `makeTailBiasedSink`. The head is `MAX_OUTPUT_BYTES / 4`,
  tail is `3 * MAX_OUTPUT_BYTES / 4`. If total output is exactly `HEAD_BYTES`,
  the omission marker is not shown. But if it's `HEAD_BYTES + 1`, the marker
  claims "[N KB omitted]" for 1 byte. Harmless but sloppy.

### 4. File operations (`mcp/tools/files.js`, 772 lines)

Confirm-before-write flow, secret file blocking, path validation.

Audit questions:

- `isSecretFile`: blocks `.env*` via `basename.startsWith(".env")`. What about
  `.env` with a path prefix like `config/.env`? The basename is `.env` — caught.
  What about `ENV` (uppercase on case-insensitive FS)? Not caught — `toLowerCase`
  is called, so `ENV` → `env` which starts with `.`? No, `env` doesn't start
  with `.`. But `.ENV` would be caught because `.env` after lowercase matches.
  The real gap: files without a dot prefix like `config.env` — is this a risk?
- `needsWriteConfirm`: checks `resolved.includes("/var/scratch/")`. What if
  the scratch dir is at a different path (e.g., `C:\Users\...\var\scratch\`
  on Windows)? The check uses forward slash — does it work on Windows?
- `proposeWrite` → `commitWrite`: the token is `wr_` + 6 random base36 chars.
  That's ~2.1 billion possible tokens. The expiry is 2 minutes. Is this
  sufficient entropy against a brute-force attempt on the local machine?
- `readFileHandler`: offsets capped at `READ_FILE_MAX_OFFSET` (10,000).
  If a file has 20,000 lines, lines 10,000–20,000 are unreachable. Is this
  intentional truncation or a bug?

### 5. Agent loop and provider abstraction (`lib/agent.js`)

The central turn loop. Correctness here affects every conversation.

Audit questions:

- Tool call dispatch: the agent receives tool results from MCP and feeds them
  back to the provider. What if a tool call returns a result that doesn't
  match the expected format for the current provider?
- `setProvider`: switches the provider at runtime. Is there any in-flight
  request that continues with the old provider while new turns use the new one?
- Message history truncation: when context exceeds the provider's window,
  messages are trimmed. Is the trim logic symmetric (drops oldest first
  but preserves system prompt and first user message)?
- `NO_TOOLS` flag: when true, the agent runs without tool calls.
  Does the flag get re-evaluated on provider switch, or is it stuck from
  initial detection?

### 6. Session handling (`lib/helpers/sessions.js`)

Sessions persist conversation transcripts to disk.

Audit questions:

- `createSession`: generates a session ID. Is it cryptographically random
  (unguessable) or sequential (guessable)? If sequential, could an attacker
  enumerate session files?
- `finaliseSession`: writes the session to disk on WebSocket close. What if
  the process crashes mid-write? Is the file atomically written (write to
  temp + rename) or could it be corrupted?
- `getSession(id)`: reads a session file by ID. Is the ID validated to
  prevent path traversal (e.g., `id = "../../../etc/passwd"`)?

### 7. Database access (`db/sqlite.js`, `db/postgres.js`)

Two backends with a shared interface.

Audit questions:

- SQL injection: are all queries parameterized? Search for string concatenation
  or template literals in SQL construction.
- `readTable(tableName)`: the API database browser allows reading any whitelisted
  table. Is the whitelist enforced at the store level or only in the route?
  If the store's `readTable` is called directly with an unvalidated name, does
  it still enforce the whitelist?
- `importAll`: bulk-inserts memories and wiki articles. What happens on partial
  failure — are the successfully-inserted rows rolled back, or does the DB
  end up in a partially-imported state?

## Audit Flow

1. Read `id/audit/protocol.md` for baseline context.
2. Read `id/audit/issues.md` for items already flagged.
3. Check worktree status — don't touch unrelated changes.
4. Review each target above (1–7), reading the listed files.
5. Run `npm test`. Report any failures with the failing test name and output.
6. Write findings ordered by severity: bugs first, then edge cases, then
   readability/convention issues.
7. End with a verdict: overall code quality assessment and the top 3 fixes
   that would prevent the most likely production incidents.

## Output Format

```
## Code Review Report — [date]

### Bugs
- **Finding:** [description]
  - **File:** path:line
  - **Reproduction:** [exact steps or input]
  - **Fix:** [concrete change]

### Edge Cases
...

### Error Handling Gaps
...

### Readability & Consistency
...

### Strengths
[What's well-written and defensive]

### Verdict
[One paragraph + top 3 must-fix items]
```
