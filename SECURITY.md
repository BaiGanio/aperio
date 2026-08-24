# 🔒 Security Policy

We take security seriously. This document outlines which versions receive 
security updates and how to responsibly report vulnerabilities.

---

## 🛡️ Automated Security Coverage

This project uses **two layers** of automated security monitoring:

| Tool | What it does |
|------|-------------|
| 🤖 **Dependabot** | Automatically scans dependencies and opens PRs for vulnerable packages |
| 🔬 **CodeQL Advanced** | Static code analysis that detects vulnerabilities in the source code itself |
| 📊 **SonarQube** | Analyzes code quality, detects bugs, code smells, and security hot spots; provides detailed reports on maintainability and test coverage |
| 🎯 **Codacy** | Automated code reviews that check for style issues, complexity, and best practices; integrates with PRs to flag problems before merge |
| 📈 **Codecov** | Tracks code coverage metrics and reports on test coverage; ensures your test suite covers critical code paths and prevents regressions |

---

## ✅ Supported Versions

Only the versions below actively receive security patches:

| Version | Supported | Notes |
|---------|-----------|-------|
| 0.69.x   | ✅ Yes    | Current stable — fully supported |
| ≤ 0.68.x | ❌ No     | No security patches. Upgrade to 0.69.x. |

> **Recommendation:** Always use the latest `0.69.x` release for the most recent features and security fixes.

---

## 🧭 Scope & Threat Model

Aperio is **local-first**: by default the server binds to loopback (`127.0.0.1`)
and is meant to run on a machine you trust.

- **`run_shell` is not a sandbox.** When enabled (`APERIO_ENABLE_SHELL=1`), the
  model runs allow-listed programs with your user's privileges. Only enable it
  for models and content you trust.
- **`run_shell` is not the only tool that executes code, and it is the only one
  behind a switch — by decision, not by oversight.** `run_node_script` and
  `run_python_script` (`mcp/tools/shell.js`) spawn `node` and `python3` on the
  same host with the same privileges. Neither is gated by `APERIO_ENABLE_SHELL`
  — the `SHELL_ENABLED` check exists in `runShellHandler` only. Neither appears
  in `CONFIRMABLE_TOOLS` (`lib/helpers/confirmableTools.js`), so neither is
  confirm-before-run. Both ship in the default `file-generate` tool profile
  (`lib/agent/tool-profiles.js`), which loads on ordinary "make me a
  deck/spreadsheet/document" requests. That is intended. Eight bundled skills
  (`pptx`, `docx`, `docx-advanced`, `pdf`, `design-randomizer`,
  `agent-conduct`) build their output by writing a script and then running it.
  Putting these two tools behind an env switch would leave a fresh install
  unable to produce a deck or a document until the user edits `.env`; putting
  them behind a confirm prompt would charge several clicks per document.
  Aperio deliberately keeps document generation working for people who should
  not have to know what a shell switch is, and states the cost here rather than
  hiding it. The cost is real: the only boundaries on these two tools are the
  file extension (`.js` / `.py`) and the requirement that the script already
  exist inside an allowed write path — there is no allowlist of what the script
  may do. The spawned child inherits the server's full environment, including
  any provider API keys and tokens present in it. Once running, the script is a
  normal process: it can open sockets, read any file the OS lets your user
  read, and spawn further programs.
- **The model can create the script it then executes, with no confirmation.**
  `write_file` / `edit_file` / `append_file` run directly for any target inside
  the allowed write paths; the confirm flow (`mcp/tools/files/interrupt.js`)
  fires only when the turn has already read untrusted content (the `__tainted`
  path, INJECT-01). A clean turn can therefore write a `.js` file into the
  session workspace and call `run_node_script` on it without a single confirm
  click and with `APERIO_ENABLE_SHELL` unset. This write-then-run path follows
  directly from the decision above and is not separately gated. **Treat
  arbitrary code execution as the Aperio user as the baseline capability of any
  model you connect, not as something the shell switch turns on.**
  `APERIO_ENABLE_SHELL` widens that surface to real binaries; it does not
  create it. The boundary that actually matters is the allowed-paths list and
  the trust you place in the model and in the content it reads. If that
  baseline is unacceptable for your deployment, do not rely on a setting —
  run Aperio in an isolated host or container.
- **The Codex provider is a coding agent, not a secret boundary.** Keep
  `CODEX_SANDBOX=workspace-write` (or `read-only`) and use it only in trusted
  workspaces. The sandbox constrains writes, but Codex and code it runs can read
  accessible project content and inherit credentials required by the provider
  process. Use `danger-full-access` only inside an externally isolated host.
