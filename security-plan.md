# Aperio Security Remediation Plan

Derived from `audit.md` + `security-eval.md` (first pass + Fable 5 addendum).
Threat model: **local now, LAN/hosted later** — agent-exfiltration surface first,
network layer built deliberately for safe future exposure.

## Operating rules

- **Verify gate (per finding):** before writing code, read the current code at the
  cited path, confirm the issue still exists, fix line refs, and drop/downgrade
  anything already resolved. Findings target ~v0.56; the tree has moved.
- **Test-first where a repro exists:** turn each finding's acceptance criteria into a
  failing test, then make it pass.
- **Surgical diffs:** one finding = one focused change + tests. No drive-by refactors.
- **Reuse existing machinery:** extend the confirm-token flow (`lib/agent/tool-hooks.js`)
  and WS confirm events; do not reinvent.

Status legend: ☐ todo · ◐ in progress · ☑ done · ⊘ dropped (already fixed / N/A)

---

## Phase 0 — Agent exfiltration surface (do first)

Coupled: SHELL-01 + INJECT-01 land together (SHELL-01 closes the curl/interpreter holes
that make INJECT-01 catastrophic).

- ☑ **EGRESS-01** — `lib/helpers/ssrfGuard.js` (`assertPublicUrl` + `isBlockedAddress`,
  opt-outs `APERIO_ALLOW_INTERNAL_FETCH` / `APERIO_EGRESS_ALLOWLIST`) + `lib/helpers/egressLog.js`,
  wired into `fetch_url` (web.js) and `fetchImageAsBase64` (github.js). Tests:
  `tests/lib/helpers/ssrfGuard.test.js` + web.test.js integration case. 131/131 tool tests pass.
  - ⊘ **SSRF-02 dropped** — current `describeImageHandler` takes only `path`/`data` (no `url`
    param); it never fetches an external URL, so there's nothing to guard there.
- ☑ **SHELL-01** — `validateSegmentArgs` in shell.js: rejects node/python inline-eval
  (`-e`/`--eval`/`-p`/`--print`/`-pe`/`-c`/`-`), `find -exec/-execdir/-ok/-delete`, `git -c`
  + non-read-only git subcommands; `curl` removed from `ALLOWED_CMDS`; node/python script
  args and `cat/grep/rg/head/tail/wc` file args confined to the allowlist (quote-aware
  tokenizer; relative args resolved against the pinned cwd). Tool description + README +
  .env.example now state "not a sandbox". Tests: 15 cases in shell.test.js. 372/372 pass.
  - ⚠️ **Residual:** `npm` left allowlisted (lifecycle/install hooks run package code) —
    needed for legit dependency installs; addendum didn't list it. Revisit if npm proves
    an exploit path.
