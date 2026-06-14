---
name: security-and-hardening
description: >
  Use this skill when writing or reviewing code that handles untrusted input,
  authentication, secrets, database queries, file paths, or network requests —
  anywhere a mistake becomes a vulnerability. Triggers: adding auth or
  permissions, building an API route or MCP tool, touching the db/ layer,
  handling user input or file uploads, managing secrets and credentials, or an
  explicit ask to secure / harden / audit something. Aperio is a Node server that
  stores user memories and exposes tools — treat security as part of writing the
  code, not a later pass.
metadata:
  keywords: "security, secure, harden, hardening, vulnerability, input validation, sanitize, sanitized, sanitization, injection, sql injection, xss, csrf, authentication, authorization, secret, credentials, untrusted, endpoint, parameterized, rate limit, owasp, least privilege"
  category: "engineering-discipline"
  load: "on-demand"
---

# Security & Hardening

## Purpose
Catch the predictable ways code gets exploited before they ship. This is not a
separate audit phase — it is a checklist you apply while writing anything that
touches untrusted input, identity, secrets, or storage.

## When to Use
- Adding or changing authentication, authorization, or session handling
- Writing an API route, MCP tool, or anything that accepts external input
- Touching the database layer (`db/`), building queries, or handling file paths
- Managing secrets, tokens, API keys, or credentials
- An explicit request to secure, harden, or audit code

## When NOT to Use
- Pure internal refactors with no change to inputs, auth, or data flow
- Content-generation skills (docx/pptx/etc.) with no untrusted input

---

## The Checklist

**Input.** Validate and sanitize everything that crosses a trust boundary. Treat
all request bodies, query params, headers, filenames, and tool arguments as
hostile until validated. All-list expected shapes; don't deny-list bad ones.

**Injection.** Never build SQL/shell/HTML by string concatenation with user data.
Use parameterized queries (Aperio's SQLite/Postgres layer), escape on output for
HTML (XSS), and avoid passing user input to shells.

**Auth.** Check authorization on every protected action, server-side, on each
request — not just in the UI. Enforce least privilege: the code gets the
narrowest access that does the job.

**Secrets.** No secrets in source, logs, or error messages. Read them from env /
vault. Don't echo tokens back to the client.

**Path & file.** Resolve and confine file paths to an expected root; reject `..`
traversal. Validate upload type and size.

**Rate & exposure.** Rate-limit expensive or auth endpoints. Return generic error
messages externally; keep stack traces server-side. Set security headers
(CSP/HSTS/CORS) deliberately, not wide-open.

---

## Rationalizations — and the rebuttal

| You're telling yourself… | Reality |
|---|---|
| "It's internal, no one will attack it." | Internal tools get exposed, reused, and reached through other bugs. Validate anyway. |
| "I'll add auth/validation later." | Later rarely comes, and the insecure version is what ships. Do it with the feature. |
| "The frontend already validates this." | The frontend is attacker-controlled. Validate on the server. |
| "String-building this query is simpler." | It's also SQL injection. Parameterize — it's barely more code. |

## Red Flags

- User input flows into a SQL string, shell command, or `eval` without parameterization.
- A protected route checks permission in the UI but not on the server.
- A secret, token, or password appears in code, a log line, or an error response.
- A file path built from user input with no traversal check.
- A new external-facing endpoint with no input validation and no rate limit.

## Verification — evidence required

1. Name each untrusted input the change introduces and how it's validated.
2. Confirm queries are parameterized and secrets come from env, not source.
3. State the authorization check that guards each new protected action.
4. Run `npm audit` if dependencies changed; report anything high/critical.
