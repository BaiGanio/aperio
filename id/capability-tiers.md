# Capability Tiers

A map of what Aperio's tools can touch, sorted by the privilege they hold, and —
for each tier — **where that privilege is enforced in code**. The point is
auditability: the guards below are real and already in the codebase, but they are
implicit and scattered across `mcp/tools/*` and `lib/routes/*`. This doc names
them so a reviewer (or the user) can see the whole ladder at a glance and check
each rung against its enforcement site.

This is documentation, not a new runtime mechanism. Nothing here is signed,
compiled, or verified at runtime — the enforcement *is* the allowlists, confirm
tokens, and origin/auth checks the code already runs. (For why Aperio does **not**
adopt HMAC-signed "laws": see [#185](https://github.com/BaiGanio/aperio/issues/185)
§B — the process that verifies the signature holds the key and can forge it, so
prompt-level signing adds complexity without a threat-model benefit. Real
enforcement lives at the capability boundary, which is what these tiers describe.)

Enforcement line numbers are anchors at time of writing; treat the function name
as authoritative and the line as a hint.

---

## Ring 0 — read-only / local

Read state; never mutate the filesystem, a database, or the outside world.

| Tool | What it does |
| --- | --- |
| `recall` | Search the user's memory store (read) |
| `wiki_get`, `wiki_search`, `wiki_list` | Read synthesized wiki articles |
| `self_recall`, `self_wiki_get` | Read the agent's own local-only memory |
| `read_file`, `read_docx`, `scan_project` | Read files **within the allowlist** |
| `code_*` (`code_search`, `code_outline`, `code_context`, `code_callers`, `code_callees`, `code_repos`) | Query the code graph |
| `doc_*` (`doc_search`, `doc_outline`, `doc_context`, `doc_refs`, `doc_repos`) | Query the document graph |
| `db_query`, `db_schema`, `db_connections` | SELECT / inspect over named DB connections |
| `fetch_url`, `web_search`, `fetch_github_issue`, `list_github_issues` | Read the outside world |
| `read_image`, `preprocess_image`, `describe_image` | Vision reads |

**Enforcement**
- Filesystem reads are ceilinged by the path allowlist: `isReadPathAllowed()`
  — `lib/routes/paths.js:225`, called at `mcp/tools/files.js:145`.
- Everything read from the outside world (`fetch_url`, `fetch_github_issue`,
  `read_file` on files Aperio didn't write, `scan_project`) is wrapped as
  **untrusted data, never instructions** — `id/whoami.md:26` (the explicit fence).
  A turn that reads such content is marked `__tainted`, which escalates any
  *subsequent write* in the same turn to Ring 2 (see below).

---

## Ring 1 — local write (no confirmation)

Mutate Aperio's **own** local stores. No filesystem-outside-scratch, no DB, no
network side effects — so these run without a confirm gate.

| Tool | What it does |
| --- | --- |
| `remember`, `update_memory`, `forget` | Write the user's memory store |
| `backfill_embeddings`, `deduplicate_memories` | Maintain the memory store |
| `self_remember`, `self_update`, `self_forget` | Write the agent's own local-only memory |
| `wiki_write`, `self_wiki_write` | Write synthesized wiki articles |
| `record_issue_triage` | Record a local triage verdict (no GitHub write) |
| `export_data`, `import_data` | Move Aperio's own data in/out |
| `write_file` / `edit_file` / `append_file` **into session scratch** | Frictionless skill output |

**Enforcement**
- Writes into the session scratch workspace are intentionally frictionless:
  `needsConfirmation()` returns `false` when the resolved path is under
  `/var/scratch/` **and** the turn is not tainted — `mcp/tools/files.js:92`.
  Anything else falls through to Ring 2.
- Self-memory tools are **local-only**: they are stripped from the offered tool
  set on cloud providers (they never leave the machine) — provider gate in
  `lib/agent/index.js`, sets defined in `lib/agent/tool-profiles.js:32-35`.

---

## Ring 2 — confirm-gated write

Mutate a **real location** — a file outside scratch, a database, or a GitHub
issue. These never execute on the model's say-so: the tool returns a preview with
a one-time `Token:` line, the UI turns it into a confirm button (the terminal
prints a token to reply with), and the action runs **only** when the user
confirms.

| Tool | Gated action |
| --- | --- |
| `write_file`, `edit_file`, `append_file` (outside scratch, or in a tainted turn) | Write a real file |
| `delete_file` | Remove a file |
| `db_execute` | Writes + DDL (can DROP/DELETE) over a DB connection |
| `create_github_issue`, `update_github_issue` | Post to GitHub |

**Enforcement**
- The gate set: `CONFIRM_TOOLS` — `lib/agent/tool-profiles.js:13`.
- A file write escalates to confirmation when it lands **outside scratch** OR the
  turn is **tainted** by untrusted content: `needsConfirmation()` —
  `mcp/tools/files.js:92` (tainted-turn warning at `:101`).
- The preview stashes the pending write behind a token; the agent hook converts
  the `Token:` line into a UI confirm event and **stops the model from re-calling
  the tool** — `lib/agent/tool-hooks.js:401` (`action_confirm_pending`). Tokens
  expire after 5 minutes (`CONFIRM_TTL_MS`, e.g. `mcp/tools/github.js:340`,
  `lib/handlers/database/databaseHandlers.js:109`).
- Write path is itself ceilinged by the allowlist: `isWritePathAllowed()` —
  `lib/routes/paths.js:231`.
- The WebSocket confirm channel only accepts a known tool + a token matching the
  strict `(?:iss|del|wr|db)_[a-z0-9]+` shape — `lib/emitters/handlers/wsHandler.js:868`.
- Destructive tools also get **strict argument handling**: malformed JSON is
  never auto-repaired (a "fixed" string could silently corrupt a file/row) —
  `lib/tools/executor.js:190`; the built-in destructive set can be extended but
  not weakened (`APERIO_EXTRA_DESTRUCTIVE_TOOLS`, `lib/config.js:181`).

---

## Ring 3 — capability-expanding

Change what Aperio itself is allowed to do next: run real binaries, or widen the
filesystem allowlist. These sit above ordinary writes because they move the
boundary that the lower rings are measured against.

| Tool / action | Effect |
| --- | --- |
| `run_shell` | Execute allowlisted binaries |
| `run_node_script`, `run_python_script` | Execute a script file (by path, within the allowlist) |
| `set_paths` (WS) / allowlist widening | Change the read/write allowlist |
| Indexed-repo sync, user-triggered indexing | Persist new allowlist entries |

**Enforcement**
- **Shell is opt-in and off by default**: `run_shell` refuses unless
  `APERIO_ENABLE_SHELL=1` — `mcp/tools/shell.js:70` (`SHELL_ENABLED`), re-checked
  at the handler `mcp/tools/shell.js:462`. It is also gated *per model*
  (`isShellAllowedFor()`, `lib/agent/tool-profiles.js:90`) — local llama.cpp models
  need an additional `APERIO_SHELL_LOCAL=1`.
- Shell is **not** a raw shell: a command allowlist (`ALLOWED_CMDS`,
  `mcp/tools/shell.js:81`), banned command-chaining/redirect operators
  (`checkBannedOperators()`, `:327`), and per-program argument rules (`:360`+)
  constrain what can run. `curl`/`wget` and inline `-e`/`-c` code are refused;
  `git` is limited to a read-only subcommand set.
- Script and shell file targets are re-checked against the allowlist on every
  call: `isWritePathAllowed()` / `isReadPathAllowed()` at `mcp/tools/shell.js:205`,
  `:271`, `:425`, `:451`, `:510`, `:595`.
- Allowlist changes flow through one chokepoint: `setAllowlist()` —
  `lib/routes/paths.js:129`. A hard **floor** (project cwd + scratch root) is
  always merged in, so the workspace can never be excluded (`withFloor`,
  `paths.js:87`). The WS `set_paths` path is `wsHandler.js:293`; the HTTP path is
  `lib/routes/api-meta.js:246`.

---

## Cross-cutting guards (apply to every ring)

- **Loopback bind by default**: the server listens on `127.0.0.1` unless `HOST`
  is overridden — `server.js:65`, `:335`.
- **WebSocket origin check (REBIND-01)**: cross-site handshakes are rejected
  against `allowedHosts` — `server.js:623`.
- **Opt-in shared secret (AUTH-01)**: when `APERIO_AUTH_TOKEN` is set, every
  `/api/*` request and WS handshake must present it (constant-time compare) —
  `lib/helpers/authGuard.js`, wired at `server.js:94`.
- **Execution budget**: output caps, timeouts, and a repeated-failure budget on
  tool calls (`lib/agent/tool-hooks.js`, `lib/tools/executor.js`).

---

## Audit cross-reference

This doc directly answers the open audit question *"Is allowlist persistence
auditable and visible in the UI?"* — `id/audit/protocol.md:95` (see also the
filesystem-allowlist discussion at `protocol.md:82` and
`id/audit/security-engineer.md:106`). The persistence path is auditable here
(`setAllowlist` → `settings['allowed-paths']`); surfacing the **live** ring map +
active allowlist in the settings panel remains an optional follow-up
([#185](https://github.com/BaiGanio/aperio/issues/185) §B).

See also: `id/whoami.md` (operating principles + the untrusted-content fence),
`id/audit/protocol.md` (audit harness).
