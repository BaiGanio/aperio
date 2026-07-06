# Aperio — Security Review

_Date: 2026-07-02 · Scope: whole application (server, MCP tools, DB layer, web UI) · Reviewer: Claude_

This is a manual, read-only review. Nothing was changed. Items are ordered by
severity so you can triage top-down. Each item has a concrete location, the
actual risk, and a suggested fix.

**Overall:** the codebase is unusually security-conscious. It has named, tested
controls for the classic local-server threats: DNS-rebinding + CSRF
(`netGuard`), opt-in shared-secret auth (`authGuard`), SSRF egress filtering
(`ssrfGuard`), a two-phase confirm-before-write gate for mutating tools, a
path allowlist enforced on every file/shell tool, prompt-injection taint
fencing, field-level + whole-DB encryption, and a genuinely thorough `run_shell`
allowlist. The findings below are residual gaps and hardening opportunities, not
gaping holes. The two worth doing first are **#1 (CSP)** and **#2 (.env perms)**.

---

## 1. [Medium] Content-Security-Policy is disabled, and several UI panels build HTML from unescaped data

- **Where:** `server.js:86` — `app.use(helmet({ contentSecurityPolicy: false }))`.
  The code comment acknowledges this is deferred until inline scripts/handlers
  and CDN assets are reworked.
- **Risk:** With no CSP, any successful HTML/JS injection into the DOM runs with
  full page capability (it can call every `/api` route as the first-party
  origin, read `/uploads` + `/scratch`, exfiltrate memories, etc.). The **main
  chat renderer is well-defended** — `public/scripts/markdown.js` escapes `&<>`
  before formatting, restricts links to `http(s):` and images to
  `/scratch|/uploads|https:`, so `javascript:`/`data:` are blocked. The gap is
  the **side panels**, which interpolate stored/served strings straight into
  `innerHTML` without escaping:
  - `public/scripts/paths-panel.js:65` — `title="${p}"` and `>${p}<` render a
    filesystem path raw. A path containing `">…<img onerror=…>` would inject.
  - `public/scripts/system.js:55`, `db-connections-panel.js`, `settings-panel.js`
    (Ollama model-name list), and others build rows from server data with
    template literals; several use an `esc()`/`escapeHtml()` helper, several do
    not. Worth an audit pass to make escaping uniform.
- **Why it matters even locally:** injected content can arrive from documents the
  model ingests (docgraph), fetched web pages, external-DB rows shown in a panel,
  or model output rendered outside the sanitized chat path.
- **Fix:** (a) re-enable a real CSP — the inline-handler rework is the actual
  blocker, so this is a project, not a one-liner; (b) in the meantime, route
  every panel's dynamic value through the existing `escapeHtml`/`esc` helper, and
  prefer `textContent`/`el.setAttribute` over `innerHTML` for single values.

## 2. [Medium] `.env` on disk is world-readable and holds live secrets

- **Where:** the actual `.env` in the repo root is `-rw-r--r--` (0644), ~19 KB,
  and contains provider API keys. `lib/helpers/envFile.js:49` correctly writes
  new files with `mode: 0o600` and re-`chmod`s, **but only for wizard-created
  files** — a hand-edited `.env` keeps whatever perms it was created with.
- **Risk:** on any shared/multi-user host, another local user can read the API
  keys (and any other secrets in `.env`). `.env` is git-ignored (`*.env`), so
  this is a local-disk exposure, not a repo leak.
- **Fix:** `chmod 600 .env` now; consider a startup check that warns (or
  self-heals) when `.env` is group/other-readable.

## 3. [Low–Medium] SSRF guard is vulnerable to DNS rebinding (TOCTOU)

- **Where:** `lib/helpers/ssrfGuard.js:61` `assertPublicUrl()` resolves the
  hostname and rejects internal IPs, but the subsequent `fetch()` in
  `mcp/tools/web.js:23` re-resolves the name independently.
- **Risk:** an attacker-controlled host that returns a public IP on the first
  lookup and `127.0.0.1`/`169.254.169.254` on the second (short-TTL rebinding)
  passes the check and then connects internally — the classic SSRF-guard bypass.
  Two smaller edges: the guard **allows unresolvable hosts through** (line ~89,
  documented as low-risk), and it only inspects DNS `A`/`AAAA`, so a redirect
  (`3xx` `Location:`) to an internal URL is not re-validated by `fetch_url`.
- **Fix:** resolve once, validate the resolved address, and connect to **that IP**
  (set a custom `lookup`/agent, or fetch the pinned IP with the original `Host`
  header). Also disable redirect-following (`redirect: "manual"`) and re-run
  `assertPublicUrl` on any `Location`. The `APERIO_EGRESS_ALLOWLIST` opt-in is a
  good stopgab for high-security deployments.

## 4. [Low] Encryption keys are passed as command-line arguments (visible to `ps`)

- **Where:** `db/encrypt.js:72` — `security add-generic-password … -w "${keyHex}"`
  (macOS), and the PowerShell path builds the key into a `-Command` string
  (`db/encrypt.js:201-206`). `lib/db-connect/secrets.js` avoids this (file-based).
- **Risk:** while the `security`/`powershell` child runs, the 256-bit key is in
  its argv, readable by any local process via `ps aux` / `/proc`. It's transient
  and the threat model is already "local user can read the running key," but
  putting a key on a command line is avoidable.
- **Fix:** pass the key via stdin where the tool supports it (Linux `secret-tool`
  already uses `input:`); on macOS, feed `-w` from stdin (`-w` with no value
  reads interactively / from a pipe) rather than inlining it.