- **Do not expose Aperio directly to untrusted networks.** For LAN/hosted use,
  set `APERIO_AUTH_TOKEN` (shared-secret gate), `APERIO_TLS_CERT`/`APERIO_TLS_KEY`
  (HTTPS), and optionally `APERIO_SESSION_KEY` (at-rest session encryption), or
  front the app with a reverse proxy that terminates TLS and authenticates.
- **Browser-side injection defense** — Helmet now emits a Content-Security-Policy
  by default (`APERIO_CSP=on`). Scripts are limited to Aperio itself and the
  explicitly used jsDelivr assets; network connections are limited to the app
  and WebSocket transports. `APERIO_CSP=report` is available for rollout
  diagnostics, while `APERIO_CSP=off` is a temporary troubleshooting escape hatch.
- **Secrets at rest** (`.env`, sessions, logs, handoffs) are written `0600`.
  The SQLite database is too — it carries provider API keys from the settings
  overlay alongside every memory. An older install created before this was
  enforced is repaired to `0600` the next time Aperio opens it.
- **Git history was rewritten on 2026-08-15** to remove an old `audit/` tree
  (superseded findings, one of which named an unpatched bug with exact
  file:line locations) plus stale build renders (`manual/preview-output`,
  `output/pdf`) from `master`. New clones no longer receive these files. This
  does **not** retroactively remove them from forks or clones made before that
  date — if you cloned or forked `aperio` before 2026-08-15, treat any copy of
  that history as still containing the old files.