- ☑ **INJECT-01** — fencing + taint infra (below); tainted-write enforcement landed in WRITE-01.
  - ☑ Provenance fencing in `callToolHooked` (tool-hooks.js): output of `fetch_url`,
    `fetch_github_issue`, `read_file`, `read_docx`, `scan_project` wrapped in
    `--- UNTRUSTED EXTERNAL CONTENT … ---` (handles string + text/image block shapes; errors unfenced).
  - ☑ Per-turn `taint` flag set on untrusted reads, exposed from `makeTurnHooks` for the write/egress gate.
  - ☑ `fetch_github_issue` `include_images` default → false (handler + schema + description).
  - ☑ System-prompt rule in `id/whoami.md` ("Untrusted Tool Content"). Tests: 5 cases in
    tool-hooks.test.js. Full suite 1613/1613.
  - ⤳ **Re-sequenced:** the "tainted `write_file`/`edit_file`/`append_file` raises a confirm
    rather than executing" acceptance criterion needs the tool-level confirm-stash that **WRITE-01**
    builds (the confirm round-trip replays via the MCP tool's `confirmation_token`, which write
    tools don't support yet). WRITE-01 will consume `hooks.taint`. Realistic egress
    (`create_github_issue`) already always-confirms, so tainted egress is already gated.
- ☑ **WRITE-01** — `write_file`/`edit_file`/`append_file` now use delete_file's two-phase
  confirm-stash (`wr_` token, `pendingWrites` map in files.js). Gate policy: confirm when the
  write lands **outside `/var/scratch/`** OR the turn is **tainted** (`__tainted` injected by the
  tool-hook from `hooks.taint`); new/overwrite inside scratch in a clean turn executes directly
  (frictionless skill output). edit_file confirm shows a capped unified diff. Wired into
  `CONFIRM_TOOLS` (tool-profiles.js), `CONFIRMABLE_TOOLS` + token regex (wsHandler.js), token
  detection + post-write-validation skip (tool-hooks.js). Schemas got `.passthrough()` so
  `__tainted` survives the MCP boundary. Tests: 6 gate cases (files.test.js) + 3 wiring cases
  (tool-hooks.test.js); existing mechanics tests routed through a two-phase `confirmed()` helper.
  Full suite 1622/1622.
  - ✅ **Closes INJECT-01 enforcement:** a tainted turn now routes write/edit/append through the
    confirm event rather than executing — the acceptance criterion deferred from INJECT-01.

## Phase 1 — Quick wins

- ☑ **SECRET-01** — `envFile.js`: new `envQuote` (strips newlines/control chars so a value
  can't inject extra `KEY=` lines, escapes `\` then `"`, always quotes) + `setKey` now uses
  function replacers (so `$` in a value isn't read as a backreference — latent bug fixed).
  `.env` written `0600` via new `writeEnv` helper (chmod after write, since `writeFileSync`
  mode is ignored on an existing file). `setKey`/`envQuote` exported for test.
  Tests: `tests/lib/helpers/envFile.test.js` (11 cases incl. newline-injection).
- ☑ **ENV-01 / SECRET-02** — server.js no longer falls back to `.env.example` as live config
  (only loads a real `.env`; pre-setup relies on process env + in-code `??` defaults).
  `db/postgres.js` `assertNonDefaultDbUrl` hard-fails when `DATABASE_URL` carries the example
  default password (`:aperio_secret@`), opt-out `APERIO_ALLOW_DEFAULT_DB_PASSWORD=1`; called in
  `PostgresStore.init`. Tests: `tests/db/postgres-guard.test.js` (4 cases).
  - ⊘ **`:?` guard already present** — `docker/docker-compose.yml` + `.prod.yml` both already
    `${POSTGRES_PASSWORD:?…}`.
- ◐ **PATH-01** — was already expanded via `os.homedir()` across paths.js / api-codegraph /
  api-docgraph. Hardened + DRY'd: new exported `expandTilde` in paths.js (regex `^~(?=\/|$)` so
  `~user/…` is left intact instead of mangled to `<home>user/…`), used in the 4 paths.js sites.
  api-codegraph/docgraph left as-is (correct for the common `~/` case — not touched, surgical).
  Tests: `tests/lib/routes/paths.test.js` (5 cases).
- ☑ **INJECTION-01** — enforcement **already existed**: `db/tables.js` `isAllowedTable`
  (Set whitelist, stronger than a regex) gates `readTable(name)` in both stores; the only other
  `${name}` interpolation (`listTables`) iterates the constant `DB_TABLES`. Added the missing
  regression test: `tests/db/tables.test.js` (rejects injection payloads / internal tables /
  empty input, accepts every advertised table).
- ☑ **INPUT-01** — removed dead `.env.example` ext entry (mcp/tools/files.js `ALLOWED_EXTENSIONS`
  + attachments `TEXT_EXTS`; `extname` never yields `.env.example` so it was unreachable). Added a
  secret/dotfile deny-list checked **before** the ext allowlist: `.env*`, known credential
  basenames (`.pgpass`/`.npmrc`/`id_rsa`/…), cert exts (`.pem`/`.key`/…). Wired into `read_file`
  + `edit_file` (edit reads first → leak vector) and the attachment router. Tests: 6 cases in
  files.test.js (`.env`, `.pgpass`, `id_rsa`, `.pem`, `.env.example` now unreadable, edit refusal).
- ☑ **DOS-01** — global `express.json` limit `1mb` → `256kb` (server.js). Per-route limits
  (memories import 512kb, etc.) unchanged — intentional overrides.
- ☑ **NET-02** — `helmet` added (`contentSecurityPolicy: false`). CSP stays off for now: the UI
  relies on inline `<script>`/`onclick=`/`style=` + jsdelivr/Google-Fonts CDNs, so a strict policy
  needs those reworked first (deferred). All other helmet headers active (nosniff, frameguard,
  Referrer-Policy, …). Full suite 1650/1650.

## Phase 2 — Network layer (build now; LAN on roadmap)

- ☑ **REBIND-01** — `lib/helpers/netGuard.js` (`buildAllowedHosts` + `createNetGuard`): an
  Express middleware (registered before all routes) that (1) rejects requests whose Host
  header isn't a known local name (DNS-rebinding), (2) rejects state-changing `/api` calls
  with a cross-site Origin, (3) requires an `X-Aperio-Client` header on state-changing `/api`
  (browsers can't forge custom headers cross-origin without a CORS preflight we never grant).
  Extend allowed hosts via `APERIO_ALLOWED_HOSTS`. Frontend side: `public/scripts/http-guard.js`
  monkey-patches `fetch` to add the header on same-origin calls (loaded first in index/setup
  HTML). The WS `verifyClient` Origin check **already existed**; rewired it to share
  `buildAllowedHosts` (fixing a latent `::1`-vs-`[::1]` mismatch). Tests:
  `tests/lib/helpers/netGuard.test.js` (18 cases).
- ☑ **AUTH-01** — `lib/helpers/authGuard.js`: opt-in shared-secret gate, off unless
  `APERIO_AUTH_TOKEN` is set. `createAuthGuard()` middleware on `/api/*`; `isAuthorized(req)`
  reused in WS `verifyClient`. Token accepted via `Authorization: Bearer`, `X-Aperio-Token`,
  or `?token=` (for SSE/WS that can't set headers); constant-time compare. Frontend:
  http-guard.js persists `?token=` to localStorage and attaches it as a Bearer header;
  chat.js appends it to the WS URL. Tests: `tests/lib/helpers/authGuard.test.js` (13 cases).
- ☑ **PRIVACY-01** — three parts:
  - `lib/helpers/redactSecrets.js` (`redactSecrets`/`redactMessages`) scrubs high-confidence
    credentials (PEM keys, `sk-…`/`ghp_…`/AWS/Google/Slack tokens, JWTs, URI passwords,
    `key=value` secrets) before egress. Applied at each cloud provider's **send boundary**
    (the derived/trimmed array in `providers/anthropic.js`, `deepseek.js`, `gemini.js`, and the
    outgoing prompt in `claude-code.js`) so the persistent `messages` history the loops mutate
    in place stays intact; also wired into `helpers/completion.js`. Ollama (local) is skipped.
    Tests: `tests/lib/helpers/redactSecrets.test.js` (13 cases).
  - **local-only memories** via a reserved `local-only` **tag** (no schema migration): the
    agent passes provider locality to the MCP process (`APERIO_PROVIDER_LOCAL` env →
    `ctx.providerIsLocal`); `recallHandler` drops `local-only`-tagged rows when the provider
    is cloud, so they never reach a third-party model (covers model-initiated recalls too).
    `remember` tool documents the reserved tag. Tests: 4 cases in `tests/mcp/tools/memory.test.js`.
  - **worker gating**: the infer/dedup workers run only on Ollama unless
    `APERIO_CLOUD_MEMORY_WORKERS=1` (gated at the server.js call site).
- ☑ **DATA-01** — `lib/helpers/secureFile.js` (`writeSecureFile` 0600 / `ensureSecureDir` 0700,
  chmod-after-write since `writeFileSync` mode is ignored on existing files). Wired into
  sessions (`helpers/sessions.js`) and both handoff writers (`terminal.js`, `wsHandler.js`),
  which also now run handoff docs through `redactSecrets`. `logger.js`: log dir 0700, error
  logs 0600 (stream `mode` + boot-time chmod of existing files), and a `redactFormat` scrubs
  secrets from the on-disk message/stack. **Handoff-location bug fixed:** `skills/handoff/SKILL.md`
  said write to the world-readable OS temp dir (`/tmp`); corrected to the private
  `<project>/var/handoffs/` (0600) the server actually uses. Tests:
  `tests/lib/helpers/secureFile.test.js` (3 cases).
- ☑ **NET-03** — `lib/helpers/rateLimit.js` (`makeRateLimiter`, `express-rate-limit`) on
  `/api/setup/specs` + `/api/setup/config` (server.js), `/api/memories/import`,
  `/api/codegraph/index`, `/api/docgraph/index`. Indexing covers the embedding-heavy path.
  Tests: `tests/lib/helpers/rateLimit.test.js` (real express app, 429 after max). The shared
  `invoke` test harness in `api.test.js` gained `setHeader`/`ip` shims so real middleware runs.
- ☑ **PATH-02** — `lib/helpers/staticAuth.js` (`createStaticGuard`): the `/uploads` and
  `/scratch` mounts now require a per-process `aperio_static` httpOnly+SameSite cookie set when
  the app shell loads (browsers load these via `<img>`/`<a>`, so a header gate is impossible;
  a foreign origin can't read or replay the cookie). A valid `APERIO_AUTH_TOKEN` also grants
  access for programmatic clients. Tests: `tests/lib/helpers/staticAuth.test.js` (6 cases).

## Phase 3 — Hosting hardening

- ⊘ **SECRET-01 (keychain)** — **deferred** (decision: keep API keys in `.env`, already
  `0600` from Phase 1). A keychain backend (native `keytar` or per-OS shell-out) adds a
  dependency/cross-platform glue for marginal gain on a local-first tool; revisit if/when
  multi-user hosting lands.
- ☑ **NET-01** — `lib/helpers/tlsServer.js` (`createAppServer`): serves HTTPS when **both**
  `APERIO_TLS_CERT` and `APERIO_TLS_KEY` point at PEM files, else plain HTTP. Setting only one
  throws at boot (fail loud, no silent downgrade). Certs are user-provided (Aperio does not
  generate them). Wired into server.js (replaces `http.createServer`); the `scheme` propagates
  to the boot log + `openBrowser` URLs; the WS server attaches to either protocol unchanged.
  Tests: `tests/lib/helpers/tlsServer.test.js` (4 cases; HTTPS case generates a throwaway cert
  via openssl, skipped if absent).
- ☑ **SESSION-01** — `lib/helpers/sessionCrypto.js` (`encodeSession`/`decodeSession`): opt-in
  AES-256-GCM keyed solely by `APERIO_SESSION_KEY` (independent of `APERIO_AUTH_TOKEN`), scrypt-stretched.
  Envelope prefix `APERIO-ENC1:`; **no-op (plaintext JSON) when no key is set**, and plaintext
  files always decode so enabling encryption later doesn't strand existing sessions. GCM auth
  rejects tampered files. Wired into `helpers/sessions.js` read/write + the two direct
  `readFileSync` sites (`listSessions`, `pruneOldSessions`). Tests:
  `tests/lib/helpers/sessionCrypto.test.js` (6 cases).
- ☑ **DEP-02** — `.github/dependabot.yml` (npm + github-actions, weekly) makes the
  Dependabot coverage `SECURITY.md` already advertised real; new `.github/workflows/ci.npm-audit.yml`
  runs `npm audit --omit=dev --audit-level=high` on PR/push + weekly cron. `--no-audit` removed
  from the lite installers (`.github/lite/Aperio.sh`, `start1.sh`).
- ☑ **PROC-01** — `lib/helpers/crashBreaker.js` (`createCrashBreaker`): sliding-window breaker.
  The existing `uncaughtException`/`unhandledRejection` handlers now route through `handleFatal`
  — a single blowup is logged and absorbed, but ≥5 fatal errors within 60s trip the breaker and
  `process.exit(1)` so a supervisor restarts cleanly instead of serving errors forever. Tests:
  `tests/lib/helpers/crashBreaker.test.js` (3 cases, injectable clock).
- ☑ **LOG-01** — `lib/helpers/errorHandler.js` (`createErrorHandler`): terminal Express error
  middleware mounted after all routes (server.js, after the `/api` router). Logs the full
  error + a correlation id server-side; returns a **scrubbed** `{error:"internal_error",errorId}`
  in production (real message outside prod). Honours `err.status`; no-ops if headers already sent.
  Tests: `tests/lib/helpers/errorHandler.test.js` (4 cases).
- ☑ **Doc drift (audit.md §5)** — `SECURITY.md` supported version `0.48.3` → `0.56.x`; added a
  "Scope & threat model" section (local-first, `run_shell` not a sandbox, don't expose to
  untrusted networks, `AUTH_TOKEN`/`TLS`/`SESSION_KEY` for LAN, secrets `0600`) consistent with
  the README. New env vars documented in `.env.example` (Phase 3 block).

---

## Testing

How to verify the **completed** phases (0, 1, 2, 3). Every finding has automated
coverage; a few also have a manual check for things the suite can't assert (file
perms, live HTTP headers).

**Run everything:**

```bash
npm test                      # full suite, human-readable output
APERIO_AGENT_RUN=1 npm test   # quiet reporter (summary only) — same pass/fail
```

Run one file in isolation: `NODE_ENV=test node --test tests/<path>.test.js`.
Baseline after Phase 1: **1650/1650 passing**. After Phase 2: **1708/1708 passing**.

### Phase 0 — agent exfiltration surface

| Finding | Automated | Manual sanity check |
|---|---|---|
| **EGRESS-01** (SSRF) | `tests/lib/helpers/ssrfGuard.test.js` + integration case in `tests/mcp/tools/web.test.js` | ask the agent to `fetch_url http://169.254.169.254/` or `http://localhost` → blocked with an SSRF-guard message (unless `APERIO_ALLOW_INTERNAL_FETCH=1`). |
| **SHELL-01** (shell allowlist) | `tests/mcp/tools/shell.test.js` (15 cases) | `run_shell node -e "..."`, `find … -exec`, `git -c …`, or `curl …` → all refused. |
| **INJECT-01** (prompt-injection fencing/taint) | `tests/lib/agent/tool-hooks.test.js` (5 cases) | after a `fetch_url`/`read_file`, the content is wrapped in `--- UNTRUSTED EXTERNAL CONTENT … ---` and that turn's writes raise a confirm (see WRITE-01). |
| **WRITE-01** (confirm-on-write gate) | `tests/mcp/tools/files.test.js` (6 gate cases) + `tool-hooks.test.js` (3 wiring) | write outside `/var/scratch/` → confirm prompt; write a new file *inside* scratch in a clean turn → executes directly. |

### Phase 1 — quick wins

| Finding | Automated | Manual sanity check |
|---|---|---|
| **SECRET-01** (.env escaping + 0600) | `tests/lib/helpers/envFile.test.js` (11 cases incl. newline-injection, `$`-safety, always-quote) | after setup writes `.env`: `ls -l .env` → `-rw-------` (0600). |
| **ENV-01** (no `.env.example` as live config) | covered indirectly; no unit test (boot-path) | rename/remove `.env`, start the server → setup wizard appears and `aperio_secret` is **not** active in `process.env`. |
| **SECRET-02** (default DB password hard-fail) | `tests/db/postgres-guard.test.js` (4 cases) | set `DATABASE_URL=postgresql://aperio:aperio_secret@localhost/aperio` and start → boot fails with "default Postgres password"; `APERIO_ALLOW_DEFAULT_DB_PASSWORD=1` overrides. |
| **PATH-01** (`~` expansion) | `tests/lib/routes/paths.test.js` (5 cases) | — |
| **INJECTION-01** (table-name whitelist) | `tests/db/tables.test.js` (injection payloads / internal tables / empties rejected) | DB browser only lists the whitelisted tables; an out-of-list name throws "Unknown table". |
| **INPUT-01** (secret deny-list) | 6 cases in `tests/mcp/tools/files.test.js` (`secret-file deny-list` describe) | ask the agent to `read_file ./.env` or attach `id_rsa`/`server.pem` → refused before any extension check. |
| **DOS-01** (256kb JSON cap) | — | `curl -X POST http://127.0.0.1:3000/api/<json-route> -H 'content-type: application/json' --data-binary @big.json` (>256kb) → `413 Payload Too Large`. |
| **NET-02** (helmet headers) | — | `curl -sI http://127.0.0.1:3000/ \| grep -iE 'x-content-type-options\|x-frame-options\|referrer-policy'` → present; **no** `content-security-policy` (CSP deliberately off). |

### Phase 2 — network layer

| Finding | Automated | Manual sanity check |
|---|---|---|
| **REBIND-01** (Host/Origin/client-header) | `tests/lib/helpers/netGuard.test.js` (18 cases) | `curl -H 'Host: evil.com' http://127.0.0.1:3000/` → `403 host_not_allowed`; `curl -X POST http://127.0.0.1:3000/api/settings/x` (no `X-Aperio-Client`) → `403 client_header_required`. |
| **AUTH-01** (opt-in token) | `tests/lib/helpers/authGuard.test.js` (13 cases) | set `APERIO_AUTH_TOKEN=secret`, start, then `curl http://127.0.0.1:3000/api/version` → `401`; add `-H 'Authorization: Bearer secret'` → ok. |
| **PRIVACY-01** (redaction / local-only / worker gate) | `tests/lib/helpers/redactSecrets.test.js` (13) + 4 local-only cases in `tests/mcp/tools/memory.test.js` | on a cloud provider, a memory tagged `local-only` never appears in recall; boot log shows "memory inference/dedup workers disabled on cloud provider". |
| **DATA-01** (0600 + redaction) | `tests/lib/helpers/secureFile.test.js` (3 cases) | `ls -l var/sessions/*.json var/handoffs/*.md var/logs/error-*.log` → `-rw-------`; a logged/handoff secret shows as `[REDACTED:…]`. |
| **NET-03** (rate-limit) | `tests/lib/helpers/rateLimit.test.js` (real express app → 429 after max) | hammer `POST /api/codegraph/index` past 20×/15min → `429 rate_limited`. |
| **PATH-02** (static-mount cookie) | `tests/lib/helpers/staticAuth.test.js` (6 cases) | `curl http://127.0.0.1:3000/scratch/anything` (no cookie) → `403 forbidden`; the app's own download cards load fine (cookie set on shell load). |

### Phase 3 — hosting hardening

| Finding | Automated | Manual sanity check |
|---|---|---|
| **NET-01** (opt-in TLS) | `tests/lib/helpers/tlsServer.test.js` (4 cases) | set `APERIO_TLS_CERT`/`APERIO_TLS_KEY` to a PEM pair, start → boot log shows `https://…`; set only one → boot fails with a "set BOTH" error. |
| **SESSION-01** (at-rest session encryption) | `tests/lib/helpers/sessionCrypto.test.js` (6 cases) | set `APERIO_SESSION_KEY=…`, finish a chat, then `head -c 32 var/sessions/<id>.json` → starts `APERIO-ENC1:` (not readable JSON); History view still loads it. |
| **DEP-02** (audit + Dependabot) | CI workflow `ci.npm-audit.yml` (`npm audit --audit-level=high`) | `npm audit --omit=dev --audit-level=high` locally → no high/critical; `.github/dependabot.yml` present. |
| **PROC-01** (crash breaker) | `tests/lib/helpers/crashBreaker.test.js` (3 cases) | — (would require forcing ≥5 fatal errors/60s; the breaker then `exit(1)`s for a supervised restart). |
| **LOG-01** (scrubbed error handler) | `tests/lib/helpers/errorHandler.test.js` (4 cases) | with `NODE_ENV=production`, trigger a route that throws → response is `{"error":"internal_error","errorId":"…"}` with no internal detail; the full error + matching id is in the server log. |
| **SECRET-01 (keychain)** | ⊘ deferred (keys stay in `0600` `.env`) | — |

---

## Sequencing

```
Phase 0 ─► Phase 1 ─► Phase 2 (REBIND first) ─► Phase 3
EGRESS→SHELL+INJECT→WRITE
```