- **Related note:** the `security add-generic-password` command interpolates
  `KEYCHAIN_ACCOUNT`/`KEYCHAIN_SERVICE` and `keyHex` into a shell string. These
  are all fixed constants or hex, so there's **no injection today**, but it's a
  fragile pattern — prefer `execFileSync('security', [args…])` (no shell) so a
  future change to those values can't become command injection.

## 5. [Low] `PUT /api/settings/:key` accepts arbitrary keys and values with no schema validation

- **Where:** `lib/routes/api-settings.js:53`.
- **Risk:** any authenticated first-party caller can write any settings key to any
  value (only a 64 KB size cap). It's gated by `netGuard` (custom header +
  Origin) and, if enabled, `authGuard`, so it's **not remotely reachable**, but
  some settings feed the config resolver into `process.env` at boot
  (`config.*` keys). A bad/typo'd value can silently alter security-relevant
  config (e.g. paths, precedence) with no validation or audit trail.
- **Fix:** validate `:key` against the known settings/registry allowlist and
  type-check values via the same `CONFIG` schema the config UI uses; reject
  unknown keys or route them to the explicit "imported/unmanaged" bucket.

## 6. [Informational] `run_shell` relies on a custom quote-aware parser as its security boundary

- **Where:** `mcp/tools/shell.js` (`checkBannedOperators`, `splitOnPipes`,
  `tokenizeSegment`, `validateSegmentArgs`), executed via `spawn("sh", ["-c", command])`.
- **Assessment:** this is **well-designed** — opt-in (`APERIO_ENABLE_SHELL=1`),
  program allowlist, banned metacharacters (`; & < > ` `` ` `` `$(`), read-only
  git, no interpreter `-e`/`-c`, file args re-resolved against the pinned cwd and
  checked against the path allowlist, `curl` deliberately excluded. The tool
  itself documents "this is NOT a sandbox."
- **Residual risk:** any hand-rolled shell tokenizer is inherently fragile; a
  parser edge case (unusual quoting, locale/glob expansion, a newly-added
  allowlisted program with its own `-exec`-style escape) can void the boundary,
  and the final `sh -c` still does its own word-splitting/globbing on what
  survives. Keep it **off by default**, and if you rely on it, prefer building
  argv explicitly and `spawn`-ing without a shell over parsing a shell string.
  Re-audit the allowlist whenever a program is added.

## 7. [Informational] Global error handlers keep the process running after unexpected throws

- **Where:** `server.js:37-49` — `uncaughtException`/`unhandledRejection` are
  logged and absorbed; a crash-breaker (5 fatals / 60 s) forces a restart.
- **Note:** this is a deliberate availability trade-off and is reasonable, but be
  aware it can mask bugs that leave state half-updated. The breaker is the right
  safety valve; just make sure genuinely fatal invariants still `exit`.

## 8. [Informational] `SECURITY.md` supported-version table is stale

- **Where:** `SECURITY.md` lists `0.56.x` as current stable; `package.json` is
  `0.66.0`. Doc hygiene only — update so the vulnerability-reporting policy names
  the version you actually ship.

---

## Things that are done well (so you don't "fix" them)

- **Confirm-before-write is not bypassable by the model.** `mcp/tools/database.js`
  / `databaseHandlers.js` emit a `Token:` line, but `lib/agent/tool-hooks.js:398-419`
  intercepts it, shows the user a confirm button, and returns a token-free
  message to the model ("STOP — do not call again"). The model never sees the
  token, so it cannot self-confirm. Same pattern for `delete_file` and GitHub
  writes.
- **SQL access is parameterized and classified.** External-DB writes route through
  `classify()` (`lib/db-connect/classify.js`) which conservatively escalates
  data-modifying CTEs / `EXPLAIN`-of-DML to "write," and read-only connections
  are enforced at the driver level too (defense in depth). Internal SQLite/PG
  queries use prepared statements with bound params; table-name interpolation is
  from fixed internal constants, not user input.
- **Webhook auth is correct.** `api-github-webhook.js` verifies an HMAC over the
  raw body with `timingSafeEqual` and refuses (503) when no secret is set — no
  unauthenticated write path.
- **Auth compares are constant-time** (`authGuard.js`, webhook) and length-safe.
- **Secrets are write-only over the API** — `api-settings.js` / `api-config.js`
  mask secret-typed and secret-named values to `{ configured: bool }` and never
  echo them.
- **No zip-slip.** `adm-zip` is only ever used to read entries in-memory
  (`getEntries()` in `pptxHandler.js`, `extract-pptx.js`); nothing calls
  `extractAllTo`/`extractEntryTo` to disk.
- **`.env` value injection is handled** — `envFile.js:envQuote` strips CR/LF and
  control chars and quotes/escapes, so wizard input can't inject extra env lines.
- **Prompt-injection taint fencing** — untrusted tool output (web/doc/db) is
  wrapped as "data, not instructions" and marks the turn tainted, feeding the
  write/egress confirm gate (`tool-hooks.js`, INJECT-01).

---

## Suggested order of work

1. `chmod 600 .env` (immediate) + add a startup perms check (#2).
2. Uniform escaping in UI panels, then re-enable CSP (#1).
3. Pin the resolved IP in `fetch_url` and disable redirect auto-follow (#3).
4. Move keychain/DPAPI key material off the command line; switch the `security`
   call to `execFileSync` argv form (#4).
5. Allowlist/validate `PUT /api/settings/:key` (#5).
6. Refresh `SECURITY.md` version (#8).