- **SQLite at-rest encryption** — when `APERIO_DB_ENCRYPT=1`, the SQLite database file is encrypted with AES-256-GCM. The decryption key is generated on first run and stored in the OS keychain (macOS Keychain, Linux libsecret, Windows DPAPI) — never on disk. The plaintext database only exists in a temporary location while the app is running; it is re-encrypted on shutdown. See [Database Encryption](#database-encryption) below.

### Database Encryption

When `APERIO_DB_ENCRYPT=1` is set, Aperio encrypts the SQLite database file at rest:

| Property | Detail |
|----------|--------|
| **Algorithm** | AES-256-GCM (authenticated encryption) |
| **Key length** | 256 bits (random, generated on first run) |
| **Key storage** | OS keychain / DPAPI (macOS Keychain, Linux libsecret, Windows DPAPI) |
| **Key on disk?** | Never — the key is retrieved from the keychain at startup and held in memory |
| **Plaintext on disk?** | Only in `$TMPDIR` while the app is running; encrypted back on shutdown |
| **Crash recovery** | If the app crashes, the next startup detects the leftover temp DB and restores any writes newer than the encrypted file |

**Platform coverage:**

- **macOS** — uses the `security` CLI to store the key in the login keychain. Zero configuration needed.
- **Linux** — uses `secret-tool` from `libsecret-tools` (`apt install libsecret-tools`). Falls back to `~/.aperio/db.key` with `0600` permissions if the package is not installed (a warning is logged).
- **Windows** — uses DPAPI via PowerShell. The key is encrypted with the current user + machine context and stored at `%APPDATA%\aperio\db.key`. Cannot be decrypted on another machine or by another user.

**Limitations:**

- The encrypted database cannot be opened directly with SQLite tools — it is opaque ciphertext on disk.
- Migrating to a new machine requires either: (a) exporting the keychain entry, or (b) starting fresh with a new database (remove the keychain entry and restart).
- Journal mode switches from WAL to DELETE when encrypted (WAL files would leak plaintext to the temp directory).
- Only applies to the SQLite backend (`DB_BACKEND=sqlite` or auto-detected SQLite). Postgres uses its own encryption mechanisms (provider-managed for cloud, filesystem-level for Docker).

---

## ⚠️ Known Limitations

These are real, currently-unfixed properties of the shipping code. They are
listed so you can judge whether your deployment is affected — not as a roadmap,
and not with the sharp edges filed off.

- **The Docker image binds every interface, and neither Compose file turns on
  authentication.** `docker/Dockerfile` sets `HOST=0.0.0.0`, and
  `docker/docker-compose.prod.yml` publishes the app as `"${PORT:-31337}:31337"`
  — with no `127.0.0.1:` prefix, unlike the Postgres service directly above it.
  Neither file sets `APERIO_AUTH_TOKEN`. A default `docker compose up` therefore
  exposes an unauthenticated Aperio — memories, settings, conversations, and any
  tools you enabled — to everything that can route to the host. Before running
  the container on a network you do not fully control: set `APERIO_AUTH_TOKEN`,
  and bind the published port to `127.0.0.1` or to one specific interface.

- **`APERIO_AUTH_TOKEN` gates the API, not the application.** The guard returns
  early for every path outside `/api/`, so the app shell at `/` is served to any
  caller. That shell is also what hands out the per-process `aperio_static`
  cookie which gates `/uploads`, `/scratch` and `/roundtables`. An
  unauthenticated client can therefore request `/`, keep the cookie it is given,
  and read agent-generated and user-uploaded files out of the workspace without
  ever presenting the token. The shared secret is a gate on the data API and the
  WebSocket; it is not a perimeter. If you need one, put a reverse proxy that
  authenticates *every* path in front of Aperio.

- **Chat markdown is rendered with a hand-written escaper, not a vetted
  sanitizer.** Model output and tool output are turned into HTML and assigned
  through `innerHTML`. The escaping is deliberate and tested, but it is bespoke
  code on a hostile input path, and a bespoke escaper is a weaker guarantee than
  a maintained sanitizer. The browser Content-Security-Policy (`APERIO_CSP=on`,
  the default) is the second layer here — do not turn it off on an instance that
  renders untrusted content.

- **Confirming an `index_folder` request grants that folder permanent,
  app-wide read *and* write access — the prompt does not say so.** The
  confirmation text reads `Action: Authorize and index <path>`
  (`lib/agent/host-tools/index-folder.js`). What the confirm actually does is
  call `setAllowlist([...paths, path])`, and Aperio keeps **one** allowed-folders
  list that serves as both the read ceiling and the write ceiling —
  `getActivePaths()` returns the same array for `readPaths` and `writePaths`
  (`lib/routes/paths.js`). `APERIO_ALLOWED_PATHS_TO_READ` and
  `APERIO_ALLOWED_PATHS_TO_WRITE` only *seed* that list on first run; after
  that the DB setting `allowed-paths` is authoritative and the read/write
  distinction no longer exists. The grant is also persisted, not scoped to the
  indexing job or the session: from the moment you click confirm, every tool in
  every later conversation — `write_file`, `edit_file`, `delete_file`,
  `run_node_script` — may write anywhere under that folder, until you remove it
  in Settings → Allowed folders. Confirm `index_folder` on a folder only if you
  would also hand the model write access to it.

- **`db_query` and `db_execute` reach your real databases, and reads are not
  confirmed.** The `db_*` tools (`mcp/tools/database.js`) are a generic SQL
  client over the connections you configure in Settings → Database connections
  — SQLite, Postgres, MySQL and SQL Server, including production systems on
  your network. `db_execute` (writes and DDL) is confirm-before-write and
  refuses read-only connections. `db_query` and `db_schema` are **not**
  confirmed: the model may issue any `SELECT` / `WITH` / `EXPLAIN` / `PRAGMA` /
  `SHOW` against any configured connection, at any time, without asking, and
  the rows enter the conversation — and therefore whatever provider that
  conversation runs on. The row cap (200 default, 1000 max) limits one call, not
  how many calls a turn makes. Marking a connection read-only stops writes; it
  does not stop reading. Give Aperio a database account with the narrowest
  grants that make the connection useful, and do not point it at a database
  whose contents you would not send to your configured AI provider.

- **Subresource Integrity does not extend to CDN-fetched fonts.** The two
  remaining jsDelivr assets (the Bootstrap Icons stylesheet and the Mermaid
  bundle) carry `integrity` hashes, and Prism is served from Aperio itself
  precisely because its autoloader pulls unhashable grammar files at runtime.
  The icon font files that the Bootstrap Icons stylesheet requests are still
  fetched without integrity checking. They are font data rather than executable
  code, but a fully offline or fully-verified deployment should vendor them.

---

## 🚨 Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

### How to report

1. Go to the **[Security Advisories](../../security/advisories/new)** tab and open a private advisory

### What to include

- A clear description of the vulnerability
- Steps to reproduce it
- Affected version(s)
- Potential impact (what an attacker could do)
- Any suggested fix (optional but appreciated!)

### What happens next

| Timeline | What to expect |
|----------|---------------|
| **Within 48 hours** | Acknowledgement of your report |
| **Within 7 days** | Initial assessment and severity rating |
| **Within 30 days** | Patch released (for confirmed vulnerabilities) |
| **After patch** | Public disclosure + credit to reporter (if desired) |

### Severity ratings we use

| Level | Examples |
|-------|---------|
| 🔴 **Critical** | Remote code execution, auth bypass |
| 🟠 **High** | Privilege escalation, data exposure |
| 🟡 **Medium** | Limited data leak, partial bypass |
| 🟢 **Low** | Minor info disclosure, edge cases |

---

## 🙏 Responsible Disclosure

We follow coordinated disclosure — we ask that you give us reasonable time 
to patch before making any vulnerability public. In return, we commit to 
responding promptly, keeping you updated, and crediting your contribution 
in the release notes if you'd like.

Thank you for helping keep this project safe! 💙
