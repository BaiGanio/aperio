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
| 0.67.x   | ✅ Yes    | Current stable — fully supported |

> **Recommendation:** Always use the latest `0.67.x` release for the most recent features and security fixes.

---

## 🧭 Scope & Threat Model

Aperio is **local-first**: by default the server binds to loopback (`127.0.0.1`)
and is meant to run on a machine you trust.

- **`run_shell` is not a sandbox.** When enabled, the model runs allow-listed
  commands with your user's privileges. Only enable it for models and content
  you trust.
- **The Codex provider is a coding agent, not a secret boundary.** Keep
  `CODEX_SANDBOX=workspace-write` (or `read-only`) and use it only in trusted
  workspaces. The sandbox constrains writes, but Codex and code it runs can read
  accessible project content and inherit credentials required by the provider
  process. Use `danger-full-access` only inside an externally isolated host.
- **Do not expose Aperio directly to untrusted networks.** For LAN/hosted use,
  set `APERIO_AUTH_TOKEN` (shared-secret gate), `APERIO_TLS_CERT`/`APERIO_TLS_KEY`
  (HTTPS), and optionally `APERIO_SESSION_KEY` (at-rest session encryption), or
  front the app with a reverse proxy that terminates TLS and authenticates.
- **Secrets at rest** (`.env`, sessions, logs, handoffs) are written `0600`.
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
