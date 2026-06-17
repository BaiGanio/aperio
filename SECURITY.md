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
| 0.56.x   | ✅ Yes    | Current stable — fully supported |

> **Recommendation:** Always use the latest `0.56.x` release for the most recent features and security fixes.

---

## 🧭 Scope & Threat Model

Aperio is **local-first**: by default the server binds to loopback (`127.0.0.1`)
and is meant to run on a machine you trust.

- **`run_shell` is not a sandbox.** When enabled, the model runs allow-listed
  commands with your user's privileges. Only enable it for models and content
  you trust.
- **Do not expose Aperio directly to untrusted networks.** For LAN/hosted use,
  set `APERIO_AUTH_TOKEN` (shared-secret gate), `APERIO_TLS_CERT`/`APERIO_TLS_KEY`
  (HTTPS), and optionally `APERIO_SESSION_KEY` (at-rest session encryption), or
  front the app with a reverse proxy that terminates TLS and authenticates.
- **Secrets at rest** (`.env`, sessions, logs, handoffs) are written `0600`.

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
